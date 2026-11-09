# The portal image's /app: its allowlisted context (portal.Dockerfile.dockerignore) and
# `pnpm install --frozen-lockfile --filter "@agentforge/portal..."`, dev dependencies included, because
# `tsx` is a devDependency of apps/portal and is its entrypoint. The Dockerfile runs no check on this tree;
# the image's boot test does (portal-image.nix).
{
  stdenv,
  removeReferencesTo,
  nodejs,
  pnpm,
  docker-context,
  pnpm-offline-install,
}:
stdenv.mkDerivation {
  pname = "nultron-portal-tree";
  version = "0";
  src = docker-context.sourceOf "webapp-deploy/portal.Dockerfile.dockerignore";

  nativeBuildInputs = [
    pnpm-offline-install
    removeReferencesTo
  ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    # Docker: pnpm install --frozen-lockfile --filter "@agentforge/portal..."
    pnpmOfflineInstall --filter=@agentforge/portal...
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    # Docker installs at /app; see web-prod.nix.
    grep -rlF --null "$PWD" node_modules apps/*/node_modules packages/*/node_modules 2>/dev/null \
      | xargs -0 --no-run-if-empty sed -i "s|$PWD|/app|g"
    mkdir -p "$out"
    cp -a . "$out/"
    runHook postInstall
  '';

  dontFixup = true;

  disallowedReferences = [
    stdenv.cc
    pnpm
    nodejs
  ];
}
