# Nultron Enterprise — Phased Security & Hosting Plan

Target: `nultron-enterprise` ([release-targets.md](release-targets.md), lanes: `enterprise`, `tester`).  
Scope: hardens the hosted web app (`apps/web`, `packages/host`, `packages/core`, `apps/portal`) and its deployment stack (`webapp-deploy/`, `nix/`). All build and verification caches stay local on the operator workstation; hosted secrets stay outside Git and container images.

## Current Baseline

The hosted stack already has strong application-layer boundaries:
- SSRF socket pinning (`SR-201`), ReDoS-bounded credential redaction (`SR-199`), request array cost budgets (`SR-196`), silent SDK stream error hooks (`SR-197`), production-only dependency install for `@agentforge/web` (`SR-113`), two-role RLS separation for Postgres in `apps/portal` (`PORTAL_MIGRATE_DATABASE_URL` vs `PORTAL_DATABASE_URL`, `webapp-deploy/k8s/base/scripts/prepare-db.mjs`), and fail-closed WhatsApp webhook HMAC verification (`SR-191`).
- Known remaining gaps tracked in [security-register.md](security-register.md): `SR-195` (64-bit grant fingerprint hash in `media-permission.ts`), `SR-111` (`run_code` isolated by JS globals rather than OS/network namespace), `SR-132` (Caddy sandbox CSP ordering), `SR-163` (multi-company hosted erase scoping), `SR-170` (plaintext `secrets.env` inputs), `SR-171` (suspended unauthenticated TKE backup job), `SR-208` (`pnpm` 9.15.9 advisories while nixpkgs `pnpm_10` still carries advisories), and dev-time `tsx` shipping in the `apps/portal` image.

---

## Phase 1 — Runtime Bundling, Grant Integrity & Immediate Fixes

**Phase 1a (implemented in `feat/security-phase1-hardening`):**
1. **Eliminate paid-media grant collision (`SR-195`):**
   - Replace the 64-bit non-cryptographic `fingerprint()` hash in `packages/core/src/runtime/media-permission.ts` with lossless canonical JSON serialization of the normalized request tuple `[tool, [[field, value], ...]]`.
   - Convert both `it.fails` cases in `packages/core/src/runtime/media-permission.property.test.ts` into passing invariants verified under `node .cursor/skills/verify-paid-media-gate/scripts/check.mjs --teeth`.
2. **Bundle `apps/portal` and strip `tsx` + devDependencies from the portal image:**
   - Add `apps/portal/src/paths.ts` (`PORTAL_ROOT`, `REPO_ROOT`) and `apps/portal/scripts/build-server.mjs` using `esbuild` to compile `src/main.ts` and `scripts/{migrate,seed,otp,invite,account}.ts` into `dist/*.mjs`.
   - Switch `webapp-deploy/portal.Dockerfile` to a multi-stage `build` -> `runtime` flow running `pnpm install --prod --frozen-lockfile --filter "@agentforge/portal..."` in the final layer and `CMD ["node", "dist/main.mjs"]`.
   - Mirror the same prod-only tree in `nix/pkgs/portal-tree.nix` (`tsx`, `vitest`, `typescript`, and `embedded-postgres` removed from the image closure) and update `webapp-deploy/compose.yml`, `webapp-deploy/scripts/portal.sh`, `webapp-deploy/k8s/base/scripts/prepare-db.mjs`, rehearsal scripts, release compose/docs generators, and deploy tests to execute `node dist/...`.

**Phase 1b (immediate follow-up PRs):**
1. **Bundle `apps/web` server (`server.ts` -> `dist/server.mjs`):** Remove `tsx` from `@agentforge/web` production `dependencies` (updating `webapp-deploy/Dockerfile`, `nix/pkgs/web-prod.nix`, `webapp-deploy/scripts/components.sh`, and `scripts/audit-deployed.test.mjs`) so neither container ships a TypeScript JIT compiler at runtime.
2. **Preview form / webhook cutover (`SR-191`, `SR-132`):** Complete live Caddy header verification for sandboxed artifacts (`SR-132`) and gate `/api/v1/channels/whatsapp/webhook` + env vars before exposing the endpoint externally (`SR-191`).
3. **`pnpm` 9 -> 10 upgrade (`SR-208`):** Blocked as a separate upgrade PR until `nixpkgs` `pnpm_10` updates past the advisories listed in `pkgs/development/node-packages/pnpm` (`pnpm` `10.34.0` in pinned `nixos-26.05` still flags 9 CVEs) and `nix/pkgs/pnpm.nix` + `pnpm-lock.yaml` are refreshed together.

