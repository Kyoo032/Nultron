/**
 * What you can ask the store for, and what it answers.
 *
 * Split out of `./types.ts` so each file stays readable: `./entities.ts` is "what a row is", this
 * is "what you can ask for", and `./types.ts` is the store itself. Every result is a discriminated
 * union rather than a throw, because a denial here is an expected outcome with a reason code the
 * caller has to branch on -- `device-code-login.md`, "Login checks and reason codes".
 */

import type {
  ActorKind,
  AuthCode,
  DenialReason,
  Device,
  DeviceCode,
  DevicePlatform,
  Invite,
  Iso,
  JsonObject,
  LoginOtp,
  OrgPlan,
  OtpPurpose,
  TenantFeatureFlags,
  TenantStatus,
  User,
  UserRole,
  UserStatus,
} from "./entities";

export * from "./entities";


// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CreateTenantInput {
  /**
   * Pre-minted by the caller so `tx(id, …)` can scope the very transaction that inserts the row:
   * the `tenants` policy in 0004 is `WITH CHECK (id = app_tenant_id())`, so a tenant cannot be
   * created by a tenant-scoped connection without knowing its id first. Defaults to a fresh uuid.
   */
  readonly id?: string;
  readonly slug: string;
  readonly name: string;
  readonly status?: TenantStatus;
  readonly residency?: string;
}

export interface UpsertTenantConfigInput {
  readonly tenantId: string;
  readonly branding?: JsonObject;
  readonly modelAllowlist?: readonly string[];
  readonly featureFlags?: TenantFeatureFlags;
}

export interface CreateOrgInput {
  readonly tenantId: string;
  readonly name: string;
  readonly slug: string;
  readonly plan?: OrgPlan;
  readonly seatCap?: number;
  readonly seatBand?: number;
  readonly currency?: "USD" | "IDR";
  readonly billingEmail?: string | null;
  readonly featureFlags?: TenantFeatureFlags;
}

export interface CreateUserInput {
  readonly tenantId: string;
  readonly orgId: string;
  readonly email: string;
  readonly displayName?: string | null;
  readonly status?: UserStatus;
  readonly role?: UserRole;
}

export interface UpsertDeviceInput {
  readonly tenantId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly installId: string;
  readonly platform: DevicePlatform;
  readonly label?: string | null;
  readonly osVersion?: string | null;
  readonly appVersion?: string | null;
}

/** A revoked install is refused, never resurrected: an admin has to clear it first. */
export type UpsertDeviceResult =
  | { readonly ok: true; readonly device: Device }
  | { readonly ok: false; readonly reason: "device_revoked"; readonly device: Device };

