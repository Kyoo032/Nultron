# syntax=docker/dockerfile:1.7
#
# Nultron hosted web app.
#
# Build context is the REPO ROOT, not this folder:
#   docker build -f webapp-deploy/Dockerfile -t nultron-web:local .
#
# Why the whole workspace SOURCE ships in the image: every @agentforge/* package exports
# TypeScript source (packages/host/package.json "exports" -> ./src/index.ts), and
# apps/web/package.json "start" is `NODE_ENV=production tsx server.ts`. So the runtime
# needs the source tree, node_modules, and tsx. Only the renderer is compiled
# (`pnpm --filter @agentforge/web build` -> apps/web/dist).
#
# Why node_modules holds PRODUCTION dependencies only (SR-113): the image used to carry the full
# install, because tsx was a devDependency of @agentforge/web and is the entrypoint. tsx is a
# dependency now, so three stages split the work:
#   build    the full install (dev dependencies included): the renderer build and the sandbox folder
#   prod     a second, fresh `pnpm install --prod`, plus the renderer the build stage made
#   runtime  copies `prod`, so vite, tailwindcss, vitest, typescript and the rest of the dev
#            toolchain are not in the image, and an advisory in them is not an advisory in it
# `scripts/audit-deployed.mjs` audits the same production closure, so the audit gate and this image
# measure the same thing.
#
# Debian (glibc) on purpose: @firecrawl/anydoc resolves to
# @firecrawl/anydoc-linux-x64-gnu / -linux-arm64-gnu in pnpm-lock.yaml. Alpine/musl
# would pick a different package and better-sqlite3 would need a full musl rebuild.

ARG NODE_VERSION=22-bookworm-slim
ARG PNPM_VERSION=9.15.9

# ---------------------------------------------------------------------------
# base: node + pnpm, shared by build and runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
ARG PNPM_VERSION
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/opt/corepack \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && chmod -R a+rX /opt/corepack \
 # pnpm bundles node-gyp, and corepack unpacks its cache with .py files at 0644.
 # better-sqlite3's generated Makefile re-runs `gyp_main.py` DIRECTLY (the "Regenerating
 # Makefile" action fires because COPY leaves mtimes slightly in the future), and a
 # non-executable script is EACCES even for root:
 #   /bin/sh: 1: .../node-gyp/gyp/gyp_main.py: Permission denied  ->  make Error 126
 && find /opt/corepack -name '*.py' -exec chmod a+x {} +

# ---------------------------------------------------------------------------
# build: the full install (dev dependencies included), the renderer, the sandbox folder
#
# Nothing from this stage's node_modules reaches the runtime image (see `prod` below); what leaves
# it is apps/web/dist and /opt/sandbox-runtime.
#
# python3/make/g++ are here for better-sqlite3: it tries a prebuilt binary first
# (prebuild-install) and falls back to node-gyp. Without them the fallback fails
# hard and the whole install dies.
# ---------------------------------------------------------------------------
FROM base AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Filtered install: @agentforge/web plus its workspace dependencies only.
# The trailing "..." is pnpm's "and its dependencies" selector. This deliberately
# skips apps/desktop (Electron, electron-builder, keytar) and apps/mobile, which
# the hosted deployment never runs. It is the FULL install on purpose: `vite build`
# below needs vite, tailwindcss and postcss, which are devDependencies.
RUN pnpm install --frozen-lockfile --filter "@agentforge/web..."

# Renderer -> apps/web/dist, which server.ts serves statically when NODE_ENV=production.
RUN pnpm --filter @agentforge/web build

