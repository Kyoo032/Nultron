# Nix cutover: moving Nultron off Docker

Rizky, 2026-11-09. The Nix ladder ([`nix-migration.md`](nix-migration.md), rungs 1 to 6) is merged on `main`. This
page is the rest of the move, in order: prove the flake on a Linux machine, move this desk off Docker Desktop,
ship a Nix-built image, then delete the Docker build side. Each phase ends in a result you can check. Nothing
here is started.

This page covers what the Nultron repo must change and prove. The desk side (volume backups, the WSL distro,
LibreChat, HYP AI, uninstalling Docker Desktop and the rollback) is Rizky's vault runbook
`C:\Users\rizky\Documents\Obsidian\40-Dev\docker-to-nix-desk-cutover.md`, which is not in git.

Lanes: `enterprise` (the hosted images and the release path) and `tester` (the next merge of `main` carries the
changes). No product code changes until phase 4.

## What "off Docker" means

- **Docker Desktop leaves this PC. A container engine stays.** Nix builds images. Something still has to run
  them: the compose rehearsal (`webapp-deploy/pilot-local.mjs`), the k8s rehearsal, and the Jakarta box. The
  engine becomes Docker Engine declared in the WSL distro's Nix config, so `docker` and `docker compose` keep
  working and the scripts do not change.
- **Docker workflows move from Windows into WSL.** These scripts call `docker` from Windows Node or PowerShell
  today, and find nothing once Docker Desktop is gone. Run them from the clone inside WSL instead:
  `webapp-deploy/pilot-local.mjs`, `scripts/deploy-preflight.mjs`, `scripts/release-web.mjs`,
  `webapp-deploy/k8s/local-images.mjs` and `scripts/review-instance.ps1`.
- **Webdev `:3000` and `ci:local` stay on Windows.** Neither calls Docker.
- **Servers keep Docker Engine and compose.** `webapp-deploy/scripts/deploy.sh` does not change. From phase 4 on,
  the image it runs is built by Nix. Moving a server to NixOS is not part of this plan.
- **The Dockerfiles go last**, after production has run a Nix-built image (phase 5).

## Gates

Each of these needs Rizky's go at that moment, as AGENTS.md requires for releases and deploys:

- uninstalling Docker Desktop (phase 3)
- the first Nix-built image on the preview desks, and the first Nix-built release (phase 4)
- deleting the Docker build side (phase 5).

HYP AI shares this desk and has its own plan (`C:\Users\rizky\Documents\hyp-ai\docs\internal\nix-migration.md`).
Docker Desktop leaves only when both projects run their Docker workflows from WSL.

## Phase 1: run the owed checks on Linux

The cloud machine that built the ladder had no work machine run. On 2026-11-09 part of it ran on this PC, in a
`nixos/nix` container on Docker Desktop (`nultron-nix`, volume `nultron-nix-store`), from an LF archive of the
merged top rung: `checks.x86_64-linux.pins`, `web-prod`, `portal-tree`, `checks.x86_64-linux.k8s-manifests`,
`web-image` and `portal-image` all built, and the pnpm-deps hash did not change. The rest runs in the WSL distro
from the desk runbook.

Work in a clone on the distro's own filesystem, not under `/mnt/c`, with `core.autocrlf` off. A Windows
checkout gives `webapp-deploy/portal.Dockerfile` CRLF line endings (`.gitattributes` covers files named exactly
`Dockerfile`), and `pins` then fails to evaluate.

1. Verify the nixpkgs lock, which the cloud session could not fetch from GitHub's archive:

	```bash
	nix flake metadata
	```

2. Run `ci:local` inside the devShell, as a user that is not root (as root, the portal suite's embedded
	Postgres cannot read its temp folders):

	```bash
	nix develop -c pnpm install --frozen-lockfile
	nix develop -c node scripts/ci-local.mjs
	```

3. Run every flake check. Run nothing else heavy beside it. The time is a guess until the first run: 45 to 90
	minutes on this PC.

	```bash
	pnpm ci:nix
	```

4. Build both images, load them, and drive the compose rehearsal on them:

	```bash
	nix build .#web-image && docker load < result
	nix build .#portal-image && docker load < result
	docker tag nultron-web:local nultron-ent:pilot-local
	docker tag nultron-portal:local nultron-portal:pilot-local
	node webapp-deploy/pilot-local.mjs up --skip-build
	node webapp-deploy/pilot-local.mjs drive
	```

5. Check for KVM. If `/dev/kvm` exists, the k3s VM test that rung 6 skipped can be written. Whether WSL exposes
	KVM on this PC is unverified until someone runs:

	```bash
	ls -l /dev/kvm
	```

Record each result in [`nix-migration.md`](nix-migration.md) under "Proof on a work machine", with the date and
the commit. A red check that also fails outside Nix on the same machine is a finding for `unreleased.md`, not a
Nix failure.

## Phase 2: repo changes before Docker Desktop leaves

Each item is its own pull request to `main`, driven before phase 3.

