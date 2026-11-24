import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { ProductBrandProvider } from "@/lib/product-brand";
import { HostCapabilitiesProvider } from "@/lib/host-capabilities";
import { applyDeskShell } from "@/lib/shell-motion";
import { applyTheme, getStoredTheme, resolveTheme } from "@/lib/theme";
import "../app/globals.css";

try {
  applyTheme(resolveTheme(getStoredTheme()));
} catch {}

applyDeskShell(document.documentElement, false);

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <ProductBrandProvider>
        <HostCapabilitiesProvider>
          <App />
        </HostCapabilitiesProvider>
      </ProductBrandProvider>
    </BrowserRouter>
  </StrictMode>,
);
