import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./app.css";

const root = document.querySelector<HTMLDivElement>("#root");

if (root === null) {
  throw new Error("Missing application root");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
