import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme, readPrefs } from "./prefs";
import "./styles.css";

// Before the first paint, so a forced light/dark theme doesn't flash (D-106).
applyTheme(readPrefs().theme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
