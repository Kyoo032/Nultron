# Minimal per-check source filesets matching the workspace package DAG and cross-package test reads.
# Not a derivation: `nix/checks/*.nix` pass these sources into `ci-pkg-step` so edits to one package
# never invalidate unrelated checks.
{ lib, repoRoot }:
let
  existing = paths: lib.fileset.unions (map (p: lib.fileset.maybeMissing (repoRoot + "/${p}")) paths);

  workspaceManifests =
    lib.concatMap
      (
        dir:
        map (name: "${dir}/${name}/package.json") (
          lib.attrNames (lib.filterAttrs (_: type: type == "directory") (builtins.readDir (repoRoot + "/${dir}")))
        )
      )
      [
        "apps"
        "packages"
      ];

  rootFileset = existing (
    [
      "package.json"
      "pnpm-lock.yaml"
      "pnpm-workspace.yaml"
      ".npmrc"
      "tsconfig.base.json"
      "biome.json"
      "turbo.json"
      "lanes.json"
      ".gitignore"
      "scripts/ci-local.mjs"
      "scripts/where-am-i.mjs"
    ]
    ++ workspaceManifests
  );

  mkSource = fileset: lib.fileset.toSource { root = repoRoot; inherit fileset; };

  # Transitive workspace DAG for tsc --noEmit.
  tscSets = rec {
    "apps/portal" = lib.fileset.unions [
      rootFileset
      (existing [ "apps/portal" ])
    ];
    "packages/core" = lib.fileset.unions [
      rootFileset
      (existing [ "packages/core" ])
    ];
    "packages/legal" = lib.fileset.unions [
      tscSets."packages/core"
      (existing [ "packages/legal" ])
    ];
    "packages/marketing" = lib.fileset.unions [
      tscSets."packages/core"
      (existing [ "packages/marketing" ])
    ];
    "packages/university" = lib.fileset.unions [
      tscSets."packages/core"
      (existing [ "packages/university" ])
    ];
    "packages/db" = lib.fileset.unions [
      tscSets."packages/university"
      (existing [ "packages/db" ])
    ];
    "packages/host" = lib.fileset.unions [
      tscSets."packages/db"
      (existing [
        "packages/legal"
        "packages/marketing"
        "packages/host"
      ])
    ];
    "apps/web" = lib.fileset.unions [
      tscSets."packages/host"
      (existing [ "apps/web" ])
    ];
  };

  # Host/paid-gate tests scan `apps/` and `packages/` TypeScript sources and read Caddyfile / locales,
  # while ignoring large static web artwork under apps/web/public and mascot renders.
  codeTree = lib.fileset.difference (existing [
    "apps"
    "packages"
  ]) (
    existing [
      "apps/web/public"
      "apps/web/components/nultron/images"
    ]
  );

  hostFileset = lib.fileset.unions [
    rootFileset
    codeTree
    (existing [
      "scripts/rotate-wrap-key.ts"
      "webapp-deploy/Caddyfile"
      "webapp-deploy/k8s/base/caddy/security.caddy"
    ])
  ];

  testSets = {
    "apps/portal" = lib.fileset.unions [
      tscSets."apps/portal"
      (existing [ "docs/internal/portal/migrations" ])
    ];
    "packages/core" = lib.fileset.unions [
      tscSets."packages/core"
      (existing [
        "apps/web/locales"
        "packages/host/src"
      ])
    ];
    "packages/legal" = tscSets."packages/legal";
    "packages/marketing" = tscSets."packages/marketing";
    "packages/university" = tscSets."packages/university";
    "packages/db" = tscSets."packages/db";
    "packages/host" = hostFileset;
    "apps/web" = lib.fileset.unions [
      tscSets."apps/web"
      (existing [
        "apps/portal/assets/logo.png"
        "webapp-deploy/compose.yml"
      ])
    ];
  };
in
{
  fullSource = mkSource (
    lib.fileset.difference repoRoot (
      existing [
        "nix"
        "flake.nix"
        "flake.lock"
        ".ci-local"
        ".nix-ci-roots"
      ]
    )
  );

  tsc = lib.mapAttrs (_: mkSource) tscSets;
  test = lib.mapAttrs (_: mkSource) testSets;

  sandbox = mkSource (
    lib.fileset.unions [
      hostFileset
      (existing [
        "scripts/build-sandbox-runtime.mjs"
        "scripts/sandbox-runtime-lock.mjs"
        "scripts/sandbox-runtime.lock.json"
        "scripts/sandbox-licenses"
      ])
    ]
  );

  formalChatSettle = mkSource (
    existing [
      "formal/chat-run-settle"
      "scripts/formal/chat-run-settle.mjs"
      "packages/host/src/runs.ts"
      "packages/host/src/threads.ts"
      "packages/host/src/usage-record.ts"
      "packages/db/src/client.ts"
    ]
  );

  formalPaidGate = mkSource (
    lib.fileset.unions [
      rootFileset
      codeTree
      (existing [ ".cursor/skills/verify-paid-media-gate" ])
    ]
  );
}
