import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installClientErrorReporter } from "./api/admin";
import { disableLoginRedirect } from "./api/client";
import { installNativeBridge } from "./native";
import { watchKeyboard } from "./lib/keyboard";
import "./index.css";

installClientErrorReporter();
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {surface === "avatar-lab" ? (
      <Suspense fallback={null}>
        <AvatarLab />
      </Suspense>
    ) : mateSurface ? (
      <Suspense fallback={null}>
        <MateSurface kind={mateSurface} />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
