/* The Android connect page (index.html): server address, username, password.
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
      if (first !== "password") $(first).focus();
    });
  }

  root.GenyMobile = { nativeRequest: nativeRequest, pickRequest: pickRequest, start: start };
  if (typeof document !== "undefined" && document.getElementById && document.getElementById("form")) {
    start(window, document);
  }
})(typeof self !== "undefined" ? self : this);