1. **Move the k8s rehearsal to kind.** Today it needs Docker Desktop's built-in cluster:
	- `webapp-deploy/k8s/local-lib.mjs:37` pins `CONTEXT = "docker-desktop"`.
	- `webapp-deploy/k8s/rehearse-local.mjs:90-102` refuses to run without that context and calls `docker info`.
	- `webapp-deploy/k8s/local-images.mjs` builds the images with `docker build` into Docker Desktop's image
		store, which that cluster reads directly.
	- `webapp-deploy/k8s/forward-local.mjs` explains its port-forward by Docker Desktop's behaviour, and the
		comments in `overlays/local/kustomization.yaml` and `base/storage.yaml` name Docker Desktop.

	The local overlay sets no storage class, so it takes the cluster's default, and kind has one. The devShell
	already pins kind 0.31.0. The change has three parts. Create a kind cluster named `nultron`. kind names its
	kubectl context `kind-nultron`, and `CONTEXT` points there. Load each image with
	`kind load image-archive <tar> --name nultron`, from a Nix `result` or a `docker save`, instead of relying on
	a shared image store. Replace the Docker Desktop preflight in `rehearse-local.mjs` with a kind one. Then run
	`node webapp-deploy/k8s/rehearse-local.mjs` on the Nix images. Refresh `webapp-deploy/k8s/README.md` and the
	map page `maps/webapp-deploy.md`.

2. **Give `scripts/review-instance.ps1` a WSL route.** It starts the portal's Postgres and Mailpit with
	`docker compose -f apps/portal/compose.yml` from PowerShell. Either call Docker inside the distro
	(`wsl -d <distro> docker compose ...`) or run Postgres 16 and Mailpit from the devShell. The ports must
	still answer on Windows `127.0.0.1`.

3. **Pin LF for every Dockerfile** until phase 5 deletes them: add `*.Dockerfile text eol=lf` to
	`.gitattributes`, so a Windows checkout and `git archive` stop producing a CRLF `portal.Dockerfile`.

Nothing else needs a code change to leave Docker Desktop. `pilot-local.mjs`, `deploy-preflight.mjs` and
`release-web.mjs` run unchanged from the WSL clone against Docker Engine.

## Phase 3: leave Docker Desktop

Follow the desk runbook. The repo's part is the check afterwards, from the WSL clone:

- Phase 1, step 4 still passes on Docker Engine in WSL.
- The kind rehearsal from phase 2 passes.
- `node scripts/release-web.mjs --tag <tag> --sha <sha> --dry-run` passes from WSL.
- Webdev `:3000` and `npx pnpm@9.15.9 ci:local` still pass on Windows.

## Phase 4: ship a Nix-built image

1. **Preview desks first.** Build `web-image` from `git archive <sha>` in WSL, and follow the safe update route
	for the preview (`nultron-files/deploy/tencent/README.md`, section "Update the app image only: the safe
	route"): send the image with `docker save | ssh docker load`, change only `app/app-image.env`, and recreate
	the desks one at a time, a tester desk first. Rizky says go for each deploy.
2. **Then the release path.** `scripts/release-web.mjs` builds both images with `docker build` from
	`git archive <sha>` and pushes them to `ghcr.io/kyoo032/nultron-ent` and `ghcr.io/kyoo032/nultron-portal`.
	Add a Nix route beside it that builds `.#web-image` and `.#portal-image` from the same archive and pushes each
	`result` tarball, for example with
	`skopeo copy docker-archive:result docker://ghcr.io/kyoo032/nultron-ent:<tag>` and a GHCR token that has
	`write:packages`. Keep `docker build` as the default until one Nix-built release has run on production.
	This is a release script, so the change needs Rizky's word before it is written.
3. **Then production.** Cut `ent-YYYY.MM.DD` through the Nix route, deploy it with the unchanged `deploy.sh`,
	and log it in the deploy log in `web-pivot-2026-09-18.md` as built by Nix.

## Phase 5: delete the Docker build side

Start only after production has run a Nix-built image for a period Rizky sets.

The flake still reads Docker files today, so delete them in this order:

1. Move into Nix what four units read from Docker files:
	- `nix/pkgs/pins.nix` reads `ARG NODE_VERSION` and `ARG PNPM_VERSION` from both Dockerfiles.
	- `nix/pkgs/dockerfile-runtime.nix` builds each image's config from its Dockerfile's last stage.
	- `nix/pkgs/ffmpeg-static.nix` reads the ffmpeg URLs and hashes from the Dockerfile's `ADD --checksum` lines.
	- `nix/pkgs/docker-context.nix` filters the source with the Docker ignore files.
2. Delete `webapp-deploy/Dockerfile`, `webapp-deploy/portal.Dockerfile`, the three ignore files, the
	`docker build` route in `release-web.mjs` and `k8s/local-images.mjs`, and `webapp-deploy/scripts/build.sh`.
	Ask Rizky whether the retired Personal app's mac build machine goes too
	(`apps/desktop/platform/macos/docker/`, `apps/desktop/scripts/mac-build-docker.mjs`).
3. Update what describes the Docker build: the "Web release (hosted)" section of `AGENTS.md`,
	`webapp-deploy/README.md`, `maps/webapp-deploy.md`, `release-targets.md`, [`nix-migration.md`](nix-migration.md),
	and the tests in `scripts/pilot-deploy.test.mjs` that hold the ignore files.

## Not in this plan

- NixOS on the Jakarta box or any other server.
- Tencent TKE: `overlays/production` stays rendered and validated, never applied.
- Any change to the HYP AI repository.
