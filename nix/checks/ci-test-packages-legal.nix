# scripts/ci-local.mjs --only test:packages/legal (vitest), inside the sandbox. See nix/pkgs/ci-step.nix.
{ ci-step }:
ci-step {
  name = "test-packages-legal";
  only = [ "test:packages/legal" ];
}
