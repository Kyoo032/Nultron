# scripts/ci-local.mjs --only node-test: `node --test scripts/*.test.mjs` and the apps/desktop tests.
{ ci-pkg-step, workspace-filesets }:
ci-pkg-step {
  name = "node-test";
  src = workspace-filesets.fullSource;
  only = [ "node-test" ];
  needsGit = true;
}
