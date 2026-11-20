# Every package pnpm-lock.yaml names, for every platform, as one fixed-output derivation: the only step of the
# Nix build that reaches the network. Its inputs are the lockfile and the workspace manifests, so a source
# edit does not refetch it, and its hash pins every tarball byte, the `xlsx` tarball from cdn.sheetjs.com
# included, which the lockfile itself records without an integrity field (SR-208).
#
# When pnpm-lock.yaml changes, this hash changes: set it to "", build, and copy the `got:` value back.
{
  lib,
  fetchPnpmDeps,
  pnpm,
  repoRoot,
}:
fetchPnpmDeps {
  pname = "nultron";
  version = "0";
  inherit pnpm;
  fetcherVersion = 5;
  src = lib.fileset.toSource {
    root = repoRoot;
    fileset = lib.fileset.unions (
      map (lib.fileset.maybeMissing) (
        [
          (repoRoot + "/package.json")
          (repoRoot + "/pnpm-lock.yaml")
          (repoRoot + "/pnpm-workspace.yaml")
          (repoRoot + "/.npmrc")
        ]
        # The workspace globs in pnpm-workspace.yaml: apps/* and packages/*.
        ++
          lib.concatMap
            (
              dir:
              map (name: repoRoot + "/${dir}/${name}/package.json") (
                lib.attrNames (
                  lib.filterAttrs (_: type: type == "directory") (builtins.readDir (repoRoot + "/${dir}"))
                )
              )
            )
            [
              "apps"
              "packages"
            ]
      )
    );
  };
  # A machine behind a TLS-inspecting proxy has that proxy's CA in Nix's `ssl-cert-file`, which Nix mounts into
  # every fixed-output build at this path. Node keeps its own roots and adds these, so the fetch trusts what
  # Nix itself trusts, and nothing more.
  prePnpmInstall = ''
    if [ -f /etc/ssl/certs/ca-certificates.crt ]; then
      export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
    fi
  '';
  hash = "sha256-/FR9X6opDjMIUIl2F5sIZoSc6ZaE4kgVP/haNjIjOUc=";
}
