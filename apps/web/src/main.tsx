import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import { App } from "./App";
import { ProductBrandProvider } from "@/lib/product-brand";
import { HostCapabilitiesProvider } from "@/lib/host-capabilities";
import { isElectron } from "@/lib/api-client";
import { applyDeskShell } from "@/lib/shell-motion";
import { applyTheme, getStoredTheme, resolveTheme } from "@/lib/theme";
import "../app/globals.css";

try {
  applyTheme(resolveTheme(getStoredTheme()));
} catch {}

// The packaged app has no GPU, so its loops stay stepped; a browser's are smooth. Written before the first
// render, so no loop ever starts under the wrong timing.
applyDeskShell(document.documentElement, isElectron());

const Router = isElectron() ? HashRouter : BrowserRouter;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router>
      <ProductBrandProvider>
        {/* Phase 8: what this deployment can do, read once from `/api/v1/ping` and shared. */}
        <HostCapabilitiesProvider>
          <App />
        </HostCapabilitiesProvider>
      </ProductBrandProvider>
    </Router>
  </StrictMode>,
);
