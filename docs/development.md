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

1. It checks `http://127.0.0.1:3080`. If an official Web UI is already running there, the desktop client connects to it. The browser and desktop app then share one live Harness process. A `port` set in `~/.dsh/profiles/web/cordis.patch.yml`, or a local bind pinned in Connection settings, is probed as well; an instance started with `dsh web --port <port>` that left nothing outside its command line to find still needs its address typed in Connection settings.
2. If nothing answers, it looks for a `dsh` you already installed on PATH (a working `dsh --version` is the whole test).
3. Then it looks for a copy npx has already cached. **The official instruction, `npx @deepseek-ai/dsh web`, installs nothing onto PATH** — it leaves the complete package in npm's cache (`~/.npm/_npx/` on POSIX, `%LOCALAPPDATA%\npm-cache\_npx\` on Windows). Running it once is enough for the client to reuse it.
4. Only if none of those exist does it use the pinned official runtime bundled in the installer or project dependencies.

Each of those four sources can be turned off independently in Connection settings (toggle buttons), which is how a test run pins itself to one of them. All four are on by default; at least one must stay on. Disabled sources are skipped; the remaining order does not change. Turning off “Already running” only stops this client from connecting to one: the client never terminates a process it did not start. Installed / npx / bundled are started by this client, so turning those off stops the current child. While a user-started official instance is still answering, any settings change that would spawn another writer is refused (turning reuse off, switching among those three while reuse is off, or switching back to Smart without reuse) — otherwise the window would land on the occupancy surface with no way to stop that process. `DSH_DESKTOP_SKIP_PROBE=1` skips this occupancy check as well as the reuse connection. `DSH_DESKTOP_SKIP_INSTALLED_DSH=1` still applies only in development, and skips PATH and npx detection.

Steps 2 and 3 run on **your own Node** and use only packages that are **already present** — nothing is downloaded, and Node.js is never installed for you; an empty cache is simply skipped. The client reads the cached package's `package.json` to confirm it really is `@deepseek-ai/dsh` and to report its true version, so nothing else sitting at that path can be launched by mistake. The npx cache never updates itself: when the cached version is older than the bundled runtime the client still prefers your cache, but says so in the connection settings — re-running `npx @deepseek-ai/dsh web` once refreshes the cache to the latest release.

