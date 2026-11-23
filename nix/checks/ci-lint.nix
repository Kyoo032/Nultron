# scripts/ci-local.mjs --only lint (Biome), inside the sandbox with zero-copy workspace-deps.
{ ci-pkg-step, workspace-filesets }:
ci-pkg-step {
  name = "lint";
  src = workspace-filesets.fullSource;
  only = [ "lint" ];
  needsGit = true;
}
