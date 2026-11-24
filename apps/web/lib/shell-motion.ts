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
