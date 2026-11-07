# The app image, `nultron-web:local` as webapp-deploy/compose.yml names it: the Dockerfile's runtime stage, built
# from web-prod.nix, web-build.nix and ffmpeg-static.nix instead of from Docker stages.
#
#   nix build .#web-image && docker load < result
#
# The config (ENV, WORKDIR, USER, EXPOSE, VOLUME, HEALTHCHECK, CMD) is read from webapp-deploy/Dockerfile, the
# entrypoint and base environment from the base image (image-base.nix). The k8s rehearsal and the release
# name the same image nultron-ent:<tag>; `docker tag` it, the bytes are the same.
{
  dockerTools,
  image-base,
  dockerfile-runtime,
  web-prod,
  web-build,
  ffmpeg-static,
}:
let
  runtime = dockerfile-runtime "webapp-deploy/Dockerfile";
in
dockerTools.buildLayeredImage {
  name = "nultron-web";
  tag = "local";

  inherit (image-base) contents;

  extraCommands = image-base.extraCommands + ''
    # COPY --from=prod --chown=node:node /app /app
    mkdir -p app
    cp -a ${web-prod}/. app/
    chmod -R u+w app

    # COPY --from=build --chown=root:root /opt/sandbox-runtime /app/sandbox; RUN chmod -R a-w /app/sandbox
    cp -a ${web-build}/sandbox-runtime app/sandbox
    chmod -R u+w app/sandbox

    # COPY --from=ffmpeg ... /usr/local/bin/ and the licence
    install -Dm0755 ${ffmpeg-static}/bin/ffmpeg usr/local/bin/ffmpeg
    install -Dm0755 ${ffmpeg-static}/bin/ffprobe usr/local/bin/ffprobe
    install -Dm0644 ${ffmpeg-static}/share/licenses/ffmpeg/LICENSE.txt usr/local/share/licenses/ffmpeg/LICENSE.txt

    # RUN mkdir -p /data; RUN mkdir -p /opt/agentforge/components
    mkdir -p data opt/agentforge/components
  '';

  fakeRootCommands = image-base.fakeRootCommands + ''
    # /app is root's (Docker's WORKDIR makes it), everything in it the node user's, the sandbox root's and read-only.
    chown -R 1000:1000 app
    chown 0:0 app
    chown -R 0:0 app/sandbox
    chmod -R a-w app/sandbox
    chown -R 1000:1000 data opt/agentforge
  '';

  config = {
    User = runtime.user;
    WorkingDir = runtime.workdir;
    Env = image-base.env ++ runtime.env;
    Entrypoint = image-base.entrypointArgs;
    Cmd = runtime.cmd;
    ExposedPorts = runtime.exposedPorts;
    Volumes = runtime.volumes;
    Healthcheck = runtime.healthcheck;
  };
}
