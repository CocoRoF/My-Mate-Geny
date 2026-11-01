import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installClientErrorReporter } from "./api/admin";
import { disableLoginRedirect } from "./api/client";
import { installNativeBridge } from "./native";
import { watchKeyboard } from "./lib/keyboard";
import { installChunkRecovery } from "./lib/recover";
import ErrorBoundary from "./components/ui/ErrorBoundary";
import TitleBar from "./components/layout/TitleBar";
import { claimWindowChrome } from "./lib/nativeWindow";
import "./index.css";

installClientErrorReporter();
installChunkRecovery(); // a code chunk gone after a deploy: reload once, never a blank page (lib/recover.ts)
installNativeBridge();
watchKeyboard(); // the on-screen keyboard: <html data-keyboard>, --app-h (lib/keyboard.ts)

// Full-page surfaces without the console:
//   /?surface=avatar-lab                          avatar renderer lab (lazy chunk)
//   /?surface=mate-overlay|mate-quick|mate-chat   the desktop app's Mate windows (docs/mate.md §6)
const surface = new URLSearchParams(window.location.search).get("surface");
const AvatarLab = lazy(() => import("./mate/AvatarLab"));
const MateSurface = lazy(() => import("./components/mate/surfaces/MateSurfaces"));
const mateSurface = surface === "mate-overlay" || surface === "mate-quick" || surface === "mate-chat" ? surface : null;

if (mateSurface === "mate-overlay" || mateSurface === "mate-quick") document.documentElement.classList.add("mate-transparent");
if (mateSurface === "mate-quick") document.documentElement.classList.add("mate-quick-page");
// a window of the desktop app (not a phone, whatever its width)
if (mateSurface && /^desktop-/.test(window.hrhNative?.platform ?? "")) document.documentElement.classList.add("desktop-surface");
if (mateSurface === "mate-overlay") disableLoginRedirect(); // a see-through window never turns into the login page
if (mateSurface) document.title = mateSurface === "mate-chat" ? "Mate — My Mate Geny" : "Mate";

// The root boundary: a render error or a chunk that failed to load shows a Reload screen instead of a black window.
// (The transparent avatar window stays empty and reloads itself; the quick card shows a one-line notice.)
const variant = mateSurface === "mate-overlay" ? "quiet" : mateSurface === "mate-quick" ? "card" : "page";
// the desktop console / chat window without a system title bar: this page draws it (TitleBar, the chat's header)
const chromed = (!surface || mateSurface === "mate-chat") && claimWindowChrome();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary variant={variant} chrome={chromed ? <TitleBar /> : undefined}>
    {surface === "avatar-lab" ? (
      <Suspense fallback={null}>
        <AvatarLab />
      </Suspense>
    ) : mateSurface ? (
      <Suspense fallback={mateSurface === "mate-chat" ? <BootSpinner /> : null}>
        <MateSurface kind={mateSurface} />
      </Suspense>
    ) : (
      <App />
    )}
    </ErrorBoundary>
  </React.StrictMode>,
);

/** while the chat window's code loads: the same spinner as index.html's boot screen (no black window) */
function BootSpinner() {
  return (
    <div className="grid h-full place-items-center" data-testid="surface-loading">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-accent/25 border-t-accent" />
    </div>
  );
}