---

## Phase 2 — Runtime & Sandbox Isolation

1. **Minimal declarative Nix images as the release default ([nix-migration.md](nix-migration.md)):**
   - Replace ad-hoc `Debian`/`bookworm-slim` layers built over `corepack` with `nix build .#web-image` and `nix build .#portal-image` built over `nix/pkgs/image-base.nix` + pinned `nodejs-slim`, eliminating package managers (`corepack`, `npm`, `pnpm`) and shells from runtime image layers where not needed.
2. **Egress-denied `run_code` sidecar (`SR-111`):**
   - Move `pyodide` / `quickjs` execution out of the main Node host process into a dedicated worker container/service attached to an `internal: true` Docker/Kubernetes network with zero external egress (`iptables` / Kubernetes `NetworkPolicy` deny-all egress), strict `pids_limit`, `memory` cgroup cap, and `read_only` rootfs.
3. **Network namespace & filesystem tightening:**
   - Isolate Caddy (`proxy`) onto an ingress network + explicit loopback/backend service network so `proxy` has no route to `portal-db`, and audit remaining `/tmp` mounts in `webapp-deploy/compose.yml` and `webapp-deploy/k8s/` for `nosuid,nodev,noexec`.

---

## Phase 3 — Secrets, Identity & Webhook Hardening

1. **Declarative encrypted secrets (`SR-170`, `SR-171`):**
   - Replace plaintext `secrets.env` / `.env` files on the operator workstation and host VM with `sops-nix` (age/KMS-encrypted secrets decrypted into memory-backed `tmpfs` `/run/secrets/*` with strict ownership) or cloud KMS/Secrets Manager on managed deployments.
   - Replace suspended unauthenticated k8s backups (`SR-171`) with authenticated encrypted object-store snapshots (`age` or AEAD + offsite replication) triggered via `systemd` timers or `CronJob`.
2. **Zero-downtime `jwks_keys` & wrap-key rotation:**
   - Automate `jwks_keys` kid rotation with overlapping publication windows before retiring signing keys, and add an offline/online re-encryption path for `AGENTFORGE_SECRETS_KEY` so short legacy keys (`SR-203`) can be rotated cleanly.
3. **Tenant-scoped gateway erase (`SR-163`):**
   - Decide owner policy for multi-company partners and scope gateway credential deletion strictly to the requesting organization before onboarding multiple companies on one portal tenant.

---

## Phase 4 — Data Architecture & Declarative Host

1. **Migrate host state from SQLite to PostgreSQL with RLS:**
   - Mirror `apps/portal`'s dual-role Postgres architecture (`PORTAL_MIGRATE_DATABASE_URL` schema owner for migrations only; unprivileged non-superuser runtime role subject to PostgreSQL row-level security policies) across `packages/db` and `packages/host`.
   - Enforce per-statement and transaction timeouts (`statement_timeout`, `idle_in_transaction_session_timeout`) at connection/transaction level and add a boot/periodic sweep for orphaned `streaming` runs — keeping the concurrency and settlement invariants proved by `formal/chat-run-settle` and `scripts/formal/chat-run-settle.mjs --hazard`.
2. **Declarative NixOS host:**
   - Provision the `nultron-enterprise` VPS with NixOS flakes + `systemd` service hardening (`ProtectSystem=strict`, `PrivateTmp=true`, `NoNewPrivileges=true`, `RestrictAddressFamilies`, `CapabilityBoundingSet=`), nftables ingress limited to Caddy ports `80`/`443`, and atomic generation rollbacks.
