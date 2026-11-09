/**
 * Boot environment for the webdev and hosted server. Imported for its side effects only, and
 * imported FIRST.
 *
 * It does three things, in this order, and they exist because ESM hoists every `import` above the
 * module body of the file that contains it. Whatever has to happen before `@agentforge/host` — and
 * through it `@agentforge/db` — is evaluated therefore has to live in a module that is imported
 * ahead of it. This is that module.
 *
 * 0. **Refuse to run on a Node.js older than 22** (SH-001). `./lib/node-version-boot` is the first
 *    import below, so it runs before the hosted guards and before any module that loads
 *    better-sqlite3, which segfaults on Node 20 with exit 139 and no message. The check is in
 *    `./lib/node-version.ts`. Webdev and the hosted server both pass through here; the packaged
 *    desktop never imports this file (its host bundle starts at `apps/desktop/src/host-entry.ts`).
 *
 * 1. **Refuse a hosted process with a bad environment** (docs/internal/security-register.md, SR-25).
 *    `packages/db/src/client.ts` does real work at module scope: it creates the data dir, applies a
 *    queued "Start over" wipe, opens SQLite and runs every migration. The two hosted guards used to
 *    run in `main()` in `server.ts`, which is after all of that, so a container with no wrap key
 *    built a half-initialised data directory (and, with a wipe queued, applied it) and only then
 *    printed its refusal. They run here instead. A throw at this point stops the import graph, so
 *    nothing below this file is evaluated and nothing is written.
 *
 *    The guards read `process.env` as the process was started. `packages/db/src/client.ts` also
 *    loads `.env` / `.env.local` when it is imported, which is later than this. That is deliberate
 *    and consistent with the hosted contract: the hosted app takes its secrets from the real
 *    environment (compose, a secret manager) and never from a file in the repo, and the image does
 *    not contain one (`webapp-deploy/.dockerignore`). A hosted variable that exists only in a
 *    dotenv file is not seen here, and `main()` in `server.ts` still checks again after the files
 *    are loaded, so it is caught late rather than not at all.
 *
 *    The warnings `assertHostedEnvComplete` can emit are muted at this call. `main()` runs the same
 *    check with the real `console.warn`, and a booting hosted server should say each of them once.
 *    Nothing is hidden by this: a refusal is a thrown error, and warnings only exist on the path
 *    where the check passes.
 *
 *    With `AGENTFORGE_SERVER` off, `assertDeskVaultKeyUsable` is the one check that runs: it reads
 *    `AGENTFORGE_SECRETS_KEY` and nothing else, and touches no file (SR-203).
 *
 * 2. **Opt this process in to applying a queued "Start over" wipe.** `client.ts` applies one at
 *    boot, but only for a process that set `AGENTFORGE_APPLY_PENDING_RESET=1` — importing the
 *    database must never delete anybody's data by accident. The web server is one of the two
 *    processes that are allowed to (the Electron shell's `bootstrapPackaged()` is the other), so it
 *    opts in here, after the guards: a server that refuses to boot has no business deleting a thing.
 *    An assignment at the top of `server.ts` would run *after* `@agentforge/host` had been
 *    evaluated, which is why this is a module of its own.
 */
import "./lib/node-version-boot";
import {
  assertDeskVaultKeyUsable,
  assertHostedEnvComplete,
  assertHostedModeCoherent,
} from "./server/hosted-mode-guard";

assertHostedModeCoherent(process.env);
assertHostedEnvComplete(process.env, () => {});
assertDeskVaultKeyUsable(process.env);

process.env.AGENTFORGE_APPLY_PENDING_RESET = "1";
