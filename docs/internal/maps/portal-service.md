# Map — Portal service (`apps/portal`)

Product: both · Instance: hosted (review :3443 for live proof; no :3000 drive)

Last verified: 2026-10-09 at 9121f295 for the new Touches / Do not touch section only (file lists checked against the tree and the imports named there; nothing else re-read). Before that: 2026-10-07 at 9aba37e + working tree for section 8 (password sign-in), Where things live, the
Verify table's last four rows and one Why bullet, written the day the mode was built; the rest of the page keeps
its reading below. Earlier: 2026-10-01 at 0b61a29 + working tree, by the sign-in-codes pass (four fixes found by driving
the pilot: a replaced code no longer signs in, one request is one code, the fifth wrong invite code is the
lock, the seat cap is told at the first step; plus the test run's exit code). That pass rewrote section 3's
state table and bullets, the OTP and sign-in rows of section 6, Where things live, three Gotchas and
Verify, and re-anchored their citations (`flows/sign-in.ts`, `otp/send.ts`, `store/postgres/otps.ts`,
`routes/sign-in-flow.ts` all moved) and re-anchored four older ones the map checker flagged
(`toTokens`, `getAuthorize`, `exchangeAuthorizationCode`, `signAccessToken`). The pass before it, the invite / sign-in-states / roles pass (the
invite-gated first sign-in, the e-mail step as a state machine, `portal:invite` and its e-mail, roles in
the token), changed — the wire contract, section 3, the controls table, Where things
live, Gotchas and Verify — were rewritten against the code and their citations re-anchored; everything
else keeps its 2026-09-23 reading at d4561b8 (the portal defect pass; the host auth pass that day
re-anchored the one citation into `packages/host/src/auth/portal-client.ts` it moved, `toTokens`). Grep
for the identifier before trusting a line number in a section this pass did not touch. A second pass the same
day added the lock's wait time (`otp-lock.ts`, `waitText`), re-anchored the citations that had drifted, and
drove the whole flow on the local Kubernetes rehearsal (Verify, the sixth drive).

## Overview

`apps/portal` is the stand-in for the Toko Token AI control plane at `api.tokotokenai.com` — the
service that owns tenants, orgs, users, devices, sessions and seats, and that the hosted Nultron
web app signs in against. It exists so the product has a **real** login to build and review
against before the backend team's service does, and it is wire-compatible with
[`../portal/device-code-login.md`](../portal/device-code-login.md) and
[`../portal/schema.md`](../portal/schema.md).

It is **not** part of the product. It never imports `@agentforge/db`, `@agentforge/host` or
`@agentforge/core`, and nothing in `apps/web`, `packages/host` or `packages/core` imports it —
the product reaches it over HTTP through `AGENTFORGE_PORTAL_URL`, exactly as it will reach the
real one. Its store is its own PostgreSQL under `PORTAL_DATABASE_URL`, never `DATABASE_URL`.

Two neighbouring pages own what this one does not:
[`portal-session-auth.md`](portal-session-auth.md) is the **host's** half of the contract (the
browser session the product mints after redeeming a code), and
[`hosted-security-controls.md`](hosted-security-controls.md) is the product's own perimeter.
This page is the portal side of the wire and nothing else.

## How it works

### 1. The wire contract

Frozen 2026-09-21 and documented from the other side in
`packages/host/src/auth/portal-client.ts:15-48`. Twenty routes, all static paths, registered
onto the server through `registerPortalRoutes` (`apps/portal/src/routes/index.ts:28`). Two of
them — `GET` and `POST /logout` — are fix pass X's, and the four `…/invite` and `…/invite/resend` posts are
the invite pass's: none of the six is part of the frozen host contract, because the host names the
`/authorize` URL, the browser follows it, and nothing server-to-server calls them.

| Method | Path | Body in | Body out |
|---|---|---|---|
| GET | `/authorize` | `response_type=code&client_id&redirect_uri&state` | HTML, or `302 {redirect_uri}?code&state` |
| POST | `/authorize/email` | form: `csrf_token`, the four authorize fields, `email`; or `resend=1` ("send a new code"), or `restart=1` ("use a different e-mail") | HTML: which screen follows is the portal's decision (section 3) |
| POST | `/authorize/invite` | the same fields + `email`, `invite_code` | HTML: the e-mailed-code screen after a valid invite, or the invite screen / a dead end |
| POST | `/authorize/invite/resend` | the same + `email` | HTML: the invite screen with a notice |
| POST | `/authorize/verify` | the same + `email`, `code` | HTML on failure, `302` on success |
| GET | `/activate` | `?code=<user_code>` | HTML (the sign-in screen, or the device screens with "You are signed in as …") |
| POST | `/activate/email`, `/activate/invite`, `/activate/invite/resend`, `/activate/verify` | the same four, with `user_code` in place of the OAuth fields | HTML (the approve screen after verify) |
| POST | `/auth/device/approve` | form **or** JSON: `csrf_token`, `user_code`, `decision` | HTML, or `{status, device_label}` |
| GET | `/logout` | `?client_id&post_logout_redirect_uri` (both optional) | HTML, or `302` to a registered origin — always clears the session cookie |
| POST | `/logout` | form: `csrf_token`, the same two | the same |
| POST | `/auth/device/code` | `{install_id, tenant_hint?, platform?, app_version?, label?}` | `{device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval}` |
| POST | `/auth/device/token` | `{device_code, install_id}` | the token body below |
| POST | `/auth/token` | `{grant_type, …}` — see below | the token body below |
| POST | `/auth/logout` | Bearer + `{all_devices}` | `204`, always |
| GET | `/auth/session` | Bearer | `{user, org, tenant, device, session}` |
| GET | `/tenant/config` | Bearer, or `?tenant=<slug>` | branding (+ flags and allowlist for a Bearer) |
| GET | `/.well-known/jwks.json` | — | `{keys:[{kty,crv,kid,x,use,alg}]}` |

