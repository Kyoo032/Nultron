# Public release notes

Every notes file here is published verbatim to a public release repo. None of them may name the internal engineering notes, an AI tool, or an agent. The release scripts refuse a notes file that does.

- `<version>-notes.md` (for example `0.15.0-notes.md`) was a **Personal** desktop release on `Kyoo032/Nultron-Desktop`, published by `pnpm desktop:release`. Personal is retired (2026-10-14): that repo is archived, and no new desktop notes are published.
- `ent-<date>-notes.md` (for example `ent-2026.09.23-notes.md`) is an **Enterprise** hosted web release on [`Kyoo032/Nultron-Releases`](https://github.com/Kyoo032/Nultron-Releases), published by `node scripts/release-web.mjs`. The same run pushes the image `ghcr.io/kyoo032/nultron-ent:<tag>` and commits the deploy bundle to that repo's `main`: `compose.yml` pinned to the image, `.env.example`, `DEPLOY.md` and `Caddyfile`. It appends the source commit sha and the image to the release body.
- `releases-readme.md` is the README of the archived desktop repo `Kyoo032/Nultron-Desktop`. The copy on that repo is `620689f`; this file was updated on 2026-10-14 for the retirement and is not pushed.
- `ent-readme.md` is the README of the Enterprise repo `Kyoo032/Nultron-Releases`. The copy on that repo is `54da47a`; this file was updated on 2026-10-14 for the new repo name and is not pushed yet.

The public name of both products is **Nultron** (Rizky, 2026-09-25). The source repo was `Kyoo032/agentforge` and has been `Kyoo032/Nultron` since 2026-10-15. On 2026-10-14 (Rizky) the Enterprise release repo moved from `Kyoo032/NultronEnt` to `Kyoo032/Nultron`, and the old desktop release repo `Kyoo032/Nultron` moved to `Kyoo032/Nultron-Desktop` and was archived. The old `NultronEnt` URLs redirect to `Kyoo032/Nultron`. Until 2026-10-15 the name `Kyoo032/Nultron` belonged to the Enterprise repo, not the desktop app; on that day the Enterprise release repo was renamed `Kyoo032/Nultron-Releases`, and the source repo `agentforge` took the name `Kyoo032/Nultron`. Notes files for earlier releases keep the name they were published under. Public text may not contain the substring "agent" (see `scripts/release-marks.mjs`).

Neither release repo is ever cloned by hand. The only local checkout is the source repo, and each release repo is written only by its release script.
