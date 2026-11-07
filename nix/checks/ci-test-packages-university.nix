# scripts/ci-local.mjs --only test:packages/university (vitest), inside the sandbox. See nix/pkgs/ci-step.nix.
{ ci-step }:
ci-step {
  name = "test-packages-university";
  only = [ "test:packages/university" ];
}
