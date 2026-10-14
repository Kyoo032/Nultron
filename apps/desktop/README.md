# Nultron desktop

> **Retired (Rizky, 2026-10-14).** The desktop app (Personal) is being merged into the web app. Its release repo, `Kyoo032/Nultron-Desktop`, is archived and takes no new releases. Do not pack or publish a new desktop cut. The code in this folder stays in the tree, and nothing here is removed by the retirement.
> **Enterprise** is the hosted multi-user web app. Its release repo is `Kyoo032/Nultron`.
> Decision record: [`web-pivot-2026-09-18.md`](../../docs/internal/web-pivot-2026-09-18.md).

Operator / agent only. The desktop installers were published from [`Kyoo032/Nultron-Desktop`](https://github.com/Kyoo032/Nultron-Desktop/releases), not from this file. That repo is archived.

Electron **is** the packaged product. The main process owns SQLite, secrets, and media. The renderer talks over IPC. There is **no** bundled Next.js child, **no** loopback HTTP server, and **no** `app-url.txt`.

| Mode | Command / install | Transport | Data |
|---|---|---|---|
| Local webdev | `pnpm dev` or `pnpm desktop:dev` | HTTP `127.0.0.1:3000` | repo `data/` |
| Packaged app | NSIS / dmg / AppImage | IPC (`window.agentforge`) | Electron `userData` |

`pnpm desktop:dev` loads webdev `:3000` **without** preload (fetch, not IPC). That is not packaged proof.

There is no mobile Electron/Capacitor/RN target. See [`docs/mobile.md`](../../docs/mobile.md) and [`apps/mobile/AGENTS.md`](../mobile/AGENTS.md).

**Per-OS rules:** [`platform/README.md`](platform/README.md) (matrix), [`platform/windows/AGENTS.md`](platform/windows/AGENTS.md), [`platform/macos/AGENTS.md`](platform/macos/AGENTS.md). Read the folder for every OS a `main.cjs` change touches.

## userData (`host-status.json`, SQLite, `settings.enc`)

`app.setName(productName)` + flavor `brand.json` (`userData` is `%APPDATA%\<productName>`). Git tracks **Nultron** only (`%APPDATA%\Nultron`, legacy `%APPDATA%\@agentforge\desktop`). Other Windows flavors are local/gitignored. The product was DPSBuddy until 2026-09-29; Nultron starts on a fresh desk and does not migrate `%APPDATA%\DPSBuddy`.

Packaged launch writes `host-status.json` there (`transport: "ipc"`). Doctor `--desktop` reads that file and **fails** if it is missing. It does **not** GET `:3000`.

## Dev (webdev window)

From repo root:

```
pnpm install
pnpm dev          # Vite + Express on 127.0.0.1:3000
pnpm desktop:dev  # optional Electron frame around that URL
```

Schema is created in-process on first SQLite open (`ensureSchema` / committed drizzle migrations). Paste a Toko Token gateway key in Settings. No login.

## Windows installer (the product)

```
pnpm desktop:build
# default public flavor: AGENTFORGE_BRAND=agentforge pnpm --filter @agentforge/desktop desktop-pack
```

Builds the Vite renderer, esbuild-bundles `host.cjs` (externals: `better-sqlite3`, `keytar`), copies drizzle migrations, then packages Electron. Output: `apps/desktop/dist/` (NSIS, current user). Git has `branding/agentforge/` (Toko Token, `appId` `com.tokotoken.agentforge`). Extra local flavors under `branding/` are gitignored and must not be committed or uploaded.

In-app rail name and logo come from extraResources `brand/brand.json` + `brand/logo.png` via preload (`window.agentforge.brand`). Changing splash/exe names alone is not enough.

Native modules must be rebuilt for Electron’s Node **on Windows**:

```
cd apps/desktop
npx @electron/rebuild -f -w better-sqlite3 -w keytar
```

Do **not** run `pnpm desktop:build` or `@electron/rebuild` on Cloud Linux.

A fresh install does **not** need Node or pnpm on PATH. On first run:

1. Wrap key in Windows Credential Manager (`Nultron` / `wrap-key`) via keytar.
2. SQLite, `settings.enc`, and `host-status.json` under Electron `userData`.
3. If no gateway key is saved, onboarding (endpoint locked to Toko Token + API key, or “Use offline demo”).
4. Window close (`X`) exits `Nultron.exe`. Threads and the saved key stay.

Window close (`X`) calls `app.exit(0)` so `Nultron.exe` and Chromium helpers die. Threads and the saved key stay.

Running `Nultron Setup *.exe` again **replaces** the existing install: it taskkills `Nultron.exe` (and a legacy `DPSBuddy.exe` / `Agentforge.exe`), overwrites the app files, and keeps `%APPDATA%\Nultron`. Uninstall (not upgrade) kills the process, deletes that folder, and removes Credential Manager `Nultron` / `wrap-key`, along with the legacy `DPSBuddy` and `Agentforge` folders and keychain items. Reinstall after uninstall shows onboarding again.

Doctor the packaged app with:

```
node .cursor/skills/verify-agentforge/scripts/doctor.mjs --desktop
```

Never commit `.env`, `data/settings.enc`, or `data/.master-key`.

## In-app updates (Nultron only)

A packaged build from this tree checks [GitHub Releases](https://github.com/Kyoo032/Nultron-Desktop/releases) in `Kyoo032/Nultron-Desktop` (the repo `brand.json` names) from Settings → **Check for updates**. That repo is archived and gets no new releases. Copies installed from 0.15.1 check `Kyoo032/Nultron` instead, which now belongs to the Enterprise repo, so their check fails with an error (2026-10-14). Kemenkeu / Metranet builds do not get this button. The source repo (`Kyoo032/agentforge`) stays private: electron-updater's GitHub provider is unauthenticated, so release assets have to live somewhere public.

The update target is written in two places that must agree: `branding/agentforge/brand.json` `updates` (read by `scripts/pack-brand.mjs`, which is what `pnpm desktop:build` runs) and `package.json` `build.publish` (used by the plain `electron-builder --dir/--mac/--linux` scripts). `pnpm desktop:release` refuses to run when they differ. The version comes from `package.json` `version` only.

Cut a release:

```
pnpm desktop:build
pnpm desktop:release          # --dry-run prints the gh command and uploads nothing; --draft, --notes <file>
```

`electron-builder` writes `latest.yml` next to the Setup exe when the Nultron flavor is packed. The local files keep the spaced `artifactName` (`Nultron Setup <version>.exe`), but `latest.yml` and the GitHub assets use the hyphenated form (`Nultron-Setup-<version>.exe`). That is electron-builder's rule for GitHub and the updater re-hyphenates anyway, so never rewrite `latest.yml`. `desktop:release` checks version, size and sha512 against `latest.yml`, refuses a dirty tree or a `dist/` holding stale Setup exes (`--allow-dirty`, `--allow-stale`), then runs `gh release create v<version>` uploading the exe, its blockmap and `latest.yml` under the hyphenated names. Flavor exes (Kemenkeu / Metranet) must never be attached to the public repo.

## macOS and Linux packages (operator builds on that OS)

```
pnpm desktop:build:mac
pnpm desktop:build:mac:dir
pnpm desktop:mac
pnpm desktop:build:linux
```

`desktop:build:mac:dir` writes an unpacked `.app` (same idea as `win-unpacked`). `pnpm desktop:mac` launches it with CDP `9222`. Both require **macOS**. This Windows checkout cannot run Apple’s Simulator or a `.app` — use WinApp F5 here. iOS Simulator / Expo stay parked.

The mac scripts run `pack-brand.mjs --restore-public` before electron-builder, so the splash, `resources/brand/brand.json`, `build/icon.png` (1024²) and `build/icon.icns` (`build.mac.icon`) are always the public Nultron flavor. Output: `Nultron-<version>-mac-x64.dmg|zip` and `-arm64`. Native modules are rebuilt per arch by electron-builder; bundled ffmpeg goes in `resources/ffmpeg/` per [`resources/ffmpeg/README.md`](resources/ffmpeg/README.md).

**No Mac?** `pnpm desktop:build:mac:docker` builds the same four files on this Windows box inside a Linux container (Docker Desktop must be running): electron-builder packs the `.app` on Linux, `rcodesign` ad-hoc signs it, libdmg-hfsplus writes the dmg, and `verify-bundle.py` checks arch, natives, symlinks, plist, asar and signatures before anything lands in `dist/`. Details and limits in [`platform/macos/AGENTS.md`](platform/macos/AGENTS.md). First run builds the image (a few minutes); later runs reuse the cache volume.

Unsigned is fine. Notarization is not done, so in-app updates are off on macOS (the Updates panel says so) and first launch needs the Gatekeeper step from the public notes. To ship: with the four files in `apps/desktop/dist/`, `pnpm desktop:release` attaches them next to the exe (`--require-mac` to insist on both arches; `--attach-mac` for an already-published release; `latest-mac.yml` is never uploaded). Mac artifacts are labelled preview until the smoke list in [`platform/macos/AGENTS.md`](platform/macos/AGENTS.md) passes on hardware.

## Move log

Desktop shell changes are recorded in [`docs/internal/moves.md`](../../docs/internal/moves.md).
