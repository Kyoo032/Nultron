# scripts/ci-local.mjs --only test:packages/host (vitest), inside the sandbox. See nix/pkgs/ci-step.nix.
{ ci-step }:
ci-step {
  name = "test-packages-host";
  only = [ "test:packages/host" ];
}
