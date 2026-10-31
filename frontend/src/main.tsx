import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installClientErrorReporter } from "./api/admin";
import { installNativeBridge } from "./native";
import "./index.css";

installClientErrorReporter();
installNativeBridge();

// Full-page surfaces without the console: /?surface=avatar-lab (avatar renderer lab, lazy chunk).
const surface = new URLSearchParams(window.location.search).get("surface");
const AvatarLab = lazy(() => import("./mate/AvatarLab"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {surface === "avatar-lab" ? (
      <Suspense fallback={null}>
        <AvatarLab />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