# Code sandbox (H4): the Pyodide and QuickJS engines, the five Python wheels and the two child scripts,
# assembled into ONE folder of real files that the host reads with `--allow-fs-read=<that folder>`.
# Everything it carries is pinned by version, URL and sha256 in scripts/sandbox-runtime.lock.json, which
# is a committed file, so the archive-from-sha build (SR-49) has it; the script refuses any file whose
# hash differs and prints the folder's size. pyodide and quickjs come from the root devDependencies,
# which the filtered install above includes (pnpm installs the workspace root with any --filter). The
# five wheels are the only download. Both the folder and the download cache are built OUTSIDE /app, and
# this stage's node_modules is never copied to the runtime image, so neither the folder's build inputs
# nor pyodide's own copy in node_modules (about 14 MiB) ships; the runtime stage copies the folder itself.
RUN node scripts/build-sandbox-runtime.mjs --out /opt/sandbox-runtime --cache /opt/sandbox-cache

# ---------------------------------------------------------------------------
# prod: the tree that ships - PRODUCTION dependencies only (SR-113)
#
# A second, fresh install rather than a prune of the build tree: it cannot leave a dev-only package
# behind, it never touches the tree that built the renderer, and a reader can see in one line what
# the image installs. The two installs run side by side under BuildKit. The toolchain is repeated
# for better-sqlite3's node-gyp fallback (see the build stage).
#
# The trade this makes: `tsx server.ts` can import only what is declared in `dependencies`. A
# server-side import of a devDependency used to resolve by luck, because the image carried them
# all; now it fails the load check below at build time instead of at boot. That is how `vite`
# became a dynamic import on the non-production branch of apps/web/server.ts.
# ---------------------------------------------------------------------------
FROM base AS prod
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Same filter as the build stage, plus --prod: dependencies and optionalDependencies of
# @agentforge/web and its workspace packages, and nothing else. The root package's devDependencies
# (biome, turbo, typescript, pyodide, quickjs) are skipped too.
RUN pnpm install --frozen-lockfile --prod --filter "@agentforge/web..."

# The renderer is the only build output the runtime serves. `**/dist` is in the ignore file, so the
# COPY above did not bring a stale local one.
COPY --from=build /app/apps/web/dist apps/web/dist

# PHASE 7 - the image must CARRY every component this server needs, not download one on first
# request. `anydoc` arrives through the install above (it is a dependency of @agentforge/host and
# pnpm-lock.yaml resolves the -linux-*-gnu prebuilt), which is easy to break without noticing: a
# filter change, a hoisting change, or a platform package that stops publishing would all leave a
# container that boots, answers healthy, and silently reads every document with the reduced
# fallback extractor instead.
#
# So prove it here. The check loads each component in
# packages/host/src/components/server.ts SERVER_COMPONENT_IDS the same way a request would -
# createRequire on the real native binding - and exits non-zero if one does not load, which fails
# the build. This runs in the stage whose node_modules becomes the runtime's, on the same
# linux/glibc base the runtime stage uses, so a binding that loads here loads there.
#
# The two variables are the runtime stage's, set here so the check runs under the rules the
# container will run under and PRINTS what the container will print - `mode: server`, and
# /opt/agentforge/components as the components root - instead of reporting itself as a desk. They
# change nothing about what loads: the bundled copy inside node_modules is what resolves either
# way, and `check` never downloads.
RUN AGENTFORGE_SERVER=1 AGENTFORGE_COMPONENTS_DIR=/opt/agentforge/components \
    apps/web/node_modules/.bin/tsx scripts/components.ts check

# SR-113 - the same idea for every other import. Load the whole host (the HTTP adapter pulls in the
# router, every handler, @agentforge/core and @agentforge/db) from apps/web, under the production
# tree, so a server import that needs a package this tree does not carry fails the build with
# ERR_MODULE_NOT_FOUND instead of failing the first container start. It opens SQLite, because
# @agentforge/db does at import, so the data dir is a throwaway one that this layer discards.
RUN cd apps/web \
 && AGENTFORGE_DATA_DIR="$(mktemp -d)" ./node_modules/.bin/tsx -e \
    "import('@agentforge/host/http').then((m) => { console.log('host loads from the production tree:', Object.keys(m).length, 'exports'); process.exit(0); }, (e) => { console.error(e); process.exit(1); })"

