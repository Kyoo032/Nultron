# A flake check that runs scripts/ci-local.mjs, unchanged, on a copy of workspace.nix:
#
#   ci-step { name = "tsc"; only = [ "tsc" ]; }   =>   node scripts/ci-local.mjs --only tsc
#
# It passes or fails exactly as the script does: exit 1 when a required step in the selection fails, advisory
# steps never. The script's logs and summary.md are the check's output, and the tail of every failing step's
# log is printed into the build log.
#
# What the sandbox lacks, it gets here, not in the script:
#   git          a throwaway repo of the copy, for the tests that list tracked files or make repos of their own
#   curl, openssl  what webapp-deploy/scripts/backup.sh and _heartbeat.sh call, as a server has them; the backup and
#                heartbeat tests run those scripts (without curl the ping is skipped, without openssl the backup stops)
#   pnpm         through CI_LOCAL_PNPM, as in the devShell, so the script never reaches for npx
#   postgres     (postgres = true) a local Postgres 16 for the portal suite, through PORTAL_TEST_DATABASE_URL, the
#                suite's own documented route; its embedded Postgres is a glibc download from npm
#   sandbox      (sandbox = true) the code sandbox folder from web-build.nix at vendor/sandbox-runtime, so
#                sandbox:integration runs the real Pyodide and QuickJS engines instead of passing with a note
#
# Not in any check, because they need what a sandbox cannot have: where-am-i, lane-guard and lane-guard:map (the
# git history and origin/main), audit:deployed and audit:workspace (the registry's advisory API), e2e (a browser).
{
  lib,
  stdenvNoCC,
  nodejs,
  pnpm,
  git,
  curl,
  openssl,
  postgresql_16,
  workspace,
  web-build,
}:
{
  name,
  only,
  postgres ? false,
  sandbox ? false,
}:
stdenvNoCC.mkDerivation {
  name = "nultron-ci-${name}";
  dontUnpack = true;

  nativeBuildInputs = [
    nodejs
    git
    curl
    openssl
  ]
  ++ lib.optional postgres postgresql_16;

  CI_LOCAL_PNPM = "${pnpm}/libexec/pnpm/bin/pnpm.cjs";

  buildPhase = ''
    runHook preBuild
    # The copy and the temp folder sit side by side, as a checkout and /tmp do on a machine. With the copy inside
    # TMPDIR, `<repo>/data` would count as a throwaway desk (packages/host/src/__fixtures__/throwaway-desk.ts).
    mkdir -p "$NIX_BUILD_TOP/tmp" "$NIX_BUILD_TOP/home"
    export TMPDIR="$NIX_BUILD_TOP/tmp" HOME="$NIX_BUILD_TOP/home"

    cp -a ${workspace} "$NIX_BUILD_TOP/ws"
    chmod -R u+w "$NIX_BUILD_TOP/ws"
    cd "$NIX_BUILD_TOP/ws"

    git init -q
    git add -A
    git -c user.name=nix -c user.email=nix@localhost commit -qm "workspace for ${name}"

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
    node scripts/ci-local.mjs ${lib.concatMapStringsSep " " (step: "--only ${step}") only} || status=$?

    ${lib.optionalString postgres ''pg_ctl -D "$pg" -m fast stop''}

    if [ "$status" -ne 0 ]; then
      for log in .ci-local/*/*.log; do
        echo "----- tail of $(basename "$log")"
        tail -n 40 "$log"
      done
    fi
    runHook postBuild
  '';

  installPhase = ''
    mkdir -p "$out"
    cp -r .ci-local/. "$out/"
    exit "$status"
  '';
}
