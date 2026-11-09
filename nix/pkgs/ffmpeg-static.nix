# The Dockerfile's `ffmpeg` stage: BtbN's static GPL build, pinned by URL and sha256. Both are read from the
# Dockerfile's `ADD --checksum=sha256:<hash> <url>` lines, so a new build is still one edit there, and the
# Nix build fetches the same bytes. The checks the Dockerfile runs in its runtime stage run here: both programs
# start, and the encoders the recipes ask for (libx264, libmp3lame) are present.
#
# "Static" is BtbN's word for the codecs: the two programs still link glibc dynamically and ask for
# /lib64/ld-linux-x86-64.so.2, which a Nix image does not have. autoPatchelf points them at the glibc and
# libgcc_s the image already carries for Node; nothing else in the binaries changes.
{
  lib,
  stdenv,
  fetchurl,
  xz,
  autoPatchelfHook,
  glibc,
  repoRoot,
}:
let
  lines = map lib.trim (
    lib.splitString "\n" (builtins.readFile (repoRoot + "/webapp-deploy/Dockerfile"))
  );

  # FROM base AS ffmpeg-<arch>
  # ADD --checksum=sha256:<hash> \
  #     <url> \
  pinFor =
    arch:
    let
      at = lib.lists.findFirstIndex (line: line == "FROM base AS ffmpeg-${arch}") null lines;
      add = lib.elemAt lines (at + 1);
      url = lib.trim (lib.removeSuffix "\\" (lib.elemAt lines (at + 2)));
    in
    if at == null then
      throw "nix/pkgs/ffmpeg-static.nix: webapp-deploy/Dockerfile has no `FROM base AS ffmpeg-${arch}` stage"
    else
      {
        inherit url;
        sha256 = lib.head (builtins.match "ADD --checksum=sha256:([0-9a-f]{64}).*" add);
      };

  # BuildKit's TARGETARCH for each Nix system.
  arch =
    {
      x86_64-linux = "amd64";
      aarch64-linux = "arm64";
    }
    .${stdenv.hostPlatform.system}
      or (throw "nix/pkgs/ffmpeg-static.nix: no ffmpeg build for ${stdenv.hostPlatform.system}");

  pin = pinFor arch;
in
stdenv.mkDerivation {
  pname = "nultron-ffmpeg-static";
  version = lib.head (builtins.match ".*/ffmpeg-(n[^-]+)-.*" pin.url);

  src = fetchurl { inherit (pin) url sha256; };

  nativeBuildInputs = [
    xz
    autoPatchelfHook
  ];
  buildInputs = [
    glibc
    stdenv.cc.cc.lib
  ];

  unpackPhase = ''
    mkdir unpacked
    tar -xJf "$src" -C unpacked --strip-components=1
  '';

  installPhase = ''
    install -Dm0755 unpacked/bin/ffmpeg "$out/bin/ffmpeg"
    install -Dm0755 unpacked/bin/ffprobe "$out/bin/ffprobe"
    install -Dm0644 unpacked/LICENSE.txt "$out/share/licenses/ffmpeg/LICENSE.txt"
  '';

  # Docker runtime stage: fail the build, not the first video job.
  doInstallCheck = true;
  # The output is read whole before it is searched: stdenv runs with pipefail, and `grep -q` closing the pipe
  # early would fail the check on SIGPIPE.
  installCheckPhase = ''
    "$out/bin/ffmpeg" -hide_banner -version > /dev/null
    "$out/bin/ffprobe" -hide_banner -version > /dev/null
    encoders="$("$out/bin/ffmpeg" -hide_banner -encoders 2> /dev/null)"
    grep -q ' libx264 ' <<< "$encoders"
    grep -q ' libmp3lame ' <<< "$encoders"
    version="$("$out/bin/ffmpeg" -hide_banner -version)"
    echo "''${version%%$'\n'*}"
  '';

  # Patched for the loader only; not stripped further.
  dontStrip = true;
}
