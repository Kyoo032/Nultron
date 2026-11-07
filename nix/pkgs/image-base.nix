# What both images take from `node:22.23.4-bookworm-slim` besides Node itself: the users, a /bin/sh, the
# small set of tools the deploy scripts run inside a container, and the base image's entrypoint. Not a
# derivation; web-image.nix and portal-image.nix splice it in.
#
# Tools, and who runs them inside a container:
#   dash (/bin/sh)     the HEALTHCHECK (CMD-SHELL), portal-entry.sh, backup.sh and restore.sh (`sh -s`, `sh -c`)
#   coreutils          rm, mkdir, mv, chown, env in those scripts; /usr/bin/env for `#!/usr/bin/env node` shebangs
#   gnutar, gzip       backup.sh `tar -czf - -C /data`, restore.sh `tar -xzf - -C /data`
#   gnused             every pnpm node_modules/.bin shim, the entrypoint `tsx` among them, runs sed to find its folder
# Debian's /bin/sh is dash too. There is no package manager, no bash and no apt.
{
  lib,
  writeTextFile,
  dash,
  coreutils,
  gnutar,
  gzip,
  gnused,
  cacert,
  node-runtime,
  pins,
}:
let
  # The base image's entrypoint, verbatim (docker-library/node, MIT): run the command with node when its first
  # word is a flag or not a command. CMD names an executable, so for the default command it is a plain exec.
  entrypoint = writeTextFile {
    name = "docker-entrypoint.sh";
    executable = true;
    text = ''
      #!/bin/sh
      set -e

      # Run command with node if the first argument contains a "-" or is not a system command. The last
      # part inside the "{}" is a workaround for the following bug in ash/dash:
      # https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=874264
      if [ "''${1#-}" != "''${1}" ] || [ -z "$(command -v "''${1}")" ] || { [ -f "''${1}" ] && ! [ -x "''${1}" ]; }; then
        set -- node "$@"
      fi

      exec "$@"
    '';
  };
in
{
  # Linked into / by buildLayeredImage: their bin/ folders become /bin.
  contents = [
    dash
    coreutils
    gnutar
    gzip
    gnused
  ];

  # Run in the image root, before the image's own commands.
  extraCommands = ''
    mkdir -p bin usr/bin usr/local/bin etc/ssl/certs tmp root home/node

    ln -s dash bin/sh
    ln -s ${coreutils}/bin/env usr/bin/env
    ln -s ${node-runtime}/bin/node usr/local/bin/node
    ln -s node usr/local/bin/nodejs
    cp ${entrypoint} usr/local/bin/docker-entrypoint.sh

    # The base image has no CA bundle and Node does not read one: it trusts its 116 compiled-in roots in both
    # images. This file is for anything else that opens TLS (ffmpeg on an https input).
    ln -s ${cacert}/etc/ssl/certs/ca-bundle.crt etc/ssl/certs/ca-certificates.crt

    # The base image's users: root, and node with uid and gid 1000.
    cat > etc/passwd <<'EOF'
    root:x:0:0:root:/root:/bin/sh
    nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin
    node:x:1000:1000::/home/node:/bin/sh
    EOF
    cat > etc/group <<'EOF'
    root:x:0:
    nogroup:x:65534:
    node:x:1000:
    EOF
  '';

  # Run under fakeroot, so the ownership lands in the layer.
  fakeRootCommands = ''
    chmod 1777 tmp
    chown 1000:1000 home/node
  '';

  # The base image's environment, without its package managers' variables (YARN_VERSION, COREPACK_*,
  # PNPM_HOME and /pnpm on PATH): neither image carries one.
  env = [
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    "NODE_VERSION=${pins.node}"
  ];

  entrypointArgs = [ "docker-entrypoint.sh" ];

}
