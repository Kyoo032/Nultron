# scripts/ci-local.mjs --only test:apps/portal (vitest), against a Postgres 16 the check starts. See
# nix/pkgs/ci-step.nix.
{ ci-step }:
ci-step {
  name = "test-apps-portal";
  only = [ "test:apps/portal" ];
  postgres = true;
}
