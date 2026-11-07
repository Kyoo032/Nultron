# The Dockerfile's `prod` stage: the tree that becomes /app in the app image. The workspace source as the
# context holds it, node_modules with production dependencies only (SR-113), and the renderer from
# web-build.nix. Both load checks the Dockerfile runs here run here too, so a tree that would boot without a
# component or without a module fails this build instead.
{
  stdenv,
  python3,
  gnumake,
  removeReferencesTo,
  nodejs,
  nodejs-slim,
  pnpm,
  docker-context,
  pnpm-offline-install,
  web-build,
}:
stdenv.mkDerivation {
  pname = "nultron-web-prod";
  version = "0";
  src = docker-context.sourceOf "webapp-deploy/Dockerfile.dockerignore";

  nativeBuildInputs = [
    pnpm-offline-install
    python3
    gnumake
    removeReferencesTo
  ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild

    # Docker: pnpm install --frozen-lockfile --prod --filter "@agentforge/web..."
    pnpmOfflineInstall --prod --filter=@agentforge/web...

    # Docker: COPY --from=build /app/apps/web/dist apps/web/dist
    cp -r ${web-build}/dist apps/web/dist
    chmod -R u+w apps/web/dist

    # Docker, PHASE 7: every server component loads from this tree, under the runtime's variables.
    AGENTFORGE_SERVER=1 AGENTFORGE_COMPONENTS_DIR=/opt/agentforge/components \
      apps/web/node_modules/.bin/tsx scripts/components.ts check

    # Docker, SR-113: the whole host loads from the production tree, against a throwaway data dir.
    (
      cd apps/web
      AGENTFORGE_DATA_DIR="$(mktemp -d)" ./node_modules/.bin/tsx -e \
        "import('@agentforge/host/http').then((m) => { console.log('host loads from the production tree:', Object.keys(m).length, 'exports'); process.exit(0); }, (e) => { console.error(e); process.exit(1); })"
    )

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Docker installs at /app. pnpm writes the install directory into its bin shims and its state file; name the
    # directory the image uses, so a shim reads as it does in the Docker image.
    grep -rlF --null "$PWD" node_modules apps/*/node_modules packages/*/node_modules 2>/dev/null \
      | xargs -0 --no-run-if-empty sed -i "s|$PWD|/app|g"

    # node-gyp records the build tools it ran with in better-sqlite3's build/ folder. Those files are build
    # metadata the runtime never reads; keep them, without the store paths that would pull the toolchain into
    # the image.
    find node_modules -path '*/better-sqlite3/build/*' -type f -print0 \
      | xargs -0 --no-run-if-empty remove-references-to -t ${python3} -t ${gnumake} -t ${stdenv.cc} -t ${pnpm} -t ${nodejs} -t ${nodejs-slim}

    mkdir -p "$out"
    cp -a . "$out/"
    runHook postInstall
  '';

  # The tree as pnpm wrote it: shebangs stay `#!/usr/bin/env node` and `#!/bin/sh`, as in the Docker image,
  # and prebuilt binaries are not stripped or patched.
  dontFixup = true;

  # The tree refers to no store path at all: the image adds its Node (node-runtime.nix), and no compiler,
  # Python, make, package manager or build-time Node can leak in.
  allowedReferences = [ ];
}
