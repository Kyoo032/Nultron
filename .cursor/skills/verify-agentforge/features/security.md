# Security

Settings can confirm which gateway key is saved without ever showing the raw secret. The host hashes the trimmed key (SHA-256) and returns a short `sha256:` prefix. TLS and at-rest seal are already in product; this file maps those surfaces, it does not claim a new envelope. Map: [`docs/internal/maps/pii-and-key-security.md`](../../../../docs/internal/maps/pii-and-key-security.md).

Product: both · Instance: main :3000

## Sub-features

- `key-fingerprint` shows `Saved key fingerprint sha256:…` on Settings (`data-testid="key-fingerprint"`) when `hasOpenai` and `openaiKeyFingerprint` are present. Hidden when no gateway key. Never put the prefix in the password input.
- `privacy-note` states HTTPS-only transport **to the named gateway host** ("… over HTTPS to api.tokotokenai.com", `{gatewayHost}` since 2026-09-17), that Nultron does not log prompts, that keys and threads are encrypted on disk, and that retention is the gateway's policy. That is the TLS / retention note — do not add a second TLS banner, and do not read the host name in it as a leaked endpoint field. On the public Nultron build that host is always the pinned api.tokotokenai.com; only a packaged brand flavor (Kemenkeu AI, AIHub Metranet), or a webdev run with the `AGENTFORGE_GATEWAY_URL` dev hook (`pinned.ts:77-80`, `gateway.ts:37`), shows another host (and a hosted member sees `introRestricted` with no host at all, `settings-page.tsx:412-413`); a flavor shows its own `brand.json` gateway host, because the name comes from the host's `gateway.endpoint`. The host name appears in the intro line only once a key is saved (`apps/web/components/settings-page.tsx:418`) and always in the privacy note (`:580`).
- At-rest seal is the existing AES-256-GCM envelope on `settings.enc`, written and read by `encryptJson` / `decryptJson` (`packages/core/src/crypto/envelope.ts:18`, `:33`; called from `packages/host/src/settings-store.ts:301`, `:414`). Do not claim new seal work from a fingerprint change.
- `gateway-pinning` (SR-85, 2026-10-01) is a source and unit check only. The packaged app sets `AGENTFORGE_PACKAGED=1`, deletes an inherited `AGENTFORGE_GATEWAY_URL` and hands over only a brand flavor's own gateway as `AGENTFORGE_BRAND_GATEWAY_URL` (`bootstrapPackaged`, `apps/desktop/main.cjs:654-680`: `AGENTFORGE_PACKAGED=1` at `:673`, the inherited gateway URL deleted at `:674`, the brand gateway set or deleted at `:677-679`), and `gatewayUrlOverride()` then ignores every dev hook (`packages/core/src/gateway/pinned.ts:72-81`). The proof is `packages/core/src/gateway/pinned.test.ts`, `apps/desktop/packaged-env.test.cjs` and `apps/desktop/brand-read.test.cjs`. It cannot be driven on webdev, where the dev hook is honoured on purpose, or without a packed installer; the register row says the packed build is not driven yet ([`docs/internal/security-register.md`](../../../../docs/internal/security-register.md), SR-85). Do not claim it as driven.
- Doctor prints `keyFingerprint: true` only when `hasOpenai` and `openaiKeyFingerprint` is a non-empty `sha256:` string; otherwise `false`. Missing key is not a doctor fail.

## How to get to it (user POV)

- Open Settings (`settings-link` or `/settings`).
- After a gateway key is saved, the line under the key field names the fingerprint. The password field stays empty / replace-placeholder.
- With no key (Cloud, fresh desk), that line is absent. The privacy note is still on Settings.

## Driving it with the Nultron harness

Preconditions:

- Doctor exits 0.
- Do **not** paste or save a gateway key unless the operator asked.
- Cloud force stub and have no key.

- **Open Settings.** Click `settings-link` or go to `/settings`. `settings-form` is visible. Stay on this page.
- **With a saved key** (`doctor.hasOpenai === true`). `key-fingerprint` is visible (10s). Its text **contains** `sha256:` followed by 12 hex chars; the surrounding sentence is locale copy (`settings.fingerprint` — `apps/web/locales/en/settings.json:20`, `apps/web/locales/id/settings.json:19`), so match `/sha256:[0-9a-f]{12}/`, not the English words. `openai-key` does not contain the fingerprint or the raw secret.
- **With no key** (`doctor.hasOpenai === false`). `key-fingerprint` count is 0. `privacy-note` is still visible. Doctor `keyFingerprint` is `false`.
- **API.** `GET /api/v1/settings` may include `openaiKeyFingerprint` (and optional extra-provider fingerprints; `telegramBotFingerprint` surfaces as `channels-bot-fingerprint`, `channels-page.tsx:65`). The JSON must not contain the raw key. When no key, the fingerprint field is null / absent from the UI — not a leaked secret.
- **IDE proof.** Screenshot under `evidence/security/<run-id>/` with Settings visible. If a key is saved, capture `key-fingerprint`. If not, capture the missing line plus `privacy-note`.
- **Cloud.** Skip fingerprint visibility. Assert `key-fingerprint` count 0 and that doctor reports `keyFingerprint: false`. Do not paste a key to force the line.

