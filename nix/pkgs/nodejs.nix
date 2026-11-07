# The Node every build step runs on: nixpkgs' Node 22, refused unless it is the exact version the
# Dockerfile's base image carries (pins.nix). Build steps need npm's node-gyp headers, so this is the full
# package; the runtime images use nodejs-slim.nix.
{ nodejs_22, pins }:
if nodejs_22.version == pins.node then
  nodejs_22
else
  throw "nix/pkgs/nodejs.nix: nixpkgs has Node ${nodejs_22.version}, the Dockerfile pins ${pins.node}"
