# Compatibility wrapper around ci-pkg-step using the full non-Nix source tree.
{ ci-pkg-step, workspace-filesets }:
args:
ci-pkg-step (
  {
    src = workspace-filesets.fullSource;
    needsGit = true;
  }
  // args
)
