# scripts/ci-local.mjs --only maps --only media: the advisory doc and media checks, which report and never
# fail. See nix/pkgs/ci-step.nix.
{ ci-step }:
ci-step {
  name = "docs";
  only = [
    "maps"
    "media"
  ];
}