export interface CreateSessionInput {
  readonly tenantId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly scope?: string;
  /** Defaults to the schema's 90-day ceiling. */
  readonly absoluteTtlMs?: number;
  /**
   * Defaults to now. Set explicitly only by a data import or a test that needs a session outside
   * the 30-day seat window -- the seat count is the one thing this column drives.
   */
  readonly lastSeenAt?: Iso;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface IssueRefreshTokenInput {
  readonly sessionId: string;
  /** The caller generated it and keeps the raw form; only the hash is stored. */
  readonly rawToken: string;
  readonly ttlMs?: number;
}

export interface RotateRefreshTokenInput {
  /** The raw token the client just presented. */
  readonly presentedToken: string;
  /** The raw successor the caller generated a moment ago -- `p_new_token_hash`, not optional. */
  readonly newToken: string;
  /** `devices.id`, compared against `sessions.device_id`. Omitting it skips the binding entirely. */
  readonly deviceId?: string | null;
  readonly ttlMs?: number;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export type RotateRefreshTokenResult =
  | {
      readonly reason: "ok";
      readonly sessionId: string;
      readonly tenantId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly deviceId: string;
      readonly newTokenId: string;
      readonly generation: number;
      readonly expiresAt: Iso;
    }
  | {
      readonly reason: DenialReason;
      readonly sessionId: string | null;
      readonly tenantId: string | null;
    };

export interface CreateDeviceCodeInput {
  readonly rawDeviceCode: string;
  readonly installId: string;
  readonly platform?: DevicePlatform | null;
  readonly tenantId?: string | null;
  readonly clientName?: string | null;
  readonly clientVersion?: string | null;
  readonly requestedScope?: string;
  readonly ttlMs?: number;
  readonly intervalSeconds?: number;
  readonly createdIp?: string | null;
}

export interface ApproveDeviceCodeInput {
  readonly userCode: string;
  readonly tenantId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly approvedIp?: string | null;
}

export type ApproveDeviceCodeResult =
  | { readonly ok: true; readonly code: DeviceCode }
  | { readonly ok: false; readonly reason: "device_code_expired" | "tenant_inactive" };

export type DenyDeviceCodeResult =
  | { readonly ok: true; readonly code: DeviceCode }
  | { readonly ok: false; readonly reason: "device_code_expired" };

/**
 * One poll of `/auth/device/token`, with the counters the login doc names: more than 2 polls
 * inside one `intervalSeconds` window answers `slow_down` and widens the interval by 5 s; more
 * than 200 polls on one code force-expires it.
 */
export type PollDeviceCodeResult =
  | { readonly reason: "ok"; readonly code: DeviceCode }
  | { readonly reason: "authorization_pending"; readonly intervalSeconds: number }
  | { readonly reason: "slow_down"; readonly intervalSeconds: number; readonly retryAfter: number }
  | { readonly reason: "device_code_expired" }
  | { readonly reason: "device_code_denied" }
  /** Unknown hash, an install_id that does not match, or a code already redeemed. */
  | { readonly reason: "invalid_grant" };

export interface RedeemDeviceCodeInput {
  readonly rawDeviceCode: string;
  readonly sessionId: string;
}

export interface SendLoginOtpInput {
  readonly tenantId: string;
  readonly email: string;
  /** The raw 6 digits. Only sha256 is stored. */
  readonly code: string;
  readonly purpose?: OtpPurpose;
  readonly ttlMs?: number;
  readonly createdIp?: string | null;
  /**
   * Treat this as a repeat of the request that minted the live code, and mint nothing, when the
   * address already has a code of this purpose that is live (not used, not out of guesses, not
   * expired) and younger than this. A double click, a reload and a re-post of one form are one
   * request; a caller that WANTS another code (the operator's one-off) leaves it unset.
   */
  readonly dedupeWithinMs?: number;
}

export type SendLoginOtpResult =
  | { readonly ok: true; readonly otp: LoginOtp }
  /** 3 sends per 15 minutes per address, counted from the rows themselves. */
  | { readonly ok: false; readonly reason: "send_rate_limited"; readonly retryAfter: number }
  /**
   * `dedupeWithinMs` applied: a live code of this purpose is that young, so it already answers
   * this request. Nothing was minted and none of the three sends was spent; `retryAfter` is the
   * whole seconds until a request would no longer count as a repeat.
   */
  | { readonly ok: false; readonly reason: "duplicate"; readonly retryAfter: number };

export interface LoginOtpStatusInput {
  readonly tenantId: string;
  readonly email: string;
  /** Which flow's codes the newest-sent time is read from. The daily guess total is across both. */
  readonly purpose?: OtpPurpose;
}

/** A read-only look at an address's codes, so a flow can say what is true before it sends one. */
export interface LoginOtpStatus {
  /** The address has spent its twenty guesses for the day: even the right code is refused. */
  readonly locked: boolean;
  /** When `locked`: whole seconds until enough of the day's guesses age out to lift it. */
  readonly retryAfter?: number;
  /** When the newest code of that purpose was minted, or null if none ever was. */
  readonly newestSentAt: Iso | null;
}

export interface VerifyLoginOtpInput {
  readonly tenantId: string;
  readonly email: string;
  readonly code: string;
  readonly purpose?: OtpPurpose;
}

export type VerifyLoginOtpResult =
  | { readonly ok: true; readonly otp: LoginOtp }
  | {
      readonly ok: false;
      /**
       * `too_many_attempts`: this code has taken its five guesses. `locked`: the ADDRESS has taken
       * twenty guesses in the last 24 hours, across every code and both purposes, so even the
       * right code on a fresh code is refused until they age out.
       */
      readonly reason: "no_code" | "expired" | "too_many_attempts" | "invalid_code" | "locked";
      readonly attemptsRemaining: number;
      /** With `locked`: whole seconds until the address can try again (`otp-lock.ts`). */
      readonly retryAfter?: number;
    };

export interface CreateInviteInput {
  readonly tenantId: string;
  readonly orgId: string;
  /** An existing `invited` member: the invite activates this row, it does not create one. */
  readonly userId: string;
  readonly email: string;
  /** The raw code. Normalised and hashed here; only the hash is stored. */
  readonly rawCode: string;
  /** Held once redeemed. Defaults to `member`: nobody is made an owner by omission. */
  readonly role?: UserRole;
  /** Defaults to 7 days. A negative value is a row already past its expiry, for a test. */
  readonly ttlMs?: number;
}

export interface RedeemInviteInput {
  readonly tenantId: string;
  readonly email: string;
  readonly rawCode: string;
}

/** How many invites an address has been issued lately, and when: the self-service resend's budget. */
export interface InviteIssueHistory {
  readonly count: number;
  readonly oldestAt: Iso | null;
  readonly newestAt: Iso | null;
}

export type RedeemInviteResult =
  | { readonly ok: true; readonly invite: Invite; readonly user: User }
  | {
      readonly ok: false;
      /**
       * `no_invite`: nothing live for that address. `wrong_code`: it was live and the code was
       * not it, and the guess was counted. `locked`: five guesses were spent, so even the right
       * code is refused. `not_invitable`: the member is disabled, which an invite does not undo.
       * None of them is shown to the person typing; they are for the audit row.
       */
      readonly reason: "no_invite" | "wrong_code" | "expired" | "already_used" | "locked" | "not_invitable";
      readonly attemptsRemaining: number;
    };

export interface IssueAuthCodeInput {
  readonly rawCode: string;
  readonly tenantId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  /**
   * Stored as sha256 only, for audit — never compared (SR-43). The login-CSRF binding on `state`
   * is the host's own `__Host-` cookie check, which runs before `/auth/token` is called.
   */
  readonly state: string;
  readonly ttlMs?: number;
  readonly createdIp?: string | null;
}

export interface ConsumeAuthCodeInput {
  readonly rawCode: string;
  readonly clientId: string;
  readonly redirectUri: string;
}

export type ConsumeAuthCodeResult =
  | { readonly ok: true; readonly code: AuthCode }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid_grant"
        | "expired"
        | "already_used"
        | "client_mismatch"
        | "redirect_mismatch";
    };

export interface CreateOAuthClientInput {
  readonly clientId: string;
  readonly tenantId: string;
  readonly name: string;
  /** The raw secret. Only sha256 is stored, and the operator sees it once. */
  readonly secret: string;
  readonly redirectUris: readonly string[];
}

export interface AppendAuditInput {
  /** NOT NULL in `0003_billing_and_usage.sql`: an event with no resolved tenant is not written. */
  readonly tenantId: string;
  readonly orgId?: string | null;
  readonly actorKind: ActorKind;
  readonly actorUserId?: string | null;
  readonly action: string;
  readonly targetKind?: string | null;
  readonly targetId?: string | null;
  readonly reasonCode?: string | null;
  readonly before?: JsonObject | null;
  readonly after?: JsonObject | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface LoginPrecheckInput {
  readonly userId: string;
  readonly deviceId: string;
  /** NULL on a brand-new session, which is the only path that charges a seat. */
  readonly sessionId?: string | null;
}

