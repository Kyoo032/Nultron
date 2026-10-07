# ffmpeg attribution (Edit, Meeting)

The app runs **ffmpeg** and **ffprobe** as separate programs for probe, cut, silence and scene detection, audio extraction, render and colour-match jobs. It does not link against them and does not modify them. Product code: `packages/host/src/edit/ffmpeg*`.

ffmpeg is mandatory (Rizky, 2026-10-06). The product carries it; nobody is asked to install it.

## Where it comes from

| Target | Build | State |
|---|---|---|
| Hosted image (`webapp-deploy/Dockerfile`) | BtbN static build `n8.1.3-9-g29e619e767`, GPL variant, release `autobuild-2026-09-30-13-08`, pinned by sha256 for amd64 and arm64 | In the image since 2026-10-06 |
| Packaged Windows app (x64) | The same BtbN build, `win64-gpl` zip, pinned in `apps/desktop/scripts/ffmpeg.lock.json` and staged into `apps/desktop/resources/ffmpeg/` by `stage-ffmpeg.mjs` before electron-builder runs | In the tree; not packed |
| Packaged macOS app (arm64, x64) | FFmpeg 9.0.2 static GPL builds from Martin Riedl's build server, one archive each for `ffmpeg` and `ffprobe` per arch, pinned in the same lock and staged per arch in the Docker mac route | In the tree; not packed, not launched on a Mac. Accepted by Rizky for the preview Mac installer only (2026-10-06); see "macOS source" below |
| Webdev | PATH, the well-known install folders, or `AGENTFORGE_FFMPEG_PATH` / `AGENTFORGE_FFPROBE_PATH` | Unchanged |

The host needs version 6 or newer (`packages/host/src/edit/ffmpeg-setup.ts`). Debian bookworm's package is 5.1, which is why the image does not use it. In the packaged app the bundled copy is read before PATH; only an explicit `AGENTFORGE_FFMPEG_PATH` outranks it.

## macOS source: accepted for the preview installer only (Rizky, 2026-10-06)

The macOS builds come from Martin Riedl's build server, a one-person host that ffmpeg.org does not link. Rizky decided on 2026-10-06 to accept that source for now and to keep both `darwin-*` entries in `apps/desktop/scripts/ffmpeg.lock.json`. His reason: the Mac app is still labelled preview, and nobody has opened it on a Mac yet.

- **Scope.** The preview Mac installer, and nothing else. It is not an acceptance of the publisher for a Mac release that is no longer preview.
- **What the pin proves.** The file we stage is the file we pinned: size and sha256 are checked before anything is unpacked or cached, and `stage-ffmpeg.mjs --verify` re-hashes the staged folder against the lock. It does not prove who built the file or what went into it. The publisher's own `.sha256` files come from the same host as the zips, so they show the download is intact, not who made it.
- **What it does not cover.** We have not audited the build or its libraries. The publisher's page and open build script say what went in; we only check that it is the same bytes every time. Nothing sandboxes the programs beyond what macOS gives any child of the app.
- **When the acceptance ends.** Either of two things: the Mac app leaves preview, or the publisher's build behind a pinned URL changes (staging fails the hash check). After either, a Mac installer carries only builds we made and pinned ourselves.
- **Follow-up, owed before the Mac app leaves preview.** A committed build script that builds FFmpeg from source on Rizky's Mac; the output pinned in the lock with our own hashes; the same FFmpeg version on Mac and Windows (today Windows is `n8.1.3-9-g29e619e767` and macOS is 9.0.2).
- **Unknown.** The programs have never run on a Mac. A helper program that carries the quarantine flag inside an app that is not notarised may be refused by macOS on first run. The app would then report its bundled ffmpeg as unable to start and say "Reinstall", and reinstalling would not fix that. The first Mac smoke has to cover it (Gatekeeper, Keychain, Cmd+V, Cmd+Q, Dock reopen, and an Edit import).

## Licence

Every build above is the **GPL** variant, version 3 or later, because the render recipe encodes with `libx264` (`packages/host/src/edit/ffmpeg/recipes.ts`) and the LGPL variant does not carry that encoder. Audio extraction uses `libmp3lame`. The macOS builds were configured with `--enable-gpl --enable-version3` (read from the configuration string inside each binary).

