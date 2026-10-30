import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installClientErrorReporter } from "./api/admin";
import "./index.css";

installClientErrorReporter();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
