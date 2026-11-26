/**
 * The portal's store contract.
 *
 * Every name and every rule here mirrors `docs/internal/portal/schema.md` and
 * `docs/internal/portal/migrations/0001-0005`, which the one driver (`./postgres/**`) applies
 * unchanged. Where those files are missing something the browser login needs, the gap is closed by
 * `apps/portal/migrations/0006-0007` in the same style, never by editing theirs.
 *
 * The row shapes live in `./entities.ts` and are re-exported here, so importing this file gets the
 * whole contract.
 *
 * Four invariants hold for every implementation:
 *
 *  1. **Raw codes and tokens are never stored.** Only `sha256(raw)` reaches a row. The raw value
 *     exists in the caller's hand and in the e-mail, and nowhere else.
 *  2. **Every returned value is deeply frozen.** Callers read rows; they never reach in and mutate
 *     one and expect the store to notice.
 *  3. **The tenant scope is explicit.** `tx(tenantId, fn)` is the only way to reach a row, because
 *     `SET LOCAL app.tenant_id` is what every RLS policy in 0004 reads, and `SET LOCAL` is only
 *     meaningful inside a transaction. `tx(null, fn)` is the pre-authentication window: it reaches
 *     exactly the two tables whose policies expose it (`device_codes`, `oauth_clients`) and fails
 *     closed everywhere else. That is the documented behaviour, not a limitation to work around --
 *     the way in is `resolve.*`, the SECURITY DEFINER resolvers in 0007.
 *  4. **Time comes from the injected `Clock`** for every TTL this code computes. The plpgsql
 *     functions in 0005 compare against the database's own `now()`, so a fake clock must stay
 *     near real time; a test that needs an expired row asks for a negative TTL instead of
 *     travelling.
 */
import type {
  Account,
  ApproveDeviceCodeInput,
  ApproveDeviceCodeResult,
  AppendAuditInput,
  AuditEntry,
  AuthCode,
  Clock,
  ConsumeAuthCodeInput,
  ConsumeAuthCodeResult,
  CountAuditByTargetInput,
  CreateCredentialInput,
  CreateDeviceCodeInput,
  CreateInviteInput,
  CreateOAuthClientInput,
  CreateOrgInput,
  CreateSessionInput,
  CreateTenantInput,
  CreateUserInput,
  Credential,
  DenyDeviceCodeResult,
  Device,
  DeviceCode,
  IssueAuthCodeInput,
  Invite,
  IssueRefreshTokenInput,
  InviteIssueHistory,
  Iso,
  LoginOtpStatus,
  LoginOtpStatusInput,
  LoginPrecheckInput,
  OAuthClient,
  Org,
  OrgStatus,
  Person,
  PollDeviceCodeResult,
  RecordSuccessInput,
  RedeemDeviceCodeInput,
  RedeemInviteInput,
  RedeemInviteResult,
  ReasonCode,
  RefreshToken,
  ReserveAttemptInput,
  ReserveAttemptResult,
  RotateRefreshTokenInput,
  RotateRefreshTokenResult,
  SendLoginOtpInput,
  SendLoginOtpResult,
  Session,
  SetPasswordInput,
  Tenant,
  TenantConfig,
  TenantStatus,
  UpsertDeviceInput,
  UpsertDeviceResult,
  UpsertTenantConfigInput,
  User,
  UserRole,
  UserStatus,
  VerifyLoginOtpInput,
  VerifyLoginOtpResult,
} from "./inputs";

export * from "./entities";
export * from "./inputs";

// ---------------------------------------------------------------------------
// Operations, inside one tenant-scoped transaction
// ---------------------------------------------------------------------------

export interface PortalOps {
  readonly tenants: {
    create(input: CreateTenantInput): Promise<Tenant>;
    findById(id: string): Promise<Tenant | null>;
    findBySlug(slug: string): Promise<Tenant | null>;
    setStatus(id: string, status: TenantStatus): Promise<Tenant | null>;
    /**
     * The DISPLAY name. The slug is the identity and never changes; this is what a person reads,
     * and `otp/product-name.ts` prints it when the tenant has chosen one. `pnpm portal:seed
     * --tenant-name` is the supported way to correct it on a tenant that already exists.
     */
    setName(id: string, name: string): Promise<Tenant | null>;
  };

