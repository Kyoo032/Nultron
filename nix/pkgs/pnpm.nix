# pnpm at the version package.json pins, running under the pinned Node.
#
# nixpkgs patches pnpm's shebang to its default nodejs-slim (Node 24). Left alone, every lifecycle script
# pnpm starts, node-gyp included, would build native modules such as better-sqlite3 against the Node 24
# ABI, and the Node 22 runtime would refuse to load them. The override puts pnpm on the pinned Node.
{
  pnpm_9,
  nodejs-slim,
  pins,
}:
let
  pnpm = pnpm_9.override { inherit nodejs-slim; };
in
if pnpm.version == pins.pnpm then
  pnpm
else
  throw "nix/pkgs/pnpm.nix: nixpkgs has pnpm ${pnpm.version}, package.json pins ${pins.pnpm}"
