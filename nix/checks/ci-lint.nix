# scripts/ci-local.mjs --only lint (Biome), inside the sandbox. See nix/pkgs/ci-step.nix.
{ ci-step }:
ci-step {
  name = "lint";
  only = [ "lint" ];
}