  readonly tenantConfig: {
    get(tenantId: string): Promise<TenantConfig | null>;
    /** Bumps `version` on every write, so the client can be told "unchanged". */
    upsert(input: UpsertTenantConfigInput): Promise<TenantConfig>;
  };

  readonly orgs: {
    create(input: CreateOrgInput): Promise<Org>;
    findById(id: string): Promise<Org | null>;
    findBySlug(tenantId: string, slug: string): Promise<Org | null>;
    /** Every org of one tenant, oldest first: how the operator's tool picks a default. */
    listForTenant(tenantId: string): Promise<readonly Org[]>;
    setStatus(id: string, status: OrgStatus): Promise<Org | null>;
    setSeatCap(id: string, seatCap: number): Promise<Org | null>;
    /** `orgs.sso_required` (0017): on, non-owners sign in through the org's OIDC provider only. */
    setSsoRequired(id: string, required: boolean): Promise<Org | null>;
    /** `count_active_users(uuid)` from 0005, called, not re-implemented. */
    countActiveUsers(orgId: string): Promise<number>;
    /**
     * Would a NEW session for this person fit the org's cap right now? The seat branch of
     * `login_precheck` (0005) with the same arithmetic and without its advisory lock: an answer
     * for a page that has not spent an invite or a code yet, not a gate. The gate is still
     * `loginPrecheck` when the authorization code is exchanged, because a seat can go in between.
     */
    hasSeatFor(orgId: string, userId: string): Promise<boolean>;
    /**
     * People on record in the org who are not disabled, invited ones included. The operator's
     * `portal:account create` checks the seat cap against it: stricter than `count_active_users`
     * (which counts only people with a live session), because an account that is created and cannot
     * sign in for want of a seat is a worse surprise than a refusal at creation.
     */
    countProvisioned(orgId: string): Promise<number>;
  };

  readonly users: {
    create(input: CreateUserInput): Promise<User>;
    findById(id: string): Promise<User | null>;
    findByEmail(tenantId: string, email: string): Promise<User | null>;
    setStatus(id: string, status: UserStatus): Promise<User | null>;
    /** The one place a role changes after the member exists. Only the operator's tool calls it. */
    setRole(id: string, role: UserRole): Promise<User | null>;
    /** Operator-only per-user API gateway endpoint assignment (`null` reverts to default pinned gateway). */
    setGatewayEndpoint(id: string, gatewayEndpoint: string | null): Promise<User | null>;
    /**
     * Members who hold `owner` and are not disabled, invited ones included: a tenant needs one.
     * **Locks those rows** (`FOR UPDATE`) until the transaction ends, so two operators cannot each
     * see two owners and each demote one: the second waits, re-reads, and finds one.
     */
    lockOwners(tenantId: string): Promise<number>;
  };

  readonly devices: {
    /** Upsert on `(user_id, install_id)`. A revoked row is refused. */
    upsert(input: UpsertDeviceInput): Promise<UpsertDeviceResult>;
    findById(id: string): Promise<Device | null>;
    findByInstall(userId: string, installId: string): Promise<Device | null>;
    revoke(id: string, reason: string): Promise<Device | null>;
    touch(id: string): Promise<void>;
  };

  readonly sessions: {
    create(input: CreateSessionInput): Promise<Session>;
    findById(id: string): Promise<Session | null>;
    listLiveForUser(userId: string): Promise<readonly Session[]>;
    /** `revoke_session_chain` from 0005: the session, its whole chain, and one audit row. */
    revoke(id: string, reason: string): Promise<Session | null>;
    revokeAllForUser(userId: string, reason: string): Promise<number>;
    revokeAllForDevice(deviceId: string, reason: string): Promise<number>;
    touch(id: string, ip?: string | null, userAgent?: string | null): Promise<void>;
  };