**The token body is read field-by-field by `toTokens`** (`packages/host/src/auth/portal-client.ts:263`):
`access_token, refresh_token, session_id, user_id, org_id, tenant_id` are required and a missing
one makes the host raise `portal_unavailable`; `expires_in`, `refresh_expires_in` and `device_id`
are optional and all three are sent. Since 2026-10-01 the body also carries **`role`** (`owner`, `admin` or
`member`, the member's role in their org), which `toTokens` does not read yet: the host provisions a
first-time sign-in's membership from it once a host worker wires it, and must not default a missing one
to `owner`. The same value is the access token's `role` claim and `/auth/session`'s `user.role`. Built once in `mintSession`
(`apps/portal/src/flows/token.ts:161`), and the exact key set is pinned by
`apps/portal/src/routes/api.test.ts`.

**Every error body** is `{ error, reason, message_en, message_id, retry_after? }`
(`errorBody`, `apps/portal/src/flows/reasons.ts:124`). `error` is the RFC 6749/8628 family,
`reason` is the vocabulary the client branches on, and the copy comes from
`apps/portal/locales/{en,id}/portal.json` — the same keys the HTML pages read, so there is one
table rather than two that drift.

### 2. `/authorize` — validate, then render, then redirect

`getAuthorize` (`apps/portal/src/routes/authorize.ts:135`), in this order and the order is the
security property:

1. per-IP limiter (`limit`, `apps/portal/src/routes/support.ts:193`);
2. `readAuthorizeParams` (`apps/portal/src/flows/authorize.ts:38`) — bounded lengths, nothing
   unbounded reaches a page;
3. `checkClient` (`:65`) — `response_type` must be `code`, `resolve_tenant_for_client` must
   answer, and `oauthClients.allowsRedirect` must match the `redirect_uri` **exactly** against
   that client's registered array;
4. only now does anything render or redirect.

A failure of 2 or 3 renders an error page and **never** writes a `Location`. That is the open
redirect, and here it would be an open redirect carrying an authorization code.

Then: a live portal session cookie for that tenant goes straight to `completeSignIn`
(`apps/portal/src/routes/authorize.ts:263`); otherwise the sign-in form. The two form posts
(`postEmail` `:141`, `postVerify` `:190`) **re-run `checkClient` on the values from their hidden
fields**, because a hidden field is a field the user edits.

`completeSignIn` runs `runBrowserLoginGate` (`apps/portal/src/flows/login.ts:50`) and then either
`redirectWithCode` (`flows/authorize.ts:137`) or, on a denial, `redirectWithError` (`:145`) —
`302 {redirect_uri}?error=<reason>&state=<echo>`, so `seat_cap_reached` lands on the product's own
sign-in screen next to the admin who can free a seat.

### 3. The sign-in is a state machine: e-mail first, then the portal decides

Owner decision, 2026-10-01: **nobody signs up**, a first sign-in needs an **invite** the operator
issued for that address and the portal e-mailed to it, every later sign-in needs only an e-mailed
six-digit code, and **the page says which situation the person is in**. This replaced the one neutral
page every address used to get (SR-30, changed on purpose, see the Gotchas).

The decisions are `flows/sign-in.ts`; the pages, statuses and budgets are `routes/sign-in-flow.ts`,
which `/authorize/*` and `/activate/*` both call, so neither door is a way round the other.

| The address is | State (`SignInState`) | The person is told | Sent |
|---|---|---|---|
| an activated member | `code_sent` | "We sent a sign-in code to <address>", the code field, **Send a new code**, **Use a different e-mail** | the six-digit code |
| invited, invite redeemable | `invite_required` | "Enter the invite code we e-mailed to <address>", the invite field, **E-mail me my invite again**, **Use a different e-mail** | nothing yet |
| invited, invite expired, spent or never issued | `invite_unusable` | "This invite has expired or was already used. Ask your admin for a new one." | nothing |
| not invited, unknown, **disabled**, removed, or in another tenant than the client's | `no_access` | "This e-mail does not have access yet. Ask your company admin to invite you." | nothing |
| an activated member who spent 20 wrong codes today | `otp_locked` | "Too many attempts for this e-mail. Try again in {wait} or ask your admin." (429; `{wait}` is when the oldest guesses leave the day, in minutes under an hour and otherwise whole hours rounded up, e.g. "19 h") | nothing |
| an invitee who spent 5 wrong invite codes | `invite_locked` | "Too many wrong invite codes for this e-mail. Ask your admin for a new invite." (429; **the fifth wrong code itself** lands here, with no form: it used to show "0 attempts left" and the form again) | nothing |
| a wrong invite code, with attempts left | `invite_wrong` | "That invite code is not right. N attempts left." (400, N from 4 to 1) | nothing |
| an activated member or a redeemable invitee whose org has **no seat** for them | `seat_cap_reached` | "No seats left in your organisation. Ask your admin to free a seat or add one." (403; the first sentence is the `reason.seat_cap_reached` copy the JSON errors use, the second is `state.seatCap.next`; both in `en` and `id`) | nothing, and **nothing is spent**: the invite stays unredeemed, no wrong guess is counted |
| a valid invite code | `code_sent` with `afterInvite` | "Invite accepted. We just sent a sign-in code to <address> to confirm it is your inbox." | the six-digit code |

Where each decision is made:

- **`beginSignIn`** (`flows/sign-in.ts:192`) is the e-mail step. It resolves the tenant by address
  (`resolve.byEmail`, `null` for unknown **and** for an address in two tenants), requires it to be the
  client's tenant, reads the member, and branches on `users.status`: `disabled` is `no_access`;
  `invited` goes to `inspectInvite` (`:140`: none, redeemed or past `expires_at` is unusable, five
  failed attempts is locked, otherwise live with its attempts left), and a **live** invite is asked
  `orgs.hasSeatFor` before the invite screen is shown (`:221`; a dead invite is its own dead end whatever
  the seats are); `active` is asked the same (`:241`) and then goes to `deliverLoginOtp`. A refusal is
  `seat_cap_reached` and an `otp.withheld` audit row with that reason. A browser that holds a live portal
  session never gets here: `GET /authorize` redirects first (`routes/authorize.ts`, `completeSignIn`).
- **`submitInvite`** (`:268`) asks `hasSeatFor` **before it touches the invite** (`:290`: no
  redemption, no wrong-guess count, an `invite.refused` audit row with reason `seat_cap_reached`), then
  redeems the typed code inside one transaction (`store.invites.redeem`, below) and **returns, never
  throws**, so a wrong guess commits its count. A wrong guess that was the fifth (`attemptsRemaining`
  `0`) is mapped to `invite_locked` here, not to `invite_wrong` (it is still audited as the
  `wrong_code` it was). A valid code activates the member, writes `invite.redeemed`, and **then** mails
  the six-digit code: the invite does not prove the inbox. A second post of the same code (a double
  click) finds the member active and carries on to the code instead of reporting the invite spent. For
  an **active** member the typed code is not checked at all (nothing to redeem) and a code is sent: see
  the Gotchas for what bounds that.
- **`resendInvite`** (`:383`): the invite is stored as a hash, so "e-mail me my invite again" is a
  **re-issue**: a new code for the same address, the old one retired, **the same `expires_at`** (asking
  again never extends an invite), the same role. Refused for a spent, expired or locked invite (the
  admin's call), a minute after the previous invite e-mail, and when four invites for the address exist
  inside an hour, counted from the `invites` rows, operator-issued ones included.
- **`deliverLoginOtp`** (`otp/send.ts:91`) mints and mails the six-digit code and keeps the old limits:
  3 sends / 15 min per address (`store.loginOtps.send`), a **cooldown on an explicit "send a new
  code"** (`OTP_RESEND_COOLDOWN_MS`, one minute) and a **lock check before anything is minted**
  (`store.loginOtps.status`, `otps.ts:212`: the same 20-guesses-a-day sum `verify` uses), so a code that
  could not be used is not sent. A refused transport is `code_mail_failed` and the page says so; the code
  row that never went is **retired** (`loginOtps.retire`) so the next post is not told "a code was sent".
- Every public function runs under `withFloor` (`:107`, 150 ms): a floor, not a constant time, which is
  the honest claim.

**One live code, one request, one seat** (the sign-in-codes pass, 2026-10-01). Three rules, each
found by driving the pilot, each pinned by a test that was red first:

- **A code is retired by its successor.** `store.loginOtps.send` marks every earlier unused code of the same
  address **and purpose** used before it inserts the new one (`retireOutstanding`, `otps.ts:49`, called at
  `:119`), and a successful `verify` marks the rest (`:201`). The rows stay, so the 3-sends window and the
  20-guesses day still count them. Before this, `verify` took the newest *unused* code and used only
  that one: request A, request B, sign in with B, and **A signed in too** (`POST /authorize/verify` with A
  answered 302 to `/auth/callback`). A device sign-in (`purpose = activate`) and a web one (`portal_login`)
  do not retire each other. Both statements stamp `clock_timestamp()`, not `now()`: `now()` is the
  transaction's start and a later-starting transaction can commit a row stamped after it, which
  `login_otps_consumed_chk` (`consumed_at >= created_at`) refuses.
- **A repeat of one request is not a new request.** `deliverLoginOtp` passes `dedupeWithinMs:
  OTP_DUPLICATE_WINDOW_MS` (15 s, `otp/send.ts:46`); `loginOtps.send` then answers `duplicate` — no row, no
  mail, none of the three sends spent, no audit row — when a code of that purpose is **live** (unused, under
  5 guesses, unexpired) and younger than that, and the page is the code page again (`already_sent` →
  `code_sent`). A code that was used, burnt, expired or never mailed does not count, so signing in and
  starting again at once sends a code. The check and the insert share one `pg_advisory_xact_lock` per
  address (`otps.ts:78`), so two posts that arrive together make one code. Before this, a double submit, a
  reload or a re-post minted two or three codes and spent the budget, and only the newest worked, so the
  person who typed the first e-mail's code burned a guess. An explicit "send a new code" keeps its minute
  (`OTP_RESEND_COOLDOWN_MS`, checked first); the operator's `portal:otp` passes no `dedupeWithinMs` and is
  always minted.
- **The seat is asked before anything is spent.** `orgs.hasSeatFor(orgId, userId)`
  (`store/postgres/identity.ts:165`) is the seat branch of `login_precheck` read without its advisory lock:
  `count_active_users(org)`, plus one unless the person already holds a live session seen in the last 30
  days, must not exceed `seat_cap` (so even a seated person fails in an org that is over its cap, exactly as
  at the exchange). `beginSignIn` and `submitInvite` ask it; the **exchange still checks**
  (`loginPrecheck`, `routes/authorize.ts` `completeSignIn`) because a seat can go between the page and
  the exchange, and `routes/browser.test.ts` "the login gate" pins that half by taking the seat in between.
  Before this the cap was checked only at the exchange: an invitee redeemed the invite, typed the code, and
  landed on `/sign-in?reason=seat_cap_reached` with the invite already spent.

**What stands in for the neutral page** is the limits, all counted whatever the outcome and none
dependent on the address existing: `signInEmailIp` 15 / 15 min per IP and `signInEmailAddress` 6 / 15 min
per address, both spent at `emailStepAllowed` (`routes/sign-in-flow.ts:285`) before anything is looked
up; `inviteAttemptIp` 10 / 15 min per IP, **counted before the work** (`:368`) so a parallel burst cannot
slip past a check made afterwards; five wrong codes per invite in the database; the invite resend budget
above; and the OTP's own. A refusal by the first three is the same `429` page for a member and a
stranger. **All the per-IP ones key on the caller's address, so behind a proxy they only mean something
with `PORTAL_TRUST_PROXY=1`** (`webapp-deploy/compose.yml:267,321` and
`webapp-deploy/k8s/base/kustomization.yaml:56` set it, and `scripts/review-instance.ps1:754` does when a proxy
is in front; without it every visitor shares one socket-address bucket).

`verifyLoginOtp` (`otp/verify.ts:46`) is unchanged: it answers `no_code` for an unknown or wrong-tenant
address, and the `locked` outcome is audited `otp.locked`, shown with `code.locked` in both languages and
the same `{wait}` as the e-mail step (`codeErrorMessage`, `routes/support.ts:93`).
`POST /authorize/verify` still wipes nothing and mints the same session; the e-mailed code is the
mailbox proof for **both** a member and a just-redeemed invitee.

**Twenty guesses per address per 24 hours** (unchanged, SR-53). `store.loginOtps.verify` sums `attempts`
over every row of the address from the last 24 hours, across both purposes, before anything else. At 20
it answers `locked`, even for the right digits on a fresh code (`otps.ts:27-28`, the check at `:85-96`), taking those rows
`FOR UPDATE` in a fixed order. The answer carries `retryAfter`: the lock is a **rolling** total, so it lifts
as the oldest codes' guesses age out of the 24 hours, and `secondsUntilUnlocked`
(`store/postgres/otp-lock.ts`) walks the rows oldest first until the total is under 20 and returns when that
code leaves the window. `loginOtps.status` returns the same number, and the e-mail step and the code screen
print it as `{wait}` (`waitText`, `views/i18n.ts`) instead of a flat "24 hours". `prune_login_otps()` keeps 24 hours of rows, which is exactly what keeps
this window countable. **What changed is that the e-mail step now says so up front** instead of mailing a
code that `verify` would refuse.

### 4. `/auth/token` — two grants

`postToken` (`apps/portal/src/routes/tokens.ts:51`).

**Which rate-limit bucket a call lands in** is decided first, before anything is looked up. A
refresh that carries `client_id` and `client_secret` goes to `postConfidentialRefresh`
(`routes/tokens.ts:105`). It peeks a per-address budget of failed client authentications
(`tokenClientAuthFailIp`, 20 / 10 min) and refuses before any query once that is spent. It then
verifies the client (`authenticateClient`, `flows/token.ts:236`). A wrong secret is
`401 invalid_client`, is audited as `token.client_auth_failed`, and counts against that budget. A
right one counts against the **client** (`tokenClient`, 20,000 / 10 min, keyed on `client_id`) and
never against the address. Everything else (the code grant, and a refresh without client
credentials) counts against the address (`tokenIp`, 300 / 10 min), as before. The reason is the
hosted app: its host refreshes every session about every 10 minutes, all from one address, so the
per-address bucket capped it at roughly 300 active sessions. The host sends both client credentials on
every refresh when they are configured (`packages/host/src/auth/portal-check.ts:300-305`, on the wire at
`packages/host/src/auth/portal-client.ts:337-345`), and the hosted boot check refuses to start without them,
so a hosted refresh lands in `tokenClient`. The refresh token remains the credential for the
refresh itself; the client credentials only choose the bucket, and are not bound to the token.

**`authorization_code`** → `exchangeAuthorizationCode` (`apps/portal/src/flows/token.ts:77`):
resolve the tenant from the code, **verify the client secret first** (so a wrong secret cannot
burn a legitimate user's code), then `authCodes.consume`, which checks client, `redirect_uri`,
single use and the 60-second window; then the login gate; then `mintSession`.

It does **not** check `state`, and it never did. `auth_codes.state_hash` is written for audit and
never compared: the login-CSRF binding on `state` is the host's own `__Host-` cookie comparison
(`packages/host/src/auth/routes.ts`, `readState`), which runs before this endpoint is called. The
dead `state_mismatch` branch that used to sit in `store/postgres/auth-codes.ts` is gone and the
column comment is corrected by `apps/portal/migrations/0009_web_session_revocation.sql` — 0006 is
applied and checksummed, so it is not edited. [SR-43](../security-register.md#sr-43).

**`refresh_token`** → `exchangeRefreshToken` (`:273`): generate the successor, hand both hashes to
`rotate_refresh_token` (`../portal/migrations/0005_functions.sql`), and let the database do
rotation and reuse detection. A spent generation kills the whole chain and the session.

**`device_id` is required, and must be a canonical uuid** (`routes/tokens.ts:37,139`); anything else
is `400 invalid_request` before any lookup, so the token is not spent. `rotate_refresh_token`
compares the device with the session's **only when one is passed**, so a refresh without it used to
skip the device binding entirely: a lifted token refreshed from anywhere. A non-uuid value used to
reach the `::uuid` cast and come back as a 500. The host always sends it:
`packages/host/src/auth/portal-check.ts:303` presents the `device_id` held from the portal's own
token body, which `mintSession` and `exchangeRefreshToken` always include, and keeps it across
rotations (`:311`). The wire's one conditional, `...(deviceId ? { device_id } : {})` in
`portal-client.ts:343`, is empty only if the portal had stopped sending the field. A session
held without one now fails closed with `invalid_request`.

### 5. Access tokens and JWKS

`keyFromSeed` (`apps/portal/src/jwt/keys.ts:62`) builds an Ed25519 key from a 32-byte seed with
`node:crypto` only — a PKCS#8 prefix and the last 32 bytes of the SPKI export, no new dependency.
`kid` is derived from the public key, so it is stable across restarts of the same key.

`resolveKeyring` (`:92`) takes `PORTAL_SIGNING_KEY` when it is set; in development it mints an
ephemeral key and writes a `portal_signing_key_ephemeral` warning naming only the `kid`; in
production with no key it **throws before anything listens** (`apps/portal/src/main.ts:27`).

`signAccessToken` (`apps/portal/src/jwt/sign.ts:66`) writes exactly the claims the login doc
freezes — `iss sub tid oid did sid scope iat exp`, one hour. `did` is `devices.id`, never the
client-minted `install_id`. `verifyAccessToken` (`:102`) checks the algorithm **before** the key
lookup (so `alg: none` cannot reach a path that treats an empty signature as a match), then the
signature, then `iss`, then `exp` with ±120 s of skew.

`publishedJwks` (`jwt/keys.ts:125`) serves the in-process keyring, `Cache-Control: public,
max-age=3600`.

### 6. Security controls, and where each one is

| Control | Where | What pins it |
|---|---|---|
| redirect allowlist, exact match | `checkClient`, `flows/authorize.ts:65` | `routes/browser.test.ts` "renders an error page for a redirect_uri outside the client's allowlist" |
| client authentication before the code is consumed | `flows/token.ts:82-100` | `routes/api.test.ts` "refuses a wrong client secret without burning the code" |
| authorization code: 60 s, single use, bound to client + redirect_uri | `migrations/0006_browser_login.sql`, `store/postgres/auth-codes.ts:53` | `routes/api.test.ts` "refuses a replayed code and audits it" |
| refresh rotation + reuse detection | `rotate_refresh_token`, called at `flows/token.ts:279` | `routes/api.test.ts` "kills the whole chain when a spent generation is presented again" |
| refresh requires a `device_id` shaped like `devices.id`, so the device binding in `rotate_refresh_token` always runs; anything else is `400 invalid_request` before any lookup | `routes/tokens.ts:37,139` | `routes/api.test.ts` "refuses a refresh with no device_id, in the invalid_request shape, without spending the token", "refuses a device_id that is not a devices.id, rather than failing inside the database" |
| OTP: 6 digits, 10 min, 5 attempts, single use | `store/postgres/otps.ts` | `routes/browser.test.ts` "counts down the five attempts and refuses the sixth" |
| OTP: 3 sends / 15 min per address | `store/postgres/otps.ts:70-130` (the budget is read under the address's advisory lock) | `routes/browser.test.ts` "the send budget": "stops after three sends inside the window, and says a code already went" (its own portal and clock: the sends have to be told apart from a repeat) |
| OTP: a code that a newer one replaced never signs anybody in, whether or not the newer one was used; a successful sign-in uses every other unused code of that address and purpose | `retireOutstanding`, `store/postgres/otps.ts:49,119,201` | `store/postgres/otps.test.ts` "a retired code stays retired" (4), `routes/sign-in-codes.test.ts` "M1: a code that was replaced stays dead" (2: the live repro, request A, request B, sign in with B, replay A from a second browser, answers 400) |
| OTP: a repeat of one request (double click, reload, re-post, two posts together) is answered by the code that already went: one mail, no budget spent; an explicit resend keeps its minute | `OTP_DUPLICATE_WINDOW_MS`, `otp/send.ts:46,132`; `store/postgres/otps.ts:78-100` | `store/postgres/otps.test.ts` "a code that is already live answers a repeat of the same request" (8, one with two sends in parallel), `routes/sign-in-codes.test.ts` "M2: one request is one code" (9: sequential, parallel, the invite step, after the window, after a refused transport), `routes/sign-in-states.test.ts` "can ask for a new code, but not within the first minute" |
| OTP: 20 guesses / 24 h per address, across every code and both purposes; the 21st is refused as `locked` even with the right digits, audited as `otp.locked`, and the page says how long to wait (`{wait}`: when the oldest guesses leave the day, `secondsUntilUnlocked` in `store/postgres/otp-lock.ts`) in `en` and `id` | `store/postgres/otps.ts:27-28,146-156`, `otp/verify.ts:67`, `codeErrorMessage` in `routes/support.ts:93` | `store/postgres/otps.test.ts` "the daily guess budget" (5 cases, one of them an uncommitted twentieth guess racing the other purpose's code) and "when a locked address can try again", `store/postgres/otp-lock.test.ts` (5, the rolling arithmetic), `routes/sign-in-states.test.ts` "6. locked out" (hours, minutes, the code screen), `routes/browser.test.ts` "refuses even the right code once twenty guesses were spent today, says why in both languages, and audits otp.locked" |
| the sign-in tells a person which situation they are in (member, invitee, spent invite, no access, lock, no seat) and sends a code only to a member or a just-redeemed invitee; an invited member is never mailed a sign-in code | `flows/sign-in.ts:192,268`, `otp/send.ts:91`, `routes/sign-in-flow.ts:201` | `routes/sign-in-states.test.ts` (41: the nine states the owner listed, both doors, the fifth wrong invite code as the lock, no password field, no code in a log or audit row) |
| the seat cap is told at the e-mail step and before an invite is redeemed, with the `seat_cap_reached` copy in both languages and nothing spent (no invite, no code, no wrong-guess count); the exchange re-checks | `orgs.hasSeatFor`, `store/postgres/identity.ts:165`; `flows/sign-in.ts:221,241,290`; `deadEndMessage`, `routes/sign-in-flow.ts:169` | `routes/sign-in-seats.test.ts` (8), `store/postgres/seats.test.ts` "orgs.hasSeatFor" (6, held to `login_precheck`'s own answer), `routes/browser.test.ts` "the login gate" |
| an invite code: 20 characters of a 32-character alphabet (about 100 bits), sha256 only, bound to its address, 7 days, single use, one live per address (partial unique index) | `crypto.ts` `randomInviteCode`, `store/postgres/invites.ts:35,91`, `migrations/0011_invites.sql` | `store/postgres/invites.test.ts` (22), `crypto.test.ts` (4), `invites/issue.test.ts` (22) |
| invite: 5 wrong guesses lock it, counted in the database under `FOR UPDATE` (8 parallel wrong guesses stop at 5 and never hit the CHECK; two parallel right codes let exactly one through) | `store/postgres/invites.ts:91-150` | `store/postgres/invites.test.ts` "wrong guesses that arrive together", `routes/sign-in-states.test.ts` "6. locked out" |
| the e-mail step is limited per IP (15 / 15 min) and per address (6 / 15 min), the strict stand-in for the neutral page; the refusal is the same page for a member and a stranger | `signInEmailIp`, `signInEmailAddress`, `security/rate-limit.ts:197,204,231-232`; `emailStepAllowed`, `routes/sign-in-flow.ts:285` | `routes/sign-in-limits.test.ts` "the e-mail step, per IP", "per address" (on the limits as shipped; the other suites lift them through `startTestPortal({ emailStepLimits })`) |
| typed invite codes: 10 / 15 min per IP, counted **before** the lookup, including a valid code | `inviteAttemptIp`, `routes/sign-in-flow.ts:368` | `routes/sign-in-limits.test.ts` "typed invite codes, per IP" |
| "e-mail me my invite again" is a re-issue (new code, old retired, same expiry and role), a minute apart and four an hour per address, never for a spent or locked invite | `resendInvite`, `flows/sign-in.ts:383` | `routes/sign-in-states.test.ts` "can have the invite e-mailed again…", "never extends the invite…"; `routes/sign-in-limits.test.ts` "'e-mail me my invite again', per address" |
| the invite e-mail carries the code, names the address it is bound to and the expiry, has no link and keeps the code out of the subject; it goes through the portal's own mailer, in the language the operator chose | `inviteMessage`, `mail/templates.ts`; `mailInvite`, `invites/deliver.ts` | `invites/deliver.test.ts` (7) |
| a role rides every invite (`owner`, `admin` or `member`, default `member`), is copied onto the member at redemption, and is in the access token claim `role`, the token response `role` and `/auth/session` `user.role`, read at every mint and refresh; a tenant always keeps an owner and its last owner cannot be demoted (the owner rows are locked `FOR UPDATE`, so two operators cannot race past it); a role changes only through the operator CLI | `store/postgres/invites.ts:136`, `flows/token.ts:168,237`, `jwt/sign.ts:76`, `invites/issue.ts:142`, `invites/role.ts:44` | `routes/roles.test.ts` (8), `invites/role.test.ts` (7), `invites/issue.test.ts` "issueInvite and roles", `jwt/sign.test.ts`, `routes/api.test.ts` "answers exactly the fields the host's toTokens reads" |
| a cookie is a session on the portal's own screens only while its member still exists and is `active`; a removed or disabled member's old cookie shows the sign-in form and cannot approve a device | `liveWebSessionUser`, `flows/web-session.ts:86`; `routes/activate.ts` | `routes/sign-in-states.test.ts` "9. a member who was removed" |
| the device screens greet a signed-in person by address with "Not you? Sign out" (`POST /logout`) | `accountBanner`, `views/pages.ts`; `routes/activate.ts` | `routes/sign-in-states.test.ts` "5. already signed in", `views/views.test.ts` |
| device code 5 / 10 min per install, 30 / 10 min per IP; approve 10 / 10 min per user; the poll (`/auth/device/token`) 600 / 10 min per IP, never under the 120 one device makes | `createPortalLimiters`, `security/rate-limit.ts:192`; the poll's check at `routes/tokens.ts:186` | `security/security.test.ts` "rate limiting", `routes/api.test.ts` "limits POST /auth/device/token per IP, at 600 per 10 minutes, and never trips one polling device" |
| `/auth/token`: a refresh from a confidential client whose secret verified counts against its `client_id` (20,000 / 10 min), never the address; failed client authentications have a per-address budget (20 / 10 min) that is peeked before any lookup; every public grant keeps 300 / 10 min per address | `postConfidentialRefresh`, `routes/tokens.ts:105-125`; `authenticateClient`, `flows/token.ts:236`; `tokenClient` / `tokenClientAuthFailIp`, `security/rate-limit.ts:200-201` | `routes/api.test.ts` "counts an authenticated client's refreshes against the client, never the address, and keeps 300 for public ones", "keys the confidential bucket on client_id, whichever address the refresh comes from", "answers 429 once a client has spent its 20,000 refreshes in the window", "refuses a wrong client_secret as invalid_client, audits it, and stops looking after 20 from one address"; `security/security.test.ts` "gives a confidential client 20,000 refreshes per 10 minutes, keyed on its client_id" |
| a limiter whose 20,000-key map is full evicts its oldest 1% of windows; it no longer refuses every new key, which let a flood of addresses lock everyone out | `makeRoom`, `security/rate-limit.ts:66-80` | `security/security.test.ts` "keeps a flood of new keys from locking a new caller out", "evicts the window that started first, even when an older key restarted its window later" |
| `slow_down` on the third poll in one interval | `store/postgres/device-codes.ts:141-221` | `routes/api.test.ts` "answers slow_down on the third poll" |
| CSRF on every portal form | `ensureCsrf` / `csrfOk`, `routes/support.ts:160,175` + `security/csrf.ts:22` | `routes/browser.test.ts` "refuses a post with no CSRF token" |
| `__Host-` cookies, or the unprefixed name only on loopback dev | `cookieNames`, `security/cookies.ts:80` | `security/security.test.ts` "cookie names and the `__Host-` prefix" |
| CSP with `script-src 'none'`, `frame-ancestors 'none'`, `form-action 'self'` | `contentSecurityPolicy` / `HTML_SECURITY_HEADERS`, `security/headers.ts:76,87` | `routes/browser.test.ts` "carries the page security headers" |
| `form-action` also names the client's origin, but **only** on a page inside an `/authorize` flow whose client already validated. A browser enforces `form-action` across the whole redirect chain, and a successful verify ends on the client's origin ([SR-20](../security-register.md#sr-20)) | `clientFormAction`, `routes/authorize.ts:78` — called only after `checkClient` returns ok | `routes/browser.test.ts` "names the client's origin in form-action on an authorize page, and only there", "keeps form-action at 'self' on a page rendered before the client was validated" |
| what is appended is exactly `new URL(redirect_uri).origin` — never a path, a query, a wildcard, a bare scheme or a CSP keyword | `formActionSource`, `security/headers.ts:56` | `security/security.test.ts` "cannot be used to inject a directive, a header or a wildcard" |
| `Referrer-Policy: no-referrer` on the redirect that carries the code | `redirectResponse`, `security/headers.ts:133` | `security/security.test.ts` "keeps no-referrer on the redirect" |
| JSON body cap of 8 KB under the server's 64 KB | `parseJsonBody`, `security/body.ts:22` | `security/security.test.ts` "refuses a body over the endpoint's own cap" |
| constant-time comparisons | `crypto.ts` `hashEquals`, `security/csrf.ts:22`, `security/web-session.ts:96` | `security/security.test.ts` "CSRF double submit" |
| `X-Forwarded-For` only behind `PORTAL_TRUST_PROXY=1`, and then only its **right-most** entry, the one the proxy wrote. A last hop that is not an address falls back to the socket, never to an entry further left, since those are the client's | `clientIp`, `security/client-ip.ts:55-68` | `security/security.test.ts` "client address" (incl. "cannot be steered by a forged prefix"), `routes/api.test.ts` "keys on the address the proxy appended, so a rotated forged prefix does not buy a fresh bucket" |
| one escaping helper, every interpolation escaped | `escapeHtml` / `html`, `views/escape.ts:26,61` | `views/views.test.ts`, four injection payloads on every screen |
| no OTP, code, token or secret in any log | `src/log.ts` sink + the field rules | `routes/{browser,api}.test.ts` "what reached the log" |
| tenant isolation under a real `portal_app` role | `0004_rls.sql`, `0006`, `0008`, `0009` | `security/rls.test.ts` (17 cases) |
| the portal's own browser session is revocable: the cookie carries `ver`, every use compares it against `web_session_versions` inside the tenant scope ([SR-21](../security-register.md#sr-21)) | `versionIsLive`, `flows/web-session.ts:52`, `security/web-session.ts:45,114`, `migrations/0009` | `routes/logout.test.ts` "ends a live cookie when the user's web sessions are revoked server-side" |
| `/logout` clears the cookie on **every** answer, including its refusals | `routes/logout.ts:115,165` | `routes/logout.test.ts` "clears the cookie on every answer, including the one it refuses" |
| `post_logout_redirect_uri` is followed only when its ORIGIN exactly matches a registered `redirect_uri`'s origin | `allowedPostLogoutRedirect`, `routes/logout.ts:55` | `routes/logout.test.ts` "renders the neutral page rather than following a URI off that origin" (7 payloads) |
| `/tenant/config`: per-IP limiter on both branches, and an unknown slug is indistinguishable from a suspended tenant ([SR-42](../security-register.md#sr-42)) | `routes/tokens.ts:247,269-275`, `security/rate-limit.ts:203` | `routes/api.test.ts` "cannot tell an unknown slug from a suspended tenant" |
| mail is never sent in the clear: STARTTLS is **required** off loopback, `ignoreTLS` only for the sandbox, and production refuses a cleartext mail host ([SR-39](../security-register.md#sr-39)) | `config.ts:257-258,268`, `mail/smtp.ts:60` | `config.test.ts` "SMTP transport security", `mail/mail.test.ts` "smtpTransportOptions" |
| a provider outage fails fast: a send that cannot connect or greet within 4 s, or goes silent on the socket for 8 s, raises `MailDeliveryError` and the sign-in answers its neutral page, so the request does not hang | `mail/smtp.ts` (`SMTP_CONNECTION_TIMEOUT_MS`, `SMTP_GREETING_TIMEOUT_MS`, `SMTP_SOCKET_TIMEOUT_MS`, `smtpTransportOptions`) | `mail/mail.test.ts` "fails an outage fast", "hands the same timeouts to the nodemailer transport" |
| `PORTAL_PUBLIC_URL` is an origin, https off loopback, required in production; `PORTAL_TRUST_PROXY` is a validated flag ([SR-33](../security-register.md#sr-33)) | `config.ts:293,347` | `config.test.ts` "PORTAL_PUBLIC_URL and PORTAL_TRUST_PROXY" |
| a registered `redirect_uri` can only be seeded as https, or http on loopback ([SR-40](../security-register.md#sr-40)) | `assertRedirectUri`, `seed/args.ts:78` | `seed/seed.test.ts` "refuses a --redirect that is not https, or http off loopback" |
| a body over the server's 64 KB ceiling is a `413` with the standard error body, not a `500` | `server.ts:88,237` | `server.test.ts` "answers 413 with the standard error body" |
| a request target the URL parser refuses (`GET //x:99999/healthz`) is a `400` with the standard error body. It is parsed against a fixed base inside the handler's try, and the Host header is never read. It used to be parsed against `http://<Host>` outside the try, so `Host: a b` or that target was an unhandled rejection and the process exited | `BAD_TARGET` / `REQUEST_BASE` / `parseTarget`, `server.ts:90-107` | `server.test.ts` "a request whose target or Host header is not a URL" (4 cases, raw socket, whole portal) |
| every request promise ends in a `.catch`, so a failure inside the error path itself (a logger that throws) still answers `500` and never becomes an unhandled rejection | `abandon`, `server.ts:151,251` | `server.test.ts` "contains a failure inside its own error handling, so a request never becomes an unhandled rejection" |
| an unhandled rejection or uncaught exception is written through the portal logger (so it is redacted like every line) and the process then exits 1 for the supervisor to restart it | `installProcessGuards`, `process-guards.ts:42`, installed first thing in `main.ts:15` | `process-guards.test.ts` (6) |
| the server connects as a plain member of `portal_app`; migrations run as the owner on their own connection, closed before anything listens. Production refuses to boot if the server role is superuser, has `BYPASSRLS`, is in `portal_admin`, can `SET ROLE` to a role that is, or is not in `portal_app` | `prepareStore` / `checkServerRole` / `serverRoleProblems`, `boot.ts:144,126,34`; `readConnectionRole`, `store/postgres/roles.ts:43`; `PORTAL_MIGRATE_DATABASE_URL`, `config.ts:188`; `migrations/0010_app_login_role.sql` | `boot.test.ts` (17), `config.test.ts` "PORTAL_MIGRATE_DATABASE_URL", `store/postgres/migrate.test.ts` "creates portal_app_login as 0001 describes it", "puts no password in a migration file" |

### 7. Tests connect as `portal_app_test`, not as a superuser

`createTestStore` (`apps/portal/src/testing/pg.ts:163`) opens the store as `portal_app_test`, a
plain LOGIN role whose only privilege is membership of `portal_app` (`APP_ROLE`, `:86`;
`asAppRole`, `:135`). Migrations still run as the admin, because `0004` re-owns every table to
`portal_admin` and `0007` creates `SECURITY DEFINER` functions.

This matters more than it sounds: a superuser **bypasses row-level security**, so the whole suite
would pass with every policy dropped. `apps/portal/src/security/rls.test.ts` asserts the role is
`NOSUPERUSER NOBYPASSRLS` first, so a future change that quietly restores the superuser connection
fails loudly instead of turning the rest of the file into theatre.

**The server now does the same.** Until 2026-09-23 the suite was the only place the policies held.
The portal migrated and served on one DSN, and `apps/portal/compose.yml` handed that DSN the cluster
superuser. `src/boot.ts` now migrates on `PORTAL_MIGRATE_DATABASE_URL`, closes that connection,
and serves on `PORTAL_DATABASE_URL` as `portal_app_login`, which 0001 describes and
`migrations/0010_app_login_role.sql` creates. It asks `pg_roles` who that is before anything
listens, and a production process refuses to boot as anything that can see past a policy.

### 8. Password sign-in: the second way in (`PORTAL_SIGNIN_MODE=password`, 2026-10-07)

Owner decision for the HYP AI deployment (Rizky, 2026-10-07: username and password in place of the e-mailed
code, 2FA being designed). **It is a mode, chosen once at boot, and the portal's own default (variable absent) is the sign-in described in
sections 2 and 3, unchanged. The Nultron Enterprise bundle sets this mode explicitly since 2026-10-09.** The full account of it, the routes, the storage, the lockout and what is not
built, is [`../portal/device-code-login.md`](../portal/device-code-login.md), "Password sign-in". What this
page adds is where it plugs in and what to be careful of.

- **One switch, read once.** `readSignInMode` (`apps/portal/src/config.ts`) answers `code` for unset or empty,
  `password` for that word and a boot refusal for anything else. In `password` the two production SMTP
  guards in `readSmtp` are skipped and every other one stays. `createMailer` (`src/mail/index.ts`) hands out
  `createDisabledMailer` (`src/mail/disabled.ts`), which refuses to send.
- **Two route tables.** `authorizeRoutes` and `activateRoutes` each return their code-mode list or, in
  password mode, `GET` plus `POST .../password` and `POST .../password/change`; the e-mail, invite and verify
  posts are not registered, so they are the server's own 404. `signInModeRoutes` (`src/routes/signin-mode.ts`)
  registers `GET /auth/signin-mode` only in password mode. `routes/code-mode-unchanged.test.ts` pins both tables
  as exact lists, and pins the eighteen code-mode screens by sha256 against hashes made from `main`'s view code.
- **The steps** are `src/flows/password-sign-in.ts`: `identifyAccount`, `verifyPasswordStep`,
  `signInWithPassword`, `changePasswordAndSignIn`. The route half is `src/routes/password-flow.ts`
  (`handlePasswordStep`, `handleChangeStep`, the two pages, the budgets), shared by `/authorize/*` and
  `/activate/*`. A person who is in goes down the same `completeSignIn` the code flow ends in
  (`routes/authorize.ts`), or `signedInOnActivate` (`routes/activate.ts`). Both re-read `must_change` in the
  transaction that issues the code or the cookie (`mustChangePasswordFirst`, password mode only), so a
  `reset-password` that lands after the password check gets the change page and no code, cookie or Approve.
- **The lockout is `store/postgres/credentials.ts`.** `reserveAttempt` counts the attempt *before* the password
  is compared, under `FOR UPDATE`, with no hashing in the transaction, and only a caller that won an increment
  gets the hash. Expiry uses the injected clock. `PASSWORD_MAX_FAILED_ATTEMPTS` (5), `PASSWORD_LOCK_MS`
  (15 minutes) and `PASSWORD_GRACE_ATTEMPTS` (3, `0013_password_grace.sql`) live there. While the account is
  locked, a caller that passes `graceAttempts` may still take up to three more, counted in the same row, so a
  window compares at most 5 + 3 passwords; `recordSuccess` is guarded by the hash that was proved
  (`expectHash`), so a reset that lands mid-comparison is not undone.
- **Who may ask for a slot is `src/security/password-attempts.ts`**, in this process: `enter` marks a source as
  having attempted a person (synchronously, before the comparison) and says whether it was clean; `ordered`
  charges one person's attempts in the order sources entered; a mark ends fifteen minutes after the first
  attempt. `PortalRuntime.attempts` holds it. A source is `sourceBucket(ip)` (`security/client-ip.ts`): an IPv4
  address, or an IPv6 /56 (`IPV6_SOURCE_PREFIX_BITS`, 256 /64s; a routed /48 is 256 sources); the e-mailed-code
  limits still key on `rateLimitKey`, the whole address.
- **Hashing is `src/password/`**: `hash.ts` (scrypt, parameters stored beside the hash, `needsRehash`, the dummy
  derivation that equalises the paths, and `admit()`, the gate of eight derivation places a sign-in step takes
  before it counts anything), `policy.ts`, `generate.ts`. `PortalRuntime.passwords` is the hasher,
  overridable in tests so a suite can count derivations.
- **The operator** is `src/accounts/` and `scripts/account.ts` (`pnpm portal:account`, or `portal.sh account`).
  `invite` and `otp` refuse to run in password mode.
- **The host and the app** learn the mode from `GET /auth/signin-mode` through
  `packages/host/src/auth/portal-mode.ts`, which `GET /api/v1/auth/session` reports as `signInMode: "password"`
  and nothing otherwise; `apps/web/components/sign-in-screen.tsx` reads it. See
  [`portal-session-auth.md`](portal-session-auth.md), "Status".

## Where things live

| File | Role |
|---|---|
| `apps/portal/src/boot.ts` | migrate as the owner, then open and check the server's connection; production refuses a privileged role |
| `apps/portal/src/process-guards.ts` | the last resort: an unhandled rejection or exception is logged, then exit 1 |
| `apps/portal/src/server.ts` | `node:http` and the route table; a fixed base for every request target, and a `.catch` on every request |
| `apps/portal/src/routes/index.ts` | the route table; `registerPortalRoutes` is the whole surface |
| `apps/portal/src/routes/authorize.ts` | `GET /authorize` and the two browser form posts |
| `apps/portal/src/routes/activate.ts` | `/activate`, its two posts, and `POST /auth/device/approve` |
| `apps/portal/src/routes/tokens.ts` | every JSON endpoint, including `/auth/token` and JWKS |
| `apps/portal/src/routes/logout.ts` | `GET` / `POST /logout` — the way out of the portal's own session |
| `apps/portal/src/routes/support.ts` | per-request context, the four response shapes, CSRF, limiters |
| `apps/portal/src/flows/context.ts` | `PortalRuntime` — mailer, keyring, limiters, issuer, proxy flag |
| `apps/portal/src/flows/authorize.ts` | client + redirect validation, the authorization code, the two redirects |
| `apps/portal/src/flows/token.ts` | both grants and `mintSession`, the one place a session is born |
| `apps/portal/src/flows/device.ts` | the device-code state machine, the platform mapping table |
| `apps/portal/src/flows/session.ts` | Bearer verification, `/auth/session`, logout, `/tenant/config` |
| `apps/portal/src/flows/login.ts` | the browser `devices` row and `login_precheck` |
| `apps/portal/src/flows/web-session.ts` | mint the browser cookie with its version, check it is live, revoke it |
| `apps/portal/src/flows/reasons.ts` | reason → status → RFC family → copy; the host-vocabulary narrowing |
| `apps/portal/src/jwt/keys.ts` | Ed25519 keys, `kid`, the JWKS document |
| `apps/portal/src/jwt/sign.ts` | the access token, and its verification |
| `apps/portal/src/flows/sign-in.ts` | the sign-in state machine: `beginSignIn`, `submitInvite`, `resendInvite`, `SignInState`, the invite resend budget |
| `apps/portal/src/routes/sign-in-flow.ts` | one state, one page, one status; the e-mail step's limits; the three posts both doors share |
| `apps/portal/src/otp/{send,verify}.ts` | `deliverLoginOtp` (mint and mail a six-digit code: limits, cooldown, lock, the 15-second repeat window, retire a code whose mail never went), and the audited verify |
| `apps/portal/src/store/postgres/otps.ts` | `send` (the per-address advisory lock, the repeat check, the budget, retire the older codes, insert), `verify` (the daily total, the newest unused code, use it and the rest), `retire`, `status` |
| `apps/portal/src/store/postgres/identity.ts` | `orgs.hasSeatFor`, the seat arithmetic of `login_precheck` without its lock, beside `countActiveUsers` |
| `apps/portal/src/invites/` | `portal:invite`: `args.ts`, `issue.ts` (the store half, roles), `deliver.ts` (the invite e-mail), `role.ts` (change a member's role) |
| `apps/portal/scripts/invite.ts` | the CLI shell: parse, migrate, issue, e-mail, print only with `--print`, exit codes |
| `apps/portal/src/store/postgres/invites.ts` | create (retire, then insert), redeem (lock, count, activate, copy the role), `issuedSince` |
| `apps/portal/migrations/0011_invites.sql` | `invites`: bound to an address, hash only, role, 5 attempts, one live per address, plain tenant RLS |
| `apps/portal/src/testing/sign-in-kit.ts` | a pilot tenant, the operator's invite as the e-mail a tester reads, and the sign-in posts |
| `apps/portal/test/global-setup.ts` | one real Postgres for the run: a free port from the OS, a start failure that throws and says why, and `keepExitCode` (see the Gotchas) |
| `apps/portal/src/security/**` | cookies, the web session, CSRF, rate limits, headers, bodies, client IP |
| `apps/portal/src/views/**` | the one escaping helper, the locale catalogs, the screens (sign-in, enter code, enter invite, dead end, approve, outcome) |
| `apps/portal/locales/{en,id}/portal.json` | every user-facing string, including the reason table |
| `apps/portal/migrations/0008_oauth_client_scope.sql` | closes the pre-auth window on `oauth_clients` |
| `apps/portal/migrations/0009_web_session_revocation.sql` | `web_session_versions`, and the `state_hash` comment correction |
| `apps/portal/migrations/0010_app_login_role.sql` | `portal_app_login`, the server's role: `LOGIN`, member of `portal_app`, nothing else, no password |
| `apps/portal/src/store/postgres/roles.ts` | who a connection is (`pg_roles`), and the development-only password for `portal_app_login` |
| `apps/portal/src/store/postgres/web-sessions.ts` | the counter: no row means version 1 |
| `apps/portal/src/testing/{pg,server}.ts` | the `portal_app_test` role, and a real portal on an ephemeral port |
| `apps/portal/src/flows/password-sign-in.ts` | the password sign-in as steps: identify, verify (take a place, charge first), the forced change; the audit rows |
| `apps/portal/src/routes/password-flow.ts` | the two password posts and pages, shared by `/authorize` and `/activate`; the 20 / 10 budgets, per source; `503` when busy |
| `apps/portal/src/routes/signin-mode.ts` | `GET /auth/signin-mode`, registered only in password mode |
| `apps/portal/src/password/{hash,policy,generate}.ts` | scrypt and its stored parameters, the gate of eight derivation places (`admit`), the 12 to 200 policy and the username pattern, the generated initial password |
| `apps/portal/src/security/password-attempts.ts` | in this process: which sources have attempted which person, and the order one person's attempts are charged in |
| `apps/portal/src/store/postgres/credentials.ts` | `user_credentials`: create, find, list, `reserveAttempt` (the lockout and its three slots), `recordSuccess` (guarded by the proved hash), `clearAttempts`, `setPassword` |
| `apps/portal/migrations/0012_password_signin.sql`, `0013_password_grace.sql` | `user_credentials` and `resolve_tenant_for_username`, no second-factor column; then `grace_attempts`, the three slots under the lock |
| `apps/portal/src/accounts/`, `apps/portal/scripts/account.ts` | `portal:account`: create, reset-password, disable, enable, set-role, list |
| `apps/portal/src/mail/disabled.ts` | the mailer of password mode: refuses to send, builds no transport |
| `apps/portal/src/testing/{password-kit,code-pages}.ts` | a password-mode pilot and its posts; the code-mode screens rendered for the byte pin |

## Touches / Do not touch

Read before editing `apps/portal`. Lanes: Enterprise. The Nultron Enterprise bundle sets `PORTAL_SIGNIN_MODE=password` (since 2026-10-09; `scripts/release-web.mjs` `ENV_DEFAULTS` and the k8s base). The portal's own default when the variable is unset is still `code`. HYP AI's own repo sets `password` too.

**This page owns these:**

- `apps/portal/src/` (`boot.ts`, `server.ts`, `config.ts`, `routes/`, `flows/`, `jwt/`, `otp/`, `password/`, `security/`, `store/`, `views/`, `mail/`, `invites/`, `accounts/`, `seed/`), `apps/portal/scripts/` (`otp.ts`, `invite.ts`, `account.ts`, `seed.ts`, `migrate.ts`), `apps/portal/locales/`.
- New schema only as `apps/portal/migrations/0014_*.sql` and up. Files `0006` to `0013` are applied history: add a new file, never edit one.
- The container side: `webapp-deploy/portal.Dockerfile`, `webapp-deploy/portal-entry.sh`, `webapp-deploy/portal.env.example`, `apps/portal/compose.yml`.

**Hard rules from `apps/portal/AGENTS.md`:**

- The portal imports nothing from `@agentforge/*`, and nothing outside `apps/portal` imports it. Verified: the only match for `@agentforge/` in `apps/portal/src` is a comment in `apps/portal/src/log.ts`, and `packages/host` and `packages/core` mention the portal only in comments and through `AGENTFORGE_PORTAL_URL`.
- `docs/internal/portal/migrations/0001` to `0005` are the backend team's files. Read at runtime, never copied, never edited.

**Do not touch from a portal change:**

- The e-mailed-code screens and routes. `apps/portal/src/routes/code-mode-unchanged.test.ts` pins them byte for byte against `main` at `9aba37e`; a password-mode change that moves one byte of code mode fails it. Fix the change, not the pin.
- `packages/host/src/auth/` (the product's side of sign-in): [`portal-session-auth.md`](portal-session-auth.md). A reason code added here needs the copy and the host's reason table in the same change.
- `packages/core/src/tenancy/types.ts`: the role strings the portal and the host both read; changing them is a wire change.
- The product database. The portal has its own Postgres under `PORTAL_DATABASE_URL`, never `DATABASE_URL`; the product stays on SQLite.
- Brand in portal copy: the sign-in and mail text name the product through `apps/portal/src/otp/product-name.ts`, not a typed brand. Keep it that way for every white-label brand.
- HYP AI's Cloudflare edge: HYP AI's own repo holds it, not this one ([`release-and-sync-lanes.md`](release-and-sync-lanes.md)).

## Gotchas

- **Password mode: every path through `verifyPasswordStep` runs exactly one derivation.** An unknown
  username, a disabled person, a locked account, an over-long password and a wrong one each end in
  `verifyDummy` or `verify`, which is what keeps the form from being an oracle for which accounts exist. A new
  early `return` in that function that skips both reintroduces one. `password-sign-in.test.ts` counts the
  derivations per path through a wrapped hasher, so it fails there; a comparison of times would not.
- **Password mode: count first, compare second, and never hash inside the transaction.** `reserveAttempt` holds
  the row for a short transaction and hands out the hash only to a caller that won an increment. Moving the
  comparison into that transaction would pin a pooled connection for ~100 ms per guess; moving the count after
  the comparison would let a parallel burst buy as many guesses as it can fire. Both are tested.
- **Password mode: mark the source before the comparison, not after it, and take the place before the count.**
  `attempts.enter` is called in the same synchronous step as the queued `reserveAttempt`; marking on failure
  would let a burst from one address all look clean and take the slots under the lock between them. And
  `signInWithPassword` asks `passwords.admit()` first: a refusal for want of a derivation place (`503`) has
  counted nothing, which is only true while the permit is taken before `reserveAttempt`, never after. Both
  orders are pinned (`flows/password-sign-in.test.ts`, "one address exactly five comparisons" and "answers busy
  before it counts anything").
- **Password mode: the lock refuses a source that has failed, not the person.** The in-process record is what
  tells them apart, so it is per process and empty after a restart; the database holds the bound (five plus
  three), not the record. A change that moves the three slots out of the row, or lets the record raise the
  count, loses the bound.
- **Password mode: the `password` field is not trimmed, the identifier is.** A space can be part of a password;
  `stringField` trims, so the password is read by `passwordField` in `routes/password-flow.ts`. Do not "tidy"
  that.
- **Password mode: a person made by `seed` has no credential.** The owner `seed` creates is active and has no
  password, so they cannot sign in until `portal:account create --email <their address>` attaches one (it keeps
  their role and takes no new seat).
- **SR-30 was changed on purpose, by the owner (2026-10-01).** The e-mail step used to be one neutral
  page and a timing floor, so nobody could tell a member from a stranger. It now tells them (section 3):
  member, invitee, spent invite, no access and lock are different pages, which makes it an oracle for
  "is this address a member, an invitee or neither" — exactly what the owner asked for. Nothing else is
  revealed (no tenant, org, role or member list), the 150 ms floor stays, and the limits above replace
  the neutral page. Anyone changing a limit, or adding a page that says more, re-reads that decision.
- **The per-IP limits are only as good as the address they key on.** `signInEmailIp`, `inviteAttemptIp`
  and the existing `otpSendIp` read `clientIp`, which believes `X-Forwarded-For` only behind
  `PORTAL_TRUST_PROXY=1`. Without it every visitor shares the socket-address bucket and fifteen e-mail
  steps in a quarter hour lock **everyone** out. The k8s base and the review instance set it; check any
  other deployment. They are in-process, so a second portal instance halves them.
- **The invite is not a second factor.** The portal e-mails it to the same address that later receives
  the six-digit code, so anyone who controls the inbox gets both. What keeps a stranger out is that an
  operator invited the address (the `invited` row), and what the invite adds is an explicit, bounded
  activation: single use, bound to the address, 7 days, five guesses. The six-digit code is still
  required after it. Redeeming activates the member **before** the mailbox is proved, so a person who
  holds a code but not the inbox can activate the membership and nothing more.
- **"E-mail me my invite again" is unauthenticated.** A third party who knows an invitee's address can
  retire the code sitting in the tester's inbox and send them a new one, up to four an hour (a minute
  apart); the e-mail only ever goes to that address, never to the requester. Likewise anyone who knows
  the address can lock an invite with five wrong codes, and lock the replacement again after each
  reissue — the same class as the OTP lockout (SR-53), and the operator's reissue is the remedy.
- **Any send retires the pending code, and a send can be asked for by anyone who knows the address.** A
  newer code replaces the older one (section 3), so a third party who posts the e-mail step for an
  address, a quarter minute or more after the last code, makes the code already in that person's inbox
  stop working and sends them another. The bound is the existing one — `signInEmailAddress` 6 / 15 min,
  the DB's 3 sends / 15 min — and before this change the same post already made the older code fail (the
  newest unused one is the one `verify` compares, so the old one was a wrong guess against the new one
  and burnt its attempts). It is an availability limit of the same class as the OTP lockout, not a
  sign-in bypass: nothing here lets the sender read, guess or reuse a code.
- **An active member's invite step sends a code without looking at the invite code typed.** A post to
  `/authorize/invite` for an address that is already `active` has nothing to redeem and falls through to
  `deliverLoginOtp` (`submitInvite`, the `active` branch). What bounds it is `inviteAttemptIp` (10 / 15
  min per IP, counted before the work) and the DB's 3 sends / 15 min per address, and the 15-second
  repeat window now keeps a re-post from spending any of them. It reaches only the member's own
  inbox, and the typed value is never compared, so it cannot be used to guess anything. The related
  residue: anyone who knows an invitee's address can lock the invite with five junk codes, or rotate it
  with "e-mail me my invite again" up to four times an hour (the existing item above); the operator's
  re-issue is the remedy.
- **The seat check at the first step is a courtesy, not a gate.** `orgs.hasSeatFor` takes no lock and
  reads `count_active_users` as it is, so two invitees can both be told there is room for the last seat;
  the second is turned away at the exchange (`login_precheck` takes the org's advisory lock there) with
  `?error=seat_cap_reached`, after redeeming their invite. That is the old behaviour, now the narrow
  one. Do not read a `true` from it as a reservation. A dead invite shows its own dead end, not the
  seat page, and `resendInvite` does not ask (it sends an invite, not a sign-in code).
- **A test run that does not print `Tests  N passed` did not run.** Importing `embedded-postgres` installs
  an `async-exit-hook` whose `beforeExit` handler calls `process.exit(0)` over vitest's
  `process.exitCode = 1`, so until 2026-10-01 the portal suite exited **0** after a failing test, and
  after a start failure under an administrator token ("No test files found"). `test/global-setup.ts`
  now records the code at `beforeExit` and restores it at `exit` (`keepExitCode`), throws a real error
  with the server's output when postgres does not start, stops the server if the migrations fail, and
  takes its port from the OS: the old `55000 + pid % 5000` landed in the Windows excluded range
  (58702-59882 here) about one run in four and died with "Permission denied". `scripts/ci-local.mjs`
  still demands the `Tests  N passed` line on top of the exit code. Removing the library's `beforeExit`
  listener instead does not work: its `exit` listener then runs first and crashes with "done is not a
  function". `runas /trustlevel:0x20000` returns at once, so write the log and the exit code to files and
  wait for them.
- **A member who has ever signed in cannot be `DELETE`d.** `audit_log.actor_user_id` is `ON DELETE SET
  NULL`: an UPDATE the append-only trigger refuses, and with the trigger off the NULL it writes breaks
  `audit_log_actor_shape_chk`. Removal today is `users.status = 'disabled'`, which the e-mail step treats
  as no access; `routes/sign-in-states.test.ts` "9." has to delete the member's audit rows with the
  trigger off to simulate a hard removal. Whoever builds account erasure meets this first.
- **A disabled member is `no_access` at the e-mail step now.** It used to be mailed a code and refused
  at the login gate with `user_inactive`. A disabled member who still holds a portal cookie is sent
  back to the app by `GET /authorize` with `?error=user_inactive` (that gate is unchanged), and the
  device screens refuse the cookie outright.
- **`other_tenant` cannot see two tenants.** The CLI refuses an address that belongs to exactly one other
  tenant, but `resolve_tenant_for_email` answers `null` for both "unknown" and "in two tenants", so an
  address already in two other tenants can still be invited and then never signs in. And `portal:seed`
  does not check either way: seeding an active user for an address that is invited elsewhere makes it
  ambiguous.
- **A role change is not instant.** It changes `users.role`; the new role is in the next access token
  (the portal reads the member's row at every mint and every refresh), and a token already issued keeps
  the role it was signed with for its hour. The host decides when it re-reads its own membership. The
  host's `ensurePortalOwner` (`packages/db/src/portal-owner.ts`) gave `owner` to every first-time sign-in
  until it reads the `role` this portal now sends; that file is not this lane's.
- **The command is `pnpm --filter @agentforge/portal invite`.** The root `package.json` has `portal:seed`
  and `portal:otp` aliases and no `portal:invite`; adding it is one line outside this directory.
- **The suites lift the two strict e-mail limits by default** (`startTestPortal({ emailStepLimits })`),
  because a suite that signs in thirty times from one address is not a suite about them.
  `routes/sign-in-limits.test.ts` runs on the limits as shipped.
- **One `Set-Cookie` per response, by construction.** `PortalResponse.headers` is
  `Record<string, string>` (`apps/portal/src/server.ts:33`), which another lane owns, so a second
  cookie has nowhere to go. `htmlResponse` / `redirectResponse` take a single `cookie`
  (`security/headers.ts:98-101,133-135`) and every screen needs at most one — the form pages mint
  the CSRF cookie, the redirect after sign-in mints the session cookie, and a CSRF cookie set on the form
  page is still there on the post. If you add a screen that needs two, that constraint is what
  will bite.
- **The browser's "device" is one row per `(user, oauth client)`**, `platform = 'web'`,
  `install_id = "web-client-<client_id>"` (`webInstallId`, `flows/login.ts:26`). `sessions.device_id`
  is NOT NULL and `login_precheck` refuses a user with no live device, so the browser flow needs a
  device row exactly as the desktop one does — and the id has to be derivable at `/auth/token`
  time, where the host holds nothing of the browser. The cost: two browsers of one user share a
  device row, so an admin cannot revoke one without the other. Sessions stay individually
  revocable. Per-browser granularity needs a `device_id` column on `auth_codes`.
- **The portal's own browser session is a signed cookie, not a row** (`security/web-session.ts`) —
  but it is revocable. The cookie carries `ver`, the value of `web_session_versions.version` it was
  minted under, and every use compares it inside the tenant scope (`flows/web-session.ts`). **No
  row means version 1**, so nothing was back-filled; a revocation is one UPSERT and takes effect on
  the next request. What ends a session: `GET`/`POST /logout` clears this browser's cookie, and
  `POST /auth/logout` with `all_devices: true` bumps the counter, which ends every browser that
  user holds. A single-session `/auth/logout` deliberately does not — it would sign somebody out of
  browsers they never touched. Every use still re-runs `login_precheck` as well.
  What this shape does **not** buy is revoking one browser from another, which would need a session
  id in the cookie and a row to match it — the same follow-up `devices` already has (SR-23).
- **A cookie minted before `ver` existed is refused**, not read as version 1. Everyone signed in at
  the moment fix pass X was deployed signs in once more. That is deliberate: the server decides, and
  it cannot decide about a payload shape it does not recognise.
- **`jwks_keys` is not read.** `0004_rls.sql:178` grants `portal_app` **SELECT only** on it, so
  this process cannot publish its own key through the table; `publishedJwks` serves the in-process
  keyring instead. Rotation through `jwks_keys` needs an ops step run as `portal_admin` plus a
  store method that does not exist yet.
- **A cross-tenant device-code approval answers `device_code_expired`, not `tenant_inactive`.**
  `p_device_codes_app` (`0004_rls.sql:57`) hides the other tenant's row from the `SELECT … FOR
  UPDATE`, so the handler never reaches its own tenant-mismatch branch
  (`store/postgres/device-codes.ts:108-110`, unreachable in production). It fails closed, which is
  the stronger behaviour; the doc's reason code is what is wrong.
- **A logout answers `refresh_reused` on the next refresh, not `session_revoked`.**
  `revoke_session_chain` marks the outstanding refresh rows revoked and `rotate_refresh_token`
  treats a revoked row as reuse. Both are terminal and the client clears the session either way,
  but the login doc's reason table implies the other one.
- **`device_code.requested` is not audited for a generic build.** `audit_log.tenant_id` is NOT
  NULL (`0003_billing_and_usage.sql`) and a code minted with no `tenant_hint` has no tenant yet
  (`flows/device.ts:107-120`). Every shipped installer is branded and always audits.
- **Rate limits are per process.** In-memory fixed windows (`security/rate-limit.ts`). One portal
  behind one proxy is the deployment; a second instance halves every limit's effectiveness. A full
  map (20,000 keys) evicts its oldest 1% of windows rather than refusing new keys, so a flood can
  reset a window but cannot lock anybody out. An IPv6 client still gets a fresh key per address,
  and nothing here groups a /64.
- **The right-most `X-Forwarded-For` entry is the client only with exactly one appending proxy.**
  That is Caddy as `webapp-deploy/Caddyfile` runs it, which replaces the header for an untrusted
  peer. A CDN in front of Caddy with `trusted_proxies` set would append its own edge address last,
  and every client would then share the CDN's buckets. `security/client-ip.ts` has to change with
  the proxy chain, exactly as `packages/host/src/rate-limit.ts` does.
- **The daily OTP budget can be spent by someone else.** Anyone who knows an address can make 20
  wrong guesses and lock it out of OTP sign-in for up to 24 hours. That takes four codes, so about
  twenty minutes under the 3-per-15-minute send limit. That is the price of stopping the guessing.
  A live portal session cookie (30 days) still signs that person in without a code, and every lock
  is an `otp.locked` audit row.
- **Outside production the portal writes one role's password.** On every migrate, `src/boot.ts`
  sets `portal_app_login`'s password from `PORTAL_DATABASE_URL`, and only when the DSN names exactly
  that role and the owner's DSN is a different one. That is what lets compose and the review
  instance run the server as the app role with nothing but two DSNs. Production never does it: 0001
  provisions login roles out of band. The statement carries the password in plaintext, so a dev
  Postgres with `log_statement` on would log it.
- **`PORTAL_TRUST_PROXY` and `PORTAL_PUBLIC_URL` are `loadConfig`'s** since fix pass X
  ([SR-33](../security-register.md#sr-33)): `config.publicUrl` and `config.trustProxy`. The public
  URL must be a bare origin — https anywhere, http on loopback only, no path, query, fragment or
  credentials — and is **required in production**. `createRuntime` reads the config, not the
  environment, and `security/client-ip.ts` takes the proxy decision as an argument. A route handler
  still never touches `process.env`.
- **The compose Postgres password has no default.** `${PORTAL_POSTGRES_PASSWORD:?…}` in
  `apps/portal/compose.yml`, so `docker compose up` refuses rather than falling back to a literal
  in git. An **existing** `portal-pgdata` volume keeps the password it was created with —
  `POSTGRES_PASSWORD` is only read by `initdb` — so a dev machine from before this change still
  needs the old one in its DSN. `scripts/review-instance.ps1` no longer seeds the literal `portal`
  ([SR-44](../security-register.md#sr-44)): it keeps whatever `review.env` already holds, generates
  one for a fresh review root, and **stops with an instruction** when the volume exists but
  `review.env` has no password. The test suite is unaffected either way: it runs
  `embedded-postgres`.

## Verify

Counts below were re-run on 2026-10-01 after the sign-in-codes pass (the invite / sign-in-states / roles pass before it) —
`pnpm --filter @agentforge/portal test`: **36 files, 551 tests, all passed** (it was 34 files, 512 tests before the
sign-in-codes pass; 39 tests and two files added), exit code 0; `tsc --noEmit` clean. (On this Windows desk
`embedded-postgres` refuses to start under an administrator token, and the run now fails with that
explanation and a non-zero exit instead of "No test files found" and 0. The run that
produced these counts was started through `runas /trustlevel:0x20000`, which drops the admin token so the
embedded server starts as designed. A Docker Postgres through `PORTAL_TEST_DATABASE_URL` also works, but
the Docker VM's clock ran about three seconds behind the host and failed four tests that compare database
time with the host's, so prefer the embedded one.)

| Suite | Proves |
|---|---|
| `apps/portal/src/routes/browser.test.ts` (24) | the browser hops for a member, five attempts, the send budget (its own portal and clock), the daily guess budget over the wire (now also at the e-mail step), the seat-cap redirect at the exchange (the seat is taken between the page and the exchange), no secret in a log |
| `apps/portal/src/routes/sign-in-states.test.ts` (41) | the nine states the owner listed on `/authorize/*` and `/activate/*`, the double click, the resend, the fifth wrong invite code as the lock, no password field, no invite code in a log or audit row |
| `apps/portal/src/routes/sign-in-codes.test.ts` (11) | a replaced code stays dead after the newer one signs in; one request is one code: sequential repeats, two posts together, a double-clicked invite, after the window, after a used code, after a refused transport, and the explicit resend still waits its minute |
| `apps/portal/src/routes/sign-in-seats.test.ts` (8) | a one-seat org: the e-mail step says no seat to an invitee and an active member in both languages and on both doors, the seat holder still signs in, a page open before the seat went does not spend the invite or a wrong-guess count |
| `apps/portal/src/routes/sign-in-limits.test.ts` (7) | the e-mail step per IP and per address, typed invite codes per IP, the invite resend budget, on the limits as shipped |
| `apps/portal/src/routes/roles.test.ts` (8) | an invite's role from `issueInvite` through a real browser sign-in and the code exchange to the claim, the response and `/auth/session`, and through a refresh after the operator changes it |
| `apps/portal/src/invites/*.test.ts` (36) | issuing (refusals, the owner rule, org choice, roles), the invite e-mail (both languages, no link, audit), changing a role (last owner, same role, not active), the CLI's arguments |
| `apps/portal/src/store/postgres/invites.test.ts` (22) | hash only, bound to the address, 5 attempts under concurrency, expiry, single use, the role copied at redemption, one live invite by the index, the resend history |
| `apps/portal/src/routes/api.test.ts` (34) | the exact token key set, replay, wrong secret, redirect mismatch, refresh reuse, refresh without a `device_id`, the full device flow, `slow_down`, the Bearer endpoints, and behind a proxy the right-most `X-Forwarded-For`, the poll limit, and the per-client refresh bucket |
| `apps/portal/src/routes/logout.test.ts` (11) | the way out: the cookie cleared on every answer, the origin-exact `post_logout_redirect_uri`, the CSRF-protected post, the server-side revocation, the audit row |
| `apps/portal/src/security/rls.test.ts` (19) | the connection is a non-superuser `portal_app` member; tenant A reads and writes none of tenant B's `users`, `sessions`, `refresh_tokens`, `login_otps`, `auth_codes`, `invites` (and cannot redeem another tenant's invite); the pre-auth window |
| `apps/portal/src/security/security.test.ts` (57) | cookie prefixes, the web session, CSRF, rate limits, their eviction and the refresh buckets, client IP from the last hop, the password sign-in's source bucket (an IPv6 /56, IPv4 untouched, `rateLimitKey` still the whole address), headers, body caps, and `form-action` on an authorize page |
| `apps/portal/src/boot.test.ts` (17) | the server role read from `pg_roles` for real roles (superuser, `BYPASSRLS`, `portal_admin` member, stranger); production refuses each; development warns; the app login's password set outside production only, for that role only |
| `apps/portal/src/server.test.ts` (14) and `process-guards.test.ts` (6) | an unparseable request target is a 400 and a bad Host header is ignored, over a raw socket; the error path's own failure is contained; the process-level last resort logs and exits 1 |
| `apps/portal/src/views/views.test.ts` (23) | escaping against four injection payloads on every screen (the new ones included), `en`/`id` key parity, locale negotiation, the invite screen never echoes a code |
| `apps/portal/src/routes/password-sign-in.test.ts` (41) | the password mode over HTTP: the form, the forced change, the redirect and the code the host redeems, one refusal for four causes with equal work and comparable time, the lockout (five from one address, a restart, a parallel burst, the expiry), the person who gets in from their own address while the attacker's stays out and the eight-comparison bound from twenty-four addresses, the forced change's refusals, a disabled person, CSRF, the code routes absent, the device-code page, the seat gate, re-hashing, the two budgets (per source, an IPv6 /56 as one, one address unable to spend a person's budget), `503` when eight are deriving, a live cookie that does not resume past the forced change, a sign-in held past its password check whose credential is then flagged (change page, no code, no cookie, on both doors), and no password in any page, audit row or log line |
| `apps/portal/src/flows/password-sign-in.test.ts` (20) | the password sign-in's decisions over a real Postgres, with no HTTP: the lock and the person it must not keep out, the bound of five plus three under parallel guesses from forty addresses, across a restart, and from one address; the audit rows (system as the actor, `lock_repeated`, at most five `withheld`); a reset that lands while a password is being compared, and a sign-in that only lost a race to another one re-hashing; the NFKC length ceiling; the `busy` answer that costs nothing and the permit given back on every road out |
| `apps/portal/src/security/password-attempts.test.ts` (11) | the in-process record: clean the first time, a mark ends fifteen minutes after the first attempt, forgotten on success, bounded in size, and the per-person order of charges |
| `apps/portal/src/routes/code-mode-unchanged.test.ts` (10) | the default mode is what `main` was: 18 screens by sha256, both route tables as exact lists, the password routes and `/auth/signin-mode` as 404s, the SMTP mailer kept |
| `apps/portal/src/accounts/cli.test.ts` (7) | `scripts/account.ts` as a real process under `tsx` against a real Postgres, in the environment the container gives it: usage, the refusal off password mode, the one-time password on stdout only, exit codes 2 to 5, reset, disable, enable, and `invite` and `otp` turned away |
| `apps/portal/src/store/postgres/credentials.test.ts` (28), `src/accounts/accounts.test.ts` (19), `src/password/password.test.ts` (20), `src/views/password-views.test.ts` (8) | the credential store (no secret field, schema CHECKs, tenant isolation, `reserveAttempt` under 50 parallel callers and its three slots under the lock, a stale success that writes nothing, the audit counts), the operator commands (seat cap, last owner, sessions ended on disable, reset and an attaching create, `enable` and `reset-password` clearing the counters, the 24-hour lock count in `list`, no password in the audit row or the list), scrypt, the derivation gate and the policy, and the two screens |
| `apps/portal/src/jwt/keys.test.ts` (11) and `sign.test.ts` (10) | key derivation, the claim set, tampering, `alg: none`, skew, the JWKS document |
| `src/{config,log,crypto,manual-otp}.test.ts`, `src/{mail/mail,seed/seed,otp/product-name,routes/assets,views/brand}.test.ts` and the other `src/store/postgres/*.test.ts` | the remaining: the aggregated config refusal and the two DSNs, the log sink's credential scrubbing (invite codes too), the invite code's shape, the manual OTP (it refuses an invited member), SMTP, the seed's once-only secret, the mail product name, the brand mark, and the store suites (including the daily OTP budget, `loginOtps.status`, retired and repeated codes in `otps.test.ts` (32), `hasSeatFor` in `seats.test.ts` (19) and the 0010 role) |

**Where to press:** [`features/login.md`](../../../.cursor/skills/verify-agentforge/features/login.md),
added 2026-09-21. It is the browser half of this page, and it exists because the suites above cannot
prove the part that matters most: **a non-browser client does not implement CSP at all**, which is
how `form-action 'self'` blocked every human's sign-in while `routes/browser.test.ts` walked the same
three hops green ([SR-20](../security-register.md#sr-20)).

Six live drives are recorded. First, `curl` against the portal on `127.0.0.1:4000` with the compose
Postgres and Mailpit: `/authorize` → e-mail → the code read from Mailpit's HTTP API → the `302` →
`/auth/token`, then the device-code flow, then the negatives (bad `redirect_uri`, unknown client,
replayed code, wrong client secret, sixth OTP attempt, fourth send, refresh reuse). Second, the full
browser sign-in in Chromium on the review instance — the one that caught SR-20.

A third, 2026-09-23, from a harness script against a throwaway `embedded-postgres`, driving the real
`src/main.ts`. First, the unfixed `createPortalServer` exited 1 on `Host: a b` and on
`GET //x:99999/healthz`; the fixed one answered 200 and 400 and kept serving. Then four boots:
production on the superuser DSN exited 2 with the refusal. Production on `portal_app_login`
(password set out of band) served, and `pg_stat_activity` showed only `portal_app_login` sessions,
so the owner's connection had closed. Development on the one superuser DSN booted with
`portal_db_role_bypasses_rls`. Development with two DSNs set the app role's password from
`PORTAL_DATABASE_URL` and booted clean. The review instance itself was not driven.

A fourth and fifth, 2026-10-01, against the real `src/main.ts` on a loopback port, a throwaway
PostgreSQL 16 (the two-DSN setup, so the server ran as `portal_app_login`) and the compose Mailpit for
SMTP. The invite was issued with the real CLI (`pnpm --filter @agentforge/portal invite`, no `--print`):
the invite e-mail landed in Mailpit and the code was read **from that e-mail**. Then a headless Chromium,
which enforces the CSP that `curl` does not (SR-20), signed in end to end: an unknown address got the
no-access page; the invitee's address, typed in capitals with stray spaces, got the invite screen with no
sign-in code sent; a wrong invite code showed "4 attempts left"; "E-mail me my invite again" inside the
minute was refused with the wait notice; the right code (typed lower case, with spaces) went to "Invite
accepted. We just sent a sign-in code…"; the e-mailed code ended in the `302` to the registered callback
with `code` and `state`; and a later sign-in with the e-mail alone went straight to the code. No console
or CSP error besides the expected 400 on the wrong code. Also: `--print` printed the code once; with the
SMTP port pointing nowhere the CLI exited 7 with "Nobody has the code" and printed nothing; a second
invite issued with `--lang id` arrived as "Anda diundang ke Nultron". Mailpit was emptied of the test
messages and the portal stopped afterwards. **Not driven:** the compose Postgres and the review instance
(neither was touched), and the host half of the `role` claim (no host reads it yet).

A sixth, 2026-10-01, on the local Kubernetes rehearsal (`docker-desktop`, namespace `nultron`, rebuilt with
`node webapp-deploy/k8s/rehearse-local.mjs --force-build`, so the portal ran as `portal_app_login` in
production mode behind Caddy with `PORTAL_TRUST_PROXY=1`, mail over STARTTLS to Mailpit). The invites were
issued with the CLI **inside the cluster** (`kubectl exec deploy/nultron-portal -c portal -- ./node_modules/.bin/tsx
scripts/invite.ts --email … --tenant nultron --role member`, no `--print`: the output carried no code), and the
codes were read from the captured mail. A headless Chromium (CSP enforced) went through the real app at
`https://nultron.localhost:8443`: (1) invite → app sign-in → portal e-mail step with the address typed in capitals →
"Enter the invite code we e-mailed to …" with **exactly one mail** to the address so far (the invite) → a wrong
invite code, "4 attempts left" → the right one, "Invite accepted. We just sent a sign-in code to … to confirm
it is your inbox" → a wrong six-digit code, "4 attempts left" → the e-mailed one → the app (`/chat`), and the
portal row was `member active`; (2) with the app's cookies cleared and the portal's kept, the app's sign-in went
**straight back to the app with no form**; (3) a fresh browser with the same address got "We sent a sign-in
code to …" and no invite screen, and the e-mailed code signed in; (4) a stranger got "This e-mail does not have
access yet" (English and Indonesian) and no mail; (5) an invite whose `expires_at` was set an hour back through
`psql` got "This invite has expired or was already used" and no mail; (6) five wrong invite codes then the right
one got "Too many wrong invite codes"; (7) "E-mail me my invite again" inside the minute got the wait notice, a
minute later a new code, and the **old code was refused** while the new one was accepted. An `--role admin
--lang id` invite arrived as "Anda diundang ke Nultron" and left an `invited` / `admin` row. No console or CSP
error beyond the expected 400s, and the final `POST /authorize/verify` → `302` to the app origin worked in
Chromium, so SR-20 still holds with the new pages. **Not driven there:** the 20-wrong-codes lock (covered by
`sign-in-states.test.ts`), the e-mail-step rate limits (`sign-in-limits.test.ts`), and the `role` claim itself
(`roles.test.ts` reads it from a real token; no host in the cluster reads it yet). Screenshots of every step are
in this session's scratchpad, not in the repo. The test members (`*@example.test`) were left in the rehearsal's
database; `teardown-local.mjs` removes it.

## Why

- **The portal is a separate app rather than a mode of the host.** `[Direct]`
  `docs/internal/web-phase9-portal-login.md:24` ("New workspace app `apps/portal` … reached
  **only** over HTTP") and `apps/portal/AGENTS.md:11-19`, which states the two import rules.
- **Postgres from day one, with `0001-0005` unchanged.** `[Direct]`
  `docs/internal/web-phase9-portal-login.md:10`, the owner's second-round ruling 2.
- **No password, by default; one mode has one.** `[Direct]` `docs/internal/portal/device-code-login.md:132` gives
  four reasons, the first being that a password database for four whitelabel partners with no shared
  IdP is the worst asset to hold. The owner lifted that for one mode on 2026-10-07
  (`PORTAL_SIGNIN_MODE=password`, HYP AI; "2FA method being designed"), so the portal's own default sign-in still has none.
  Since 2026-10-09 the Nultron Enterprise release bundle selects the password mode explicitly (its templates and
  `DEPLOY.md`, not this code), so its deployments run it too; `code` stays selectable. See section 8 and [SR-165](../security-register.md#sr-165).
- **A signed cookie for the portal's own session rather than a table.** `[Inferred]` No doc states
  it. The store contract (`apps/portal/src/store/types.ts`) has no browser-session table and
  belongs to another lane, so a migration adding one would have had no code path able to write to
  it; the inference is from that boundary plus the re-running of `login_precheck` on every use,
  which is what makes the missing revocation bounded rather than open-ended.
- **A version counter rather than a session table, once revocation had to exist.** `[Inferred]`
  Fix pass X, 2026-09-21. The requirement was "a revoke takes effect on the next request"
  ([SR-21](../security-register.md#sr-21)), which both shapes satisfy. The counter wins on cost: one
  row per user instead of one per sign-in, nothing to prune, and an absent row reading as version 1
  meant no back-fill. What it gives up is revoking one browser without the others — the same
  granularity `devices` already gives up (SR-23), and the same follow-up would buy both.
