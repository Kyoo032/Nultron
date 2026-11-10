import {
  ApiError,
  canAdminister,
  type GatewayGatePayload,
  guidePayload,
  hasLiveProvider,
  HOME_WORKSPACE_NAME,
  isAppLocale,
  isServerMode,
  listToolCapabilities,
  listToolRoutes,
  maskSecrets,
  redactSecrets,
  resolvedGatewayName,
  type TenantContext,
  resolvedProductName,
  resolveRuntimeMode,
  RESET_CONFIRM_WORD,
  type SecretPatch,
} from "@agentforge/core";
import type { HostRequest, HostResult } from "../types";
import { jsonError, jsonOk } from "../errors";
import { getTenant } from "../tenant";
import {
  clearGatewayKeyEverywhere,
  loadSettings,
  loadUserGuide,
  loadUserKeyLater,
  localDataDir,
  saveKeysToDesks,
  saveUserLocale,
  saveSettings,
} from "../settings-store";
import {
  clearGateState,
  GATEWAY_VERDICT_UNWRITABLE_MESSAGE,
  maybeRefreshGateway,
  reportGatewayGate,
  runGatewayCheck,
} from "../gateway-gate";
import { killTrackedChildren } from "../child-processes";
import { keyLaterPayload } from "../key-later";
import { voiceSettingsFor } from "../voice/flag";
import { applySavedLocaleAsBoot, localePayload } from "../locale-boot";
import { refreshModelCache, modeDefaultsFor } from "../selectable-models";
import { clearThisKeyCache, loadAccountUsage } from "../account-usage";
import { probeSummary } from "../model-cache";
import { db, hasPendingDataReset, listLocalWorkspaces, pendingResetPath, requestDataReset } from "@agentforge/db";
import { rmSync } from "node:fs";
import { resetEmbedCircuit } from "../knowledge-embed";
import { resetModelReliabilityState } from "../job-model-fallback";
import { revokeKnowledgeGatewayModel } from "../knowledge/backend-api";
// Phase 8: the hosted "Start over". Everything policy-shaped is checked in there, not here.
import { resetTenant } from "../tenant-reset";

function readStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") {
      next[key] = item;
    }
  }
  return next;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string");
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function settingsPayload(
  settings: ReturnType<typeof loadSettings>,
  tenant: Awaited<ReturnType<typeof getTenant>>,
  serverMode: boolean = isServerMode(),
  acceptLanguage?: string,
) {
  const rows = await listLocalWorkspaces(db, tenant.organizationId);
  const current = rows.find((row) => row.id === tenant.workspaceId);
  return {
    ...maskSecrets(settings),
    // Hosted only: a person who never chose a language is shown the one their browser asks for, so the
    // app and a model run agree (`./locale-boot.ts`). On a desk the header is never read.
    ...localePayload(tenant, { serverMode, ...(acceptLanguage === undefined ? {} : { acceptLanguage }) }),
    // Whether this person has been through the first-run guide, so the renderer never re-offers it.
    // Stored beside the locale and erased by the same "Start over" (`settings-store.ts`).
    guide: guidePayload(loadUserGuide(tenant)),
    // Enterprise only: whether this person chose to add the gateway key later. A preference about the
    // screen; the gate below is the host's decision and never reads it. Absent off server mode, so
    // the Personal app's answer is the one it always was.
    ...(serverMode ? { keyLater: keyLaterPayload(loadUserKeyLater(tenant)) } : {}),
    workspaceId: tenant.workspaceId,
    workspaceName: current?.name ?? HOME_WORKSPACE_NAME,
    productName: resolvedProductName(),
    gatewayName: resolvedGatewayName(),
    runtime: resolveRuntimeMode({
      settingsHasKey: hasLiveProvider(settings),
      envRuntime: process.env.AGENTFORGE_RUNTIME,
    }),
    // The host decides; the renderer only displays `allowed`. See gateway-gate.ts.
    gateway: reportGatewayGate(settings, { tenant }),
    // True while a queued wipe is waiting for the next boot, so Settings can offer to call it off.
    resetPending: hasPendingDataReset(localDataDir()),
    probe: probeSummary(undefined, tenant),
    // Only the per-mode default ids. The model lists live on `GET /api/v1/models`, once: this answer
    // used to carry them too, nine identical copies of the chat catalogue, which was 261 KB of a
    // 274 KB read that the shell repeats on every cold load. No reader of this route used them.
    defaults: modeDefaultsFor(tenant),
    toolCatalog: listToolCapabilities().map((capability) => ({
      id: capability.id,
      label: capability.label,
      description: capability.description,
      backends: capability.backends.map((backend) => ({
        id: backend.id,
        label: backend.label,
        envVars: backend.envVars,
        urlVars: backend.urlVars ?? [],
      })),
    })),
    toolRoutes: listToolRoutes(settings),
    usage: await loadAccountUsage(settings, tenant),
    // The mic shows only when `enabled`; H1 checks it again, so this is a hint and not the gate.
    voice: voiceSettingsFor(tenant, process.env, serverMode),
  };
}