## Gotchas

- Cloud has no gateway key. Treat missing `key-fingerprint` as the empty-state pass, not a product fail. Still assert the field is absent (count 0), not leaked into `openai-key` or the settings JSON body as a raw secret.
- The fingerprint is a 12-hex prefix (`sha256:` + 12 chars), not the full digest and not the key. Do not ask the owner to paste the secret to “verify” the prefix.
- Hashing is server-side (`maskSecrets` → `openaiKeyFingerprint`). The Settings client must not import `keyFingerprint` or hash in the browser.
- `privacy-note` already covers TLS. A fingerprint change does not add or rewrite the at-rest envelope.
- Doctor must not exit 1 when `keyFingerprint` is `false`. That is the Cloud stub default.
- **Anchor a raw-key scan.** A loose pattern such as `sk-[A-Za-z0-9_-]{8,}` matches the CSS ids `desk-buddy-dock`, `desk-buddy-tap`, `desk-buddy-chip`, `desk-buddy-minimise` and `desk-backdrop` (`de` plus `sk-buddy…`), so a page-HTML scan fails on a clean page (hit 2026-10-05). Use `(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}`, and also scan `localStorage` and `sessionStorage`.
- Driven read-only on `:3000` 2026-10-05 (`evidence/security/2026-10-05-maintain/`, two drivers, same result): `key-fingerprint` read `sha256:d647ad8d7b0e` and equalled `openaiKeyFingerprint` from `GET /api/v1/settings`, `privacy-note` named `api.tokotokenai.com`, `openai-key` was empty, the settings JSON carried no raw-key pattern, and the endpoint testids counted 0. The first driver's top-level files were overwritten by the second; see `action-a-reconstructed.md` there.
- At-rest inventory (existing AES-256-GCM envelope: `v` / `alg` / `n` / `ct` / `tag` + vault key). **Sealed:** (also desk file bodies, `desk-files/body.ts:8`; artifact bodies, `artifacts.ts:100`; folder proposals, `folder-root/proposal-store.ts:101`; hosted `auth_sessions.refresh_sealed`, `auth/session-secrets.ts:57-65`) `settings.enc` (gateway, extras, tool keys) through `encryptJson` / `decryptJson`; `agent_versions.system_prompt`; `messages.content`; `tool_invocations.input` / `output` through the `sealPayload` / `openPayload` wrappers of the same envelope (`packages/host/src/threads.ts:21`, `:29`; `packages/db/src/repos/drizzle-agent-repository.ts:17`, `:28`). Legacy plaintext still opens for those rows (`openPayload` returns the value when it is not an envelope).
- **Stays plaintext on purpose:** thread `title` (short UX label); agent name / slug / description; model ids (`agent_versions.model`, version `config` generate pins, Settings model picks); binding `config` (empty or copied flags — product does not store keys there); `runs.usage` / `runs.error`; tool key names and status; key fingerprints (`sha256:` + 12 hex — hashes, not secrets).
- This is the product envelope, not a new crypto stack and not an ISO 27001 claim.
- The fingerprint is not gated on `mayChangeKey`: a hosted member gets `settings-key-restricted` (`settings-page.tsx:530`) in place of `openai-key` and `key-fingerprint` can still show, so "`openai-key` does not contain the fingerprint" needs a member exception (count 0). `foundation.spec.ts:64-65` already asserts `privacy-note` visible and `key-fingerprint` count 0 on a keyless desk. The evidence folder named above is gitignored, so a fresh clone cannot check it.
- **Driven 2026-10-06 on `:3000` (keyed; maintain3), read-only.** `key-fingerprint` matched `sha256:<12 hex>` and equalled the `openaiKeyFingerprint` of `GET /api/v1/settings`; `openai-key` was empty; `privacy-note` named `api.tokotokenai.com`; `settings-endpoint`, `settings-endpoint-reset` and `openai-base-url` were count 0; the raw-key scan (`(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}`) over the page HTML, `localStorage`, `sessionStorage` and the settings JSON found 0 hits, and the payload carried no `openaiApiKey`. Gateway pinning and at-rest sealing are unit-test proof only (`pinned.test.ts`, `packaged-env.test.cjs`, `brand-read.test.cjs`); there is no packed installer to drive.
