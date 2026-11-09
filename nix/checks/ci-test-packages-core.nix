# scripts/ci-local.mjs --only test:packages/core (vitest), inside the sandbox. See nix/pkgs/ci-step.nix.
{ ci-step }:
ci-step {
  name = "test-packages-core";
  only = [ "test:packages/core" ];
}
