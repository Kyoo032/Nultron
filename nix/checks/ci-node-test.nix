# scripts/ci-local.mjs --only node-test: `node --test scripts/*.test.mjs`.
{ ci-pkg-step, workspace-filesets }:
ci-pkg-step {
  name = "node-test";
  src = workspace-filesets.fullSource;
  only = [ "node-test" ];
  needsGit = true;
}
