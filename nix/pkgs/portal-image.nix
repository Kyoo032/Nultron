# The portal image, `nultron-portal:local` as webapp-deploy/compose.yml names it: portal.Dockerfile's runtime
# stage over portal-tree.nix.
#
#   nix build .#portal-image && docker load < result
#
# The config is read from webapp-deploy/portal.Dockerfile, the entrypoint and base environment from the base
# image (image-base.nix). portal-entry.sh and prepare-db.mjs, which compose and the k8s rehearsal run inside
# this image, arrive with the tree because the allowlist lets them in.
{
  dockerTools,
  image-base,
  dockerfile-runtime,
  portal-tree,
}:
let
  runtime = dockerfile-runtime "webapp-deploy/portal.Dockerfile";
in
dockerTools.buildLayeredImage {
  name = "nultron-portal";
  tag = "local";

  inherit (image-base) contents;

  extraCommands = image-base.extraCommands + ''
    # COPY --from=build --chown=node:node /app /app
    mkdir -p app
    cp -a ${portal-tree}/. app/
    chmod -R u+w app

    # RUN mkdir -p /portal-data && chown node:node /portal-data
    mkdir -p portal-data
  '';

  fakeRootCommands = image-base.fakeRootCommands + ''
    chown -R 1000:1000 app
    chown 0:0 app
    chown 1000:1000 portal-data
  '';

  config = {
    User = runtime.user;
    WorkingDir = runtime.workdir;
    Env = image-base.env ++ runtime.env;
    Entrypoint = image-base.entrypointArgs;
    Cmd = runtime.cmd;
    ExposedPorts = runtime.exposedPorts;
    Healthcheck = runtime.healthcheck;
  };
}
