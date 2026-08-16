# Development guide

[中文](development.zh.md)

This document collects the developer-facing content moved out of the README: running from source, development and verification, releasing, and project status. For installation, usage, and connection behavior see the [README](../README_EN.md); for the process model, trust boundary, and design decisions see [Desktop client architecture](desktop-client-architecture.md).

## Run from source

Source development requires Node.js `^22.19.0 || >=24.0.0` and [pnpm](https://pnpm.io/). A separate `dsh` installation is not required.

```sh
git clone https://github.com/bruc3van/dsh-desktop.git
cd dsh-desktop
pnpm install
pnpm run dev
```

On launch, **Smart mode** picks a runtime in this order:

1. It checks `http://127.0.0.1:3080`. If an official Web UI is already running there, the desktop client connects to it. The browser and desktop app then share one live Harness process. A `port` set in `~/.dsh/profiles/web/cordis.patch.yml` is probed as well; an instance started with `dsh web --port <port>` leaves nothing outside its command line to find, so point the client at it from connection settings instead.
2. If nothing answers, it looks for a `dsh` you already installed on PATH (a working `dsh --version` is the whole test).
3. Then it looks for a copy npx has already cached. **The official instruction, `npx @deepseek-ai/dsh web`, installs nothing onto PATH** — it leaves the complete package in npm's cache (`~/.npm/_npx/` on POSIX, `%LOCALAPPDATA%\npm-cache\_npx\` on Windows). Running it once is enough for the client to reuse it.
4. Only if none of those exist does it use the pinned official runtime bundled in the installer or project dependencies.

Steps 2 and 3 run on **your own Node** and use only packages that are **already present** — nothing is downloaded, and Node.js is never installed for you; an empty cache is simply skipped. The client reads the cached package's `package.json` to confirm it really is `@deepseek-ai/dsh` and to report its true version, so nothing else sitting at that path can be launched by mistake. The npx cache never updates itself: when the cached version is older than the bundled runtime the client still prefers your cache, but says so in the connection settings — re-running `npx @deepseek-ai/dsh web` once refreshes the cache to the latest release.

What gets started is always a plain background service (`dsh web --port 0`) — not a browser window, and never on port 3080 — and the client shuts it down when you quit. If the chosen runtime fails to start, the client falls back to the bundled one automatically. Connection settings show which runtime is in use (installed / npx cache / bundled) and its version. The bundled safe marketplace is seated only for the bundled closure (reusing a running instance, a user-installed dsh, or a pinned address withdraws it); to try it from a source run, pin resolution to that closure with `DSH_DESKTOP_SKIP_INSTALLED_DSH=1` — see [Development and verification](#development-and-verification) and the README's [bundled safe marketplace](../README_EN.md#the-bundled-safe-marketplace) section.

If the bundled runtime cannot start, or you want to use another instance, open the application menu and choose **Web UI Connection…**.

## Development and verification

```sh
pnpm run build          # build the Electron main process and preload
pnpm run prepare:runtime # prepare the bundled dsh runtime closure
pnpm run check:picker   # verify the bundled Win32 picker compatibility patch
pnpm run check:runtime-env # verify the Agent environment does not inherit Electron's Node-mode variable
pnpm run check:bundled-plugin # verify the in-box market seat / withdraw contract
pnpm run check:runtime-lock # verify the runtime lock and update-install ordering
pnpm run dist           # build packages for the current platform
pnpm run typecheck      # TypeScript validation
pnpm run lint           # source and script linting
pnpm run check:updater  # verify in-app update check, hash, and dismiss
pnpm run audit          # boot and browser-surface smoke test
pnpm run smoke:package  # prove the packaged app uses its bundled dsh runtime
pnpm run shot           # refresh screenshots in shots/
pnpm run shot:readme    # refresh the privacy-safe README screenshots
pnpm run e2e            # send a real prompt and verify the streamed response
```

In addition, `scripts/` contains a family of regression checks for connection and runtime behavior: `check:connection` (mode switching), `check:installed-runtime` (installed runtime), `check:runtime-resolution` (runtime resolution), `check:bundled-plugin` (in-box market seat / withdraw), `check:runtime-lock` (runtime lock and update ordering), `check:auto-fallback` (loss-of-instance fallback), and `check:error-surface` (error UI).

`pnpm run e2e` needs a valid API key. The production window loads the official Web UI; this repository does not maintain a second product renderer. `pnpm run check:updater` drives a local update-feed fixture through check, hash verification, and dismiss.

### The bundled safe marketplace (development)

- The market's version is pinned by the `dsh-desktop-safe-market` tarball dependency in `dsh-runtime/package.json`; it shares the release closure with the official runtime and ships in the installer, so bumping that dependency is how the client's bundled market is upgraded.
- The client seats the market only when it resolves its own bundled closure (`source: 'bundled'`): one `dsh.profile.bundles` entry plus a symlink into the closure. Reusing a running instance, a user-installed dsh, or a pinned address withdraws the seat; the add / already-present / user-owned / stale-overlay-lifted / withdraw / abandon / foreign-directory / missing-plugin / no-profile / upgrade-retargets-the-link contracts are pinned by `check:bundled-plugin`.
- To pin a source run to the closure and try the market: `DSH_DESKTOP_SKIP_INSTALLED_DSH=1 pnpm run dev` (skips installed-dsh detection).
- The market's catalog pipeline (daily collection plus manual curation), the review-before-install prompt, and its security boundaries live in the market's repository; the seat implementation is `src/main/bundled-plugin.ts`.

## Releasing a version

To release a version, push its tag directly. GitHub Actions treats the tag as the single version source and writes it to `package.json` during the build:

```sh
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions validates the tag format, uses the tag as the release version, then builds:

- macOS Apple Silicon: DMG;
- macOS Intel: DMG;
- Windows x64: NSIS installer.

Linux packages are temporarily outside the automated release scope; the source-level cross-platform compatibility code remains in place.

After every platform succeeds, the workflow generates SHA-256 checksums and `latest.json` for the in-app updater, then creates or updates the matching GitHub Release. Tags containing prerelease identifiers such as `-rc` or `-beta` are marked as prereleases automatically and do not become the `/releases/latest` update feed.

## Project status

The desktop shell, Smart/Pinned address modes, shared `DSH_HOME`, tray behavior, runtime supervision, in-app updates, bundled official `@deepseek-ai/dsh`, the bundled safe marketplace (review-before-install, shipped in the installer), macOS/Windows packaging, and tag-based release automation are implemented; a runtime lock with legacy-process adoption keeps a second harness from writing one `DSH_HOME`, and Smart mode also probes ports configured in the profile's patch layer. The release workflow launches each packaged app with an empty PATH and probes its Web UI, preventing artifacts that accidentally omit the bundled runtime. Automated artifacts are still unsigned; macOS/Windows signing and notarization remain prerequisites for a warning-free general-user installation. Notifications, OS keychain integration, and voice input are also future work — see [TODO](../TODO.md).

Contributions and issue reports are welcome, especially around Windows behavior, Pinned address connections, and packaging.