What gets started is always a plain background service (default `dsh web --port 0`, or a port pinned in Connection settings) — rc.8 and newer get `--no-open`, so not a browser window, and never on port 3080 unless you pin it — and the client shuts it down when you quit. If the chosen runtime fails to start, the client walks the remaining enabled sources (the bundled runtime last, when it is still enabled). A pinned port that is already taken is not replaced, and the source ladder is not walked against the same dead bind. Connection settings show which runtime is in use (installed / npx cache / bundled) and its version. The bundled safe marketplace is seated into whichever runtime the client starts (a reused instance and a pinned address are the exceptions — the client does not start those); see [Development and verification](#development-and-verification) and the README's [bundled safe marketplace](../README_EN.md#the-bundled-safe-marketplace) section.

If the bundled runtime cannot start, or you want to use another instance, open **Settings → Desktop settings**. If the page cannot load at all, the startup surface offers **Web UI connection…**.

## Development and verification

```sh
pnpm run build          # build the Electron main process and preload
pnpm run prepare:runtime # prepare the bundled dsh runtime closure
pnpm run check:picker   # verify the bundled Win32 picker compatibility patch
pnpm run check:runtime-env # verify the Agent environment does not inherit Electron's Node-mode variable
pnpm run check:bundled-plugin # verify the market seat / withdraw / version-gate contract
pnpm run check:local-web-port # verify the local-bind port and --no-open spawn args
pnpm run check:runtime-lock # verify the runtime lock and update-install ordering
pnpm run check:restart  # verify who the tray Restart may stop
pnpm run dist           # build packages for the current platform
pnpm run typecheck      # TypeScript validation
pnpm run lint           # source and script linting
pnpm run check:updater  # verify in-app update check, hash, and dismiss
pnpm run audit          # boot and browser-surface smoke test
pnpm run smoke:package  # prove the packaged app uses its bundled dsh runtime
pnpm run smoke:dmg      # mount the macOS DMG, copy the .app out, and smoke that copy
pnpm run shot           # refresh screenshots in shots/
pnpm run shot:readme    # refresh the privacy-safe README screenshots
pnpm run e2e            # send a real prompt and verify the streamed response
```

In addition, `scripts/` contains a family of regression checks for connection and runtime behavior: `check:connection` (mode switching), `check:installed-runtime` (installed runtime), `check:runtime-resolution` (runtime resolution), `check:smart-runtimes` (Smart-mode source toggles), `check:local-web-port` (local-bind port), `check:bundled-plugin` (in-box market seat / withdraw), `check:runtime-lock` (runtime lock and update ordering), `check:restart` (who the tray Restart may stop), `check:auto-fallback` (occupancy refusal when reuse is turned off or managed sources would spawn beside a live instance, then loss-of-instance fallback), and `check:error-surface` (error UI).

`pnpm run e2e` needs a valid API key (export `DEEPSEEK_API_KEY=…`, or add one once via 设置 → 凭据). Without one it exits with code 2 on purpose: a skipped live round trip must not look green. It also runs against a throwaway `DSH_HOME`, so it never touches your real sessions. The production window loads the official Web UI; this repository does not maintain a second product renderer. `pnpm run check:updater` drives a local update-feed fixture through check, hash verification, and dismiss.

### The bundled safe marketplace (development)

- The market's version is pinned by the exact `dsh-desktop-safe-market` npm dependency in `dsh-runtime/package.json`; it shares the release closure with the official runtime and ships in the installer, so bumping that dependency is how the client's bundled market is upgraded. The package is published from a tagged upstream release with npm provenance; because a release-day version is younger than pnpm's minimum release age, each bump also adds that exact version to `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` — one version at a time, never a wildcard.
- The client seats the market into every runtime it **starts** — the bundled one, a `dsh` on PATH, an npx-cached one alike: the plugin is **copied** into `<DSH_HOME>/profiles/node_modules` and its name goes into the profile's `dsh.profile.bundles`. Copying rather than linking is what makes that work across runtimes — Node resolves from the realpath, so a link sent the plugin's `@deepseek-ai/*` imports back into the client's closure and handed the serving runtime a second copy of the Service classes. The copy carries a `.dsh-desktop-seat.json` ownership marker; a link left by an older client is replaced by a copy.
- The gate is a version check (`runtimeRefusal()`): the plugin is built against the dsh this client ships, so an older runtime — which may not export what it imports — is refused, a newer one is allowed, and an unreadable version is refused rather than guessed. A reused instance or a pinned address still releases the seat, because the client does not control their boot. The add / already-present / user-owned / stale-overlay-lifted / withdraw / abandon / foreign-directory / missing-plugin / no-profile / upgrade-re-copies / older-client-link-replaced / version-gate contracts are pinned by `check:bundled-plugin`.
- There are two removal paths, covering different moments: the seating switch in the client's connection settings (turning it off withdraws the entry and deletes the copy, and the choice is durable in `~/.bruc3van-dsh-desktop/settings.json` — the seat is re-offered on every start, so an unrecorded removal would undo itself); and the market's own installed panel, which lists a seat carrying `.dsh-desktop-seat.json` and can uninstall it — the only door left once the client is gone.
- To pin a source run to the bundled closure rather than your own dsh: `DSH_DESKTOP_SKIP_INSTALLED_DSH=1 pnpm run dev`. The market itself no longer needs that switch.
- The market's catalog pipeline (daily collection plus manual curation), the review-before-install prompt, and its security boundaries live in the market's repository; the seat implementation is `src/main/bundled-plugin.ts`.

## Releasing a version

To release a version, push its tag directly. GitHub Actions treats the tag as the single version source and writes it to `package.json` during the build:

```sh
git tag v0.4.0
git push origin v0.4.0
```

GitHub Actions validates the tag format, uses the tag as the release version, then builds:

- macOS Apple Silicon: DMG;
- macOS Intel: DMG;
- Windows x64: NSIS installer.

Linux packages are temporarily outside the automated release scope; the source-level cross-platform compatibility code remains in place.

After every platform succeeds, the workflow generates SHA-256 checksums and `latest.json` for the in-app updater, then creates or updates the matching GitHub Release. Tags containing prerelease identifiers such as `-rc` or `-beta` are marked as prereleases automatically and do not become the `/releases/latest` update feed.

## Project status

The desktop shell, Smart/Pinned address modes, shared `DSH_HOME`, tray behavior, runtime supervision, in-app updates, system-notification permissions, bundled official `@deepseek-ai/dsh`, the bundled safe marketplace (review-before-install, shipped in the installer), macOS/Windows packaging, and tag-based release automation are implemented; a runtime lock with legacy-process adoption keeps a second harness from writing one `DSH_HOME`, and Smart mode also probes ports configured in the profile's patch layer. The release workflow launches each packaged app with an empty PATH and probes its Web UI, preventing artifacts that accidentally omit the bundled runtime. Automated artifacts still lack formal signing: Windows/Linux use native notifications, while macOS preserves Web Notification behavior through Dock badges, bouncing, and in-app reminders. Proper signing remains a prerequisite for warning-free installation and macOS Notification Center delivery. OS keychain integration and voice input are also future work — see [TODO](../TODO.md).

Contributions and issue reports are welcome, especially around Windows behavior, Pinned address connections, and packaging.
