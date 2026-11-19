import UIKit
import WebKit
import Capacitor

/// Which server the app talks to — chosen by the user, never built in (the iOS side of GenyServerPlugin.java; docs/apps.md).
///
/// No server saved: the web view starts on the local connect page (www/index.html) which finds the server and signs in
/// (www/connect-core.js, native HTTP) and then calls `connect`. The bridge is made again with Capacitor's server URL set
/// to that server's origin — so the console gets the native bridge on its own origin — and first opens
/// {server}/auth/exchange?code=… so the session cookie is set first-party. Later starts open the saved server.
///
/// Back to the connect page: `switchServer` / `signOut` (the console or the server's login page calls them through the
/// bridge), or the offline page, which navigates to /__geny/{retry,switch-server,sign-out}.
enum GenyServer {
    private static let store = UserDefaults.standard
    private static let kServer = "geny.server"          // base URL: origin [+ sub-path], no trailing slash
    private static let kLast = "geny.lastServer"        // prefill for the connect page
    private static let kUser = "geny.username"
    private static let kRemember = "geny.remember"
    private static let kEphemeral = "geny.ephemeral"    // connected without "remember": dropped at the next start
    private static let kPending = "geny.pendingStart"   // the exchange URL the next start opens first
    private static let kTheme = "geny.themeMode"        // system | light | dark (the console's Appearance)
    private static var processStarted = false

    /// "https://host[:port][/path]" without a trailing slash, or nil
    static func cleanBase(_ raw: String?) -> String? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), let u = URLComponents(string: raw),
              let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = u.host, !host.isEmpty else { return nil }
        var path = u.path
        while path.hasSuffix("/") { path.removeLast() }
        let port = u.port
        let plain = port == nil || (scheme == "http" && port == 80) || (scheme == "https" && port == 443)
        return "\(scheme)://\(host.lowercased())\(plain ? "" : ":\(port!)")\(path)"
    }

    static func origin(_ base: String) -> String? {
        guard let u = URLComponents(string: base), let scheme = u.scheme, let host = u.host else { return nil }
        return "\(scheme)://\(host)\(u.port.map { ":\($0)" } ?? "")"
    }

    static func sameOrigin(_ a: String, _ b: String) -> Bool {
        guard let oa = origin(a) else { return false }
        return oa == origin(b)
    }

    static var server: String? { cleanBase(store.string(forKey: kServer)) }

    static func forget(signOut: Bool) {
        store.removeObject(forKey: kServer)
        store.removeObject(forKey: kPending)
        store.removeObject(forKey: kEphemeral)
        if !(store.object(forKey: kRemember) as? Bool ?? true) {
            store.removeObject(forKey: kLast)
            store.removeObject(forKey: kUser)
        }
        if signOut {
            WKWebsiteDataStore.default().removeData(ofTypes: [WKWebsiteDataTypeCookies], modifiedSince: .distantPast) {}
            HTTPCookieStorage.shared.cookies?.forEach { HTTPCookieStorage.shared.deleteCookie($0) }
        }
    }

    static func select(base: String, start: String, username: String, remember: Bool) {
        store.set(base, forKey: kServer)
        store.set(start, forKey: kPending)
        store.set(remember, forKey: kRemember)
        store.set(!remember, forKey: kEphemeral)
        if remember {
            store.set(base, forKey: kLast)
            store.set(username.trimmingCharacters(in: .whitespaces), forKey: kUser)
        } else {
            store.removeObject(forKey: kUser)
        }
    }

    /// This start: the saved server's origin, its sub-path and its host for Capacitor; → the exchange URL to open first
    static func apply(to d: InstanceDescriptor) -> URL? {
        if !processStarted {
            processStarted = true
            if store.bool(forKey: kEphemeral) { forget(signOut: true) }
        }
        guard let base = server, let origin = origin(base), let host = URL(string: origin)?.host else { return nil }
        d.serverURL = origin
        let sub = String(base.dropFirst(origin.count))
        d.appStartPath = sub.isEmpty ? nil : sub + "/"
        d.allowedNavigationHostnames = [host]
        defer { store.removeObject(forKey: kPending) }
        if let start = store.string(forKey: kPending), sameOrigin(start, base), let url = URL(string: start) { return url }
        return nil
    }

    static func state(version: String) -> [String: Any] {
        let mode = themeMode
        return [
            "server": server ?? "",
            "lastServer": cleanBase(store.string(forKey: kLast)) ?? "",
            "username": store.string(forKey: kUser) ?? "",
            "remember": store.object(forKey: kRemember) as? Bool ?? true,
            "version": version,
            "themeMode": mode,
            "theme": dark(mode) ? "dark" : "light",
        ]
    }

    static var themeMode: String { store.string(forKey: kTheme) ?? "system" }

    static func setTheme(_ mode: String) {
        store.set(mode, forKey: kTheme)
        applyTheme()
    }

    static func dark(_ mode: String) -> Bool {
        if mode == "dark" { return true }
        if mode == "light" { return false }
        return UITraitCollection.current.userInterfaceStyle == .dark
    }

    /// the window follows the console's Appearance (light / dark / the system's)
    static func applyTheme() {
        DispatchQueue.main.async {
            let style: UIUserInterfaceStyle = themeMode == "dark" ? .dark : themeMode == "light" ? .light : .unspecified
            keyWindow()?.overrideUserInterfaceStyle = style
        }
    }

    static func keyWindow() -> UIWindow? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.first?.windows.first
    }

    /// the bridge made again, with the server now saved (or none: the connect page)
    static func restart() {
        DispatchQueue.main.async {
            keyWindow()?.rootViewController = MainViewController()
        }
    }
}

