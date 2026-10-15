export const SHELL_KINDS = ["opc", "enterprise"] as const;

export type ShellKind = (typeof SHELL_KINDS)[number];

export const DEFAULT_SHELL: ShellKind = "opc";

export function resolvedShell(env: NodeJS.ProcessEnv = process.env): ShellKind {
  const value = (env.AGENTFORGE_SHELL ?? "").trim().toLowerCase();
  return SHELL_KINDS.find((kind) => kind === value) ?? DEFAULT_SHELL;
}
