# The Dockerfile's `build` stage: the full filtered install (dev dependencies included), the renderer, and the
# code sandbox folder. As in Docker, only two things leave it, apps/web/dist and the sandbox runtime:
#
#   $out/dist               what `pnpm --filter @agentforge/web build` writes to apps/web/dist
#   $out/sandbox-runtime    what scripts/build-sandbox-runtime.mjs writes (Docker: /opt/sandbox-runtime)
{
  stdenv,
  python3,
  gnumake,
  docker-context,
  pnpm-offline-install,
  sandbox-cache,
}:
stdenv.mkDerivation {
  pname = "nultron-web-build";
  version = "0";
  src = docker-context.sourceOf "webapp-deploy/Dockerfile.dockerignore";

  nativeBuildInputs = [
    pnpm-offline-install
    python3
    gnumake
  ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild

    # Docker: pnpm install --frozen-lockfile --filter "@agentforge/web..."
    pnpmOfflineInstall --filter=@agentforge/web...

    # Docker: pnpm --filter @agentforge/web build
    pnpm --filter @agentforge/web build

    # Docker: node scripts/build-sandbox-runtime.mjs --out /opt/sandbox-runtime --cache /opt/sandbox-cache
    # The cache already holds every pinned wheel (sandbox-cache.nix), so --offline holds.
    cp -r ${sandbox-cache} "$TMPDIR/sandbox-cache"
    chmod -R u+w "$TMPDIR/sandbox-cache"
    node scripts/build-sandbox-runtime.mjs --out "$TMPDIR/sandbox-runtime" --cache "$TMPDIR/sandbox-cache" --offline

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -r apps/web/dist "$out/dist"
    cp -r "$TMPDIR/sandbox-runtime" "$out/sandbox-runtime"
    runHook postInstall
  '';

  # Static web assets and the sandbox's own files, byte for byte as the scripts wrote them.
  dontFixup = true;
}
