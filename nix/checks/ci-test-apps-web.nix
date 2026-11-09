# scripts/ci-local.mjs --only test:apps/web (vitest), inside the sandbox. See nix/pkgs/ci-step.nix.
{ ci-step }:
ci-step {
  name = "test-apps-web";
  only = [ "test:apps/web" ];
}
