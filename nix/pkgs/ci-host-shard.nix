# Sharded Vitest check for packages/host (`--shard=i/4`), keeping the checkVitestLog non-empty guard.
{ ci-pkg-step, workspace-filesets }:
shard:
ci-pkg-step {
  name = "test-packages-host-${toString shard}";
  src = workspace-filesets.test."packages/host";
  command = ''
    set -euo pipefail
    export AGENTFORGE_DATA_DIR="$(mktemp -d)"
    vitest_entry="$PWD/packages/host/node_modules/vitest/vitest.mjs"
    if [ ! -f "$vitest_entry" ]; then
      vitest_entry="$PWD/node_modules/vitest/vitest.mjs"
    fi
    (cd packages/host && node "$vitest_entry" run --shard=${toString shard}/4 --maxWorkers=2) 2>&1 | tee "$TMPDIR/step.log"
    LOG_FILE="$TMPDIR/step.log" node --input-type=module -e '
      import { readFileSync } from "node:fs";
      import { checkVitestLog } from "./scripts/ci-local.mjs";
      const verdict = checkVitestLog(readFileSync(process.env.LOG_FILE, "utf8"));
      if (!verdict.ok) { console.error(verdict.reason); process.exit(1); }
      console.log("host shard ${toString shard}/4 passed:", verdict.passed, "tests");
    '
  '';
}
