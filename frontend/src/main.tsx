import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ThemeProvider } from "./context/ThemeContext";
import { SettingsProvider } from "./context/SettingsContext";
import { NetworkProvider } from "./context/NetworkContext";
import { TransactionProvider } from "./context/TransactionContext";
import { registerServiceWorker } from "./lib/registerServiceWorker";
import "./modern-styles.css";
import "./index.css";

// #522 — register the offline-mode service worker. The helper resolves
// to null in environments without the SW API, so this is a no-op for
// jsdom tests and older browsers. `import.meta.env.PROD` is Vite's
// build-time replacement for production detection (no `process` global
// in browser-targeted builds).
if (typeof window !== "undefined" && import.meta.env.PROD) {
  void registerServiceWorker();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <NetworkProvider>
          <SettingsProvider>
            <TransactionProvider>
              <App />
            </TransactionProvider>
          </SettingsProvider>
        </NetworkProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
