# apps/portal — agent rules

**This is a stand-in for the backend team's portal** (`api.tokotokenai.com`), built so the hosted
Nultron web app has a real login to develop and review against before that service exists. It is
wire-compatible with [`docs/internal/portal/`](../../docs/internal/portal/) — `device-code-login.md`
for the flow, `schema.md` for the data model, `migrations/0001-0005` for the schema itself.

Read [`docs/internal/web-phase9-portal-login.md`](../../docs/internal/web-phase9-portal-login.md)
before working here. It is the plan of record and it names the lanes.

## The three rules that make this safe to keep in the repo

1. **The portal never imports the product.** No `@agentforge/db`, no `@agentforge/host`, no
   `@agentforge/core`. It has its own store, its own data directory, its own logger and its own
   config. If something here needs a helper the host already has, it gets its own copy — the idiom
   is borrowed, the module is not.
2. **The product never imports the portal.** `apps/web`, `packages/host` and `packages/core` reach
   it only over HTTP, through `AGENTFORGE_PORTAL_URL`. A `from "@agentforge/portal"` anywhere
   outside this directory is a bug.
3. **`docs/internal/portal/migrations/0001-0005` are the backend team's files.** They are read at
   runtime, never copied and never edited. Anything the browser login needs that they do not have
   goes in a new numbered file under [`migrations/`](migrations/) — today `0006_browser_login.sql`
   (oauth_clients, auth_codes, device_codes.platform and the poll-window counters),
   `0007_tenant_resolvers.sql` (the `SECURITY DEFINER` tenant resolvers `schema.md` says are
   missing), `0008_oauth_client_scope.sql` (closing the pre-authentication window 0006 opened
   on `oauth_clients`, which nothing needed), `0009_web_session_revocation.sql` (the portal's own
   browser session counter), `0010_app_login_role.sql` (the server's login role, which 0001
   describes and nobody had created), `0011_invites.sql` (the invite that gates a first sign-in),
   `0012_password_signin.sql` (the credentials of the password sign-in) and `0013_password_grace.sql` (the
   attempts a source with no earlier failure may take under that sign-in's lock).
   Same style: one transaction per file,
   `IF NOT EXISTS`, `DROP POLICY` before `CREATE POLICY`, and every new table placed explicitly
   into one of the three RLS shapes `0004_rls.sql` defines.

## Postgres, and only Postgres

`PORTAL_DATABASE_URL` is required and must be `postgres://`. There is no SQLite driver and there
should not be one: the interesting parts of this schema are RLS policies, plpgsql functions and a
partitioned table, and a second driver would mean a second definition of reuse detection and a
second definition of a seat. `PORTAL_DATABASE_URL` is also never `DATABASE_URL` — that one is the
product's SQLite desk and the two must not be able to point at each other.

**Two roles, never one.** `PORTAL_MIGRATE_DATABASE_URL` is the schema owner's DSN, and it only ever
runs migrations, on a connection `src/boot.ts` closes before anything listens. `PORTAL_DATABASE_URL`
is the server's, and it is `portal_app_login`, a plain member of `portal_app`. A superuser, a
`BYPASSRLS` role or a member of `portal_admin` skips every tenant policy, so production refuses to
boot on one. Do not "fix" a boot refusal by giving the server role more, just as you would not for a
failing isolation test.

`docker compose -f compose.yml up -d` gives you Postgres 16 on `127.0.0.1:5433` and Mailpit on
`127.0.0.1:1025` (UI at `http://127.0.0.1:8025`). Both are loopback-only.

## Tenant scope is not optional

Every RLS policy in `0004_rls.sql` reads `app.tenant_id`, and `SET LOCAL` only exists inside a
transaction — so `store.tx(tenantId, ops => …)` is the only way to reach a row, and there is
deliberately no "just run one query" escape hatch. `tx(null, …)` is the pre-authentication window
and reaches exactly the two tables whose policies expose it (`device_codes`, `oauth_clients`).

When the tenant is not known yet — a refresh token, an authorization code, a `client_id`, an
e-mail address — use `store.resolve.*`. Those are the `SECURITY DEFINER` resolvers in 0007 and each
returns **at most a tenant id**, so none of them tells a caller whether a value was ever valid.

## Secrets

- Raw codes and tokens are **never** stored. Only `sha256(raw)`, in a `bytea` column with a
  `CHECK (octet_length(...) = 32)`. That covers refresh tokens, device codes, OTPs, authorization
  codes, invite codes and client secrets.
- Comparisons of secret material use `hashEquals` (constant time), never `===`.
- `user_code`, `device_code`, refresh tokens, JWTs, OTPs and client secrets are **never logged**.
  `src/log.ts` enforces that at the sink: any field whose name carries a credential word is
  dropped, and any string value shaped like a token is scrubbed. Do not work around it — rename
  the field.
- There is no plaintext outbox and no "log the code" path. Mail goes over SMTP to Mailpit in
  development and to a provider in production; `loadConfig` refuses to start a production process
  that has no `PORTAL_SMTP_HOST`.
- `pnpm portal:otp <email>` **issues** a new code for an operator to read out (it cannot read a
  stored one back — only the hash exists). It needs `PORTAL_ALLOW_MANUAL_OTP=1`, is refused in
  production, and writes `otp.issued_manually` to the audit log. It refuses an address that is
  still `invited` (it has no session to give a code to): that address needs an invite.
- **Nobody signs up, and the sign-in says which situation you are in.** A first sign-in needs an
  invite an operator issued (`pnpm --filter @agentforge/portal invite -- --email <address> --role <role>`,
  `src/invites/`) and the portal **e-mails** the code to that address; the CLI prints it only with
  `--print`. The browser sign-in is a state machine in `src/flows/sign-in.ts`, rendered by
  `routes/sign-in-flow.ts` for both doors (`/authorize/*` and `/activate/*`): e-mail first, then an
  activated member gets the six-digit code, an invitee gets the invite screen (no code sent), a spent
  invite or no access gets a dead-end page, a lock gets its own, and an org with no seat left says so
  (`seat_cap_reached`, asked with `orgs.hasSeatFor` at the e-mail step and again before an invite is redeemed
  or a code sent; the exchange still checks, because a seat can go in between). A valid invite activates the
  member and then the e-mailed code still follows, because the invite does not prove the inbox on its own.
  **A code is retired by its successor** (`store.loginOtps.send` marks the older unused codes used, and a
  successful verify marks the rest) and **a repeat of one post is not a new request** (a code still live and
  under `OTP_DUPLICATE_WINDOW_MS`, 15 s, answers it: nothing minted, mailed or counted). Keep both: without the
  first a replaced code signs in again once the newer one is used, without the second a double click spends the
  three sends a quarter hour allows and the person types the mail that no longer works.
  **SR-30 was changed on purpose here (owner, 2026-10-01):** the e-mail step used to be one neutral
  page for every address, and now it is an oracle for member / invitee / neither by design. What stands
  in for the neutral page is the limits (`signInEmailIp`, `signInEmailAddress`, `inviteAttemptIp`, the
  invite resend budget, the OTP limits) -- do not loosen them without re-reading that decision, and
  remember they key on the caller's address, so they need `PORTAL_TRUST_PROXY=1` behind a proxy. Nothing
  else may be revealed: no tenant, org, role or member list. Never log, audit or echo an invite code.
- **Roles.** Every invite carries `owner | admin | member` (default `member`); redeeming copies it onto
  the member; the portal sends it to the host as the access token's `role` claim and the token
  response's `role` field, read from the member's row at every mint and refresh (a member it cannot read
  gets `member`, never `owner`). A tenant always keeps an owner: the first invite for a tenant, and any
  that would leave none, must be `owner`, and the last owner cannot be demoted. A role changes in one
  place, `invites/role.ts` through the CLI, and there is no portal route for it. The host must not
  default a missing role to `owner`.

## Password sign-in (`PORTAL_SIGNIN_MODE=password`)

**What it is.** A second way in, for a deployment that does not want e-mailed codes (owner, 2026-10-07, for
one white-label deployment): a username (or the address on record) and a password, no e-mail sent, SMTP not needed to boot.
Everything after the person is proved is the code sign-in's own tail: the same login gate, the same
authorization code, the same portal cookie and the same `role` claim. The decision record and every control
is SR-165 in [`docs/internal/security-register.md`](../../docs/internal/security-register.md); the flow is in
[`device-code-login.md`](../../docs/internal/portal/device-code-login.md), "Password sign-in".

**The switch.** `PORTAL_SIGNIN_MODE` is read once, at boot, by `loadConfig`. Unset (or empty) is `code`, and
in `code` mode **nothing changes**: `src/routes/code-mode-unchanged.test.ts` pins twenty-one routes and
eighteen screens so the default cannot drift. Any other value than `code` and `password` refuses to start. In
`password` mode the e-mail, invite and verify routes are not registered (they answer the server's own 404),
`invite` and `otp` exit 3, the mailer refuses to send, and `GET /auth/signin-mode` answers
`{"mode":"password"}` (it exists only in this mode, and the host believes only that word).

**The operator command.** There is no sign-up and no self-service reset. `pnpm --filter @agentforge/portal
account <command>`, or `sh webapp-deploy/scripts/portal.sh account <command>` on the box: `create`
(a username, an address, a role; prints a generated initial password **once**), `reset-password`, `disable`,
`enable`, `set-role`, `list`. An initial or reset password must be replaced before a session exists. The code
is `src/accounts/`; the command refuses to run unless the portal is in password mode.

**Where it lives.** `src/flows/password-sign-in.ts` holds the steps (identify, verify, change; a second
factor goes between verify and change); `src/routes/password-flow.ts` is the two posts, shared by
`/authorize/*` and `/activate/*`; `src/store/postgres/credentials.ts` is the table and the lock;
`src/password/` is scrypt and the policy; `src/security/password-attempts.ts` is the in-process record of
which sources have attempted whom.

**Rules that are easy to break.**

- **One refusal, one cost.** An unknown username, a wrong password, a locked account and a disabled person
  get the same sentence and exactly one scrypt derivation. A new refusal that is cheaper or says something
  different is an oracle.
- **An attempt is counted before the password is compared**, in one transaction that holds the row, and the
  hash goes only to a caller that won an increment. Five attempts lock the account for fifteen minutes; while
  it is locked, a source that has not itself attempted that person in the window may take up to three more,
  counted in the same row (`grace_attempts`), so the most passwords a window ever tries is **five plus
  three**, whoever asks. Do not move the count after the comparison, and do not let the record of sources
  raise that number: it only decides who may ask for a slot.
- **A step takes a derivation permit before it counts or looks up anything** (`PasswordHasher.admit`, eight
  at a time) and answers `503` when there is none, so a refusal for want of a place costs nobody an attempt.
- **Sources are an IPv4 address or an IPv6 /56** (`sourceBucket`, `IPV6_SOURCE_PREFIX_BITS`). It is not a
  /64 because one routed /48 is 65,536 of those, enough to hold every derivation permit; as a /56 it is 256.
  The password routes only: the code sign-in's limits still count the whole address. The lockout's record of
  sources is fed the same value: one function says what a source is.
- **A fresh sign-in is held to the forced change at its end, as a resumed cookie is.** `completeSignIn` and
  `signedInOnActivate` read `must_change` in the transaction that issues the code or the cookie
  (`mustChangePasswordFirst`), so a `reset-password` that lands after the password check gets the change
  page and nothing else. Keep that read in front of every place a session or a code is minted.
- **The audit rows an outsider can cause name the system as the actor and the person as the target.** None
  is written for an unknown username or for an attempt that was not counted, so the table cannot be grown
  without bound. Never put a password, a hash or a typed identifier in a row, a log line or a URL.
- **Not built, on purpose:** a second factor (no column, no placeholder), self-service reset, a list of
  breached passwords, a place to see an initial password again. The operator sees initial passwords; that is
  a recorded residual, not an oversight.

## Lanes

This directory is split between two lanes of the Phase 9 plan.

| Owned by | Files |
|---|---|
| Lane A (done) | `package.json`, `src/{config,log,crypto,server,main,index,manual-otp,boot,process-guards}.ts`, `src/store/**`, `src/mail/**`, `src/seed/**`, `scripts/**`, `test/**` |
| Lane B (done) | `src/{routes,flows,views,otp,security,jwt}/**`, `locales/**`, `migrations/0008+`, `src/testing/**`, `compose.yml`, these two files |

Lane B extended the server through `createPortalServer(...).register(route)` — the route table is
the seam, so `/authorize`, `/activate`, `/auth/device/*` and `/auth/token` are a list of route
objects (`src/routes/index.ts`) rather than a rewrite of `src/server.ts`.

## Where the login lives

Read [`docs/internal/maps/portal-service.md`](../../docs/internal/maps/portal-service.md) before
changing any of it — it carries the wire contract, every security control with the test that pins
it, and the gotchas. The shape in one paragraph: **routes are thin** (`src/routes/**`: parse,
limit, check CSRF, call a flow, render), **flows hold the decisions** (`src/flows/**`), **guards
live in one place each** (`src/security/**`), and every user-facing string is a key in
`locales/{en,id}/portal.json` — including the reason-code table, which the JSON error bodies and
the HTML pages both read so there is one copy of it.

Four rules that are easy to break here:

- **One `Set-Cookie` per response.** `PortalResponse.headers` is `Record<string, string>`, so a
  second cookie silently has nowhere to go. `htmlResponse` / `redirectResponse` take one `cookie`.
- **Nothing redirects before the client and the `redirect_uri` are validated**, on every hop,
  including the form posts — a hidden field is a field the user edits.
- **Every interpolation into a page goes through the `html` tag** (`src/views/escape.ts`).
  `raw()` is the only escape hatch and exists to be greppable.
- **The tests connect as `portal_app_test`**, a non-superuser member of `portal_app`
  (`src/testing/pg.ts`). Do not "fix" a failing isolation test by giving that role more; a policy
  refusing it is the test working.

## Tests

`pnpm --filter @agentforge/portal test`. Real PostgreSQL, always:

- `PORTAL_TEST_DATABASE_URL` if it is set (point it at the compose service);
- otherwise `embedded-postgres`, which ships real PG 16 binaries and needs no Docker.

**On Windows, under an administrator token, `embedded-postgres` refuses to start** ("Execution of PostgreSQL by a
user with administrative permissions is not permitted"). The run then **fails**: `test/global-setup.ts` throws an
error that carries the server's own output and says what to do, and the command exits non-zero. (Until 2026-10-01 it
printed "No test files found" and exited **0**, and so did a run with a failing test: importing `embedded-postgres`
installs an `async-exit-hook` whose `beforeExit` handler calls `process.exit(0)` over vitest's `process.exitCode = 1`.
`keepExitCode` in the global setup restores it. A suite you did not see print "Tests N passed" did not run.) Run
the suite from a non-elevated shell, or drop the token for one command with `runas /trustlevel:0x20000 "cmd /c ..."`
(`runas` returns at once: have the command write its log and exit code to files and wait for them). Pointing
`PORTAL_TEST_DATABASE_URL` at a Docker Postgres works too, but Docker Desktop's VM clock can run seconds behind
the host and fail the few tests that compare database time with the test's own clock.

`test/global-setup.ts` starts one server per run and builds `portal_template` with every migration
applied; each test file then takes a private database from that template. Two reasons, both worth
keeping: suites cannot see each other's rows, and the cluster-wide `CREATE ROLE` in 0001 happens
once instead of racing across parallel workers.

Copy nothing from the product's test setup into here, and never point a test at the compose volume
you are also using by hand — the suite drops every `portal_test_*` database it finds at the end.

`src/testing/server.ts` starts a **real** portal on an ephemeral port with a captured mail
transport and an array log sink; `src/routes/{browser,api}.test.ts` drive it over HTTP, which is
the only way to prove "a browser can sign in and the host can redeem the code" — and the only way
to assert that no OTP, code or token reached a log line.