  readonly refreshTokens: {
    /** Generation 1 under a fresh session. */
    issue(input: IssueRefreshTokenInput): Promise<RefreshToken>;
    /** `rotate_refresh_token(...)` from 0005. Only legal once `app.tenant_id` is set. */
    rotate(input: RotateRefreshTokenInput): Promise<RotateRefreshTokenResult>;
    listForSession(sessionId: string): Promise<readonly RefreshToken[]>;
  };

  readonly deviceCodes: {
    create(input: CreateDeviceCodeInput): Promise<DeviceCode>;
    findByUserCode(userCode: string): Promise<DeviceCode | null>;
    approve(input: ApproveDeviceCodeInput): Promise<ApproveDeviceCodeResult>;
    deny(userCode: string): Promise<DenyDeviceCodeResult>;
    /** Counts the poll, applies `slow_down` and the 200-poll ceiling, then reports the state. */
    poll(rawDeviceCode: string, installId: string): Promise<PollDeviceCodeResult>;
    /** Single use: `redeemed` + `used_at` + `session_id`, in the caller's transaction. */
    redeem(input: RedeemDeviceCodeInput): Promise<DeviceCode | null>;
    /** `expire_device_codes()` from 0005. */
    expireDue(): Promise<number>;
  };

  readonly loginOtps: {
    /**
     * Mints a code and **retires every earlier unused code of the same address and purpose**: a
     * second code replaces the first, and the first never works again, whether or not the second
     * was used. Sends for one address are serialised, so two requests that arrive together cannot
     * both pass the budget or the `dedupeWithinMs` check.
     */
    send(input: SendLoginOtpInput): Promise<SendLoginOtpResult>;
    /** Marks one code used without anyone having used it: a code whose e-mail never went. */
    retire(id: string): Promise<void>;
    verify(input: VerifyLoginOtpInput): Promise<VerifyLoginOtpResult>;
    /**
     * Read-only, so a flow can tell a person the truth (locked, or a code was just sent) before it
     * mints another one. The same counts `send` and `verify` use; nothing here writes or locks.
     */
    status(input: LoginOtpStatusInput): Promise<LoginOtpStatus>;
    /** `prune_login_otps()` from 0005: keeps 24 h so the send window stays countable. */
    prune(): Promise<number>;
  };

  /**
   * The invite that gates a first sign-in (`apps/portal/migrations/0011_invites.sql`): one live
   * code per address, bound to it, single use. Redeeming activates the `invited` member.
   */
  readonly invites: {
    /** Retires any live invite for the address, then inserts. Only sha256 of the code is stored. */
    create(input: CreateInviteInput): Promise<Invite>;
    /** Checks, counts and consumes in the caller's transaction, and activates the member. */
    redeem(input: RedeemInviteInput): Promise<RedeemInviteResult>;
    /** The newest invite for the address that has not been replaced. Redeemed and expired ones count. */
    latestForEmail(tenantId: string, email: string): Promise<Invite | null>;
    /** Invites issued for the address since `since`, retired ones included: the resend budget. */
    issuedSince(tenantId: string, email: string, since: Iso): Promise<InviteIssueHistory>;
  };

