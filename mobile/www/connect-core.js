/* My Mate Geny: finding a server from what the user typed, and signing in.
 *
 * Shared by both apps, byte-for-byte identical (a test checks):
 *   desktop/src/connect-core.js  — Node CommonJS (the Electron main process)
 *   mobile/www/connect-core.js   — a plain <script> (window.GenyConnect)
 * Edit one, copy it over the other.
 *
 * Pure: no I/O of its own. HTTP goes through an injected
 *   request({ url, method, headers, body, timeoutMs })
 *     → Promise<{ status, url, headers, data }>   (rejects on network errors)
 * (`fetchRequest(fetch)` builds one from any WHATWG fetch).
 *
 * Server contract:
 *   GET  {server}/health          → {"status":"ok","service":"my-mate-geny"|"hr-harnessor"}
 *   POST {server}/api/auth/login  {username,password,exchange:true}
 *                                 → 200 {ok, token, exchange_code, expires_in} | 401/403 {detail}
 *   GET  {server}/auth/exchange?code=…&next=/  → session cookie + 302 to the console
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GenyConnect = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SERVICES = ["my-mate-geny", "hr-harnessor"];
  var HEALTH_TIMEOUT_MS = 5000;
  var LOGIN_TIMEOUT_MS = 20000;
  var MAX_REDIRECTS = 5;
  var MAX_PATHS = 4;

  var MESSAGES = {
    empty: "Enter your server's address",
    invalid: "That doesn't look like a server address",
    scheme: "Only http:// and https:// addresses work",
    unreachable: "Can't reach the server",
    timeout: "Can't reach the server",
    tls: "Can't connect securely — the server's certificate isn't trusted",
    cleartext: "This device refused a plain http:// connection",
    not_geny: "Not a My Mate Geny server",
    missing_username: "Enter your username",
    missing_password: "Enter your password",
    credentials: "Wrong username or password",
    rate: "Too many attempts — try later",
    old_server: "This server is too old for the app — update My Mate Geny on the server",
    server_error: "The server had a problem — try again",
  };

  function fail(kind, detail, extra) {
    var out = { ok: false, kind: kind, message: MESSAGES[kind] || MESSAGES.unreachable, detail: detail || "" };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
    return out;
  }

  // ── addresses ────────────────────────────────────────────────

  function ipv4(host) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return null;
    var p = [+m[1], +m[2], +m[3], +m[4]];
    return p.every(function (n) { return n <= 255; }) ? p : null;
  }

  function privateV4(p) {
    return (
      p[0] === 127 || p[0] === 10 || p[0] === 0 ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) // CGNAT / Tailscale
    );
  }

  /** localhost, private/link-local/CGNAT IPs, single-label and LAN-only names. */
  function isPrivateHost(hostname) {
    var h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!h) return false;
    if (h === "localhost" || /\.localhost$/.test(h)) return true;
    var v4 = ipv4(h);
    if (v4) return privateV4(v4);
    if (h.indexOf(":") >= 0) {
      if (h === "::1" || h === "::") return true;
      var mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(h);
      if (mapped) {
        if (mapped[1]) return !!ipv4(mapped[1]) && privateV4(ipv4(mapped[1]));
        var a = parseInt(mapped[2], 16), b = parseInt(mapped[3], 16);
        return privateV4([a >> 8, a & 255, b >> 8, b & 255]);
      }
      return /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
    }
    if (h.indexOf(".") < 0) return true; // "nas", "raspberrypi"
    return /\.(local|lan|home|home\.arpa|internal|intranet|localdomain|corp)$/.test(h);
  }

  /**
   * What the user typed → where to look for the server.
   * → { ok, host, port, explicitScheme, schemes, paths, candidates: [{scheme, path, base}], display }
   *   | { ok: false, kind, message }
   * Bases never end with "/" ("https://example.com", "http://10.0.0.2:58080/geny").
   */
  function parseAddress(raw) {
    var s = String(raw == null ? "" : raw).replace(/[\s ​-‍﻿]+/g, "");
    s = s.replace(/^[<"'`(]+|[>"'`)]+$/g, "").replace(/\\/g, "/");
    if (!s) return fail("empty");
    if (s.length > 2048) return fail("invalid", "The address is too long.");

    var scheme = null;
    var m = /^(https?|wss?):\/*/i.exec(s) || /^(https?)\/\/+/i.exec(s);
    if (m) {
      scheme = m[1].toLowerCase().replace(/^ws/, "http");
      s = s.slice(m[0].length);
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      return fail("scheme");
    }
    s = s.replace(/^\/+/, "");

    // host[:port] — the part before the path / query / fragment
    var cut = s.search(/[/?#]/);
    var hostport = cut < 0 ? s : s.slice(0, cut);
    var rest = cut < 0 ? "" : s.slice(cut);
    var at = hostport.lastIndexOf("@");
    if (at >= 0) hostport = hostport.slice(at + 1); // drop user:pass@
    // bare IPv6 ("::1", "fe80::1") → bracketed
    if (hostport.charAt(0) !== "[" && (hostport.match(/:/g) || []).length >= 2 && /^[0-9a-f:.]+(%\w+)?$/i.test(hostport)) {
      hostport = "[" + hostport.replace(/%\w+$/, "") + "]";
    }
    var hp = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(hostport);
    if (!hp || !hp[1]) return fail("invalid");
    var hostIn = hp[1].replace(/\.+$/, "");
    var port = hp[2] ? parseInt(hp[2], 10) : null;
    if (port !== null && (port < 1 || port > 65535)) return fail("invalid", "The port must be between 1 and 65535.");
    if (!hostIn) return fail("invalid");

    var probeUrl;
    try {
      probeUrl = new URL("http://" + hostIn + (port ? ":" + port : "") + "/");
    } catch (e) {
      return fail("invalid");
    }
    var host = probeUrl.hostname;
    if (!host || /[^a-z0-9.\-_\[\]:%\u0080-￿]/i.test(host)) return fail("invalid");
    if (!/^\[/.test(host) && !ipv4(host) && !/^[a-z0-9_\u0080-￿-]+(\.[a-z0-9_\u0080-￿-]+)*$/i.test(host)) return fail("invalid");

    // path: no query/fragment, no empty or dot segments, no trailing slash
    var path = rest.replace(/[?#].*$/, "");
    var segs = path.split("/").filter(function (x) { return x && x !== "."; });
    var clean = [];
    segs.forEach(function (x) {
      if (x === "..") clean.pop();
      else clean.push(x);
    });
    var paths = [];
    for (var n = clean.length; n >= 0 && paths.length < MAX_PATHS; n--) paths.push(n ? "/" + clean.slice(0, n).join("/") : "");
    if (paths[paths.length - 1] !== "") paths.push("");

    var schemes;
    if (scheme) schemes = [scheme];
    else if (port === 443) schemes = ["https", "http"];
    else if (port !== null || isPrivateHost(host)) schemes = ["http", "https"];
    else schemes = ["https", "http"];

    var candidates = [];
    schemes.forEach(function (sc) {
      var origin = new URL(sc + "://" + host + (port ? ":" + port : "") + "/").origin;
      paths.forEach(function (p) {
        candidates.push({ scheme: sc, path: p, base: origin + p });
      });
    });
    return {
      ok: true,
      host: host,
      port: port,
      explicitScheme: !!scheme,
      schemes: schemes,
      paths: paths,
      candidates: candidates,
      display: candidates[0].base,
    };
  }

  /** A saved base URL, checked: "https://host[:port][/path]" without a trailing slash, or "". */
  function cleanBase(url) {
    try {
      var u = new URL(String(url || ""));
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return u.origin + u.pathname.replace(/\/+$/, "");
    } catch (e) {
      return "";
    }
  }

  // ── errors ───────────────────────────────────────────────────

  /** A thrown network error (Node/undici, Electron net, Android HttpURLConnection, browsers). */
  function classifyNetworkError(err) {
    var e = err || {};
    var c = e.cause || {};
    var text = [e.name, e.code, e.errorCode, e.message, c.name, c.code, c.message, e.data && e.data.message]
      .filter(Boolean).join(" ");
    if (/Abort|Timeout|ETIMEDOUT|TIMED_OUT|timed? ?out/i.test(text)) {
      return fail("timeout", "It didn't answer in time.", { network: true });
    }
    if (/CLEARTEXT/i.test(text)) {
      return fail("cleartext", "Use https://, or a build that allows http:// on private networks.", { network: true });
    }
    if (/EXPIRED|DATE_INVALID|CertificateExpired|expired/i.test(text)) {
      return fail("tls", "The server's certificate has expired.", { network: true });
    }
    if (/ALTNAME|COMMON_NAME|NAME_INVALID|SSLPeerUnverified|not verified|Hostname .* (?:not|doesn't)/i.test(text)) {
      return fail("tls", "The certificate is for a different name.", { network: true });
    }
    if (/SELF_SIGNED|AUTHORITY_INVALID|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|Trust anchor|CertPath|CERT_|certificate/i.test(text)) {
      return fail("tls", "The certificate is self-signed or from an unknown authority.", { network: true });
    }
    if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME|NAME_NOT_RESOLVED|UnknownHost|getaddrinfo|resolve host/i.test(text)) {
      return fail("unreachable", "That name doesn't resolve — check the spelling.", { network: true });
    }
    if (/SSL|TLS|EPROTO|WRONG_VERSION|packet/i.test(text)) {
      return fail("unreachable", "It doesn't speak this protocol (http vs https).", { network: true, protocol: true });
    }
    if (/REFUSED|ConnectException|Failed to connect/i.test(text)) {
      return fail("unreachable", "Nothing answered at that address and port.", { network: true });
    }
    return fail("unreachable", "Check the address and your connection.", { network: true });
  }

  // which failure tells the user the most
  var RANK = { rate: 7, not_geny: 6, tls: 5, cleartext: 4, timeout: 3, unreachable: 2, invalid: 1 };
  function better(a, b) {
    if (!a) return b;
    if (!b) return a;
    var ra = (RANK[a.kind] || 0) - (a.protocol ? 1.5 : 0);
    var rb = (RANK[b.kind] || 0) - (b.protocol ? 1.5 : 0);
    return rb > ra ? b : a;
  }

  // ── HTTP helpers ─────────────────────────────────────────────

  function asJson(data) {
    if (data && typeof data === "object") return data;
    if (typeof data !== "string" || !data) return null;
    try {
      var v = JSON.parse(data);
      return v && typeof v === "object" ? v : null;
    } catch (e) {
      return null;
    }
  }

  function header(res, name) {
    var h = (res && res.headers) || {};
    var want = name.toLowerCase();
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k) && k.toLowerCase() === want) return h[k];
    return "";
  }

  var banned = /block|attempt|banned|too many|차단|시도/i;

  /** GET {base}/health, following redirects (Android's HttpURLConnection
   *  won't cross http→https on its own). → { ok, server, service, version } | failure */
  function probe(base, request, opts) {
    var url = base + "/health";
    var hops = 0;
    function step() {
      return Promise.resolve()
        .then(function () {
          return request({ url: url, method: "GET", headers: { Accept: "application/json" }, timeoutMs: opts.healthTimeoutMs || HEALTH_TIMEOUT_MS });
        })
        .then(function (res) {
          var status = Number(res && res.status) || 0;
          var loc = header(res, "location");
          if (status >= 300 && status < 400 && loc && hops < MAX_REDIRECTS) {
            hops++;
            url = new URL(loc, (res && res.url) || url).href;
            return step();
          }
          var final = String((res && res.url) || url);
          var body = asJson(res && res.data);
          if (status === 200 && body && body.status === "ok" && SERVICES.indexOf(body.service) >= 0) {
            var server = /\/health\/?(?:[?#].*)?$/.test(final) ? cleanBase(final.replace(/\/health\/?(?:[?#].*)?$/, "")) : base;
            return { ok: true, server: server || base, service: body.service, version: body.version || "" };
          }
          if ((status === 403 || status === 429) && body && typeof body.detail === "string" && banned.test(body.detail)) {
            return fail("rate", body.detail, { status: status, server: base });
          }
          var what = status === 200 ? "It answered, but not as My Mate Geny." : "It answered HTTP " + status + " at " + base + "/health.";
          return fail("not_geny", what, { status: status });
        }, function (err) {
          return classifyNetworkError(err);
        });
    }
    return step();
  }

  /**
   * Find the server behind what the user typed: every candidate scheme in
   * order, the typed sub-path first and then its parents; a scheme that gets
   * no HTTP answer at all skips its remaining paths.
   * → { ok: true, server, service, version } | { ok: false, kind, message, detail }
   */
  function findServer(input, request, opts) {
    opts = opts || {};
    var parsed = parseAddress(input);
    if (!parsed.ok) return Promise.resolve(parsed);
    var progress = typeof opts.onProgress === "function" ? opts.onProgress : function () {};
    var worst = null;
    var list = parsed.candidates.slice();
    var deadScheme = {};
    function next() {
      var c = list.shift();
      if (!c) return Promise.resolve(worst || fail("unreachable"));
      if (deadScheme[c.scheme]) return next();
      progress({ step: "probe", url: c.base });
      return probe(c.base, request, opts).then(function (r) {
        if (r.ok) return r;
        if (r.kind === "rate") return r; // a real server that blocked us
        worst = better(worst, r);
        if (r.network) deadScheme[c.scheme] = true;
        return next();
      });
    }
    return next();
  }

  function exchangeUrl(server, code, next) {
    return cleanBase(server) + "/auth/exchange?code=" + encodeURIComponent(code) + "&next=" + encodeURIComponent(next || "/");
  }

  /**
   * POST the credentials with exchange:true.
   * → { ok: true, code, exchangeUrl, expiresIn } | { ok: false, kind, message, detail }
   */
  function signIn(server, username, password, request, opts) {
    opts = opts || {};
    var base = cleanBase(server);
    if (!base) return Promise.resolve(fail("invalid"));
    username = String(username == null ? "" : username).trim();
    password = String(password == null ? "" : password);
    if (!username) return Promise.resolve(fail("missing_username"));
    if (!password) return Promise.resolve(fail("missing_password"));
    return Promise.resolve()
      .then(function () {
        return request({
          url: base + "/api/auth/login",
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ username: username, password: password, exchange: true }),
          timeoutMs: opts.loginTimeoutMs || LOGIN_TIMEOUT_MS,
        });
      })
      .then(function (res) {
        var status = Number(res && res.status) || 0;
        var body = asJson(res && res.data) || {};
        var detail = typeof body.detail === "string" ? body.detail : "";
        if (status === 200 && body.exchange_code) {
          return {
            ok: true,
            code: String(body.exchange_code),
            exchangeUrl: exchangeUrl(base, String(body.exchange_code), opts.next || "/"),
            expiresIn: Number(body.expires_in) || 0,
          };
        }
        if (status === 200 && body.ok) return fail("old_server", "It signed in but sent no exchange code.");
        if (status === 401) return fail("credentials", detail);
        if (status === 403 || status === 429) return fail("rate", detail);
        if (status === 404 || status === 405) return fail("old_server", "It has no app sign-in (HTTP " + status + ").");
        if (status === 400 || status === 422) return fail("server_error", detail || "It refused the sign-in request (HTTP " + status + ").");
        return fail("server_error", detail || "HTTP " + status + ".", { status: status });
      }, function (err) {
        return classifyNetworkError(err);
      });
  }

  /** request() on top of a WHATWG fetch (Node ≥18, Electron net.fetch, browsers). */
  function fetchRequest(fetchImpl) {
    return function (o) {
      var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = ctrl && o.timeoutMs ? setTimeout(function () { ctrl.abort(); }, o.timeoutMs) : null;
      var init = { method: o.method || "GET", headers: o.headers || {}, redirect: "follow", credentials: "omit" };
      if (o.body != null) init.body = o.body;
      if (ctrl) init.signal = ctrl.signal;
      return Promise.resolve()
        .then(function () { return fetchImpl(o.url, init); })
        .then(function (res) {
          return res.text().then(function (text) {
            var headers = {};
            if (res.headers && res.headers.forEach) res.headers.forEach(function (v, k) { headers[String(k).toLowerCase()] = v; });
            return { status: res.status, url: res.url || o.url, headers: headers, data: text };
          });
        })
        .then(function (r) {
          if (timer) clearTimeout(timer);
          return r;
        }, function (e) {
          if (timer) clearTimeout(timer);
          if (ctrl && ctrl.signal.aborted) {
            var t = new Error("timed out");
            t.name = "TimeoutError";
            throw t;
          }
          throw e;
        });
    };
  }

  return {
    SERVICES: SERVICES,
    MESSAGES: MESSAGES,
    parseAddress: parseAddress,
    isPrivateHost: isPrivateHost,
    cleanBase: cleanBase,
    classifyNetworkError: classifyNetworkError,
    probe: probe,
    findServer: findServer,
    signIn: signIn,
    exchangeUrl: exchangeUrl,
    fetchRequest: fetchRequest,
  };
});
