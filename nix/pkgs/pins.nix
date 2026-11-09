# The versions the Docker build pins, read from the files that pin them, so the Nix build cannot drift
# from them without failing evaluation:
#   Node   ARG NODE_VERSION in webapp-deploy/Dockerfile and webapp-deploy/portal.Dockerfile
#   pnpm   ARG PNPM_VERSION in both Dockerfiles, and packageManager in package.json
# Not a derivation: nodejs.nix, nodejs-slim.nix and pnpm.nix assert against it.
{ lib, repoRoot }:
let
  argIn =
    file: name:
    let
      found = lib.findFirst (line: lib.hasPrefix "ARG ${name}=" line) null (
        lib.splitString "\n" (builtins.readFile (repoRoot + "/${file}"))
      );
    in
    if found == null then
      throw "nix/pkgs/pins.nix: ${file} has no `ARG ${name}=` line"
    else
      lib.removePrefix "ARG ${name}=" found;

  agree =
    what: values:
    let
      unique = lib.unique (lib.attrValues values);
    in
    if lib.length unique == 1 then
      lib.head unique
    else
      throw "nix/pkgs/pins.nix: the ${what} pins disagree: ${builtins.toJSON values}";

  # `22.23.4-bookworm-slim` is the Docker tag; the Node version is the part before the first `-`.
  nodeTag = agree "Node image" {
    "webapp-deploy/Dockerfile" = argIn "webapp-deploy/Dockerfile" "NODE_VERSION";
    "webapp-deploy/portal.Dockerfile" = argIn "webapp-deploy/portal.Dockerfile" "NODE_VERSION";
  };

  packageManager = (lib.importJSON (repoRoot + "/package.json")).packageManager;
in
{
  inherit nodeTag;
  node = lib.head (lib.splitString "-" nodeTag);
  pnpm = agree "pnpm" {
    "webapp-deploy/Dockerfile" = argIn "webapp-deploy/Dockerfile" "PNPM_VERSION";
    "webapp-deploy/portal.Dockerfile" = argIn "webapp-deploy/portal.Dockerfile" "PNPM_VERSION";
    "package.json packageManager" = lib.removePrefix "pnpm@" packageManager;
  };
}
