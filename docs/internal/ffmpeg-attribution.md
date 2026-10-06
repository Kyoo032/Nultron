# ffmpeg attribution (Edit, Meeting)

The app runs **ffmpeg** and **ffprobe** as separate programs for probe, cut, silence and scene detection, audio extraction, render and colour-match jobs. It does not link against them and does not modify them. Product code: `packages/host/src/edit/ffmpeg*`.

ffmpeg is mandatory (Rizky, 2026-10-06). The product carries it; nobody is asked to install it.

## Where it comes from

| Target | Build | State |
|---|---|---|
| Hosted image (`webapp-deploy/Dockerfile`) | BtbN static build `n8.1.3-9-g29e619e767`, GPL variant, release `autobuild-2026-09-30-13-08`, pinned by sha256 for amd64 and arm64 | In the image since 2026-10-06 |
| Packaged desktop app | Whatever is in `apps/desktop/resources/ffmpeg/` at pack time (`extraResources`, read from `process.resourcesPath/ffmpeg/`) | The folder holds only its README. Still owed |
| Webdev | PATH, the well-known install folders, or `AGENTFORGE_FFMPEG_PATH` / `AGENTFORGE_FFPROBE_PATH` | Unchanged |

The host needs version 6 or newer (`packages/host/src/edit/ffmpeg-setup.ts`). Debian bookworm's package is 5.1, which is why the image does not use it.

## Licence

The build in the image is the **GPL** variant, version 3 or later, because the render recipe encodes with `libx264` (`packages/host/src/edit/ffmpeg/recipes.ts`) and the LGPL variant does not carry that encoder. Audio extraction uses `libmp3lame`.

- The licence text from the build ships in the image at `/usr/local/share/licenses/ffmpeg/LICENSE.txt`.
- Source for that exact build: FFmpeg commit `29e619e767` (tag `n8.1.3` plus 9 commits) at https://git.ffmpeg.org/ffmpeg.git, built with the scripts at https://github.com/BtbN/FFmpeg-Builds at the release tag above.
- An image that only runs on our own servers is not a distribution. An image handed to a customer to run themselves is one: keep the licence file in it and give the customer this page's source pointer.
- A desktop installer that bundles ffmpeg is also a distribution. Ship the licence text beside the binaries, name the build and its source in the release notes, and say that a person may replace the bundled copy with their own (`AGENTFORGE_FFMPEG_PATH`).

## Operator notes

- Doctor: webdev and hosted `GET /api/v1/edit/doctor`; the packaged app writes `editFfmpeg` into `host-status.json`.
- To move the image to a newer build, change the release tag, both file names and both hashes in the Dockerfile together. BtbN keeps month-end releases for about two years (security register SR-135).

Official project: [https://ffmpeg.org](https://ffmpeg.org)
