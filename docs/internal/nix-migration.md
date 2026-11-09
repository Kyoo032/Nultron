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
| pnpm | 9.15.9 through corepack | `pnpm_9` 9.15.9, shebang moved onto Node 22 | yes. nixpkgs marks 9.15.9 insecure; permitted by exact name only ([SR-208](security-register.md#sr-208)) |

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

## Rung 2: `ci-local.mjs` inside `nix develop`

Run on 2026-11-07 on the cloud machine (Ubuntu 24.04, root, 4 cores), script unchanged:

```bash
nix develop -c pnpm install --frozen-lockfile
```

```bash
nix develop -c node scripts/ci-local.mjs
```

Every step passed except these four. None of them is caused by the shell: each fails the same way outside it.

| Step | Kind | Result | Cause |
|---|---|---|---|
| `test:apps/portal` | required | fail as root; **735 of 735 pass** against the shell's Postgres 16 | Run as root, `embedded-postgres` hands initdb to a `postgres` user that cannot read the root-owned temp folders it was given. The same happens without Nix. The suite's own way round it, `PORTAL_TEST_DATABASE_URL`, passes against a server started from the shell's `postgresql_16` with password auth. A non-root user does not hit this. |
| `node-test:scripts` | required | 323 pass, 4 fail | The four `pre-push` tests copy the hook into a temp repo with `writeFileSync`, mode 0644. Git on Linux ignores a hook that is not executable ("hook was ignored because it's not set as executable"); Git for Windows does not check. Same four fail without Nix. Not fixed here. |
| `audit:workspace` | advisory | 106 advisories | The whole workspace, dev tools included. Same without Nix. The required gate, `audit:deployed`, passes. |
| `edit:starters:check` | advisory | 7 files missing | The Edit starter media are generated and gitignored, so a fresh clone has none. |

One more thing the first run showed: `node scripts/ci-local.mjs --install` on a fresh clone reports every lint, `tsc` and vitest step as "not installed", because the script looks the tools up before its own install step runs. Install first, then run it.

What the shell sets: `CI_LOCAL_PNPM`, so the script runs this pnpm instead of fetching one with `npx`, and `npm_config_nodedir`, so node-gyp reads the pinned Node's headers.

On NixOS there is no `/lib64/ld-linux-x86-64.so.2`, so the glibc programs npm ships (biome, embedded-postgres's
`postgres` and `initdb`) do not start from `node_modules` there. esbuild is a static Go binary and starts
anywhere. The flake checks of rung 5 run those steps inside Nix instead.

## Rung 3: the workspace as derivations

One unit per Dockerfile stage, plus the parts they share:

| Unit | Docker equivalent | What it does |
|---|---|---|
| `docker-context.nix` | BuildKit's context | Reads an ignore file with BuildKit's rules (last match wins, a match on a parent folder counts, `**`, `!`) and returns the files it keeps. Checked against both reference images: the portal context is the same 185 files, and the app context differs only by `apps/web/dist/` and `sandbox/`, which the build stage adds |
| `pnpm-deps.nix` | the downloads inside `pnpm install` | `fetchPnpmDeps` over the whole lockfile, every platform, as one fixed-output derivation. Its inputs are the manifests and the lockfile only. Its hash pins every tarball, `xlsx` included |
| `pnpm-offline-install.nix` | `pnpm install --frozen-lockfile` | A setup hook: install offline with `--ignore-scripts`, then `pnpm rebuild --pending`, because pnpm refuses an offline scripted install of `xlsx` (`ERR_PNPM_NO_OFFLINE_TARBALL`, reproduced here) |
| `sandbox-cache.nix` | the wheel downloads of `build-sandbox-runtime.mjs` | Each wheel in `scripts/sandbox-runtime.lock.json` as a `fetchurl` with the lock's URL and sha256 |
| `web-build.nix` | stage `build` | The filtered install, `vite build`, and the sandbox folder with `--offline` |
| `web-prod.nix` | stage `prod` | `--prod` install, the renderer, and both load checks the Dockerfile runs |
| `ffmpeg-static.nix` | stages `ffmpeg-amd64` / `ffmpeg-arm64` | The URL and sha256 are read from the Dockerfile's `ADD --checksum` lines, so the bytes are the same; the encoder checks of the runtime stage run here |
| `portal-tree.nix` | `portal.Dockerfile` stage `build` | `pnpm install --filter "@agentforge/portal..."` from the allowlisted context |

```bash
nix build .#web-prod .#portal-tree .#ffmpeg-static
```

Compared on 2026-11-07, file by file by sha256, with Docker images built from the rung-1 commit:

| Tree | Same | Different, and why |
|---|---|---|
| `apps/web/dist` | 77 of 77 | none |
| sandbox runtime | 35 of 38 | `pyc-cache.json.gz` and the two manifests that hash it. The JSON inside is byte-identical; the gzip bytes are not, because nixpkgs' Node links the system zlib and the official Node binary carries Chromium's, which deflates differently at level 9 |
| app `/app` (17,397 files in Docker) | 17,380 | `.gitignore` (this rung adds `/result`). `node_modules/.modules.yaml` (the store folder and a timestamp). better-sqlite3's `build/Makefile` and `build/config.gypi` (node-gyp's record of the toolchain; store paths removed so the toolchain stays out of the image). 13 dependency bin shims: `pnpm rebuild` writes them through the package symlink and without the `NODE_PATH` hint; they start the same programs. `node_modules/.bin/esbuild`: linked before esbuild's postinstall swapped its launcher for the native binary, so this one shim calls `node` on the binary. Nothing in the server runs it; tsx calls esbuild's API, which starts the binary itself. One shim Docker has is absent (`esbuild/node_modules/.bin/esbuild`) |
| portal `/app` (2,687 files) | 2,673 | `.modules.yaml`, 11 dependency shims and the two esbuild shims, for the same reasons |

The entrypoint shims, `apps/web/node_modules/.bin/tsx` and `apps/portal/node_modules/.bin/tsx`, are identical.
A second relinking pass was tried to make the esbuild shim match; it rewrote the entrypoint shims instead, so
it was dropped.

Both of the Dockerfile's guards run inside `web-prod.nix` with the same output as in Docker:
`ok anydoc@0.2.4 — bundled with the app (the container image, on a server)` and
`host loads from the production tree: 7 exports`.

**Native modules.** Nothing in either production tree is compiled. better-sqlite3 13.0.3 ships N-API prebuilds
for every platform and loads `prebuilds/linux-x64.node`; its `binding.gyp` targets are `type: none` on Linux,
so node-gyp only writes stamps. N-API does not depend on the Node ABI, so the Node 24 shebang problem cannot
reach it, but the pnpm override stays: anything that does compile would hit it. anydoc is a napi-rs prebuild
and esbuild a static Go binary. Building better-sqlite3 from source would replace the binary the Docker image
runs; that is a separate decision, not a strangler step.

**ffmpeg.** BtbN's "static" build still links glibc dynamically and asks for `/lib64/ld-linux-x86-64.so.2`.
`autoPatchelf` points both programs at the glibc and libgcc_s the image already carries for Node. Same
tarball, same version line (`ffmpeg version n8.1.3-9-g29e619e767-20260930`), different ELF interpreter and
RUNPATH.

**Closures.** `web-prod` refers to the pinned Node and its libraries only; `disallowedReferences` fails the build
if Python, make, the compiler, pnpm or the full Node package leak in. `portal-tree` refers to nothing.

## Running it

```bash
nix flake check -L
```

```bash
nix build .#pnpm
```

```bash
nix develop
```

When `pnpm-lock.yaml` changes, `nix/pkgs/pnpm-deps.nix` needs its new hash: set `hash = "";`, run
`nix build .#pnpm-deps`, and copy the `got:` value back.

## Still owed

- Monday, 2026-11-09: run each rung on a work machine with flakes on, and record the result in its PR.
- Fetching `nixpkgs` from GitHub's archive was not possible in the cloud session (its proxy refuses the GitHub
  API). The lock was written from a `git+https` fetch of the same commit; nixpkgs has no `export-ignore` or
  `export-subst` attributes, so the archive has the same content and the same `narHash`. A machine that can
  reach GitHub verifies it on the first `nix flake metadata`.