export async function handleGetSettings(request: HostRequest, deps: ServerModeDeps = {}): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const settings = loadSettings(tenant);
    // A desk that upgraded into the gate has a key but no verdict, and a verdict goes stale after a
    // day. Both are opened on trust, so this is where the gateway actually gets asked. Fire-and-
    // forget and throttled: the response never waits for it.
    maybeRefreshGateway(settings, { tenant });
    return jsonOk(
      await settingsPayload(
        settings,
        tenant,
        deps.isServerMode ? deps.isServerMode() : isServerMode(),
        request.headers["accept-language"],
      ),
    );
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Fields of `POST /api/v1/settings` that belong to the OPERATOR, not to the caller
 * (docs/internal/security-owasp-2026-09.md, finding A01-3).
 *
 * `toolKeys` / `toolBackends` are the credentials and endpoints every tenant's tools run through.
 * The handler had no notion of
 * privilege, so one signed-in tenant could rewrite any of them for everybody. In server mode a
 * request that carries one is refused.
 *
 * THE PROVIDER KEYS ARE DELIBERATELY NOT IN THIS LIST. Onboarding and Settings are the only ways to
 * supply the gateway key and both post it here, so refusing key writes leaves a Phase 0 deploy on an
 * onboarding screen whose only button answers 403 — which is what the first version of the A01-3 fix
 * did, and why it was reverted.
 *
 * **Phase 4 is what makes that safe rather than merely necessary.** A01-3 left a residual: "on a
 * hosted box any tenant can still set the shared gateway key". There is no shared key to set any
 * more. Lane D put each tenant's `settings.enc` in its own place, Phase 4 put it in its own
 * `tenant_state` row, and `resolveProviderKeys` no longer falls back to the operator's
 * `OPENAI_API_KEY` in server mode. So a key write reaches the caller's tenant and nothing else, and
 * the operator's own key is not writable OR readable from a tenant session. The residual is closed;
 * see `docs/internal/web-phase4-tenant-secrets.md` §3.
 *
 * What still needs `keyFieldValue` below is narrower and has nothing to do with sharing: a key sent
 * as the EMPTY string is not a change anyone asked for — it is the renderer echoing an input nobody
 * typed in (`apps/web/components/settings-page.tsx` posts `openaiApiKey` from state on every save) —
 * and `mergeSecrets` DELETES the stored key on an empty string. Dropping the blank (on the desk too,
 * since 2026-10-06) is what stops a Settings save from wiping the key. Meaning "forget my key"
 * is `POST /api/v1/settings/reset` with `scope: "key"`, which Phase 4 opens on the server.
 *
 * Writing a key in server mode is itself gated by role (M4): see `requestsKeyWrite` and
 * `SETTINGS_KEY_FORBIDDEN_CODE` below. It is not an operator-only field, because the company's own
 * owner and admins must be able to supply it.
 */
