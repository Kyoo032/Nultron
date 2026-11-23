# Workspace node_modules installed offline from pnpm-deps.nix, built strictly from manifests + lockfile.
#
# Separating dependency installation from product source keeps every check's `node_modules` cached in the
# Nix store across arbitrary TypeScript/React/test edits until package.json or pnpm-lock.yaml changes.
{
  lib,
  stdenv,
  python3,
  gnumake,
  pkg-config,
  libsecret,
  autoPatchelfHook,
  nodejs,
  repoRoot,
  pnpm-offline-install,
}:
stdenv.mkDerivation {
  pname = "nultron-workspace-deps";
  version = "0";

  # Identical manifest-only inputs to nix/pkgs/pnpm-deps.nix so source edits never invalidate node_modules.
  src = lib.fileset.toSource {
    root = repoRoot;
    fileset = lib.fileset.unions (
      map lib.fileset.maybeMissing (
        [
          (repoRoot + "/package.json")
          (repoRoot + "/pnpm-lock.yaml")
          (repoRoot + "/pnpm-workspace.yaml")
          (repoRoot + "/.npmrc")
        ]
        ++
          lib.concatMap
            (
              dir:
              map (name: repoRoot + "/${dir}/${name}/package.json") (
                lib.attrNames (
                  lib.filterAttrs (_: type: type == "directory") (builtins.readDir (repoRoot + "/${dir}"))
                )
              )
            )
            [
              "apps"
              "packages"
            ]
      )
    );
  };

  nativeBuildInputs = [
    pnpm-offline-install
    nodejs
    (python3.withPackages (ps: [ ps.setuptools ]))
    gnumake
    pkg-config
    autoPatchelfHook
  ];
  buildInputs = [
    libsecret
    stdenv.cc.cc.lib
  ];

  ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    pnpmOfflineInstall
    pnpm rebuild --pending --recursive --reporter=append-only
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    if [ -d node_modules ]; then
      cp -a node_modules "$out/node_modules"
    fi
    for d in apps/* packages/*; do
      if [ -d "$d/node_modules" ]; then
        mkdir -p "$out/$d"
        cp -a "$d/node_modules" "$out/$d/node_modules"
      fi
    done
    runHook postInstall
  '';

  dontStrip = true;
  dontAutoPatchelf = true;
  postFixup = ''
    autoPatchelf "$out"/node_modules/.pnpm/@biomejs+cli-linux-*/node_modules/@biomejs/cli-linux-*/biome
  '';
}
