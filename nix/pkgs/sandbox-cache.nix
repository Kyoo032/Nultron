# The download cache scripts/build-sandbox-runtime.mjs reads (`<cache>/wheels/<file>`), filled from
# scripts/sandbox-runtime.lock.json: each Python wheel the Dockerfile's build stage downloads becomes a
# fetchurl with the lock's own URL and sha256, so the script then runs with --offline and touches no network.
{
  lib,
  runCommand,
  fetchurl,
  repoRoot,
}:
let
  lock = lib.importJSON (repoRoot + "/scripts/sandbox-runtime.lock.json");
  wheels = map (wheel: {
    inherit (wheel) file;
    src = fetchurl {
      inherit (wheel) url sha256;
      name = wheel.file;
    };
  }) lock.pyodide.wheels;
in
runCommand "nultron-sandbox-cache" { } ''
  mkdir -p "$out/wheels"
  ${lib.concatMapStrings (wheel: ''
    cp ${wheel.src} "$out/wheels/${wheel.file}"
  '') wheels}
''
