# scripts/ci-local.mjs --only sandbox, with the code sandbox folder web-build.nix builds in place.
{ ci-pkg-step, workspace-filesets }:
ci-pkg-step {
  name = "sandbox";
  src = workspace-filesets.sandbox;
  only = [ "sandbox" ];
  sandbox = true;
}
