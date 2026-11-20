import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { AppLocale, GuideOutcome, GuideRecord, SecretPatch, StoredSecrets, TenantContext } from "@agentforge/core";
import {
  ApiError,
  LOCAL_TENANT_ID,
  resolvedGatewayBaseUrl,
  assertAllowedEndpointUrl,
  decryptJson,
  encryptJson,
  isAppLocale,
  isEnvelope,
  isGatewayBaseUrl,
  isServerMode,
  knowledgeBackendSetting,
  mergeSecrets,
  parseAppLocale,
  parseGuideRecord,
} from "@agentforge/core";
import { getLocalVaultKey } from "@agentforge/db/vault-key";
import { withCodeRunPolicy } from "./code-runner/enabled";
import { carriesStoredBypass, setInjectionGuardBypass, withInjectionGuardBypass } from "./injection-guard-bypass";
import { parseKeyLaterRecord, type KeyLaterRecord } from "./key-later";
import { readSelectedWorkspaceId } from "./workspace";
import { assertTenantId, tenantDataDir } from "./tenant-paths";
import { tenantStateBackend, type TenantStateBackend } from "./tenant-state-store";
import { log } from "./log";

export { getLocalVaultKey, localDataDir } from "@agentforge/db/vault-key";

/** Machine-wide v1 payload, claimed onto Default on first boot after upgrade. */
export const LEGACY_SETTINGS_WORKSPACE = "__legacy__";
/** Used only when no desk is selected (unit tests, first boot). */
export const FALLBACK_SETTINGS_WORKSPACE = "__default__";

/**
 * Phase 3 lane D — whose settings a call is about.
 *
 * A `TenantContext` names both the tenant and the desk. A bare string (or nothing) is the
 * pre-Phase-3 spelling and means "this desk, on the local tenant": correct on the desktop and on
 * webdev, and **refused in server mode**, where a call that cannot name its tenant must not fall
 * back to somebody else's file. `packages/host/src/handlers` is swept to the tenant form; the
 * remaining bare-string callers are listed in `docs/internal/web-phase3-lane-d.md`.
 */
export type SettingsScope = Pick<TenantContext, "tenantId" | "workspaceId"> | string | null | undefined;

export type ResolvedSettingsScope = { tenantId: string; workspaceId: string };

export function resolveSettingsScope(scope?: SettingsScope): ResolvedSettingsScope {
  if (scope && typeof scope === "object") {
    return { tenantId: assertTenantId(scope.tenantId), workspaceId: resolveSettingsWorkspaceId(scope.workspaceId) };
  }
  if (isServerMode()) {
    throw new ApiError(
      "tenant_required",
      "This request reached the settings store without a tenant. Hosted requests must pass the tenant, never a bare desk id.",
      500,
    );
  }
  return { tenantId: LOCAL_TENANT_ID, workspaceId: resolveSettingsWorkspaceId(scope) };
}

/**
 * Phase 4 — whose settings a call is about, *and which user is asking*.
 *
 * The secrets themselves are per tenant and per desk, exactly as lane D left them. The UI locale is
 * neither: it belongs to the person looking at the screen, and on a hosted server two people share
 * both a tenant and a desk. `loadUserLocale` / `saveUserLocale` take this rather than a
 * `SettingsScope` so a call that cannot name a user is a compile error and not a silent fall back
 * onto the install's locale.
 */
export type UserScope = Pick<TenantContext, "tenantId" | "workspaceId" | "userId">;

/**
 * Phase 4 — where the payload actually lives.
 *
 * `settings.enc` is a file on a desk and a `tenant_state` row on the hosted server, and the choice
 * is made by mode in `tenant-state-store.ts`, never here. Everything below this line works in
 * strings: it seals a payload, hands the bytes to the backend, and takes bytes back. There is no
 * path in this module any more.
 */
const SETTINGS_KEY = "settings" as const;

/**
 * `<dataDir>/settings.json` for the local tenant, under `tenants/<tenantId>/` for anyone else.
 *
 * The one path this module still knows, and deliberately: this is the pre-encryption v1 plaintext
 * file, which only a desktop install that upgraded through it can have. It is read once, folded
 * into the sealed payload and deleted. A hosted tenant never had one, so this never fires there.
 */
