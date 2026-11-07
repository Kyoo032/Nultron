# scripts/ci-local.mjs --only test:packages/marketing (vitest), inside the sandbox. See nix/pkgs/ci-step.nix.
{ ci-step }:
ci-step {
  name = "test-packages-marketing";
  only = [ "test:packages/marketing" ];
}
