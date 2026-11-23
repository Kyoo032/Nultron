# Fast per-package CI step runner using minimal source filesets and zero-copy workspace-deps.
#
# Only the minimal `src` fileset and pnpm's lightweight top-level symlinks (~1 MB) are copied into
# the build sandbox; `node_modules/.pnpm` (17k+ files) is symlinked directly into the Nix store.
# Keeping `ws/node_modules` and `ws/{apps,packages}/*/node_modules` as writable directories on the
# work tree keeps `@agentforge/*` relative workspace symlinks pointing at `ws/packages/*` and lets
# tools such as Vitest/Vite write cache files cleanly inside `node_modules/.vite`.
{
  lib,
  stdenvNoCC,
  nodejs,
  pnpm,
  git,
  curl,
  openssl,
  postgresql_16,
  workspace-deps,
  web-build,
}:
{
  name,
  src,
  only ? null,
  command ? null,
  postgres ? false,
  sandbox ? false,
  needsGit ? false,
}:
assert (only != null) != (command != null);
stdenvNoCC.mkDerivation {
  name = "nultron-ci-${name}";
  dontUnpack = true;

  nativeBuildInputs = [
    nodejs
    curl
    openssl
  ]
  ++ lib.optional needsGit git
  ++ lib.optional postgres postgresql_16;

  CI_LOCAL_PNPM = "${pnpm}/libexec/pnpm/bin/pnpm.cjs";

  buildPhase = ''
    runHook preBuild
    mkdir -p "$NIX_BUILD_TOP/tmp" "$NIX_BUILD_TOP/home" "$NIX_BUILD_TOP/ws"
    export TMPDIR="$NIX_BUILD_TOP/tmp" HOME="$NIX_BUILD_TOP/home"

    cp -a ${src}/. "$NIX_BUILD_TOP/ws/"
    chmod -R u+w "$NIX_BUILD_TOP/ws"
    cd "$NIX_BUILD_TOP/ws"

    ${lib.optionalString needsGit ''
      git init -q
      git add -A
      git -c user.name=nix -c user.email=nix@localhost commit -qm "workspace for ${name}"
    ''}

    mkdir -p node_modules
    for entry in ${workspace-deps}/node_modules/* ${workspace-deps}/node_modules/.[!.]*; do
      [ -e "$entry" ] || [ -L "$entry" ] || continue
      base="$(basename "$entry")"
      if [ "$base" = ".pnpm" ]; then
        ln -s "$entry" "node_modules/.pnpm"
      else
        cp -a "$entry" "node_modules/$base"
      fi
    done
    for pkgdir in ${workspace-deps}/apps/* ${workspace-deps}/packages/*; do
      [ -d "$pkgdir/node_modules" ] || continue
      rel="''${pkgdir#${workspace-deps}/}"
      if [ -d "$rel" ]; then
        cp -a "$pkgdir/node_modules" "$rel/node_modules"
      fi
    done

    ${lib.optionalString sandbox ''
      mkdir -p vendor
      cp -r ${web-build}/sandbox-runtime vendor/sandbox-runtime
      chmod -R u+w vendor/sandbox-runtime
    ''}

    ${lib.optionalString postgres ''
      pg="$TMPDIR/pg"
      echo portal-test > "$TMPDIR/pg-password"
      initdb -D "$pg" -U portaltest --pwfile="$TMPDIR/pg-password" --auth=scram-sha-256 -E UTF8 --locale=C > "$TMPDIR/initdb.log"
      pg_ctl -D "$pg" -o "-p 54329 -k $TMPDIR -c listen_addresses=127.0.0.1" -l "$TMPDIR/pg.log" -w start
      export PORTAL_TEST_DATABASE_URL="postgres://portaltest:portal-test@127.0.0.1:54329/postgres"
    ''}

    status=0
    ${if only != null then ''
      node scripts/ci-local.mjs ${lib.concatMapStringsSep " " (step: "--only ${step}") only} || status=$?
      if [ "$status" -ne 0 ]; then
        for log in .ci-local/*/*.log; do
          echo "----- tail of $(basename "$log")"
          tail -n 40 "$log"
        done
      fi
    '' else ''
      printf '%s\n' 'set -euo pipefail' ${lib.escapeShellArg command} > "$NIX_BUILD_TOP/run-command.sh"
      bash "$NIX_BUILD_TOP/run-command.sh" || status=$?
      if [ "$status" -ne 0 ] && [ -f "$TMPDIR/step.log" ]; then
        echo "----- tail of step.log"
        tail -n 60 "$TMPDIR/step.log"
      fi
    ''}

    ${lib.optionalString postgres ''pg_ctl -D "$pg" -m fast stop''}

    runHook postBuild
  '';

  installPhase = ''
    mkdir -p "$out"
    if [ -d .ci-local ]; then
      cp -r .ci-local/. "$out/"
    elif [ -f "$TMPDIR/step.log" ]; then
      cp "$TMPDIR/step.log" "$out/step.log"
    fi
    exit "$status"
  '';
}
