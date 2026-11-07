# Every Nix unit of this repo lives in one scope (lib.makeScope). A unit is one file, and the folder it sits
# in decides what it becomes:
#
#   nix/pkgs/<name>.nix     scope.<name>, and packages.<name> when it is a derivation
#   nix/checks/<name>.nix   checks.<name>
#   nix/shells/<name>.nix   devShells.<name>
#
# The folders are listed, never enumerated by hand, so adding a unit is adding a file: two units built in
# parallel never edit the same one. Each file is called with the scope's callPackage. An argument named
# after another unit gets that unit (`nodejs` is the pinned Node, not nixpkgs' default), `repoRoot` is the
# committed tree, and anything else comes from nixpkgs.
{ pkgs, src }:
let
  inherit (pkgs) lib;

  unitsIn =
    dir:
    let
      files = lib.filterAttrs (name: type: type == "regular" && lib.hasSuffix ".nix" name) (
        if builtins.pathExists dir then builtins.readDir dir else { }
      );
    in
    lib.mapAttrs' (name: _: lib.nameValuePair (lib.removeSuffix ".nix" name) (dir + "/${name}")) files;

  pkgUnits = unitsIn ./pkgs;

  scope = lib.makeScope pkgs.newScope (
    self: { repoRoot = src; } // lib.mapAttrs (_: file: self.callPackage file { }) pkgUnits
  );

  callEach = dir: lib.mapAttrs (_: file: scope.callPackage file { }) (unitsIn dir);
in
{
  # Without makeScope's own `packages` function: it would answer `nix build .#packages.<system>.<name>` with
  # "not an attribute set" before Nix tries the flake's real packages output.
  scope = removeAttrs scope [ "packages" ];
  packages = lib.filterAttrs (_: lib.isDerivation) (lib.getAttrs (lib.attrNames pkgUnits) scope);
  checks = callEach ./checks;
  devShells = callEach ./shells;
}
