# Per-workspace Vitest helper using minimal transitive source filesets.
{ lib, ci-pkg-step, workspace-filesets }:
{ pkg, postgres ? false }:
let
  slug = lib.replaceStrings [ "/" ] [ "-" ] pkg;
in
ci-pkg-step {
  name = "test-${slug}";
  src = workspace-filesets.test.${pkg};
  only = [ "test:${pkg}" ];
  inherit postgres;
}