function legacyPlaintextPath(tenantId: string): string {
  return resolve(tenantDataDir(tenantId), "settings.json");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && item.trim().length > 0) {
      next[key] = item.trim();
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeSecrets(parsed: StoredSecrets): StoredSecrets {
  const disabledTools = Array.isArray(parsed.disabledTools)
    ? parsed.disabledTools
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : undefined;
  return {
    openaiApiKey: readString(parsed.openaiApiKey),
    googleApiKey: readString(parsed.googleApiKey),
    anthropicApiKey: readString(parsed.anthropicApiKey),
    volcengineApiKey: readString(parsed.volcengineApiKey),
    openaiBaseUrl: readString(parsed.openaiBaseUrl),
    googleBaseUrl: readString(parsed.googleBaseUrl),
    anthropicBaseUrl: readString(parsed.anthropicBaseUrl),
    volcengineBaseUrl: readString(parsed.volcengineBaseUrl),
    toolKeys: readStringMap(parsed.toolKeys),
    toolBackends: readStringMap(parsed.toolBackends),
    imageGenModel: readString(parsed.imageGenModel),
    videoGenModel: readString(parsed.videoGenModel),
    musicGenModel: readString(parsed.musicGenModel),
    documentGenModel: readString(parsed.documentGenModel),
    researchGenModel: readString(parsed.researchGenModel),
    presentationGenModel: readString(parsed.presentationGenModel),
    disabledTools,
    editTurnCapUsd:
      typeof parsed.editTurnCapUsd === "number" && Number.isFinite(parsed.editTurnCapUsd)
        ? Math.min(50, Math.max(0.5, parsed.editTurnCapUsd))
        : undefined,
    // An unknown id on disk (an older / newer build, a hand-edited file) reads as absent, which
    // means builtin: a desk can never be locked out of retrieval by a value nothing can serve.
    knowledgeBackend: knowledgeBackendSetting(parsed.knowledgeBackend),
    weknoraApiKey: readString(parsed.weknoraApiKey),
    weknoraTenantId: readString(parsed.weknoraTenantId),
    weknoraAesKey: readString(parsed.weknoraAesKey),
    weknoraJwtSecret: readString(parsed.weknoraJwtSecret),
    weknoraRevokedModelIds: readString(parsed.weknoraRevokedModelIds),
    telegramBotToken: readString(parsed.telegramBotToken),
    whatsappAccessToken: readString(parsed.whatsappAccessToken),
  };
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function readLegacyPlaintext(tenantId: string): StoredSecrets | null {
  try {
    const raw = readFileSync(legacyPlaintextPath(tenantId), "utf8");
    return normalizeSecrets(JSON.parse(raw) as StoredSecrets);
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    return null;
  }
}

function tryDeleteLegacyPlaintext(tenantId: string): void {
  const path = legacyPlaintextPath(tenantId);
  if (!existsSync(path)) {
    return;
  }
  try {
    unlinkSync(path);
  } catch {
    log.warn("settings_legacy_json_not_deleted", { path });
  }
}

/**
 * Per-user state inside a tenant's sealed payload: the UI locale, whether the person has been
 * through the first-run guide (`guide`, see `@agentforge/core` `guide.ts`), and, on the hosted app
 * only, whether they chose to add a gateway key later (`keyLater`, see `./key-later.ts`).
 *
 * It rides in the same envelope rather than in a table of its own because it is written by the
 * same save, read by the same read and thrown away by the same "start over" — and because a second
 * store would be a second thing to rotate, back up and keep in step. On a desk the one user is the
 * local owner, so both are machine-wide there; the guide's record is why "Start over" shows the
 * tour again on a fresh install: `settings.enc` is the first entry it removes.
 */
type UserPrefs = { locale?: AppLocale; guide?: GuideRecord; keyLater?: KeyLaterRecord };

type SettingsFileV2 = {
  version: 2;
  /**
   * The install's locale. Phase 4 made the locale per user (`users` below); this stays because it
   * is what `getBootLocale()` freezes on a desk, and because a v2 file written by an older build
   * has it and nothing else.
   */
  locale?: AppLocale;
  users?: Record<string, UserPrefs>;
  workspaces: Record<string, StoredSecrets>;
};

/**
 * Keyed by where the payload lives, not a single slot: two tenants alternating requests would
 * otherwise evict each other on every call and re-decrypt on each one. The stamp is the backend's
 * own change token (a file's mtime, a row's `updated_at`), so a payload rewritten by another
 * process is picked up rather than served from here.
 */
type PayloadCache = { stamp: string; file: SettingsFileV2 };
const payloadCache = new Map<string, PayloadCache>();

function emptySettingsFile(): SettingsFileV2 {
  return { version: 2, workspaces: {} };
}

function isSettingsFileV2(value: unknown): value is SettingsFileV2 {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as { version?: unknown; workspaces?: unknown };
  return (
    record.version === 2 &&
    record.workspaces !== null &&
    typeof record.workspaces === "object" &&
    !Array.isArray(record.workspaces)
  );
}

function secretsMap(workspaces: Record<string, unknown>): Record<string, StoredSecrets> {
  const next: Record<string, StoredSecrets> = {};
  for (const [id, value] of Object.entries(workspaces)) {
    if (value && typeof value === "object") {
      next[id] = normalizeSecrets(value as StoredSecrets);
    }
  }
  return next;
}

function readLocaleField(value: unknown): AppLocale | undefined {
  return isAppLocale(value) ? value : undefined;
}

/**
 * The `users` map, kept to what it claims to be. An unknown key or a locale nothing can serve is
 * dropped rather than carried: the fallback is the install's locale, which always resolves.
 */
function usersMap(value: unknown): Record<string, UserPrefs> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const next: Record<string, UserPrefs> = {};
  for (const [userId, prefs] of Object.entries(value as Record<string, unknown>)) {
    if (!userId.trim() || !prefs || typeof prefs !== "object") {
      continue;
    }
    const locale = readLocaleField((prefs as UserPrefs).locale);
    const guide = parseGuideRecord((prefs as UserPrefs).guide);
    const keyLater = parseKeyLaterRecord((prefs as UserPrefs).keyLater);
    if (locale || guide || keyLater) {
      next[userId] = {
        ...(locale ? { locale } : {}),
        ...(guide ? { guide } : {}),
        ...(keyLater ? { keyLater } : {}),
      };
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

type ParsedSettingsFile = { file: SettingsFileV2; migrated: boolean; droppedBypass: boolean };

function parseSettingsFile(decrypted: unknown): ParsedSettingsFile {
  if (isSettingsFileV2(decrypted)) {
    const source = decrypted as SettingsFileV2;
    const users = usersMap(source.users);
    return {
      file: {
        version: 2,
        locale: readLocaleField(source.locale),
        ...(users ? { users } : {}),
        workspaces: secretsMap(decrypted.workspaces as Record<string, unknown>),
      },
      migrated: false,
      droppedBypass: carriesStoredBypass(decrypted.workspaces),
    };
  }
  if (decrypted && typeof decrypted === "object") {
    return {
      file: { version: 2, workspaces: { [LEGACY_SETTINGS_WORKSPACE]: normalizeSecrets(decrypted as StoredSecrets) } },
      migrated: true,
      droppedBypass: false,
    };
  }
  return { file: emptySettingsFile(), migrated: false, droppedBypass: false };
}

function persistEncrypted(tenantId: string, file: SettingsFileV2): void {
  // The wrap key stays machine-wide (`vault-key.ts`) and the envelope is unchanged: Phase 3 split
  // the payload per tenant, Phase 4 moved it behind `tenant-state-store.ts`. What the backend
  // stores is exactly the bytes a desk's `settings.enc` holds, which is what lets
  // `wrap-key-rotation.ts` re-seal a row and a file with the same code.
  const backend = tenantStateBackend();
  const envelope = encryptJson(file, getLocalVaultKey());
  backend.write(tenantId, SETTINGS_KEY, `${JSON.stringify(envelope)}\n`);
  payloadCache.delete(backend.describe(tenantId, SETTINGS_KEY));
}

export function resolveSettingsWorkspaceId(workspaceId?: string | null): string {
  const explicit = workspaceId?.trim();
  if (explicit) {
    return explicit;
  }
  return readSelectedWorkspaceId() ?? FALLBACK_SETTINGS_WORKSPACE;
}

function sliceFor(file: SettingsFileV2, workspaceId: string): StoredSecrets {
  const own = file.workspaces[workspaceId];
  if (own) {
    return own;
  }
  if (workspaceId === FALLBACK_SETTINGS_WORKSPACE && file.workspaces[LEGACY_SETTINGS_WORKSPACE]) {
    return file.workspaces[LEGACY_SETTINGS_WORKSPACE]!;
  }
  return {};
}

function assertSavedEndpoints(secrets: StoredSecrets): void {
  for (const url of [
    secrets.openaiBaseUrl,
    secrets.googleBaseUrl,
    secrets.anthropicBaseUrl,
    secrets.volcengineBaseUrl,
  ]) {
    if (url) {
      assertAllowedEndpointUrl(url);
    }
  }
}

/**
 * A stored payload that is not a sealed envelope at all — truncated, hand-edited, half-written.
 * There is nothing in it to lose, so it is moved aside and the tenant starts empty, which is what
 * this module has always done.
 *
 * Only ever reached on the file backend: a `tenant_state` row is written in one statement and
 * cannot be half a value, and there is nowhere to move a row aside to.
 */
function quarantineUnreadableSettings(tenantId: string, backend: TenantStateBackend, reason: unknown): void {
  if (backend.kind !== "file") {
    return;
  }
  const file = backend.describe(tenantId, SETTINGS_KEY);
  if (!existsSync(file)) {
    return;
  }
  const aside = `${file}.unreadable`;
  try {
    renameSync(file, aside);
    log.warn("settings_enc_moved_aside", {
      path: aside,
      detail: reason instanceof Error ? reason.message : reason,
    });
  } catch (moveError) {
    log.warn("settings_enc_not_moved_aside", {
      detail: reason instanceof Error ? reason.message : reason,
      moveDetail: moveError instanceof Error ? moveError.message : moveError,
    });
  }
}

/**
 * What a sealed payload that will not open means. Phase 4 splits this from the case above, because
 * the two have opposite right answers and until now they shared one.
 *
 * A decrypt failure says the wrap key is wrong, not that the payload is rubbish: the bytes are
 * every key that tenant ever saved, and they come back the moment the right `AGENTFORGE_SECRETS_KEY`
 * is supplied. Moving them aside on a hosted server would mean one bad environment variable
 * quarantining every tenant's vault on the next boot, in a sweep, with no one watching — which is
 * also exactly what a mis-keyed run of the rotation drill would look like. So in server mode this
 * refuses and leaves the payload where it is.
 *
 * On a desk it still quarantines, and that is deliberate rather than an oversight: the behaviour is
 * unchanged from before this phase, there is one owner who can restore a backup, and the app has to
 * be able to start so that "Start over" is reachable at all. `vault-key.ts` already refuses to
 * re-mint a bad `.master-key` for the same reason this refuses on the server — the difference is
 * only who is watching, and how many vaults one mistake reaches.
 */
function onUndecryptableSettings(tenantId: string, backend: TenantStateBackend, reason: unknown): null {
  if (isServerMode()) {
    log.error("settings_payload_undecryptable", { tenantId, backend: backend.kind });
    throw new ApiError(
      "settings_unreadable",
      "This tenant's saved settings could not be decrypted with the current wrap key. They have not been " +
        "changed. Check AGENTFORGE_SECRETS_KEY against the value the settings were sealed with.",
      500,
    );
  }
  quarantineUnreadableSettings(tenantId, backend, reason);
  return null;
}

/** The decrypted payload, or null when there is nothing usable to read. */
function decodeStoredPayload(tenantId: string, backend: TenantStateBackend, raw: string): unknown | null {
  const key = getLocalVaultKey();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    quarantineUnreadableSettings(tenantId, backend, error);
    return null;
  }
  if (!isEnvelope(parsed)) {
    quarantineUnreadableSettings(tenantId, backend, new Error("settings payload is not a valid envelope"));
    return null;
  }
  try {
    return decryptJson<unknown>(parsed, key);
  } catch (error) {
    return onUndecryptableSettings(tenantId, backend, error);
  }
}

function normalizeEndpoint(url: string | undefined): string | undefined {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : undefined;
}

/** Logged at most once per process: a repeat on every settings read would be noise, not signal. */
let warnedStoredGatewayEndpoint = false;

/**
 * The gateway endpoint is pinned (`core/gateway/pinned.ts`) and Settings no longer accepts the field. A
 * value left behind by an older build - or written into `settings.enc` by hand - is discarded here, on
 * both the load and the save path, so no caller can be handed a host that would receive the gateway key.
 * The warning names no URL: it would be echoing back an attacker-controlled field.
 */
function withGatewayDefault(secrets: StoredSecrets): StoredSecrets {
  const stored = normalizeEndpoint(secrets.openaiBaseUrl);
  if (stored && !isGatewayBaseUrl(stored) && !warnedStoredGatewayEndpoint) {
    warnedStoredGatewayEndpoint = true;
    log.warn("settings_stored_gateway_endpoint_ignored");
  }
  return { ...secrets, openaiBaseUrl: resolvedGatewayBaseUrl() };
}

function clearStoredBypass(tenantId: string, file: SettingsFileV2): boolean {
  try {
    persistEncrypted(tenantId, file);
  } catch (error) {
    log.warn("settings_injection_guard_bypass_not_cleared", {
      tenantId,
      detail: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  log.warn("settings_injection_guard_bypass_dropped", { tenantId });
  return true;
}

function loadSettingsFile(tenantId: string): SettingsFileV2 {
  const backend = tenantStateBackend();
  const slot = backend.describe(tenantId, SETTINGS_KEY);
  const stored = backend.read(tenantId, SETTINGS_KEY);

  if (stored) {
    const cached = payloadCache.get(slot);
    if (cached && cached.stamp === stored.stamp) {
      return cached.file;
    }
    const payload = decodeStoredPayload(tenantId, backend, stored.value);
    if (payload != null) {
      const parsed = parseSettingsFile(payload);
      if (parsed.migrated) {
        // A v1 machine-wide payload found inside the envelope. Rewriting it as v2 changes the
        // stamp, so the cache is populated by the next read rather than from a token that is
        // already stale.
        persistEncrypted(tenantId, parsed.file);
        return parsed.file;
      }
      if (parsed.droppedBypass && clearStoredBypass(tenantId, parsed.file)) {
        return parsed.file;
      }
      payloadCache.set(slot, { stamp: stored.stamp, file: parsed.file });
      return parsed.file;
    }
  }

  payloadCache.delete(slot);
  const legacy = readLegacyPlaintext(tenantId);
  if (!legacy) {
    return emptySettingsFile();
  }
  const migrated: SettingsFileV2 = {
    version: 2,
    workspaces: { [LEGACY_SETTINGS_WORKSPACE]: legacy },
  };
  persistEncrypted(tenantId, migrated);
  tryDeleteLegacyPlaintext(tenantId);
  return migrated;
}

/**
 * The settings a run reads, and the one place a run's disabled-tools list is resolved: every Chat turn, job and
 * Edit agent turn loads them here and hands them to `createRuntime`, whose `buildToolSecretScope` turns
 * `disabledTools` into the set the model is never offered. `run_code` joins it while `AGENTFORGE_CODE_RUNS` is
 * off (`code-runner/enabled.ts`). Applied on read only: `saveSettings` merges into the stored slice, so the
 * file never records a tool the operator's switch turned off.
 */
export function loadSettings(scope?: SettingsScope): StoredSecrets {
  const { tenantId, workspaceId } = resolveSettingsScope(scope);
  return withInjectionGuardBypass(
    withCodeRunPolicy(withGatewayDefault(sliceFor(loadSettingsFile(tenantId), workspaceId))),
    tenantId,
    workspaceId,
  );
}

export function saveSettings(patch: SecretPatch, scope?: SettingsScope): StoredSecrets {
  const { tenantId, workspaceId } = resolveSettingsScope(scope);
  const file = loadSettingsFile(tenantId);
  const next = withGatewayDefault(mergeSecrets(sliceFor(file, workspaceId), patch));
  assertSavedEndpoints(next);
  persistEncrypted(tenantId, {
    ...file,
    version: 2,
    workspaces: { ...file.workspaces, [workspaceId]: next },
  });
  tryDeleteLegacyPlaintext(tenantId);
  if (typeof patch.injectionGuardBypass === "boolean") {
    setInjectionGuardBypass(tenantId, workspaceId, patch.injectionGuardBypass);
  }
  return withInjectionGuardBypass(next, tenantId, workspaceId);
}

/** The provider key fields a hosted save carries to a company's other desks (SR-163). Nothing else travels. */
export type CompanyKeyPatch = Pick<
  SecretPatch,
  "openaiApiKey" | "googleApiKey" | "anthropicApiKey" | "volcengineApiKey"
>;

/**
 * Hosted only (SR-163, review round). On the server a provider key belongs to the company, not to the
 * desk it was typed on, and the gateway verdict is the company's too. `saveSettings` writes one desk's
 * slice, so a key rotated on one desk left the company's other desks on the old key: their fingerprint no
 * longer matched the company's verdict, they answered `403 gateway_blocked`, and a re-check from one of
 * them could replace the verdict and close the first. This writes the same key fields to the named desks
 * in one write, the mirror of `clearGatewayKeyEverywhere(.., { workspaceIds })` for "forget my key".
 *
 * The caller names the desks (its own organisation's, never the partner's, so no other company is
 * touched), and a field the patch leaves undefined is left alone, so only what was typed travels. A desk
 * keeps no key of its own on the server, which is why this is not offered on a desk: there the owner's
 * desks are separate on purpose and `saveSettings` stays desk-scoped.
 */
export function saveKeysToDesks(
  keys: CompanyKeyPatch,
  scope: SettingsScope,
  workspaceIds: readonly string[],
): string[] {
  const { tenantId } = resolveSettingsScope(scope);
  const patch: CompanyKeyPatch = {
    openaiApiKey: keys.openaiApiKey,
    googleApiKey: keys.googleApiKey,
    anthropicApiKey: keys.anthropicApiKey,
    volcengineApiKey: keys.volcengineApiKey,
  };
  if (Object.values(patch).every((value) => value === undefined) || workspaceIds.length === 0) {
    return [];
  }
  const file = loadSettingsFile(tenantId);
  const workspaces: Record<string, StoredSecrets> = { ...file.workspaces };
  const touched: string[] = [];
  for (const id of new Set(workspaceIds)) {
    const next = withGatewayDefault(mergeSecrets(sliceFor(file, id), patch));
    assertSavedEndpoints(next);
    workspaces[id] = next;
    touched.push(id);
  }
  persistEncrypted(tenantId, { ...file, version: 2, workspaces });
  return touched;
}

/**
 * Move a pre-isolation machine-wide key onto Default. Other desks stay empty until the owner pastes a key there.
 */
export function adoptLegacySettings(homeWorkspaceId: string): void {
  const id = homeWorkspaceId.trim();
  if (!id) {
    return;
  }
  // Desktop upgrade path only. `LEGACY_SETTINGS_WORKSPACE` is a v1 machine-wide payload, which only
  // a pre-v2 desktop install has; a hosted tenant's payload starts at v2 and never carries one.
  // Called from `getTenant` on every request, so in server mode it must be a no-op rather than a throw.
  if (isServerMode()) {
    return;
  }
  const file = loadSettingsFile(LOCAL_TENANT_ID);
  const legacy = file.workspaces[LEGACY_SETTINGS_WORKSPACE];
  if (!legacy) {
    return;
  }
  const rest = { ...file.workspaces };
  delete rest[LEGACY_SETTINGS_WORKSPACE];
  if (!rest[id]) {
    rest[id] = legacy;
  }
  persistEncrypted(LOCAL_TENANT_ID, { ...file, version: 2, workspaces: rest });
}

/** The desks a hosted "forget my key" may touch: the caller's company's own. Never passed on a desk. */
export type ClearKeyWithin = { readonly workspaceIds: readonly string[] };

/**
 * "Start over — key only": drop the gateway key from every desk **of one tenant** in one write.
 *
 * A key saved on a second desk would otherwise keep the app open after the owner asked to forget
 * it, so this covers every desk — but only the caller's tenant, which is what makes it safe to
 * reach in server mode at all. Returns the desks that actually held a key.
 *
 * On the hosted server pass `within` (SR-163): the tenant is the partner, and a company is one
 * organisation inside it, so the desks to clear are the caller's organisation's. The one caller that
 * leaves it out there is the hosted erase, which is partner-wide by its own design (`tenant-reset.ts`).
 */
export function clearGatewayKeyEverywhere(scope?: SettingsScope, within?: ClearKeyWithin): string[] {
  const { tenantId } = resolveSettingsScope(scope);
  const file = loadSettingsFile(tenantId);
  // SR-163. A hosted tenant is the white-label partner, and every company of the deployment keeps its
  // desks in the same payload. "Every desk of the tenant" is right on a desk, where it is one person's
  // machine, and wrong on the server, where it would sign every other company out of the gateway. The
  // hosted caller names the desks that are its company's; any slice outside them is left byte for byte.
  const only = within ? new Set(within.workspaceIds) : null;
  const touched: string[] = [];
  const workspaces: Record<string, StoredSecrets> = {};
  for (const [id, slice] of Object.entries(file.workspaces)) {
    if (only && !only.has(id)) {
      workspaces[id] = slice;
      continue;
    }
    if (slice.openaiApiKey) {
      touched.push(id);
    }
    workspaces[id] = mergeSecrets(slice, { openaiApiKey: "" });
  }
  if (touched.length === 0) {
    return [];
  }
  persistEncrypted(tenantId, { ...file, version: 2, workspaces });
  return touched;
}

export function dropWorkspaceSettings(workspaceId: string, scope?: SettingsScope): void {
  const id = workspaceId.trim();
  if (!id) {
    return;
  }
  const { tenantId } = resolveSettingsScope(scope ?? workspaceId);
  setInjectionGuardBypass(tenantId, id, false);
  const file = loadSettingsFile(tenantId);
  if (!file.workspaces[id]) {
    return;
  }
  const rest = { ...file.workspaces };
  delete rest[id];
  persistEncrypted(tenantId, { ...file, version: 2, workspaces: rest });
}

/**
 * The install's UI locale, and the one `getBootLocale()` freezes for this process.
 *
 * Still the local tenant's value and still machine-wide, because that is what it is for: the host
 * freezes one boot locale that every copy catalogue reads, and on a desk there is one owner whose
 * choice that is. Phase 4 did not make this per tenant; it made the *user's* locale a separate
 * thing (`loadUserLocale`), which is what a hosted server needs — two people on one tenant and one
 * desk, each reading their own language.
 */
export function loadOwnerLocale(): AppLocale {
  return parseAppLocale(loadSettingsFile(LOCAL_TENANT_ID).locale);
}

export function saveOwnerLocale(locale: AppLocale): AppLocale {
  const file = loadSettingsFile(LOCAL_TENANT_ID);
  persistEncrypted(LOCAL_TENANT_ID, { ...file, version: 2, locale });
  return locale;
}

/**
 * Phase 4 — the locale of the person asking.
 *
 * Falls back to the tenant's own stored locale, then to the parser's default, and never to another
 * tenant's payload: a user with no saved choice gets English, not whatever the operator picked for
 * the install. On a desk the fall-through lands on exactly the value `loadOwnerLocale` returns, so
 * a desktop owner who set Indonesian before this phase still sees Indonesian without re-choosing.
 */
export function loadUserLocale(scope: UserScope): AppLocale {
  const { tenantId } = resolveSettingsScope(scope);
  const file = loadSettingsFile(tenantId);
  const userId = scope.userId?.trim();
  const own = userId ? file.users?.[userId]?.locale : undefined;
  return parseAppLocale(own ?? file.locale);
}

/**
 * The language this person chose themselves, or `null` when they never did.
 *
 * What `loadUserLocale` is not: that one answers a language for everyone, falling through to the
 * tenant's own stored locale and then to English, so it cannot tell "chose English" from "never
 * chose". This one reads only `users[userId].locale`, so a caller can offer a default (the browser's
 * `Accept-Language`, on the hosted server) to a person who has made no choice, and never over one who
 * has. A missing user id reads no one's choice.
 */
export function loadUserLocaleChoice(scope: UserScope): AppLocale | null {
  const { tenantId } = resolveSettingsScope(scope);
  const userId = scope.userId?.trim();
  const own = userId ? loadSettingsFile(tenantId).users?.[userId]?.locale : undefined;
  return isAppLocale(own) ? own : null;
}

/**
 * Save one person's locale.
 *
 * On a desk this also writes the install's locale, because `getBootLocale()` reads that and the
 * desktop's single owner choosing a language must still change the app they are looking at. In
 * server mode it does not: the install's locale is shared, and one tenant's user must not be able
 * to set the language every other tenant's process boots in.
 */
export function saveUserLocale(scope: UserScope, locale: AppLocale): AppLocale {
  const { tenantId } = resolveSettingsScope(scope);
  const userId = scope.userId?.trim();
  const file = loadSettingsFile(tenantId);
  const users = { ...(file.users ?? {}) };
  if (userId) {
    users[userId] = { ...users[userId], locale };
  }
  persistEncrypted(tenantId, {
    ...file,
    version: 2,
    ...(isServerMode() ? {} : { locale }),
    users,
  });
  return locale;
}

/**
 * Has this person been through the first-run guide, and how did it end?
 *
 * `null` is "never": a missing entry, an unreadable one, or a user this payload has never heard of.
 * Nothing falls through to another user's record, because "was I shown the tour" is the one fact
 * that must not be inherited.
 */
export function loadUserGuide(scope: UserScope): GuideRecord | null {
  const { tenantId } = resolveSettingsScope(scope);
  const userId = scope.userId?.trim();
  if (!userId) {
    return null;
  }
  return loadSettingsFile(tenantId).users?.[userId]?.guide ?? null;
}

/**
 * Record how the guide ended. Written on finish, on Skip and on close, and never removed by anything
 * but "Start over" (`settings.enc` is the first entry the fresh-install wipe deletes). Replaying the
 * guide from Settings does not clear it: a replay is a choice, not a first run.
 */
export function saveUserGuide(scope: UserScope, outcome: GuideOutcome, now: number = Date.now()): GuideRecord {
  const { tenantId } = resolveSettingsScope(scope);
  const userId = scope.userId?.trim();
  if (!userId) {
    throw new ApiError("invalid_request", "The guide's outcome needs a signed-in user.", 400);
  }
  const record: GuideRecord = { outcome, at: now };
  const file = loadSettingsFile(tenantId);
  const users = { ...(file.users ?? {}), [userId]: { ...(file.users?.[userId] ?? {}), guide: record } };
  persistEncrypted(tenantId, { ...file, version: 2, users });
  return record;
}

/**
 * Did this person choose to add a gateway key later? `null` is "no": a missing entry, an unreadable
 * one, or a user this payload has never heard of. Never inherited from another user, for the same
 * reason the guide's record is not.
 */
export function loadUserKeyLater(scope: UserScope): KeyLaterRecord | null {
  const { tenantId } = resolveSettingsScope(scope);
  const userId = scope.userId?.trim();
  if (!userId) {
    return null;
  }
  return loadSettingsFile(tenantId).users?.[userId]?.keyLater ?? null;
}

/**
 * Record the choice. A preference about what the screen shows and nothing more: the gate and every
 * gateway-calling route read only the key and the gateway's verdict on it, never this. Removed by
 * "Start over" (`settings.enc` is the first entry the wipe deletes) and by the hosted tenant erase,
 * which takes the whole `tenant_state` row; saving a key does not clear it, since a key that later
 * stops working must not bring the welcome screen back.
 */
export function saveUserKeyLater(scope: UserScope, now: number = Date.now()): KeyLaterRecord {
  const { tenantId } = resolveSettingsScope(scope);
  const userId = scope.userId?.trim();
  if (!userId) {
    throw new ApiError("invalid_request", "Adding the key later needs a signed-in user.", 400);
  }
  const record: KeyLaterRecord = { at: now };
  const file = loadSettingsFile(tenantId);
  const users = { ...(file.users ?? {}), [userId]: { ...(file.users?.[userId] ?? {}), keyLater: record } };
  persistEncrypted(tenantId, { ...file, version: 2, users });
  return record;
}

/** Test seam: forget every decrypted payload so a suite can rewrite the store underneath. */
export function resetSettingsCacheForTests(): void {
  payloadCache.clear();
}
