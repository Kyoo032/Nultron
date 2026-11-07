{
  # The Nix build of the hosted web app, beside the Docker one. Nothing here replaces webapp-deploy/: the
  # Dockerfiles, compose and the k8s rehearsal keep working unchanged, and every rung of the move is written
  # up in docs/internal/nix-migration.md.
  description = "Nultron: Nix build of the hosted web app (strangler beside webapp-deploy/)";

  # The stable channel the migration pins. nixos-26.05 carries the exact Node (22.23.4) and pnpm (9.15.9)
  # that webapp-deploy/Dockerfile and package.json pin; nix/pkgs/pins.nix refuses an evaluation where
  # they disagree.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      # The two architectures the Dockerfile builds (BuildKit's TARGETARCH amd64 and arm64).
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      units =
        system:
        import ./nix/scope.nix {
          pkgs = import nixpkgs {
            inherit system;
            # nixpkgs marks pnpm 9.15.9 insecure (twelve CVEs). It is the version package.json pins and the
            # Dockerfile installs, so it is permitted by exact name and nothing else is.
            # docs/internal/security-register.md, SR-199.
            config.permittedInsecurePackages = [ "pnpm-9.15.9" ];
          };
          src = ./.;
        };
      forEachSystem = f: lib.genAttrs systems (system: f (units system));
    in
    {
      legacyPackages = forEachSystem (u: u.scope);
      packages = forEachSystem (u: u.packages);
      checks = forEachSystem (u: u.checks);
      devShells = forEachSystem (u: u.devShells);
    };
}