- The image ships the licence text at `/usr/local/share/licenses/ffmpeg/LICENSE.txt`.
- Each installer ships `LICENSE.txt` beside the programs, in `resources/ffmpeg/` (Windows) and `Contents/Resources/ffmpeg/` (macOS). It is the GPL v3 text: byte for byte the `LICENSE.txt` in the BtbN archive and `COPYING.GPLv3` at FFmpeg tag `n9.0.2` (sha256 `8ceb4b9e...b903`; the lock pins the full hash).
- Source for the Windows and image build: FFmpeg commit `29e619e767` (tag `n8.1.3` plus 9 commits) at https://git.ffmpeg.org/ffmpeg.git, built with the scripts at https://github.com/BtbN/FFmpeg-Builds at the release tag `autobuild-2026-09-30-13-08`.
- Source for the macOS builds: FFmpeg tag `n9.0.2` at https://git.ffmpeg.org/ffmpeg.git, plus the libraries the publisher lists (x264, x265, LAME and others), built with the open-source script at https://git.martin-riedl.de/ffmpeg/build-script. The publisher's page names each library and version: https://ffmpeg.martin-riedl.de/.
- An image that only runs on our own servers is not a distribution. An image handed to a customer to run themselves is one: keep the licence file in it and give the customer this page's source pointers.
- **A desktop installer that bundles ffmpeg is a distribution.** Duties for each public release of the Personal app:
  1. The licence text ships beside the programs (the staging script puts it there and the pack fails without it).
  2. The release notes (`docs/public/<version>-notes.md`) name the bundled build and where its source is. Suggested wording: "Includes FFmpeg, licensed under the GPL v3: build n8.1.3-9-g29e619e767 on Windows and 9.0.2 on macOS. Source: https://git.ffmpeg.org/ffmpeg.git. Build scripts: https://github.com/BtbN/FFmpeg-Builds and https://git.martin-riedl.de/ffmpeg/build-script." Link only to the public locations above, never to `docs/internal`. Do not name the `AGENTFORGE_FFMPEG_PATH` variable in public text: `scripts/release-marks.mjs` refuses any text containing "agent", and `AGENTFORGE` contains it.
  3. A person may replace the bundled copy with their own: set `AGENTFORGE_FFMPEG_PATH` (and `AGENTFORGE_FFPROBE_PATH`) and restart the app.
  4. The programs are not modified and are not linked into Nultron; they run as separate processes. The rest of the app is not GPL because of that.

## Operator notes

- Doctor: webdev and hosted `GET /api/v1/edit/doctor`; the packaged app writes `editFfmpeg` into `host-status.json`. In the packaged app a failing bundled copy reports `setup.bundled: true` and every screen says "reinstall" (see the Edit recipe, `.cursor/skills/verify-agentforge/features/edit.md`).
- Input limits: `runFfmpeg` adds `-protocol_whitelist file,crypto,data` to every ffmpeg and ffprobe run, a playlist or script is refused at the probe, and hosted runs have timeout caps (`packages/host/src/edit/ffmpeg/input-safety.ts`; security register SR-135). A new ffmpeg build must pass `ffmpeg-input-safety-real.test.ts` (it runs against the staged programs or `AGENTFORGE_FFMPEG_PATH`) before it is pinned.
- To move the image to a newer build, change the release tag, both file names and both hashes in the Dockerfile together. BtbN keeps month-end releases for about two years (security register SR-135).
- To move the desktop bundle, change the URL, byte size and sha256 of each source, and of each member taken out of it, in `apps/desktop/scripts/ffmpeg.lock.json`, then stage and run the Edit recipe. Two publisher limits to know: BtbN prunes old month-end releases after about two years, and Martin Riedl's page says macOS Intel release builds stop in January 2027 (so a newer Intel pin will not exist after that; the pinned URL is versioned and should keep working, which has not been checked past today). The macOS binaries are built for macOS 12 or newer (`LC_BUILD_VERSION` minos 12.0), one major above Electron 35's own floor of 11, so on macOS 11 the bundled copy will not start and the app shows the reinstall notice.
- The Windows programs are about 165 MB each. The installer grows by roughly that much before compression.

Official project: [https://ffmpeg.org](https://ffmpeg.org)