  /**
   * Password sign-in (`apps/portal/migrations/0012_password_signin.sql`): one scrypt credential per
   * person, created only by the operator's `portal:account`. The code sign-in never reads it.
   */
  readonly credentials: {
    /**
     * Inserts the credential for an existing person, taking the tenant from their `users` row.
     * `null` when it conflicted: the person already has one, or the username is taken in the tenant.
     */
    create(input: CreateCredentialInput): Promise<Credential | null>;
    findByUserId(userId: string): Promise<Credential | null>;
    /** By username, or by e-mail address when the identifier holds an `@`, inside one tenant. */
    findAccount(tenantId: string, identifier: string): Promise<Account | null>;
    /** Every person in the org, oldest first, with their credential when they have one. */
    listPeople(tenantId: string, orgId: string): Promise<readonly Person[]>;
    reserveAttempt(input: ReserveAttemptInput): Promise<ReserveAttemptResult>;
    /**
     * Clears the counters and the lock, stamps the sign-in, and re-hashes when asked to -- but only
     * while the stored hash is still `expectHash`. `false` when it was not: nothing was written.
     */
    recordSuccess(input: RecordSuccessInput): Promise<boolean>;
    /** The count, the slots and the lock back to nothing, and no other column. For an `enable`. */
    clearAttempts(userId: string): Promise<void>;
    /**
     * Replaces the password, clears the counters and the lock, and sets `must_change`. `false` when
     * `expectHash` was given and no longer matched: nothing was written.
     */
    setPassword(input: SetPasswordInput): Promise<boolean>;
  };

  readonly authCodes: {
    issue(input: IssueAuthCodeInput): Promise<AuthCode>;
    consume(input: ConsumeAuthCodeInput): Promise<ConsumeAuthCodeResult>;
  };

  readonly oauthClients: {
    create(input: CreateOAuthClientInput): Promise<OAuthClient>;
    findByClientId(clientId: string): Promise<OAuthClient | null>;
    /** Constant-time compare of sha256(secret). */
    verifySecret(clientId: string, secret: string): Promise<boolean>;
    rotateSecret(clientId: string, secret: string): Promise<OAuthClient | null>;
    /**
     * Replace the redirect allowlist. Separate from `rotateSecret` on purpose: a deployment that
     * gains a second public origin — the review instance behind a tunnel is the first one — has to
     * register that callback **without** invalidating the secret every running process already
     * holds. The caller decides the whole list; nothing here merges, so a removal stays expressible.
     */
    setRedirectUris(clientId: string, redirectUris: readonly string[]): Promise<OAuthClient | null>;
    allowsRedirect(clientId: string, redirectUri: string): Promise<boolean>;
  };

  /**
   * The portal's own browser session, which is a signed cookie rather than a row
   * (`src/security/web-session.ts`). This is the one piece of it that is server-side: a per-user
   * version counter the cookie carries, so a revocation takes effect on the next request (SR-21).
   */
  readonly webSessions: {
    /** The live version for a user. **No row means 1** — nothing is back-filled. */
    version(userId: string): Promise<number>;
    /** Bump it, ending every portal browser session that user holds. Returns the new version. */
    revoke(input: { readonly userId: string; readonly tenantId: string }): Promise<number>;
  };

  /**
   * OIDC sign-in (0017): the (issuer, subject) bindings a finished SSO sign-in leaves behind, and
   * the single-use login states a PKCE round trip keeps server-side.
   */
  readonly oidc: {
    /** The user a binding points at, inside the door's tenant scope; NULL when unbound. */
    findUserByIdentity(tenantId: string, issuer: string, subject: string): Promise<string | null>;
    /**
     * First sign-in through this provider: bind (issuer, subject) to the seat the verified
     * e-mail matched. `ON CONFLICT DO NOTHING` -- a raced first sign-in keeps the first binding.
     */
    bindIdentity(input: {
      readonly tenantId: string;
      readonly userId: string;
      readonly issuer: string;
      readonly subject: string;
    }): Promise<void>;
    createState(input: {
      readonly tenantId: string;
      readonly stateHash: Buffer;
      readonly nonceHash: Buffer;
      readonly sealed: string;
      readonly provider: string;
      readonly expiresAt: Date;
    }): Promise<void>;
    /**
     * `DELETE ... RETURNING` in one statement: single-use. NULL for an unknown or expired state.
     */
    consumeState(
      tenantId: string,
      stateHash: Buffer,
    ): Promise<{ readonly nonceHash: Buffer; readonly sealed: string; readonly provider: string } | null>;
  };

