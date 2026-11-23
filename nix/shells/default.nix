# `nix develop`: the toolchain scripts/ci-local.mjs and the k8s rehearsal call, at the Docker build's pins.
#
#   nix develop -c pnpm install --frozen-lockfile
#   nix develop -c node scripts/ci-local.mjs
#
# What each tool is for:
#   nodejs, pnpm          the pinned Node 22 (with npm's node-gyp headers) and pnpm 9 on that Node
#   python3, gnumake, gcc  node-gyp's fallback build of better-sqlite3, as in the Dockerfile's build stage
#   git                    where-am-i, lane-guard, and tests that list tracked files
#   getent                 name lookups the glibc tools in node_modules make outside a full distribution
#   postgresql_16          a local server for the portal suite (PORTAL_TEST_DATABASE_URL) where its embedded
#                          Postgres cannot start, e.g. as root; the same major version compose runs
#   kubectl, kustomize, kind, kubeconform, openssl   the k8s rehearsal (webapp-deploy/k8s)
#
# Binaries that npm ships for glibc (biome, esbuild, embedded-postgres) run from node_modules as they are,
# because the host's /lib64/ld-linux-x86-64.so.2 loads them. On NixOS that loader is absent; use the flake
# checks there (docs/internal/nix-migration.md, rung 5).
{
  mkShell,
  nodejs,
  pnpm,
  python3,
  gnumake,
  gcc,
  git,
  getent,
  postgresql_16,
  kubectl,
  kustomize,
  kind,
  kubeconform,
  openssl,
  jre_headless,
  tla2tools,
}:
mkShell {
  packages = [
    nodejs
    pnpm
    python3
    gnumake
    gcc
    git
    getent
    postgresql_16
    kubectl
    kustomize
    kind
    kubeconform
    openssl
    jre_headless
  ];

  # ci-local.mjs runs pnpm as `node <pnpm.cjs>` and looks for that file in CI_LOCAL_PNPM before falling back to
  # `npx pnpm@<version>`, which would fetch a second pnpm from the registry. Point it at this one.
  CI_LOCAL_PNPM = "${pnpm}/libexec/pnpm/bin/pnpm.cjs";
  # node-gyp builds against this Node's own headers instead of downloading a tarball for the version.
  npm_config_nodedir = "${nodejs}";
  # Hermetic pinned TLA+ / TLC jar for `pnpm formal:settle`.
  TLA2TOOLS_JAR = "${tla2tools}";
}
