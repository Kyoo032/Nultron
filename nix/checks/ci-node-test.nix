# scripts/ci-local.mjs --only node-test: `node --test scripts/*.test.mjs` and the apps/desktop tests. See
# nix/pkgs/ci-step.nix.
{ ci-step }:
ci-step {
  name = "node-test";
  only = [ "node-test" ];
}
