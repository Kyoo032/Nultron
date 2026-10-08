export type IpcHostRequest = {
  requestId: string;
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
  files?: Array<{ field: string; filename: string; mime: string; bytes: number[] }>;
};

export type IpcHostResponse =
  | { type: "json"; status: number; body: unknown }
  | { type: "bytes"; status: number; bytes: number[]; contentType: string; filename?: string }
  | { type: "stream"; status: number; requestId: string };

export type DesktopBrandHint = {
  productName?: string;
  gatewayName?: string;
  gatewayBaseUrl?: string;
};

/**
 * Loose snapshot from the Electron main process. `status` stays a plain string here so this module has no
 * dependency on the renderer copy module; use `normalizeUpdateSnapshot` from `./app-updates-copy` to narrow it.
 */
export type DesktopUpdateSnapshot = {
  supported: boolean;
  status?: string;
  currentVersion?: string;
  version?: string;
  percent?: number;
  message?: string;
};

/** Shell restart request. `reset` asks the packaged app to wipe local data on the next boot. */
export type DesktopRelaunchOptions = {
  reset?: boolean;
};

/**
 * What the shell answered. `ok: false` means the restart did **not** happen — the shell refuses
 * while an update installs (`installing-update`), while a quit is already in flight
 * (`already-exiting`), from any frame that is not the main renderer (`forbidden`), and there is no
 * shell at all on webdev (`unavailable`).
 */
export type DesktopRelaunchResult = {
  ok: boolean;
  reason?: string;
};

/**
 * What the shell's save dialog answered (`host:save-bytes` in apps/desktop/main.cjs): `ok: true`, or
 * `ok: false` with `forbidden`, `bad-filename`, `too-large`, `canceled` (the person closed the dialog)
 * or `write-failed` (the disk refused the file).
 */
export type DesktopSaveResult = {
  ok: boolean;
  reason?: string;
};

/**
 * What the shell's folder dialog answered: the folder the owner chose, or nothing chosen (dialog
 * closed, or the shell refused the caller). The path is the owner's pick and still unchecked; the
 * host validates it.
 */
export type DesktopFolderPick = { path: string } | { canceled: true };

export type DesktopUpdatesApi = {
  supported: boolean;
  state: () => Promise<DesktopUpdateSnapshot>;
  check: () => Promise<DesktopUpdateSnapshot>;
  download: () => Promise<DesktopUpdateSnapshot>;
  install: () => Promise<void>;
  onStatus?: (callback: (state: DesktopUpdateSnapshot) => void) => () => void;
};

type DesktopBridge = {
  isElectron: true;
  brand?: DesktopBrandHint;
  brandLogo?: string;
  invoke: (payload: IpcHostRequest) => Promise<IpcHostResponse>;
  stream: (requestId: string, onChunk: (chunk: string) => void) => Promise<void>;
  abortStream?: (requestId: string) => void;
  /** Answers a `DesktopSaveResult`; typed `unknown` because an older shell answered nothing at all. */
  saveBytes?: (filename: string, bytes: number[]) => Promise<unknown>;
  pickMedia?: () => Promise<string[]>;
  pickFolder?: () => Promise<unknown>;
  updates?: DesktopUpdatesApi;
  relaunch?: (options?: DesktopRelaunchOptions) => unknown;
};

declare global {
  interface Window {
    agentforge?: DesktopBridge;
  }
}

function desktopBridge(): DesktopBridge | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.agentforge;
}

/** True only in the packaged Electron renderer (preload attached). */
export function isElectron(): boolean {
  return Boolean(desktopBridge()?.isElectron);
}

export function getDesktopBrand(): DesktopBrandHint | undefined {
  return desktopBridge()?.brand;
}

export function getDesktopBrandLogo(): string | undefined {
  const logo = desktopBridge()?.brandLogo;
  return typeof logo === "string" && logo.startsWith("data:image/") ? logo : undefined;
}

export function getDesktopUpdates(): DesktopUpdatesApi | undefined {
  return desktopBridge()?.updates;
}

