# The Node the images run: the pinned nodejs-slim binary alone, without its headers and docs.
#
# nodejs-slim's own closure is 223 MiB, because the binary's build config (process.config) names its own store
# path and the -dev outputs of every library Node links (openssl, icu4c, zlib, libuv and others), each of which
# brings headers, pkg-config files and the shell tools their scripts use. The binary loads only the libraries.
# Those strings are blanked; process.config is read by node-gyp at build time, never by the running app, and
# the build steps use nodejs-slim itself.
{
  runCommand,
  removeReferencesTo,
  nodejs-slim,
}:
runCommand "nodejs-runtime-${nodejs-slim.version}"
  {
    nativeBuildInputs = [ removeReferencesTo ];
    disallowedReferences = [ nodejs-slim ];
    inherit (nodejs-slim) version;
  }
  ''
    install -Dm0755 ${nodejs-slim}/bin/node "$out/bin/node"
    remove-references-to -t ${nodejs-slim} "$out/bin/node"
    grep -aoE '${builtins.storeDir}/[a-z0-9]{32}-[^/"[:space:]]+-dev' "$out/bin/node" | sort -u \
      | while read -r dev; do remove-references-to -t "$dev" "$out/bin/node"; done
    "$out/bin/node" -e 'require("node:sqlite"); require("node:zlib"); require("node:crypto"); process.stdout.write(process.version + "\n")'
  ''