/// The app's web view: Capacitor's, started on the saved server (GenyServer), with the app's own plugins
class MainViewController: CAPBridgeViewController {
    private var firstURL: URL?

    override func instanceDescriptor() -> InstanceDescriptor {
        let descriptor = super.instanceDescriptor()
        firstURL = GenyServer.apply(to: descriptor)
        return descriptor
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(GenyServerPlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        GenyServer.applyTheme()
        // (right after signing in: the exchange URL sets the session cookie on the server's own origin; Capacitor's start
        // path can't carry its query)
        if let url = firstURL {
            firstURL = nil
            _ = webView?.load(URLRequest(url: url))
        }
    }
}

@objc(GenyServerPlugin)
public class GenyServerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GenyServerPlugin"
    public let jsName = "GenyServer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTheme", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "switchServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signOut", returnType: CAPPluginReturnPromise),
    ]

    private var version: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? ""
    }

    @objc func getState(_ call: CAPPluginCall) {
        call.resolve(GenyServer.state(version: version))
    }

    /// {mode: system | light | dark}: the console's Appearance — kept, and the window follows now
    @objc func setTheme(_ call: CAPPluginCall) {
        var mode = call.getString("mode") ?? "system"
        if mode != "light" && mode != "dark" { mode = "system" }
        GenyServer.setTheme(mode)
        call.resolve(["themeMode": mode, "theme": GenyServer.dark(mode) ? "dark" : "light"])
    }

    /// {server, start, username, remember}: save the server and open start (its exchange URL)
    @objc func connect(_ call: CAPPluginCall) {
        guard let base = GenyServer.cleanBase(call.getString("server")) else {
            call.reject("Not an http(s) server address")
            return
        }
        guard let start = call.getString("start"), GenyServer.sameOrigin(start, base) else {
            call.reject("The start page must be on the server")
            return
        }
        GenyServer.select(base: base, start: start, username: call.getString("username") ?? "", remember: call.getBool("remember") ?? true)
        call.resolve()
        GenyServer.restart()
    }

    /// back to the connect page (the session cookie stays)
    @objc func switchServer(_ call: CAPPluginCall) {
        GenyServer.forget(signOut: false)
        call.resolve()
        GenyServer.restart()
    }

    /// sign out: cookies cleared, back to the connect page
    @objc func signOut(_ call: CAPPluginCall) {
        GenyServer.forget(signOut: true)
        call.resolve()
        GenyServer.restart()
    }

    /// local pages ask for actions by navigating to /__geny/<action> (the offline page)
    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url, url.path.hasPrefix("/__geny/") else { return nil }
        let local = url.host == "localhost" || url.scheme == InstanceDescriptorDefaults.scheme
        guard local else { return nil }
        switch String(url.path.dropFirst("/__geny/".count)) {
        case "switch-server":
            GenyServer.forget(signOut: false)
            GenyServer.restart()
        case "sign-out":
            GenyServer.forget(signOut: true)
            GenyServer.restart()
        default:
            if let base = GenyServer.server, let target = URL(string: base + "/") {
                DispatchQueue.main.async { [weak self] in _ = self?.bridge?.webView?.load(URLRequest(url: target)) }
            } else {
                GenyServer.restart()
            }
        }
        return true
    }
}