# ---------------------------------------------------------------------------
# ffmpeg: the two programs Edit and Meeting spawn (ffmpeg, ffprobe)
#
# The image must carry them. A person on the hosted app cannot install anything, and until this stage
# existed every desk showed the "ffmpeg was not found" notice. Debian bookworm's package is 5.1 and the
# host refuses anything older than 6 (packages/host/src/edit/ffmpeg-setup.ts MIN_MAJOR), so this is a
# static build: BtbN's, which ffmpeg.org's download page links to, from a month-end release (those are
# kept for about two years; the daily ones are deleted after two weeks). It is pinned by URL and sha256,
# and BuildKit refuses the download when the hash differs.
#
# The GPL variant on purpose: the render recipe encodes with libx264
# (packages/host/src/edit/ffmpeg/recipes.ts), which the LGPL variant does not carry. ffmpeg runs as a
# separate program and is not modified; its licence text ships beside it, and
# docs/internal/ffmpeg-attribution.md names the exact build and where its source is.
#
# To move to a newer build, change the tag, both file names and both hashes together.
# ---------------------------------------------------------------------------
FROM base AS ffmpeg-amd64
ADD --checksum=sha256:97ce978979194b5cf7e06a5e68020dbdaa7a4f3294c5452b6a1bc347100dbb79 \
    https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n8.1.3-9-g29e619e767-linux64-gpl-8.1.tar.xz \
    /tmp/ffmpeg.tar.xz

FROM base AS ffmpeg-arm64
ADD --checksum=sha256:10523d1e0be6b3ce62a9708cc50815c4b5eb5f36ae147fbe2afeecda6f2d6845 \
    https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n8.1.3-9-g29e619e767-linuxarm64-gpl-8.1.tar.xz \
    /tmp/ffmpeg.tar.xz

# BuildKit sets TARGETARCH (amd64 or arm64) and builds only the stage it names.
FROM ffmpeg-${TARGETARCH} AS ffmpeg
RUN apt-get update \
 && apt-get install -y --no-install-recommends xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/ffmpeg/unpacked /opt/ffmpeg/bin /opt/ffmpeg/licenses \
 && tar -xJf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg/unpacked --strip-components=1 \
 && cp /opt/ffmpeg/unpacked/bin/ffmpeg /opt/ffmpeg/unpacked/bin/ffprobe /opt/ffmpeg/bin/ \
 && cp /opt/ffmpeg/unpacked/LICENSE.txt /opt/ffmpeg/licenses/LICENSE.txt \
 && rm -rf /opt/ffmpeg/unpacked /tmp/ffmpeg.tar.xz \
 && chmod 0755 /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM base AS runtime

# Data dir lives on a volume. packages/db/src/vault-key.ts reads AGENTFORGE_DATA_DIR
# and puts agentforge.sqlite, settings.enc, media and logs under it. Components do NOT go there on
# a server - see AGENTFORGE_COMPONENTS_DIR below and the VOLUME further down.
ENV NODE_ENV=production \
    PORT=3000 \
    AGENTFORGE_DATA_DIR=/data \
    AGENTFORGE_COMPONENTS_DIR=/opt/agentforge/components \
    AGENTFORGE_SANDBOX_DIR=/app/sandbox

WORKDIR /app

# Copy the production tree wholesale: the workspace source, node_modules with production
# dependencies only (tsx is one, and is the entrypoint), and the built renderer.
COPY --from=prod --chown=node:node /app /app

# Code sandbox runtime (see the build stage). Root-owned and not writable by anyone, so the `node` user
# that runs the host can read it (the sandbox child gets --allow-fs-read=$AGENTFORGE_SANDBOX_DIR) but
# cannot change a byte of it; compose also mounts the root filesystem read-only.
COPY --from=build --chown=root:root /opt/sandbox-runtime /app/sandbox
RUN chmod -R a-w /app/sandbox

