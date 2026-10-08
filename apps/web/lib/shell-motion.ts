/**
 * Which shell draws the desk, written on <html> once at boot so the stylesheet can pick the right timing.
 *
 * The packaged Personal app runs Chromium without the GPU (`app.disableHardwareAcceleration()` in
 * `apps/desktop/main.cjs`), so every frame of a running CSS loop is composited in software on the CPU. Its
 * ambient loops (the shapes' bob and turn, the dot grid's drift) and its busy indicators are therefore
 * stepped, a few frames a second. A browser (webdev, the hosted Enterprise app) has the GPU and runs the
 * same loops smooth (owner, 2026-10-05).
 *
 * `app/globals.css` reads one attribute: `html[data-shell="desktop"]` hands the stepped values back. Only the
 * packaged shell sets it. The value comes from the caller, which asks `isElectron()`: this file never reads
 * `window.agentforge`, because only `lib/desktop-bridge.ts` may.
 */

export type DeskShell = "desktop" | "browser";

export const SHELL_ATTR = "data-shell";

export function deskShell(desktop: boolean): DeskShell {
  return desktop ? "desktop" : "browser";
}

/** Marks the shell on `root` and returns what it wrote. Call it before the first render. */
export function applyDeskShell(root: { setAttribute(name: string, value: string): void }, desktop: boolean): DeskShell {
  const shell = deskShell(desktop);
  root.setAttribute(SHELL_ATTR, shell);
  return shell;
}
