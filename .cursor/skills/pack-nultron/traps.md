# Pack traps (this Windows desk): retired 2026-10-14

Retired 2026-10-14: the desktop route is no longer run and its repo is archived, so this file is a record of what broke. Lived through 0.14.23, 0.14.25 and 0.14.26 (packed twice). Read when a step fails; do not invent a third environment. Windows pack and mac pack are different routes (different cwd, command, natives, artifacts, proof). A failure on one is not diagnosed with the other.

## Python / natives

electron-builder's `@electron/rebuild` (node-gyp) picks `python3` = Windows Store **3.14**, which has no `distutils`. Pin both:

```
PYTHON=C:\Users\rizky\AppData\Local\Programs\Python\Python312\python.exe
npm_config_python=<same>
```

Do not use the Hermes venv path; it may be gone.

## `ELECTRON_RUN_AS_NODE`

Agent shells inject this. Electron then runs as Node and the pack/launch is nonsense. `Remove-Item Env:ELECTRON_RUN_AS_NODE` in every pack shell. Preflight fails if it is set.

**The launch shell counts too (0.14.26).** Unsetting it for the build and then starting `Nultron.exe` from a shell that still has it set gives a **silent** failure: the exe runs as plain Node, never boots a window, exits without an error line, and `doctor --desktop` finds nothing to talk to. It looks like a broken pack. `Remove-Item Env:ELECTRON_RUN_AS_NODE` before every launch as well as every build, and check `$env:ELECTRON_RUN_AS_NODE` in the shell you are actually launching from.

## Dirty tree vs Docker

`mac-build-docker.mjs` clones **HEAD** of the mounted checkout. Uncommitted product code is not in the `.app`. `make-dmg.py` / `verify-bundle.py` are read from the `/src` mount (working tree), so a dmg-script fix can be tested with `--allow-dirty`, but the app inside the dmg is still HEAD. Commit the version bump before packing.

## Isolated Windows worktree

Pack Windows in `C:\Users\rizky\agentforge-pack-<version>`, not the main checkout (keeps `node_modules` / dist isolated). Do **not** reuse `C:\Users\rizky\agentforge-pack` — that tree is the 0.14.23 `4fc02f4` leftover.

Copy gitignored media from the main checkout after `git worktree add`:

- `apps/desktop/resources/starters` (7 files: 6 mp4 + 1 m4a)
- `apps/desktop/resources/examples/videos` (6 mp4)

`desktop-build` runs `edit-starters.mjs --check` and `video-examples.mjs --check` first.

## NSIS `/S`

`oneClick: false` + `allowToChangeInstallationDirectory: true`. `/S` hangs on a directory UI. Do not wait on it. Packaged proof: launch `apps/desktop/dist/win-unpacked/Nultron.exe`, then `doctor.mjs --desktop`. Human runs `Nultron Setup <v>.exe` for the real install.

## macOS dmg `hfsplus ls`

`make-dmg.py` `parse_hfs_ls_name` must keep **spaced** helper names (`Nultron Helper (GPU).app`) and accept numeric dates (`8/12/2026 12:17`, 7 columns) as well as `Jan 01 1980` (8 columns). Symptom if the parser regresses:

```
ERROR: /Nultron.app: … ['Contents']
ERROR: /Nultron.app/Contents/Frameworks: … ['Nultron Helper (GPU).app', …]
```

(The 0.14.26 log that taught this said `DPSBuddy.app`; the parser rule is the same under the new name.) Doubling the HFS+ volume does **not** fix a parser bug. How-to: `apps/desktop/platform/macos/BUILD-DMG-ON-WINDOWS.md`.

**Days 1 to 9 of a month (0.16.0, 2026-10-06).** libdmg-hfsplus pads a one-digit day with a space and prints the month zero-based: on 6 October a row reads `040755   0   0   0  9/ 6/2026 02:42 Contents`. The old whitespace split took `02:42 Contents` as the name, so a pack made on the 1st to the 9th failed with `/Nultron.app: … ['Contents']` after three doublings; every earlier cut happened to be packed on a day of 10 or more. `parse_hfs_ls_name` now matches the whole row with a regex, the same shape as `HFS_LS_LINE` in `verify-bundle.py`, which already allowed the space.

