/**
 * What you can ask the store for, and what it answers.
 *
 * Split out of `./types.ts` so each file stays readable: `./entities.ts` is "what a row is", this
 * is "what you can ask for", and `./types.ts` is the store itself. Every result is a discriminated
 * union rather than a throw, because a denial here is an expected outcome with a reason code the
 * caller has to branch on -- `device-code-login.md`, "Login checks and reason codes".
 */

import type { PasswordHash } from "../password/hash";
import type {
  ActorKind,
  AuthCode,
  Credential,
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

// ---------------------------------------------------------------------------
// Password sign-in (PORTAL_SIGNIN_MODE=password; apps/portal/migrations/0012_password_signin.sql)
// ---------------------------------------------------------------------------

export interface CreateCredentialInput {
  /** An existing `users` row: the credential takes its tenant from it and goes with it. */
  readonly userId: string;
  /** Already normalised (lower case) and checked against `USERNAME_PATTERN`. */
  readonly username: string;
  readonly secret: PasswordHash;
  /** Defaults to true: an operator-issued password is one the person replaces at first sign-in. */
  readonly mustChange?: boolean;
  readonly now: Date;
}

/** A person and the credential that lets them in. */
export interface Account {
  readonly user: User;
  readonly credential: Credential;
}

/** Everyone in an org, with the credential when they have one. The operator's `list`. */
export interface Person {
  readonly user: User;
  readonly credential: Credential | null;
}

export interface ReserveAttemptInput {
  readonly userId: string;
  /** The injected clock's time: lockout expiry is computed from it, not from the database's `now()`. */
  readonly now: Date;
  /** Attempts before the account locks. */
  readonly maxAttempts: number;
  readonly lockMs: number;
  /**
   * How many attempts past the lock this caller may still take (0 to 3, the schema's cap): the flow
   * passes `PASSWORD_GRACE_ATTEMPTS` for a source address that has not itself failed against this
   * person in the window and nothing for any other. Absent or 0 is the lock exactly as it was before
   * the slots existed. The slots are counted in the row (`grace_attempts`), so what a window allows
   * is `maxAttempts` plus the slots, whoever asks and however many addresses they ask from.
   */
  readonly graceAttempts?: number;
}

/**
 * The charge-first step. An attempt is counted BEFORE the password is compared, in one transaction
 * that holds the row, so a burst of parallel guesses is compared exactly as many times as the counter
 * allows and no more. Only a caller that won an increment is handed the hash.
 */
export type ReserveAttemptResult =
  | {
      readonly kind: "reserved";
      /** This attempt's number, 1 to `maxAttempts`; `maxAttempts` for an attempt taken under the lock. */
      readonly attemptsUsed: number;
      /** True when this attempt was the last one allowed: the account is locked now. */
      readonly lockedNow: boolean;
      /** 0 for an ordinary attempt; 1 to 3 for one taken under the lock, which slot it was. */
      readonly graceUsed: number;
      readonly secret: PasswordHash;
    }
  /** Locked until then, and no slot for this caller: nothing was counted and nothing was compared. */
  | { readonly kind: "locked"; readonly until: Iso }
  /** No credential for this person. */
  | { readonly kind: "none" };

export interface RecordSuccessInput {
  readonly userId: string;
  readonly now: Date;
  /** The same password under the current cost parameters, when the stored ones are out of date. */
  readonly rehash?: PasswordHash;
  /**
   * The hash that was compared and found right. Nothing is written unless the stored hash is still
   * this one: a reset that landed while the password was being compared must not be undone by the
   * sign-in that began before it, whether by writing the old password back (`rehash`) or by clearing
   * the count the new password has begun.
   */
  readonly expectHash: Buffer;
}

export interface SetPasswordInput {
  readonly userId: string;
  readonly secret: PasswordHash;
  readonly mustChange: boolean;
  readonly now: Date;
  /**
   * When set, the write happens only if the stored hash is still this one: the password was proved a
   * moment ago, and a change that lost a race with another is refused instead of silently winning.
   */
  readonly expectHash?: Buffer;
}

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

/** Rows of one action in one tenant since a moment, counted per target. See `audit.countByTarget`. */
export interface CountAuditByTargetInput {
  readonly tenantId: string;
  readonly action: string;
  readonly since: Date;
  /** Only this target. Absent: every target that has at least one row. */
  readonly targetId?: string;
}

export interface LoginPrecheckInput {
  readonly userId: string;
  readonly deviceId: string;
  /** NULL on a brand-new session, which is the only path that charges a seat. */
  readonly sessionId?: string | null;
}

