# A setup hook giving a build the shell function `pnpmOfflineInstall <pnpm install flags...>`: the Dockerfile's
# `pnpm install --frozen-lockfile <flags>`, run offline from pnpm-deps.nix.
#
# It installs with --ignore-scripts and then runs `pnpm rebuild --pending`, instead of one scripted install:
# pnpm refuses an offline scripted install of a dependency the lockfile records as a bare tarball URL with no
# integrity (`xlsx`, ERR_PNPM_NO_OFFLINE_TARBALL), and the two steps run the same lifecycle scripts the
# Dockerfile's install runs. node-gyp, which pnpm starts for better-sqlite3 because it ships a binding.gyp,
# reads the pinned Node's headers through npm_config_nodedir instead of downloading them.
{
  makeSetupHook,
  writeText,
  zstd,
  pnpm,
  nodejs-slim,
  pnpm-deps,
}:
makeSetupHook
  {
    name = "nultron-pnpm-offline-install";
    propagatedBuildInputs = [
      zstd
      pnpm
      nodejs-slim
    ];
  }
  (
    writeText "nultron-pnpm-offline-install.sh" ''
      pnpmOfflineInstall() {
        local store
        store="$(mktemp -d)"
        tar --zstd -xf ${pnpm-deps}/pnpm-store.tar.zst -C "$store"
        chmod -R u+w "$store"

        export HOME="''${HOME:-$(mktemp -d)}"
        [ -w "$HOME" ] || export HOME="$(mktemp -d)"
        export npm_config_nodedir=${nodejs-slim}
        pnpm config set store-dir "$store"
        pnpm config set manage-package-manager-versions false
        pnpm config set update-notifier false
        pnpm config set package-import-method copy

        pnpm install --offline --frozen-lockfile --ignore-scripts "$@"

        # The rebuild takes the same workspace filter, and none of the install-only flags.
        local filters=() arg
        for arg in "$@"; do
          case "$arg" in
            --filter=*) filters+=("$arg") ;;
          esac
        done
        pnpm rebuild --pending "''${filters[@]}"
      }
    ''
  )
