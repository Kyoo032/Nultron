# scripts/ci-local.mjs --only tsc: `tsc --noEmit` for every workspace with a tsconfig. See nix/pkgs/ci-step.nix.
{ ci-step }:
ci-step {
  name = "tsc";
  only = [ "tsc" ];
}
