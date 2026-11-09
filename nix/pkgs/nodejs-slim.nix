# The same pinned Node without npm and corepack: what pnpm runs under, and what the runtime images carry.
{ nodejs-slim_22, pins }:
if nodejs-slim_22.version == pins.node then
  nodejs-slim_22
else
  throw "nix/pkgs/nodejs-slim.nix: nixpkgs has Node ${nodejs-slim_22.version}, the Dockerfile pins ${pins.node}"
