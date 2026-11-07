# Nix migration: the ladder for Nultron

Rizky, 2026-11-07: move the build factory of the hosted web app from Docker to Nix, strangler style. Each
rung swaps one part of the factory and keeps its output the same; the Dockerfiles, compose, the k8s
rehearsal and `scripts/ci-local.mjs` keep working beside it. Deleting the Docker side is a later change,
made only after the Nix side has run the same jobs. Every rung is its own branch and draft pull request,
stacked on the one before. Nothing here is merged, released or deployed.

Lanes: `enterprise` (the hosted images) and `tester` (the next merge of `main` brings the flake along). No
product code changes; `personal` is retired and owes nothing.

## What the Docker factory is today

Mapped on 2026-11-07 at `39cd5f0`.

| Piece | What it does | Who runs it |
|---|---|---|
| `webapp-deploy/Dockerfile` | The app image. Stages: `base` (`node:22.23.4-bookworm-slim` + pnpm 9.15.9 through corepack), `build` (full filtered install, `vite build` of `apps/web`, the code sandbox folder), `prod` (a fresh `pnpm install --prod --filter "@agentforge/web..."`, the renderer, two load checks), `ffmpeg-amd64` / `ffmpeg-arm64` (BtbN static build pinned by URL and sha256), `runtime` | `scripts/release-web.mjs` (from `git archive <sha>`), `webapp-deploy/scripts/build.sh`, `pilot-local.mjs`, `k8s/local-images.mjs` |
| `webapp-deploy/portal.Dockerfile` | The portal image: `pnpm install --filter "@agentforge/portal..."`, dev dependencies included (`tsx` is the entrypoint) | the same four |
| `Dockerfile.dockerignore`, `.dockerignore` (byte copy), `portal.Dockerfile.dockerignore` (an allowlist) | What enters each build context | BuildKit |
| `webapp-deploy/compose.yml` | Five services: `app` (`nultron-web:local`), `proxy` (`caddy:2.11-alpine`), `portal` and `portal-prepare` (`nultron-portal:local`), `portal-db` (`postgres:16`) | the Jakarta box, `deploy.sh` |
| `webapp-deploy/compose.local.yml` | Loopback rehearsal of the same stack: images `nultron-ent:pilot-local` and `nultron-portal:pilot-local`, Mailpit, a throwaway CA | `pilot-local.mjs` |
| `webapp-deploy/k8s/` | Kustomize base plus `overlays/local` (Docker Desktop) and `overlays/production` (TKE, never applied). Images `nultron-ent` and `nultron-portal`, rewritten by the overlay or the rehearsal's generated kustomization | `rehearse-local.mjs` |
| `apps/desktop/platform/macos/docker/Dockerfile` | Build environment for the retired Personal app's mac dmg (libdmg-hfsplus, rcodesign); builds no image that ships | `pnpm desktop:build:mac:docker` |
| `.github/workflows/` | Deleted 2026-09-24. There is no hosted CI | — |
| `scripts/ci-local.mjs` | The only CI: lint, `tsc` per workspace, vitest per package, `node --test`, the deployed-closure audit, advisory doc checks | a person, before a PR |
| `.nvmrc`, `package.json` | `22`; `packageManager: pnpm@9.15.9`, `engines.node >=22` | corepack, a developer |

No `act` wrapper exists, because no workflow exists to run.

## Pins

| What | Docker | Nix | Same? |
|---|---|---|---|
| nixpkgs | — | `nixos-26.05` at `c56a87d8` (2026-11-05), in `flake.lock` | — |
| Node | `node:22.23.4-bookworm-slim` | `nodejs_22` / `nodejs-slim_22` 22.23.4 | yes, version; built from source instead of the official binary |
| pnpm | 9.15.9 through corepack | `pnpm_9` 9.15.9, shebang moved onto Node 22 | yes. nixpkgs marks 9.15.9 insecure; permitted by exact name only ([SR-199](security-register.md#sr-199)) |

`nix/pkgs/pins.nix` reads `ARG NODE_VERSION` and `ARG PNPM_VERSION` from both Dockerfiles and
`packageManager` from `package.json`. Evaluation fails if they disagree with each other or with nixpkgs, so a
bump in one place without the other cannot build.

## The ladder

| Rung | Applies? | What it adds | What stays the same |
|---|---|---|---|
| 1. Base | yes | `flake.nix`, `flake.lock`, `nix/scope.nix`, the pins, a `pins` check; the three ignore files exclude `flake.nix`, `flake.lock` and `nix` | every Docker image: the new files never enter a build context |
| 2. devShell | yes | the toolchain `ci-local.mjs` calls | `ci-local.mjs` runs unchanged inside `nix develop` |
| 3. Workspace derivations | yes | the pnpm store as one fixed-output derivation; the build tree and the production tree the Dockerfile makes, with its guards | the Dockerfile's trees |
| 4. Images | yes, both | `dockerTools.buildLayeredImage` for `nultron-web:local` and `nultron-portal:local` | refs, tags and the image config, field by field |
| 5. Checks | yes | `nix flake check` wrapping the `ci-local.mjs` steps; `pnpm ci:nix` | `ci-local.mjs` and its steps |
| 6. k8s | partly | kustomize pinned by Nix; a check that renders each overlay and validates it with kubeconform | every manifest |
| 6b. k3s VM test | no | — | — |

Rungs that do not apply, and why:

- **The mac dmg build environment** (`apps/desktop/platform/macos/docker/Dockerfile`). Personal is retired
  (2026-10-14) and no installer is cut. The image is a build machine for electron-builder, not something that
  ships, and its context is its own folder, so the flake files never reach it and its ignore rules need no
  line.
- **GitHub workflows and an `act` wrapper.** Both are gone since 2026-09-24; `ci-local.mjs` is the CI, and
  rung 5 wraps it.
- **A NixOS VM test with k3s.** It needs KVM, and the cloud machine that built these rungs has no
  `/dev/kvm`. Written down and skipped; the kustomize render and kubeconform check is what rung 6 proves.

## How the Nix side is laid out

`nix/scope.nix` builds one `lib.makeScope`. A unit is one file; the folder decides what it becomes:

| Folder | Becomes |
|---|---|
| `nix/pkgs/<name>.nix` | `legacyPackages.<system>.<name>`, and `packages.<system>.<name>` when it is a derivation |
| `nix/checks/<name>.nix` | `checks.<system>.<name>` |
| `nix/shells/<name>.nix` | `devShells.<system>.<name>` |

The folders are listed, never enumerated in a shared file, so two units built in parallel never touch the
same file. A unit's arguments resolve inside the scope first: `nodejs` is the pinned Node 22 and `pnpm` is the
pinned pnpm on that Node, wherever a unit asks for them.

The flake builds what git has committed. A file that is not tracked does not exist to `nix build`; stage it
before you build. Never build through a `path:` flake.

## Running it

```bash
nix flake check -L
```

```bash
nix build .#pnpm
```

## Still owed

- Monday, 2026-11-09: run each rung on a work machine with flakes on, and record the result in its PR.
- Fetching `nixpkgs` from GitHub's archive was not possible in the cloud session (its proxy refuses the GitHub
  API). The lock was written from a `git+https` fetch of the same commit; nixpkgs has no `export-ignore` or
  `export-subst` attributes, so the archive has the same content and the same `narHash`. A machine that can
  reach GitHub verifies it on the first `nix flake metadata`.
