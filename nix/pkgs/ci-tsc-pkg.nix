# Per-workspace `tsc --noEmit` helper using minimal transitive source filesets.
{ lib, ci-pkg-step, workspace-filesets }:
pkg:
let
  slug = lib.replaceStrings [ "/" ] [ "-" ] pkg;
in
ci-pkg-step {
  name = "tsc-${slug}";
  src = workspace-filesets.tsc.${pkg};
  only = [ "tsc:${pkg}" ];
}
