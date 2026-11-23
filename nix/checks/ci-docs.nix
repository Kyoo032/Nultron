# scripts/ci-local.mjs --only maps --only media: the advisory doc and media checks.
{ ci-pkg-step, workspace-filesets }:
ci-pkg-step {
  name = "docs";
  src = workspace-filesets.fullSource;
  only = [
    "maps"
    "media"
  ];
}