const OPERATOR_ONLY_CODE = "settings_operator_only";
const OPERATOR_ONLY_MESSAGE =
  "Those settings are managed by the operator on the hosted service: the tool credentials and " +
  "backends, and the prompt-injection guard. They are shared by every tenant on this server, so " +
  "they cannot be changed from here.";

/** True when the body asks to change a field the operator owns. Keys are not among them — see above. */
export function requestsOperatorOnlySettings(body: Record<string, unknown>): boolean {
  for (const field of ["toolKeys", "toolBackends"] as const) {
    const value = body[field];
    if (value !== null && typeof value === "object" && Object.keys(value as object).length > 0) {
      return true;
    }
  }
  return body.injectionGuardBypass === true;
}

/**
 * A provider key on its way into the patch.
 *
 * A blank (empty or whitespace) is dropped instead of forwarded, on the desk and on the server alike:
 * it is the key field nobody typed in, and `mergeSecrets` would read it as "forget my key". Until
 * 2026-10-06 only server mode dropped it, so on a desk saving Settings with the field empty (changing
 * only the Edit turn cap, say) signed the desk out of the gateway. Forgetting a key is
 * `POST /api/v1/settings/reset` with `scope: "key"`, and nothing else. A real value passes through.
 */
export function keyFieldValue(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return undefined;
  }
  return raw;
}

/**
 * M4 (2026-10-01 abuse walk): on the hosted service the gateway key belongs to the COMPANY, not to
 * whoever is looking at Settings. Every person who signs in to it spends through that one key, so
 * writing it — saving, replacing or clearing — needs `canAdminister` (an owner or an admin). A member
 * could do both before this (`POST /api/v1/settings { openaiApiKey }` and `POST /api/v1/settings/reset
 * { scope: "key" }` each answered 200), which meant any colleague could swap the company onto their own
 * key or sign the whole company out of the gateway.
 *
 * Server mode only. On a desk the person holding the machine is the owner of everything on it and the
 * local tenant is always `owner`, so nothing here is evaluated and the Personal app answers exactly what
 * it did (`settings-key-roles.test.ts` pins that with a member session and the switch off).
 *
 * The bar is `canAdminister`, the same one the agent service uses, and not the owner-only bar of the
 * company erase (`tenant-reset.ts`): changing the key is routine administration and an admin is trusted
 * with it; deleting every person in the company is not routine.
 */
export const SETTINGS_KEY_FORBIDDEN_CODE = "settings_key_forbidden";
const SETTINGS_KEY_FORBIDDEN_MESSAGE =
  "Only an owner or admin can change the company's gateway key. Ask one of them to do it.";

/** The provider key fields `POST /api/v1/settings` accepts: each one is the company's credential. */
const PROVIDER_KEY_FIELDS = ["openaiApiKey", "googleApiKey", "anthropicApiKey", "volcengineApiKey"] as const;

/**
 * True when the body writes a provider key, in server mode. "Writes" is exactly what `keyFieldValue`
 * lets through to the patch: a non-blank string. A blank is dropped there, so the blank the Settings
 * page echoes from an untouched input on every save is not a key write and a member's ordinary save
 * is not refused for it; a non-string is ignored by the same function. Off server mode the answer is
 * `false`, because nothing consults it there and a blank means "forget my key" on a desk.
 */
export function requestsKeyWrite(body: Record<string, unknown>, serverMode: boolean): boolean {
  return serverMode && PROVIDER_KEY_FIELDS.some((field) => keyFieldValue(body[field]) !== undefined);
}

/**
 * Every field `POST /api/v1/settings` reads from its body. Keep it in step with each `body.*` read in this
 * file: `handlePostSettings`, `requestsOperatorOnlySettings`, `requestsKeyWrite` and
 * `refreshGatewayGateAfterSave`. `scope` and `confirm` belong to `POST /api/v1/settings/reset`, another route,
 * so they are not listed. A name missing here is not refused, because an older renderer or the tester branch
 * may still send one: it is reported in `ignoredFields` instead, so a typo is visible (SH-002).
 */
