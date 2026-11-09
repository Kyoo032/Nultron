# scripts/ci-local.mjs --only sandbox, with the code sandbox folder web-build.nix builds in place, so
# sandbox:integration runs Pyodide and QuickJS for real. See nix/pkgs/ci-step.nix.
{ ci-step }:
ci-step {
  name = "sandbox";
  only = [ "sandbox" ];
  sandbox = true;
}