export async function invokeDesktop(payload: IpcHostRequest): Promise<IpcHostResponse> {
  const bridge = desktopBridge();
  if (!bridge) {
    throw new Error("Nultron desktop bridge is not available");
  }
  return bridge.invoke(payload);
}

export function streamDesktop(requestId: string, onChunk: (chunk: string) => void): Promise<void> {
  const bridge = desktopBridge();
  if (!bridge) {
    return Promise.reject(new Error("Nultron desktop bridge is not available"));
  }
  return bridge.stream(requestId, onChunk);
}

export function abortDesktopStream(requestId: string): void {
  desktopBridge()?.abortStream?.(requestId);
}

/**
 * Write bytes through the shell's native save dialog and hand back what it answered, so the caller can
 * tell a save from a closed dialog from a disk that refused. `undefined` means there was no answer to
 * read: no shell, or an older one whose save answered nothing. That is not a failure the renderer can
 * name, so callers treat it as a save that happened (see `throwIfSaveFailed`).
 */
export async function saveDesktopBytes(filename: string, bytes: number[]): Promise<DesktopSaveResult | undefined> {
  const save = desktopBridge()?.saveBytes;
  if (!save) {
    return undefined;
  }
  return readSaveAnswer(await save(filename, bytes));
}

function readSaveAnswer(answer: unknown): DesktopSaveResult | undefined {
  if (!answer || typeof answer !== "object") {
    return undefined;
  }
  const { ok, reason } = answer as { ok?: unknown; reason?: unknown };
  if (typeof ok !== "boolean") {
    return undefined;
  }
  return typeof reason === "string" && reason ? { ok, reason } : { ok };
}

export async function pickMedia(): Promise<string[]> {
  const pick = desktopBridge()?.pickMedia;
  if (!pick) {
    return [];
  }
  return pick();
}

/**
 * Ask the shell to open its folder dialog. `null` means there is no folder picker at all (webdev,
 * the hosted app, or an older shell whose preload lacks it), so the caller hides the control instead
 * of showing one that does nothing. An answer that is not a non-empty path reads as "nothing chosen".
 */
/** Whether this shell can open the folder picker, asked without opening it. */
export function hasDesktopFolderPicker(): boolean {
  const bridge = desktopBridge();
  return Boolean(bridge?.isElectron && typeof bridge.pickFolder === "function");
}

export async function pickDesktopFolder(): Promise<DesktopFolderPick | null> {
  const bridge = desktopBridge();
  if (!bridge?.isElectron || typeof bridge.pickFolder !== "function") {
    return null;
  }
  const answer = await bridge.pickFolder();
  const folder = (answer as { path?: unknown } | null | undefined)?.path;
  if (typeof folder === "string" && folder.trim()) {
    return { path: folder };
  }
  return { canceled: true };
}

/**
 * Packaged relaunch if preload already exposes it. Does not invent Electron chrome.
 *
 * `{ reset: true }` asks the shell to wipe local data on the next boot.
 *
 * The shell can refuse (see `DesktopRelaunchResult`), and a refusal must never read as a restart in
 * flight: the user would sit waiting for a window that is not coming back. On webdev there is no
 * bridge at all, which is `{ ok: false, reason: "unavailable" }` — the caller tells the operator to
 * restart by hand. A non-object answer is success: on the happy path the process exits before the
 * IPC reply is ever sent, so the promise resolves with whatever Electron had (or never at all).
 */
export async function relaunchDesktopApp(options?: DesktopRelaunchOptions): Promise<DesktopRelaunchResult> {
  const relaunch = desktopBridge()?.relaunch;
  if (typeof relaunch !== "function") {
    return { ok: false, reason: "unavailable" };
  }
  const answer = await relaunch(options);
  if (!answer || typeof answer !== "object") {
    return { ok: true };
  }
  const result = answer as { ok?: unknown; reason?: unknown };
  if (result.ok === false) {
    return { ok: false, reason: typeof result.reason === "string" && result.reason.trim() ? result.reason : "refused" };
  }
  return { ok: true };
}
