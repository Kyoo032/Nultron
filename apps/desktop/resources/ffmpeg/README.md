# Bundled ffmpeg

Packaged Nultron carries its own `ffmpeg` and `ffprobe`. Nobody installs them. `extraResources` (`apps/desktop/package.json`) copies this folder to `resources/ffmpeg/` in the installer, and the host reads it first (`packages/host/src/edit/ffmpeg-binary.ts`, `process.resourcesPath/ffmpeg/`). A copy on PATH never replaces it; only an explicit `AGENTFORGE_FFMPEG_PATH` does. Webdev and dev builds still find ffmpeg on PATH or through that variable.

Only this README is tracked. The programs, `LICENSE.txt` and `MANIFEST.json` are staged by a script and gitignored.

## Staging

```
node apps/desktop/scripts/stage-ffmpeg.mjs --target win32-x64
node apps/desktop/scripts/stage-ffmpeg.mjs --target darwin-arm64
node apps/desktop/scripts/stage-ffmpeg.mjs --target darwin-x64
node apps/desktop/scripts/stage-ffmpeg.mjs --verify            # re-hash what is staged against the lock, no network
```

`pnpm desktop:build` (and `desktop-build-all`, `desktop-pack`, `desktop-build-dir`) stage `win32-x64` before electron-builder runs and stop if the check fails. The macOS Docker route (`platform/macos/docker/build-mac.sh`) stages `darwin-<arch>` inside each arch's loop and verifies the finished `.app`. Staging a target removes the other targets' files first, so the Windows programs never travel in a mac bundle. The on-Mac scripts (`desktop-build-mac*`) and Linux do not stage; use the Docker route.

Everything that is downloaded is named in `apps/desktop/scripts/ffmpeg.lock.json` and nowhere else: https URL, byte size and sha256 of each archive, and of each file taken out of it. The script refuses a hash or size mismatch before unpacking, refuses an archive with any member whose path would leave the folder, and takes no URL or hash from an argument or the environment. Downloads are cached in `vendor/.ffmpeg-cache/` (gitignored); `--offline` never touches the network.

| Target | Build | Publisher |
|---|---|---|
| `win32-x64` | BtbN `n8.1.3-9-g29e619e767`, GPL variant | github.com/BtbN/FFmpeg-Builds, release `autobuild-2026-09-30-13-08` |
| `darwin-arm64`, `darwin-x64` | FFmpeg 9.0.2, GPL, `libx264` and `libmp3lame` | ffmpeg.martin-riedl.de (build script git.martin-riedl.de/ffmpeg/build-script) |

## What is in the folder after staging

- `ffmpeg(.exe)` and `ffprobe(.exe)`: the programs. On macOS they are single-arch Mach-O files and must match the arch being built.
- `LICENSE.txt`: the GPL v3 text, shipped beside the binaries.
- `MANIFEST.json`: generated; target, version, source URLs and the sha256 of each file.

To move to a newer build, change the URLs, sizes and hashes in the lock together, re-stage, and update `docs/internal/ffmpeg-attribution.md`. Licence duties and source pointers are there too.