export const KNOWN_SETTINGS_FIELDS: ReadonlySet<string> = new Set<string>([
  "locale",
  ...PROVIDER_KEY_FIELDS,
  "toolKeys",
  "toolBackends",
  "imageGenModel",
  "videoGenModel",
  "musicGenModel",
  "documentGenModel",
  "researchGenModel",
  "presentationGenModel",
  "disabledTools",
  "injectionGuardBypass",
  "editTurnCapUsd",
]);

/** The most names one answer carries, and the longest each may be. A body is the caller's own, but a response is not the place to echo an unbounded one. */
export const MAX_IGNORED_FIELDS = 20;
export const MAX_IGNORED_FIELD_NAME_LENGTH = 64;

/**
 * The names of the body's fields this handler does not read, in the order the body sent them. Names only:
 * a value is never returned, not even a key's. A body that is not a JSON object (plain text, an array, a
 * number) carries no field names, so it reports none.
 */
export function unknownSettingsFields(body: unknown): string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return [];
  }
  return Object.keys(body)
    .filter((name) => !KNOWN_SETTINGS_FIELDS.has(name))
    .slice(0, MAX_IGNORED_FIELDS)
    .map((name) => name.slice(0, MAX_IGNORED_FIELD_NAME_LENGTH));
}

/** Throws the 403 for anyone who is not an owner or an admin. Called only in server mode. */
function assertMayChangeCompanyKey(tenant: TenantContext): void {
  if (!canAdminister(tenant.role)) {
    throw new ApiError(SETTINGS_KEY_FORBIDDEN_CODE, SETTINGS_KEY_FORBIDDEN_MESSAGE, 403);
  }
}

/**
 * Hosted only (SR-163, review round): write the provider keys of this save to the caller's company's
 * other desks. `tenant.tenantId` is the white-label partner, so the desks are listed by the caller's own
 * organisation, which is what keeps every other company's desks out of it. Only the key fields travel;
 * a desk's own choices (models, caps) stay its own. Callers pass a patch whose blank fields are already
 * dropped (`keyFieldValue`), so a field nobody typed is never written onto another desk.
 */
async function mirrorKeysToCompanyDesks(patch: SecretPatch, tenant: TenantContext): Promise<void> {
  const desks = await listLocalWorkspaces(db, tenant.organizationId);
  saveKeysToDesks(
    {
      openaiApiKey: patch.openaiApiKey,
      googleApiKey: patch.googleApiKey,
      anthropicApiKey: patch.anthropicApiKey,
      volcengineApiKey: patch.volcengineApiKey,
    },
    tenant,
    desks.map((desk) => desk.id).filter((id) => id !== tenant.workspaceId),
  );
}

/** Injected like `ResetDeps` below, so a test can exercise hosted behaviour without the env flag. */
export type ServerModeDeps = { isServerMode?: () => boolean };

