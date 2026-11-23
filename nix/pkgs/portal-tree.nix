# The portal image's /app: its allowlisted context (portal.Dockerfile.dockerignore), bundled with
# esbuild into apps/portal/dist/*.mjs so the production tree runs on plain Node with `--prod`
# dependencies only (no `tsx`, `vitest`, `typescript`, or `embedded-postgres`). The image's boot
# test checks the resulting runtime (portal-image.nix).
{
  stdenv,
  nodejs,
  removeReferencesTo,
  docker-context,
  pnpm-offline-install,
}:
stdenv.mkDerivation {
  pname = "nultron-portal-tree";
  version = "0";
  src = docker-context.sourceOf "webapp-deploy/portal.Dockerfile.dockerignore";

  nativeBuildInputs = [
    nodejs
    pnpm-offline-install
    removeReferencesTo
  ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    pnpmOfflineInstall --filter=@agentforge/portal...
    node apps/portal/scripts/build-server.mjs
    rm -rf node_modules apps/*/node_modules packages/*/node_modules
    rm -rf apps/portal/src apps/portal/scripts
    pnpmOfflineInstall --filter=@agentforge/portal... --prod
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    # Docker installs at /app; see web-prod.nix.
    (grep -rlF --null "$PWD" node_modules apps/*/node_modules packages/*/node_modules 2>/dev/null || true) \
      | xargs -0 --no-run-if-empty sed -i "s|$PWD|/app|g"
    mkdir -p "$out"
    cp -a . "$out/"
    runHook postInstall
  '';

  dontFixup = true;

  # The tree refers to no store path; the image adds its Node (node-runtime.nix).
  allowedReferences = [ ];
}
