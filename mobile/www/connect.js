/* The Android connect page (index.html): a QR code (Settings → 디바이스 인증), or server address, username, password.
 *
 * A QR code is one of two (docs/geny-net.md): geny://login?u=<server>&c=<one-time code> — the server's sign-in for
 * its current account, opened as <server>/auth/exchange?code=… — or geny://link?… — pairing with the desktop app
 * (Geny Net, GenyNet.java): the phone asks, both screens show the same six digits, the user allows it on the computer,
 * and the app opens the computer through its own encrypted link from then on.
 *
 * Finds the server and signs in with connect-core.js over Capacitor's native
 * HTTP (no CORS, no mixed-content block for http:// LAN servers, even though
 * this page itself is https://localhost), then hands the server and its
 * exchange URL to the GenyServer plugin (GenyServerPlugin.java), which
 * restarts the WebView on the server.
 *
 * CapacitorHttp is called directly (Capacitor.nativePromise) rather than
 * through `plugins.CapacitorHttp.enabled`, which would also reroute the
 * console's own fetch/XHR (streaming) through native code.
 */
(function (root) {
  "use strict";

  /** connect-core's request() over the native CapacitorHttp plugin. */
  function nativeRequest(cap) {
    return function (o) {
      var opts = {
        url: o.url,
        method: o.method || "GET",
        headers: o.headers || {},
        connectTimeout: o.timeoutMs,
        readTimeout: o.timeoutMs,
        responseType: "text",
        // HttpURLConnection follows same-scheme redirects itself; connect-core follows the rest
      };
      if (o.body != null) opts.data = o.body;
      return cap.nativePromise("CapacitorHttp", "request", opts).then(function (r) {
        var headers = {};
        var h = (r && r.headers) || {};
        for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k)) headers[k.toLowerCase()] = h[k];
        return { status: r.status, url: r.url || o.url, headers: headers, data: r.data };
      });
    };
  }

  function pickRequest(win) {
    var cap = win.Capacitor;
    if (cap && typeof cap.nativePromise === "function" && cap.isNativePlatform && cap.isNativePlatform()) return nativeRequest(cap);
    return root.GenyConnect.fetchRequest(win.fetch.bind(win)); // a desktop browser (development)
  }

  /** what a scanned QR code is: {kind: "login", server, start} | {kind: "link", name} | null */
  function parseCode(text) {
    var u;
    try {
      u = new URL(String(text || "").trim());
    } catch (e) {
      return null;
    }
    if (u.protocol !== "geny:") return null;
    var host = u.host || u.pathname.replace(/^\/\//, "").split(/[/?]/)[0];
    var q = u.searchParams;
    if (host === "login") {
      var server = String(q.get("u") || "").replace(/\/+$/, "");
      var code = q.get("c") || "";
      if (!/^https?:\/\/[^/?#]+/i.test(server) || !code) return null;
      return { kind: "login", server: server, start: server + "/auth/exchange?code=" + encodeURIComponent(code) + "&next=/" };
    }
    if (host === "link") {
      if (!q.get("n") || !q.get("f") || !q.get("k")) return null;
      return { kind: "link", name: q.get("d") || "the computer" };
    }
    return null;
  }

  var PAIR_ERRORS = {
    expired: "This code has expired or was already used. Show a new one on the computer.",
    unreachable: "Can't reach the computer. Is My Mate Geny open on it? On another network, its relay has to be on.",
    busy: "The computer has too many requests waiting. Try again in a moment.",
    full: "The computer has too many phones paired. Remove one there first.",
    mismatch: "Something answered that isn't the computer in this code. Nothing was paired.",
    bad_code: "This QR code isn't complete. Show a new one on the computer.",
  };

  function netPlugin(win) {
    var cap = win.Capacitor;
    var call = function (method, options) {
      if (!cap || typeof cap.nativePromise !== "function") return Promise.reject(new Error("Not inside the app"));
      return cap.nativePromise("GenyNet", method, options || {});
    };
    return {
      state: function () { return call("state").catch(function () { return {}; }); },
      incoming: function () { return call("incoming").catch(function () { return {}; }); },
      scan: function () { return call("scan", { prompt: "Scan the QR code in Settings → Device sign-in" }); },
      pair: function (uri) { return call("pair", { uri: uri }); },
      wait: function () { return call("waitResult"); },
      cancel: function () { return call("cancel").catch(function () {}); },
      open: function () { return call("open"); },
      forget: function () { return call("forget"); },
    };
  }

  function plugin(win) {
    var cap = win.Capacitor;
    var call = function (method, options) {
      if (!cap || typeof cap.nativePromise !== "function") return Promise.reject(new Error("Not inside the app"));
      return cap.nativePromise("GenyServer", method, options || {});
    };
    return {
      state: function () { return call("getState").catch(function () { return {}; }); },
      connect: function (o) { return call("connect", o); },
    };
  }

  function start(win, doc) {
    var core = root.GenyConnect;
    var $ = function (id) { return doc.getElementById(id); };
    var request = pickRequest(win);
    var native = plugin(win);
    var net = netPlugin(win);
    var pairing = 0; // (the pairing on screen: a new one or Cancel ends the old one's loop)
    var busy = false;
    var fields = ["server", "username", "password"];

    function status(kind, text, detail) {
      var el = $("status");
      el.className = "status" + (kind === "err" ? " err" : "");
      el.textContent = "";
      if (kind === "busy") {
        var s = doc.createElement("span");
        s.className = "spin";
        el.appendChild(s);
      }
      var box = doc.createElement("div");
      box.textContent = text || "";
      if (detail) {
        var d = doc.createElement("small");
        d.textContent = detail;
        box.appendChild(d);
      }
      el.appendChild(box);
    }
    function setBusy(on) {
      busy = on;
      $("go").disabled = on;
      fields.forEach(function (id) { $(id).readOnly = on; });
    }
    function mark(id) {
      fields.forEach(function (f) { $(f).setAttribute("aria-invalid", String(f === id)); });
      if (id) $(id).focus();
    }

    $("show").onclick = function () {
      var p = $("password");
      var show = p.type === "password";
      p.type = show ? "text" : "password";
      $("show").textContent = show ? "Hide" : "Show";
      $("show").setAttribute("aria-pressed", String(show));
    };

    function pairStatus(kind, text) {
      var el = $("pairStatus");
      el.className = "status" + (kind === "err" ? " err" : "");
      el.textContent = "";
      if (kind === "busy") {
        var sp = doc.createElement("span");
        sp.className = "spin";
        el.appendChild(sp);
      }
      var t = doc.createElement("div");
      t.textContent = text || "";
      el.appendChild(t);
    }
    function showPair(on) {
      $("pair").hidden = !on;
      $("form").hidden = on;
    }

    /** a QR code's text: sign in to a server, or pair with the computer */
    function useCode(text, confirmed) {
      var c = parseCode(text);
      if (!c) return status("err", "This isn't a My Mate Geny code.", "Scan the code in Settings → Device sign-in.");
      if (c.kind === "login") {
        if (!confirmed && !win.confirm("Sign in to " + c.server + "?")) return;
        status("busy", "Signing in to " + c.server + "…");
        return native.connect({ server: c.server, start: c.start, username: $("username").value.trim(), remember: true })
          .catch(function (e) { status("err", "Couldn't open " + c.server, String((e && e.message) || e)); });
      }
      if (!confirmed && !win.confirm("Connect this phone to " + c.name + "?")) return;
      var mine = ++pairing;
      status("busy", "Reaching " + c.name + "…");
      setBusy(true);
      return net.pair(String(text).trim())
        .then(function (r) {
          if (mine !== pairing) return;
          setBusy(false);
          status("", "");
          $("sas").textContent = String(r.sas || "").replace(/^(\d{3})(\d{3})$/, "$1 $2");
          $("pairHint").textContent = "Allow it on " + (r.name || c.name) + " if it shows the same number.";
          pairStatus("busy", "Waiting for the computer…");
          showPair(true);
          return waitLoop(mine);
        })
        .catch(function (e) {
          if (mine !== pairing) return;
          setBusy(false);
          showPair(false);
          status("err", PAIR_ERRORS[e && e.code] || "Couldn't pair", String((e && e.message) || e));
        });
    }

    function waitLoop(mine) {
      return net.wait().then(function (r) {
        if (mine !== pairing) return;
        var state = r && r.state;
        if (state === "pending") return waitLoop(mine);
        if (state === "approved") {
          pairStatus("busy", "Paired — opening the console…");
          return net.open();
        }
        showPair(false);
        status("err", state === "denied" ? "The computer said no." : PAIR_ERRORS.expired);
      }, function (e) {
        if (mine !== pairing) return;
        showPair(false);
        status("err", PAIR_ERRORS.unreachable, String((e && e.message) || e));
      });
    }

    $("pairCancel").onclick = function () {
      pairing++;
      net.cancel();
      showPair(false);
      status("", "");
    };
    $("scan").onclick = function () {
      if (busy) return;
      net.scan().then(function (r) {
        if (r && r.text) useCode(r.text, true); // (scanned here: the user chose it)
      }, function (e) {
        status("err", "The camera didn't open", String((e && e.message) || e));
      });
    };
    $("openLinked").onclick = function () {
      status("busy", "Opening " + $("linkedName").textContent + "…");
      net.open().catch(function (e) { status("err", "Couldn't open it", String((e && e.message) || e)); });
    };
    $("forget").onclick = function () {
      if (!win.confirm("Forget " + $("linkedName").textContent + "? To use it again, pair with a new QR code.")) return;
      net.forget().then(function () { $("linked").hidden = true; });
    };

    $("form").onsubmit = function (ev) {
      ev.preventDefault();
      if (busy) return;
      var input = $("server").value.trim();
      var username = $("username").value.trim();
      var password = $("password").value;
      if (!input) return status("err", core.MESSAGES.empty), mark("server");
      if (!username) return status("err", core.MESSAGES.missing_username), mark("username");
      if (!password) return status("err", core.MESSAGES.missing_password), mark("password");
      mark(null);
      setBusy(true);
      status("busy", "Looking for the server…");
      var server = "";
      core.findServer(input, request)
        .then(function (found) {
          if (!found.ok) {
            status("err", found.message, found.detail);
            mark(found.kind === "rate" ? null : "server");
            return null;
          }
          server = found.server;
          $("server").value = server;
          status("busy", "Signing in to " + server + "…");
          return core.signIn(server, username, password, request);
        })
        .then(function (r) {
          if (!r) return;
          if (!r.ok) {
            status("err", r.message, r.detail);
            mark(r.kind === "credentials" ? "password" : null);
            return;
          }
          status("busy", "Opening the console…");
          var remember = $("remember").checked;
          try {
            if (remember) win.localStorage.setItem("geny.server", server);
            else win.localStorage.removeItem("geny.server");
          } catch (e) {}
          $("password").value = "";
          return native.connect({ server: server, start: r.exchangeUrl, username: username, remember: remember })
            .catch(function () {
              win.location.href = r.exchangeUrl; // outside the app (development)
            });
        })
        .catch(function (e) {
          status("err", "Something went wrong", String((e && e.message) || e));
        })
        .then(function () { setBusy(false); });
    };

    native.state().then(function (s) {
      s = s || {};
      $("ver").textContent = s.version ? "· " + s.version : "";
      $("server").value = s.server || s.lastServer || "";
      $("username").value = s.username || "";
      $("remember").checked = s.remember !== false;
      var first = !$("server").value ? "server" : !$("username").value ? "username" : "password";
      if (first !== "password" && !(s.server || s.lastServer)) return;
      if (first !== "password") $(first).focus();
    });
    net.state().then(function (s) {
      if (!s || !s.paired) return;
      $("linkedName").textContent = s.name || "Your computer";
      $("linked").hidden = false;
    });
    // a geny:// code the app was opened with (the camera app): asked about first unless the user just said yes
    net.incoming().then(function (r) {
      if (r && r.uri) useCode(r.uri, !!r.confirmed);
    });
  }

  root.GenyMobile = { nativeRequest: nativeRequest, pickRequest: pickRequest, parseCode: parseCode, start: start };
  if (typeof document !== "undefined" && document.getElementById && document.getElementById("form")) {
    start(window, document);
  }
})(typeof self !== "undefined" ? self : this);