export async function handlePostSettings(request: HostRequest, deps: ServerModeDeps = {}): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const serverMode = deps.isServerMode ? deps.isServerMode() : isServerMode();
    if (serverMode && requestsOperatorOnlySettings(body)) {
      throw new ApiError(OPERATOR_ONLY_CODE, OPERATOR_ONLY_MESSAGE, 403);
    }
    // Before any write below, so a request that mixes a key with a setting the caller may change
    // (their language, say) is refused whole: nothing in it is applied.
    if (requestsKeyWrite(body, serverMode)) {
      assertMayChangeCompanyKey(tenant);
    }
    if (body.locale !== undefined) {
      if (!isAppLocale(body.locale)) {
        throw new ApiError("invalid_request", "locale must be en or id", 400);
      }
      // Phase 4: the person's language, not the install's. On a desk `saveUserLocale` still
      // writes the install locale too, so `getBootLocale()` and the Restart control are unchanged.
      saveUserLocale(tenant, body.locale);
    }
    // Keys pass through in both modes; only a blank is dropped in server mode, where it would
    // DELETE the key every tenant shares. `toolKeys`, `toolBackends` and `injectionGuardBypass`
    // never reach the patch in server mode — the check above proved none of them carries a value.
    const patch: SecretPatch = {
      openaiApiKey: keyFieldValue(body.openaiApiKey),
      googleApiKey: keyFieldValue(body.googleApiKey),
      anthropicApiKey: keyFieldValue(body.anthropicApiKey),
      volcengineApiKey: keyFieldValue(body.volcengineApiKey),
      toolKeys: serverMode ? undefined : readStringMap(body.toolKeys),
      toolBackends: serverMode ? undefined : readStringMap(body.toolBackends),
      imageGenModel: readOptionalString(body.imageGenModel),
      videoGenModel: readOptionalString(body.videoGenModel),
      musicGenModel: readOptionalString(body.musicGenModel),
      documentGenModel: readOptionalString(body.documentGenModel),
      researchGenModel: readOptionalString(body.researchGenModel),
      presentationGenModel: readOptionalString(body.presentationGenModel),
      disabledTools: readStringArray(body.disabledTools),
      injectionGuardBypass: serverMode ? undefined : readOptionalBoolean(body.injectionGuardBypass),
      editTurnCapUsd: readOptionalNumber(body.editTurnCapUsd),
    };
    const saved = saveSettings(patch, tenant);
    // SR-163: on the server the key is the company's, so it reaches every desk of the company.
    if (requestsKeyWrite(body, serverMode)) {
      await mirrorKeysToCompanyDesks(patch, tenant);
    }
    clearThisKeyCache();
    // A fixed key / URL must take effect now, not after the 5-minute embeddings breaker expires —
    // and the job-side breaker skips a model for the same five minutes, so it is cleared with it, along
    // with the Thinking levels the runtime learned a model refuses.
    resetEmbedCircuit();
    resetModelReliabilityState();
    // The retrieval sidecar holds a *copy* of the gateway key, inside the model row it embeds with.
    // A key that has been changed here but left in that database has not been rotated, so the row
    // is revoked; the next knowledge call mints a fresh one against the new credentials.
    await revokeKnowledgeGatewayModel(tenant);
    try {
      await refreshModelCache(saved, { scope: tenant });
    } catch {
      // Airplane mode: key stays on disk; probe happens on generate.
    }
    let gateRefreshFailed = false;
    let freshGate: GatewayGatePayload | null = null;
    try {
      freshGate = await refreshGatewayGateAfterSave(body, saved, tenant);
    } catch (error) {
      // The key is already on disk by the time we get here. A verdict that could not be refreshed
      // or written — an unwritable data dir, a full disk, a directory squatting on
      // `gateway-gate.json` — is a stale verdict, not a lost key, so it must not come back as
      // "saving your key failed" and send the owner off to paste it again. `allowed` is left
      // exactly as derived: an unwritable state file is no reason to lock the desk out.
      gateRefreshFailed = true;
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`gateway verdict refresh failed after save: ${redactSecrets(detail)}`);
    }
    const payload = await settingsPayload(saved, tenant, serverMode, request.headers["accept-language"]);
    // SH-002: a field this handler does not read was not applied, so the answer names it. Only when there is
    // one: an answer with nothing to report keeps the shape it always had.
    const ignoredFields = unknownSettingsFields(body);
    return jsonOk({
      ...payload,
      gateway: gateVerdictFor(payload.gateway, freshGate, gateRefreshFailed),
      ...(ignoredFields.length > 0 ? { ignoredFields } : {}),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function handleApplyLocale(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    applySavedLocaleAsBoot();
    return jsonOk(
      await settingsPayload(loadSettings(tenant), tenant, isServerMode(), request.headers["accept-language"]),
    );
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * A key is only worth anything once the gateway has seen it, so saving one validates it now and the
 * response carries the fresh verdict. Clearing one throws the verdict away with it.
 *
 * `runGatewayCheck` turns a rejected or unreachable gateway into a persisted verdict rather than a
 * throw, so the usual failures never reach the caller. Disk failures still can, which is why the
 * one call site treats a throw here as a stale verdict and not as a failed save.
 */
/**
 * Which verdict the save response carries. The one `runGatewayCheck` just returned wins, because it
 * is the only one that knows a verdict was reached but not stored. `failed` is the last-resort case
 * where the refresh threw outright: the key is saved, so the gate is reported as `error` without
 * touching `allowed` — an unwritable data dir must not close a desk.
 */
function gateVerdictFor(
  derived: GatewayGatePayload,
  fresh: GatewayGatePayload | null,
  failed: boolean,
): GatewayGatePayload {
  if (failed) {
    return { ...derived, status: "error", message: GATEWAY_VERDICT_UNWRITABLE_MESSAGE };
  }
  return fresh ?? derived;
}

async function refreshGatewayGateAfterSave(
  body: Record<string, unknown>,
  saved: ReturnType<typeof saveSettings>,
  tenant: TenantContext,
): Promise<GatewayGatePayload | null> {
  // No key typed, or a blank field: the key did not change (`keyFieldValue` drops the blank), so its
  // verdict stands. Clearing it here used to leave a kept key "never checked". Forgetting a key, and
  // its verdict, is `resetGatewayKey`.
  if (keyFieldValue(body.openaiApiKey) === undefined) {
    return null;
  }
  // The verdict this returns is the one the response carries. Re-deriving it from disk instead
  // would throw away the one case where the two differ: a verdict that was reached but could not
  // be written, which disk reads back as "never checked".
  return await runGatewayCheck(saved, { tenant });
}

export async function handleGatewayCheck(request: HostRequest): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const gateway = await runGatewayCheck(loadSettings(tenant), { tenant });
    return jsonOk({ gateway });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Everything under the data dir that the host itself wrote. Deliberately a named list, never the
 * directory: in the packaged app this same folder is Electron's userData / Chromium profile, so
 * `host-status.json`, `Local Storage/`, caches and cookies are not ours to delete. The SQLite trio
 * is added by `applyPendingDataReset`, because `@agentforge/db` owns it.
 */
export const HOST_RESET_ENTRIES = [
  "settings.enc",
  "settings.json",
  ".master-key",
  "gateway-gate.json",
  "media",
  "workspace-id.txt",
  "desk-usage.json",
  // Phase 3 lane D: every non-local tenant's settings, verdict, usage, datasets, matters and
  // scratch live under here. "Start over" is refused in server mode, so on the desktop this is
  // normally absent; a webdev instance that resolved a second tenant is the case it covers.
  "tenants",
  "datasets",
  "edit",
  "legal",
  // Desk channels: the bot token lives in settings.enc, but the channel list and the stored
  // conversation are files here, and they are the host's own writes like everything else on this list.
  "channels",
  "models-cache.json",
  "models-dev-cache.json",
  // Its freshness sidecar (one timestamp), written beside it on every registry refresh.
  "models-dev-cache.meta.json",
  // Downloaded native components (packages/host/src/components). Written by the host, inside the
  // data dir, and re-downloadable — so a full "Start over" drops it like everything else the host
  // wrote. The cost of being wrong here is one re-download, never data.
  "components",
  // The component installer's own diagnostics. Same reasoning; nothing in it is the owner's work.
  "logs",
] as const;

/** Reason code and message for a "Start over" that the hosted service does not offer. */
const RESET_DISABLED_CODE = "reset_disabled";
const RESET_DISABLED_MESSAGE =
  "Starting over is not available on the hosted service. Delete the desks, threads or files you no longer want instead.";

/**
 * "Forget my key", and **Phase 4 turns it on for the hosted service**.
 *
 * It used to be refused there, and the reason was true when it was written: the key and the verdict
 * were machine-wide, so one tenant pressing this signed every other tenant out of the gateway. Lane
 * D scoped both calls to the caller's tenant and Phase 4 moved both payloads into that tenant's own
 * `tenant_state` rows, so what this clears now is the caller's key on the caller's desks and the
 * caller's verdict — nobody else's. Leaving it refused would mean a hosted tenant who pasted the
 * wrong key had no way to take it back, since `keyFieldValue` drops a blank by
 * design, and that is the whole of the route out.
 *
 * Who may press it is a separate question from whose key it clears. It is the COMPANY's key, so on the
 * hosted service `handleResetApp` admits an owner or an admin and answers a member
 * `403 settings_key_forbidden` (M4, `SETTINGS_KEY_FORBIDDEN_CODE`). The caller can still be any
 * person who holds that bar; what changed is that "any person" no longer means "any member".
 *
 * "Start over" stays refused: that one really does still wipe the shared data directory.
 */
async function resetGatewayKey(tenant: TenantContext, serverMode: boolean): Promise<HostResult> {
  // Every desk of this tenant: a key left on a second desk would keep the gate open after "forget
  // my key". Phase 3 lane D narrowed both calls from the whole install to the caller's tenant.
  //
  // SR-163: on the hosted server the tenant is the white-label partner and a company is one
  // organisation inside it, so "every desk of this tenant" would be every company's desks and this
  // button would sign the whole deployment out of the gateway. There it is the caller's own
  // organisation's desks, and the verdict `clearGateState` drops is that company's own. A desk has
  // one person and one organisation, and keeps the call exactly as it was.
  if (serverMode) {
    const desks = await listLocalWorkspaces(db, tenant.organizationId);
    clearGatewayKeyEverywhere(tenant, { workspaceIds: desks.map((desk) => desk.id) });
  } else {
    clearGatewayKeyEverywhere(tenant);
  }
  clearGateState(tenant);
  clearThisKeyCache();
  resetEmbedCircuit();
  resetModelReliabilityState();
  return jsonOk({
    ok: true,
    scope: "key",
    relaunch: false,
    resetPending: hasPendingDataReset(localDataDir()),
    gateway: reportGatewayGate(loadSettings(tenant), { tenant }),
  });
}

/**
 * "Start over" wipes the whole data dir, which on the hosted service is every tenant's work, not the
 * caller's (docs/internal/web-security-spec.md, row T8). Until it is scoped per tenant it is simply
 * off there. The refusal comes first, before the confirmation word and before anything is queued:
 * the owner of one workspace must not be able to arm a wipe for everyone else's.
 */
function resetEverything(tenant: TenantContext, confirm: string | undefined, serverMode: boolean): HostResult {
  if (serverMode) {
    throw new ApiError(RESET_DISABLED_CODE, RESET_DISABLED_MESSAGE, 403);
  }
  if (confirm !== RESET_CONFIRM_WORD) {
    throw new ApiError("invalid_request", `confirm must be "${RESET_CONFIRM_WORD}" to erase everything`, 400);
  }
  // The database is open and ffmpeg may still be writing, so the wipe is queued for the next boot.
  requestDataReset(localDataDir(), [...HOST_RESET_ENTRIES]);
  killTrackedChildren();
  return jsonOk({
    ok: true,
    scope: "all",
    relaunch: true,
    resetPending: hasPendingDataReset(localDataDir()),
    gateway: reportGatewayGate(loadSettings(tenant), { tenant }),
  });
}

/**
 * Phase 8 — "Erase account" for a hosted tenant, which is a different act with a different blast
 * radius, so it is a different scope rather than a hosted branch inside `scope: "all"`.
 *
 * Since 2026-10-01 (owner decision, SR-65) it deletes every person in the company and ends every
 * session, the caller's included, so the answer says `signedOut: true` and the renderer follows with
 * the ordinary sign-out (`POST /api/v1/auth/logout`, which is idempotent for a session that no longer
 * exists and still answers with the portal's own logout URL). Nothing here touches the cookie: it is
 * dead the moment the transaction commits, and the logout answer clears it.
 *
 * Writing it as a third scope is what makes the two mutually unreachable: `all` is refused in
 * server mode and `tenant` is refused off it, both before the confirmation word is read, so no
 * client of either target can reach the other's button by sending the wrong string. A hosted
 * branch inside `all` would have made an existing desk client's request mean something new the
 * day the flag flipped.
 *
 * The work itself is `../tenant-reset.ts`; everything policy-shaped (server mode, owner, the
 * confirmation, the local-tenant guard) is checked there, so this handler stays a router.
 *
 * `relaunch` is `false` and `resetPending` is `false` on purpose. Both belong to the desk's staged
 * wipe — a marker on disk applied by the next boot — and nothing about the hosted reset is staged:
 * by the time this answers, it has already happened.
 */
async function resetThisTenant(tenant: TenantContext, confirm: string | undefined): Promise<HostResult> {
  const outcome = await resetTenant(tenant, confirm);
  return jsonOk({
    ok: true,
    scope: "tenant",
    relaunch: false,
    resetPending: false,
    signedOut: outcome.signedOut,
    rowsDeleted: outcome.rowsDeleted,
    objectsDeleted: outcome.objectsDeleted,
    bytesFreed: outcome.bytesFreed,
    gateway: reportGatewayGate(loadSettings(tenant), { tenant }),
  });
}

/** Injectable so a test can ask for hosted behaviour without touching the process environment. */
export type ResetDeps = { isServerMode?: () => boolean };

export async function handleResetApp(request: HostRequest, deps: ResetDeps = {}): Promise<HostResult> {
  try {
    const tenant = await getTenant(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const scope = readOptionalString(body.scope);
    const serverMode = deps.isServerMode ? deps.isServerMode() : isServerMode();
    if (scope === "key") {
      // Hosted: forgetting the key signs the whole company out of the gateway, so it is the same
      // owner-or-admin act as saving one. A desk has no roles to read.
      if (serverMode) {
        assertMayChangeCompanyKey(tenant);
      }
      return await resetGatewayKey(tenant, serverMode);
    }
    if (scope === "all") {
      return resetEverything(tenant, readOptionalString(body.confirm), serverMode);
    }
    if (scope === "tenant") {
      return await resetThisTenant(tenant, readOptionalString(body.confirm));
    }
    throw new ApiError("invalid_request", 'scope must be "key", "all" or "tenant"', 400);
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Call off a queued wipe. The marker is the whole of the pending state, so unlinking it is the
 * cancel. Idempotent on purpose: the owner asked for nothing to be pending, and after this nothing
 * is, whether or not anything was.
 */
export async function handleCancelReset(request: HostRequest, deps: ResetDeps = {}): Promise<HostResult> {
  try {
    await getTenant(request);
    // Symmetry with the two refusals above: the pending-reset marker is machine-wide, so one tenant
    // must not be able to reach it either way. Arming a wipe is already refused in server mode, so
    // this cannot fire on anything the hosted service itself queued — it closes the case where a
    // marker arrives another way (a restored data dir, a desk volume mounted on the server) and one
    // tenant quietly cancels a wipe the operator armed.
    if (deps.isServerMode ? deps.isServerMode() : isServerMode()) {
      throw new ApiError(RESET_DISABLED_CODE, RESET_DISABLED_MESSAGE, 403);
    }
    // `recursive` so that a directory left at the marker path — a botched restore, a sync client —
    // is cleared like anything else instead of throwing EISDIR and turning "cancel my wipe" into a
    // 500 the owner cannot get past.
    rmSync(pendingResetPath(localDataDir()), { force: true, recursive: true });
    return jsonOk({ ok: true, resetPending: false });
  } catch (error) {
    return jsonError(error);
  }
}
