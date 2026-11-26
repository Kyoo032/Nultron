# Isolation and hardening (F7a)

How an untrusted file is kept from taking the host down, and what the deployed container actually
enforces. Written against `webapp-deploy/compose.yml` and `webapp-deploy/Dockerfile` line by line;
the live-container proof runs once the deploy hold lifts (AC-7.4).

## Parser isolation

Every document `extractFile` parses runs in a fresh child process
(`packages/host/src/file-extract/child-parse.ts`, entry `parse-worker.ts`), never in the host
process. A zip bomb, a broken PDF or a runaway napi conversion costs a disposable child.

- `--permission` — fs read on the repository only (needed to load its own code and the anydoc
  binding; the document's bytes cross over IPC, so no document path is ever granted), **no fs
  write**, no `--allow-child-process`. `--allow-addons` and `--allow-worker` are structural grants:
  the anydoc binding is a `.node` addon, and the TypeScript loader (tsx/esbuild) compiles on a
  worker thread.
- `--max-old-space-size=${AGENTFORGE_PARSE_CHILD_MAX_MB}` (default 384) caps the child's JS heap.
- Empty environment: the child never sees `AGENTFORGE_SECRETS_KEY` or any tenant key.
- Network: the permission model does not reach sockets, so the worker's first act — before any
  converter module is loaded — is to disable `net`, `tls`, `http`, `https`, `http2`, `dgram`, `dns`,
  `fetch` and `WebSocket`. `child-parse.test.ts` proves the seal from outside.
- The deadline SIGKILLs the process. The old in-process deadline could only race a timer against a
  napi promise; this one actually stops the native work.
- The 2/3 native-gate cap (`native-gate.ts`) now bounds how many parse children may exist at once.

## Execution limits

- Tool budget: `createToolBudget(undefined)` applies `DEFAULT_RUN_BUDGET` (60 tool calls, 6 steps);
  a runtime that passes no budget is no longer admit-all.
- Run caps (`packages/host/src/run-limits.ts`, `runExecutionCaps`): `AGENTFORGE_RUN_MAX_SECONDS`
  (default 1800) ends a run past its wall-clock with `run.failed` "reached its time limit";
  `AGENTFORGE_RUN_MAX_OUTPUT_BYTES` (default 2 MB) ends a run that streams too much. Both cancel the
  model call so billing stops. The per-tenant concurrency cap (`admitRun`) is unchanged.
- Outbound: `isPrivateIpLiteral` refuses cloud metadata addresses — `169.254.169.254`, IPv6
  metadata/link-local (`fd00:ec2::254`, `fe80::`), and IPv4-mapped spellings — on every egress path
  that resolves through `safe-fetch.ts`.

## Container hardening (compose / Dockerfile, verified line by line)

- `read_only: true` (`compose.yml:91`): the image is immutable; only `AGENTFORGE_DATA_DIR` and the
  components volume are writable.
- `tmpfs` `/tmp` is `nosuid,nodev,noexec`, 512m (`compose.yml:92-93`).
- Volumes: `nultron-data:/data` and `nultron-components:/opt/agentforge/components`
  (`compose.yml:95-127`): executable content lives on the second volume only, never in the tenant
  volume, which stays free to be mounted `noexec` on the host.
- `security_opt: no-new-privileges`, `cap_drop: ALL` (`compose.yml:119-121`): the app binds 3000 and
  holds no capabilities.
- `init: true`, `pids_limit: 512` (`compose.yml:123-125`): worker/parse children are reaped; a stuck
  run cannot exhaust pids.
- `mem_limit: 6g`, `mem_reservation: 1g` (`compose.yml:126-127`): parse children share this envelope;
  the 384 MiB default child cap keeps a parse well inside the 768 MiB desk figure (AC-7.3).
- `USER node`, `WORKDIR /app/apps/web`, `EXPOSE 3000` (`Dockerfile:242-246`): the app never runs as
  root; `VOLUME /opt/agentforge/components` (`Dockerfile:239-241`) matches the compose mount above.
