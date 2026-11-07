# Proves the pins at build time, not only at evaluation: the Node binary reports the Dockerfile's version,
# and pnpm, started through its own patched shebang, reports package.json's version from under that Node.
{
  runCommand,
  nodejs,
  nodejs-slim,
  pnpm,
  pins,
}:
runCommand "nultron-pins"
  {
    nativeBuildInputs = [ pnpm ];
  }
  ''
    export HOME="$TMPDIR"
    check() {
      if [ "$2" != "$3" ]; then
        echo "pins: $1 is $2, expected $3" >&2
        exit 1
      fi
      echo "pins: $1 $2"
    }
    check "node" "$(${nodejs}/bin/node --version)" "v${pins.node}"
    check "node (slim)" "$(${nodejs-slim}/bin/node --version)" "v${pins.node}"
    check "pnpm" "$(pnpm --version)" "${pins.pnpm}"

    # The interpreter pnpm's patched shebang names must be the pinned Node, not nixpkgs' default.
    entry="$(readlink -f "$(command -v pnpm)")"
    interpreter="$(head -n 1 "$entry" | sed -e 's/^#! *//' -e 's/ .*//')"
    check "pnpm's node" "$("$interpreter" --version)" "v${pins.node}"
    touch "$out"
  ''
