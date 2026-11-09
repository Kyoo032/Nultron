# scripts/ci-local.mjs --only test:packages/db (vitest), inside the sandbox. See nix/pkgs/ci-step.nix.
{ ci-step }:
ci-step {
  name = "test-packages-db";
  only = [ "test:packages/db" ];
}
