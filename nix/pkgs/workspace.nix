# The whole workspace installed offline, dev dependencies included: what `pnpm install --frozen-lockfile` gives
# a developer, and the tree the flake checks run scripts/ci-local.mjs in (ci-step.nix). Never shipped.
#
# The install scripts it runs, as on a developer's machine: esbuild's binary check, embedded-postgres's symlink
# step, better-sqlite3's gyp configure, and keytar, whose prebuild download fails offline so it compiles from
# source against libsecret and the pinned Node's headers. Electron's binary download is switched off with its
# own variable; nothing in ci-local.mjs starts Electron.
#
# biome is a glibc program from npm and asks for /lib64/ld-linux-x86-64.so.2, which the Nix sandbox does not
# have; it is pointed at the Nix glibc. Nothing else in node_modules is patched.
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
  pname = "nultron-workspace";
  version = "0";

  # Everything git tracks except the Nix files, so editing a check does not reinstall the workspace.
  src = lib.fileset.toSource {
    root = repoRoot;
    fileset = lib.fileset.difference repoRoot (
      lib.fileset.unions [
        (repoRoot + "/nix")
        (repoRoot + "/flake.nix")
        (repoRoot + "/flake.lock")
      ]
    );
  };

  nativeBuildInputs = [
    pnpm-offline-install
    # keytar's install script runs `npm run build`, so this is the Node with npm.
    nodejs
    # The whole workspace hoists node-gyp 9.4.1 (from the Electron tooling), and its gyp imports distutils, which
    # Python 3.12 removed. setuptools brings it back. The Dockerfile's Debian bookworm has Python 3.11 and never
    # meets this.
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
    # With no --filter, the hook's `pnpm rebuild --pending` reaches only the root project; the packages the
    # workspace projects depend on are still pending, so build them across all of them.
    pnpm rebuild --pending --recursive --reporter=append-only
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp -a . "$out/"
    runHook postInstall
  '';

  # Shebangs are patched so the checks can run every node_modules bin inside the sandbox, which has no
  # /usr/bin/env. No stripping, and only biome gets a new loader.
  dontStrip = true;
  dontAutoPatchelf = true;
  postFixup = ''
    autoPatchelf "$out"/node_modules/.pnpm/@biomejs+cli-linux-*/node_modules/@biomejs/cli-linux-*/biome
  '';
}