## Wrong cwd

| You are in | Allowed | If you run the other command |
|---|---|---|
| `C:\Users\rizky\agentforge-pack-<v>` | `desktop:build` (NSIS) | Docker would mount the worktree as `/src` and write mac files next to `win-unpacked` |
| `C:\Users\rizky\agentforge` | `desktop:build:mac:docker` | `desktop:build` pollutes main `node_modules` / `dist` (the 0.14.23 reason for the worktree) |

Python 3.12 is **Windows native rebuild** only. The Linux container does not use that interpreter.

## Mixing proof

| Env | Allowed proof | Not proof |
|---|---|---|
| Windows worktree pack | `latest.yml` sha512, `host.cjs` grep, `doctor --desktop` on unpacked/installed exe | Docker verify-bundle, `:3000` |
| Docker mac pack | container `verify-bundle.py` (app + dmg + zip), `mac-<v>.sha256` | `doctor --desktop` on this PC, claiming the app launched, Cua Fleet, Lume, Docker Desktop GUI |
| Mac hardware (someone else's Mac) | Gatekeeper, Keychain, Cmd+V, Dock, Cmd+Q, `doctor --desktop` on that machine | a green Docker log from this PC |
| WSL + `webapp-deploy` compose | hosted Linux image health | desktop pack, Jakarta CVM |
| webdev `:3000` | product UI while developing | packaged / shipped |

Never run `electron-builder --mac` on this host. Cloud Linux runs neither path.

## Combining dist

Windows artifacts land in the **worktree** `dist/`. Mac artifacts land in the **main checkout** `dist/`. Copy exe + blockmap + `latest.yml` into the main `dist/` before `desktop-release`. Archive other-version Setup exes / mac files or pass `--allow-stale`.

`--require-mac` needs both arches' `.dmg`. `latest-mac.yml` and mac blockmaps are never uploaded.

## Two repos

Source commits stay on `Kyoo032/agentforge`. `pnpm desktop:release` created a GitHub **release** on `Kyoo032/Nultron-Desktop` (binaries + `docs/public/<v>-notes.md`) until that repo was archived on 2026-10-14. The release repo for the web app is now `Kyoo032/Nultron`, and only `scripts/release-web.mjs` writes to it. Do not `git push` source to either repo.

## Repacking the same version

0.14.26 was packed twice (a fix landed after the first pack). A repack of the **same version** from a new sha:

- gets its own fresh worktree, `C:\Users\rizky\agentforge-pack-<version>-<shortsha>` — never reuse the first pack's worktree, and never reuse the bare `agentforge-pack-<version>` name once a second sha exists;
- moves the earlier pack's artifacts out of the way into the main checkout's `apps/desktop/dist/superseded-<oldsha>/` — **both** routes, Windows and mac, so `desktop-release` cannot pick up a stale exe or dmg of the same version number;
- records **both** packs in the changelog's "Pack + publish" line, with each sha and which one shipped. A superseded pack that leaves no trace is indistinguishable from a pack that was never made.

## Git writes during a pack

`git worktree add` is the **only** git write a pack agent may make. No `stash`, `checkout`, `switch`, `restore`, `reset`, `rebase`, no commit, no branch move — the pack reads a sha, it does not move the tree.

A stash or checkout by any agent wipes every other worker's uncommitted edits in the shared checkout. This happened **twice on 2026-09-15** during a multi-worker pass, both times costing hours of unrelated work. If the tree is dirty and the pack needs a clean one, that is what the worktree is for.

## Branch moving mid-pack (0.14.27)

`mac-build-docker.mjs` clones HEAD **when the container starts**, not when the lane checked the sha. A docs-only commit landed on `release/0.14.27` between the mac lane's check (`05e97a5`) and the clone (`22f1f78`); harmless that time, but the recorded sha and the checked sha differed. While a Docker pack is running, nobody commits to the branch being packed. The orchestrator waits for the lane, then writes.

## pnpm hoists platform packages — purge the store, not the links (0.14.27, mac)

`@firecrawl/anydoc` has one optional dependency per platform. On the Linux install inside Docker pnpm fetches the `linux-*` ones, and `asarUnpack` `**/node_modules/@firecrawl/anydoc-*/**` then ships their ELF `.node` files into the Mac app; `verify-bundle` refuses it with `2 non-Mach-O native binaries`. Deleting the sibling symlinks under `.pnpm/@firecrawl+anydoc@<v>/node_modules/@firecrawl/` is **not** enough: pnpm also hoists every package into `node_modules/.pnpm/node_modules/` and keeps the real directory in `node_modules/.pnpm/@firecrawl+anydoc-linux-x64-gnu@<v>/`, and app-builder's `node-dep-tree` walks up into both. `build-mac.sh` now removes the non-darwin store entries and their links once after install, dies if a linux/win32 anydoc `.node` is still reachable, and swaps the pinned darwin package (sha512 from `packages/host/src/components/manifest.ts`) in beside anydoc per arch. Bump the manifest and the script together. It took three packs to learn this; the first two are in `superseded-e2e477e/` and the changelog.

## ffmpeg missing from the installer (found 2026-10-06, fixed in the tree, not yet packed)

Every installer up to 0.16.0 shipped `resources/ffmpeg/` with only its README, so each person got an "install ffmpeg" notice. Now `apps/desktop/scripts/stage-ffmpeg.mjs` fills it from `apps/desktop/scripts/ffmpeg.lock.json` and the pack fails when it cannot. Traps to expect on the first real pack, none yet driven:

- **A cold stage is a 190 MB download** (Windows) or about 120 MB per arch (mac), each hash-checked before it is unpacked. The cache is `vendor/.ffmpeg-cache/` on the host and the `/cache/ffmpeg` volume in the mac container. `--offline` fails fast when the cache is cold.
- **Staging is per target and removes the others.** `desktop:build` stages `win32-x64`; the mac container stages `darwin-<arch>` inside each arch's loop. Never hand-copy a program into the folder: `--verify` (and preflight) reject any file the lock does not name, and `verify-bundle.py` rejects a PE or ELF file in a `.app`.
- **A Windows exe in the worktree is not in `git`.** The folder is gitignored apart from its README, so the pack worktree stages its own copy; copying the main checkout's folder across is allowed only if `--verify` passes there.
- **rcodesign may rewrite the mac programs.** The bundle is hash-checked before signing; after signing only "executable" is required and the log says whether the bytes changed. If a Mac refuses to start a bundled program, check that line first.
- **Windows Defender or SmartScreen may quarantine a 165 MB unsigned `ffmpeg.exe`** on first run. The host then reports the bundled copy as `exec_failed` and the app tells the person to reinstall; it does not fall back to a PATH copy. Look at Defender's history before blaming the pack.
- **The installer is much larger.** Check `Nultron Setup <v>.exe` against the previous size and say so in the pack record.
- **Release notes must carry the GPL source line** (`docs/internal/ffmpeg-attribution.md`). `release-desktop.mjs` does not check for it.

## First Nultron pack (2026-09-29, not yet packed)

The rename changed every artifact name. Three things to watch on the first pack, none proven yet:

- `apps/desktop/dist/` still holds `DPSBuddy Setup 0.15.1.exe`, `DPSBuddy-0.15.1-mac-<arch>.*` and a `win-unpacked/` with `DPSBuddy.exe`. `release-desktop.mjs` counts every `*Setup*.exe` in `dist/` (`SETUP_EXE`), so the old exe beside the new one fails its "more than one Setup exe" gate unless it is archived or `--allow-stale` is passed; preflight lists the old files as stale once the version moves. Archive them into `published-0.15.1/` first.
- Same `appId`, new `productName`. `apps/desktop/build/installer.nsh` assumes Nultron installs over an existing DPSBuddy as an upgrade and kills a running `DPSBuddy.exe` first, but nobody has driven it: in-place replace or a second install, the Start menu shortcut and the install directory are all unconfirmed. Drive it on Windows before shipping and record the result here.
- No data migration by decision. A DPSBuddy user who updates starts on a fresh desk under `%APPDATA%\Nultron` with a new `Nultron` / `wrap-key` credential; an upgrade leaves the old `%APPDATA%\DPSBuddy` folder and `DPSBuddy` / `wrap-key` credential behind, and only a real uninstall of Nultron removes them (`installer.nsh`, `customUnInstall`). Check that on the installed app, not on `win-unpacked`.