  readonly audit: {
    append(input: AppendAuditInput): Promise<AuditEntry>;
    list(filter?: {
      readonly tenantId?: string;
      readonly action?: string;
      readonly limit?: number;
    }): Promise<readonly AuditEntry[]>;
    /**
     * How many rows of `action` each target has had since `since`, inside the tenant. Only targets
     * with at least one row are in the map. `created_at` is the database's own clock, so `since` has
     * to be a time that clock agrees with (the injected clock, near real time).
     */
    countByTarget(input: CountAuditByTargetInput): Promise<ReadonlyMap<string, number>>;
  };

  /** `login_precheck(uuid, uuid, uuid)` from 0005, with its advisory lock. */
  loginPrecheck(input: LoginPrecheckInput): Promise<ReasonCode>;
}

/**
 * The pre-authentication resolvers (`apps/portal/migrations/0007_tenant_resolvers.sql`).
 * Each answers at most a tenant id, so none of them confirms that a code, a token or an address
 * is valid to a caller who does not already hold it.
 */
export interface TenantResolvers {
  bySlug(slug: string): Promise<string | null>;
  /** NULL when the address is unknown **or** matches users in more than one tenant. */
  byEmail(email: string): Promise<string | null>;
  /** NULL when the username is unknown **or** is used in more than one tenant. */
  byUsername(username: string): Promise<string | null>;
  byRefreshToken(rawToken: string): Promise<string | null>;
  byDeviceCode(rawDeviceCode: string): Promise<string | null>;
  byUserCode(userCode: string): Promise<string | null>;
  byAuthCode(rawCode: string): Promise<string | null>;
  byClientId(clientId: string): Promise<string | null>;
  /** The callback's only way to a tenant: NULL for an unknown, expired or consumed state. */
  byOidcState(stateHash: Buffer): Promise<string | null>;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

export interface MigrateOptions {
  /**
   * Development only (`src/boot.ts` decides): after migrating, set `portal_app_login`'s password to
   * this. Production provisions login roles out of band (`0001_extensions_and_roles.sql:53-55`).
   */
  readonly appLoginPassword?: string;
}

/**
 * Who the store's connection really is, from `pg_roles`: what `src/boot.ts` checks before the
 * server listens. Every field is a way to see past the tenant policies in `0004_rls.sql`, except
 * `portalApp`, which is the membership every grant in that file is made to.
 */
export interface ConnectionRole {
  readonly name: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  /** A member of `portal_admin`, whose policy on every table is `USING (true)`. */
  readonly portalAdmin: boolean;
  readonly portalApp: boolean;
  /** Other roles it may `SET ROLE` to that are superuser or `BYPASSRLS`, by name. */
  readonly privilegedRoles: readonly string[];
}

export interface PortalStore {
  readonly clock: Clock;
  /**
   * One transaction with `SET LOCAL app.tenant_id`. `null` opens the pre-authentication window.
   * The callback's return value is passed through; a throw rolls the transaction back.
   */
  tx<T>(tenantId: string | null, fn: (ops: PortalOps) => Promise<T>): Promise<T>;
  readonly resolve: TenantResolvers;
  /**
   * Applies 0001-0005 (theirs, unchanged) then 0006+ (ours), idempotently. Only on the schema
   * owner's connection (`openMigrationStore`): the server's role cannot, and must not be able to.
   */
  migrate(options?: MigrateOptions): Promise<MigrationResult>;
  /** The connection's role as `pg_roles` has it. A catalog read, outside any tenant scope. */
  connectionRole(): Promise<ConnectionRole>;
  close(): Promise<void>;

  /**
   * Refresh arrives with no `tid` -- the client sends a token and a device id and nothing else.
   * So this one composes the resolver with the scoped transaction, which is the sequence the
   * refresh handler must not get wrong.
   */
  rotateRefreshToken(input: RotateRefreshTokenInput): Promise<RotateRefreshTokenResult>;
  /** Same shape: the polling app holds a device code and knows no tenant. */
  pollDeviceCode(rawDeviceCode: string, installId: string): Promise<PollDeviceCodeResult>;
}