# ffmpeg and ffprobe (see the ffmpeg stage). Root-owned in /usr/local/bin, which is on PATH and is one of
# the places the host looks (packages/host/src/edit/ffmpeg-locations.ts), so nobody sets a path.
COPY --from=ffmpeg --chown=root:root /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/
COPY --from=ffmpeg --chown=root:root /opt/ffmpeg/licenses /usr/local/share/licenses/ffmpeg
# Fail the build, not the first video job, when a binary does not run on this base or lacks an encoder
# the recipes ask for (libx264 for the render, libmp3lame for extracted audio).
RUN ffmpeg -hide_banner -version > /dev/null \
 && ffprobe -hide_banner -version > /dev/null \
 && ffmpeg -hide_banner -encoders 2> /dev/null | grep -q ' libx264 ' \
 && ffmpeg -hide_banner -encoders 2> /dev/null | grep -q ' libmp3lame ' \
 && ffmpeg -hide_banner -version | head -n 1

RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

# PHASE 7 - components live OUTSIDE the tenant data volume.
#
# /data is what every tenant writes into, and the host refuses to createRequire a native module out
# of it in server mode (packages/host/src/components/paths.ts, downloadedComponentsAllowed). That
# refusal is what makes /data mountable `noexec` (docs/internal/web-security-spec.md H3). The
# directory below is the operator's instead, and it stays EMPTY on a healthy box: the image's own
# copy of anydoc is what loads, and a newer version arrives in a newer image, never through a
# download into a running container. It is written only when
# `webapp-deploy/scripts/components.sh install` repairs a box whose bundled copy stopped loading.
# compose.yml gives it its own volume so such a repair survives a restart.
RUN mkdir -p /opt/agentforge/components && chown -R node:node /opt/agentforge
VOLUME ["/opt/agentforge/components"]

USER node
WORKDIR /app/apps/web
EXPOSE 3000

# Same command as apps/web/package.json "start", minus the pnpm wrapper:
#   NODE_ENV=production tsx server.ts
# NOTE: server.ts:114-115 binds resolveBindHost(process.env) (apps/web/lib/bind-host.ts),
# which defaults to 127.0.0.1. BIND_HOST is not set here, so the container only answers on
# its own loopback. See webapp-deploy/README.md - the proxy joins this container's network
# namespace instead of talking to it over a bridge.
# `GET /healthz` is the liveness probe (packages/host/src/handlers/health.ts). It is answered in
# the HTTP adapter before routing (packages/host/src/http-adapter.ts:534-536), so it never reaches
# `dispatch`, never opens the database and is outside the session gate by construction rather than
# by an entry in an exemption list. Its whole body is `{"status":"ok"}` - no version, no path, no
# tenant, no component list - because an unauthenticated route must hand a stranger nothing.
#
# No `x-forwarded-proto: https` header, and that is the change Phase 8 made. In server mode
# `rejectPlaintext` (packages/host/src/http-adapter.ts:388-391, called via `transportRejection` at
# :398-408) answers 403 https_required to every request that does not carry it, on every path,
# before routing. `/healthz` is the one carve-out (`allowPlaintext`, passed only as `isLiveness` at
# :529), because this probe runs inside the container and hits the app's own loopback port with no
# proxy in front of it. A probe that had to stamp the proxy's own header would be a probe that
# lies the day the proxy rule changes - it would keep reporting healthy against a process that no
# real request could reach. Everything else still runs over the probe: the request-line filter,
# the method allowlist, the header cap and the per-IP bucket.
#
# Until Phase 8 this probed `GET /api/v1/components` with the header stamped on. That worked, but
# it opened a route that reports component ids and versions to anything that can reach the port,
# and it proved the proxy header was accepted rather than that the app was alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
  CMD node -e "const p=process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["./node_modules/.bin/tsx", "server.ts"]
