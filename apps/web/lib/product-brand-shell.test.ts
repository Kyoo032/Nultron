import { describe, expect, it } from "vitest";
import { brandFromUnknown, DEFAULT_PRODUCT_BRAND, mergePingBrand, parseShellLook, WEB_LOGO_SRC } from "./product-brand";
import {
  activeWorkspaceIdOf,
  railWorkspaceHref,
  WORKSPACE_TONES,
  workspaceInitial,
  workspaceTone,
} from "./rail-workspaces";

describe("parseShellLook", () => {
  it("knows the two looks and nothing else", () => {
    expect(parseShellLook("opc")).toBe("opc");
    expect(parseShellLook("enterprise")).toBe("enterprise");
    expect(parseShellLook("Enterprise")).toBeNull();
    expect(parseShellLook("")).toBeNull();
    expect(parseShellLook(undefined)).toBeNull();
    expect(parseShellLook(3)).toBeNull();
  });
});

describe("the shell look in the brand", () => {
  const web = { ...DEFAULT_PRODUCT_BRAND, logoSrc: WEB_LOGO_SRC };

  it("is not set before the host has answered", () => {
    expect(web.shell).toBeUndefined();
  });

  it("is read from the ping", () => {
    expect(mergePingBrand(web, { body: { shell: "enterprise" } }).shell).toBe("enterprise");
    expect(brandFromUnknown({ shell: "enterprise" }, web).shell).toBe("enterprise");
  });

  it("is the default look when the host answers without one", () => {
    expect(mergePingBrand(web, { body: { productName: "Acme Desk" } }).shell).toBe("opc");
  });

  it("is the default look when the host answers something it does not know", () => {
    expect(mergePingBrand(web, { body: { shell: "other" } }).shell).toBe("opc");
  });

  it("leaves the rest of the brand as it was", () => {
    const merged = mergePingBrand(web, { body: { productName: "Acme Desk", shell: "enterprise" } });
    expect(merged.productName).toBe("Acme Desk");
    expect(merged.logoSrc).toBe(WEB_LOGO_SRC);
  });
});

describe("workspace rows", () => {
  it("gives a stable tone inside the palette", () => {
    for (const id of ["a", "ws_alpha", "ws_beta", "00000000-0000-0000-0000-000000000000"]) {
      const tone = workspaceTone(id);
      expect(Number.isInteger(tone)).toBe(true);
      expect(tone).toBeGreaterThanOrEqual(0);
      expect(tone).toBeLessThan(WORKSPACE_TONES);
      expect(workspaceTone(id)).toBe(tone);
    }
  });

  it("takes the first letter of the name, whatever its script", () => {
    expect(workspaceInitial("finance")).toBe("F");
    expect(workspaceInitial("  legal ")).toBe("L");
    expect(workspaceInitial("")).toBe("?");
    expect(workspaceInitial("\u{1F4C1} Files")).toBe("\u{1F4C1}");
  });

  it("opens a Workspace on the Workspaces page", () => {
    expect(railWorkspaceHref("ws_alpha")).toBe("/projects?open=ws_alpha");
    expect(railWorkspaceHref("a b/c")).toBe("/projects?open=a%20b%2Fc");
  });

  it("is active only on the Workspaces page with that Workspace open", () => {
    expect(activeWorkspaceIdOf("/projects", new URLSearchParams("open=ws_alpha"))).toBe("ws_alpha");
    expect(activeWorkspaceIdOf("/projects", new URLSearchParams())).toBeNull();
    expect(activeWorkspaceIdOf("/chat", new URLSearchParams("open=ws_alpha"))).toBeNull();
  });
});
