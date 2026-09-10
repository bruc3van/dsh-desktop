# Development guide

[中文](development.zh.md)

This document collects the developer-facing content moved out of the README: running from source, development and verification, releasing, and project status. For installation, usage, and connection behavior see the [README](../README_EN.md); for the process model, trust boundary, and design decisions see [Desktop client architecture](desktop-client-architecture.md).

## Run from source

Source development requires Node.js `^22.19.0 || >=24.0.0` and [pnpm](https://pnpm.io/). A separate `dsh` installation is not required.

```sh
git clone https://github.com/bruc3van/dsh-desktop.git
cd dsh-desktop
pnpm install
pnpm run dev          # builds and prepares the separated offline runtime payload
```

On launch, **Smart mode** picks a runtime in this order:

1. It checks `http://127.0.0.1:3080`. If an official Web UI is already running there, the desktop client connects to it. The browser and desktop app then share one live Harness process. A `port` set in `~/.dsh/profiles/web/cordis.patch.yml`, or a local bind pinned in Connection settings, is probed as well; an instance started with `dsh web --port <port>` that left nothing outside its command line to find still needs its address typed in Connection settings.
2. If nothing answers, it looks for a `dsh` you already installed on PATH (a working `dsh --version` is the whole test).
3. Then it looks for a copy npx has already cached. **The official instruction, `npx @deepseek-ai/dsh web`, installs nothing onto PATH** — it leaves the complete package in npm's cache (`~/.npm/_npx/` on POSIX, `%LOCALAPPDATA%\npm-cache\_npx\` on Windows). Running it once is enough for the client to reuse it.
4. Only if none of those exist does it use the pinned official runtime bundled in the installer or project dependencies.

Each of those four sources can be turned off independently in Connection settings (toggle buttons), which is how a test run pins itself to one of them. All four are on by default; at least one must stay on. Disabled sources are skipped; the remaining order does not change. Turning off “Already running” only stops this client from connecting to one: the client never terminates a process it did not start. Installed / npx / bundled are started by this client, so turning those off stops the current child. While a user-started official instance is still answering, any settings change that would spawn another writer is refused (turning reuse off, switching among those three while reuse is off, or switching back to Smart without reuse) — otherwise the window would land on the occupancy surface with no way to stop that process. `DSH_DESKTOP_SKIP_PROBE=1` skips this occupancy check as well as the reuse connection. `DSH_DESKTOP_SKIP_INSTALLED_DSH=1` still applies only in development, and skips PATH and npx detection.

Steps 2 and 3 run on **your own Node** and use only packages that are **already present** — nothing is downloaded, and Node.js is never installed for you; an empty cache is simply skipped. The client reads the cached package's `package.json` to confirm it really is `@deepseek-ai/dsh` and to report its true version, so nothing else sitting at that path can be launched by mistake. The npx cache never updates itself: when the cached version is older than the bundled runtime the client still prefers your cache, but says so in the connection settings — re-running `npx @deepseek-ai/dsh web` once refreshes the cache to the latest release.

What gets started is always a plain background service (automatic mode tries port 3080, then 13080, then `dsh web --port 0`; Connection settings can instead pin a port) — rc.8 and newer get `--no-open`, so not a browser window — and the client shuts it down when you quit. If the chosen runtime fails to start, the client walks the remaining enabled sources (the bundled runtime last, when it is still enabled). A pinned port that is already taken is not replaced, and the source ladder is not walked against the same dead bind. Connection settings show which runtime is in use (installed / npx cache / bundled) and its version. The bundled safe marketplace is offered when the client starts a verifiable official CLI with compatible dependencies, including recognized PATH and npx installations (reused instances and pinned addresses are read-only); see [Development and verification](#development-and-verification) and the README's [bundled safe marketplace](../README_EN.md#the-bundled-safe-marketplace) section.

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

- Update the exact market version, lockfile and release-age exemption together. `prepare:runtime` places the payload in `.runtime/bundled-plugins`, packaged as `resources/bundled-plugins`, outside installation-first DSH lookup.
- The managed launcher checks each installed peer package against its own range, calls that version's official `initProfile()`, then registers the market before the first profile load. Missing optional peers are allowed; incompatible present peers are rejected. Raw CLIs without a verifiable package anchor receive no injected market.
- Only marked copies in `<DSH_HOME>/profiles/web/node_modules` are upgraded. All user dependencies, local installs and lockfiles remain untouched. Legacy shared copies migrate to web; copies referenced by other profiles remain.
- Adopting a running server or connecting to a pinned address does not edit profiles. Disabling the client switch removes owned state on the next managed launch, preserving user installs. The market's installed panel can still remove its marked copy after the client is uninstalled.
- `check:bundled-plugin` covers ownership/migration/disable; `check:market-boot` exercises the actual official loader and launcher, cold startup, peers and patch/module identity; `smoke:package` starts the packaged application from an empty home and calls market APIs. CI and release gates include these checks.
- The market repository owns its catalog and review prompts. This repository owns distribution and profile preparation; see `src/main/bundled-market-boot.ts` and `src/main/bundled-plugin.ts`.

### Legacy market migration and dependency diagnostics

Recognized official PATH shims/symlinks and npx entries run the launcher on the user's Node. `pnpm run dev` prepares the separated runtime and market payload before starting Electron.

A valid user installation allows cleanup of an unused shared copy marked as client-owned. Other profiles, incomplete user installations, foreign links and links with unknown targets are preserved. A legacy link can be removed when its target is the current payload; its target is never deleted.

After official fallback preparation, peer checks start from the market's real directory. User dependency drift is reported in startup logs without changing user packages or lockfiles. Drift in a client-owned market withdraws only its registration.

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

## Desktop settings and page modules

`src/main/pages/` contains pure renderers for loading, error, settings, update, and notice pages, plus the settings script. The main process supplies locale, icon, and dynamic copy, and retains window lifecycle, filesystem access, and caller authorization.

`src/main/settings-adapter.ts` owns read-only detection of the official settings DOM. Integration diagnostics distinguish `absent` (no recognizable dialog), `mounted` (entry attached), and `unsupported` (recognizable dialog with an unsupported structure). Unsupported structures trigger cleanup of injected navigation and display changes. Each failure reason is logged once per document. The main-process status field `settingsIntegration` contains fixed codes, without page text, addresses, or credentials. An entirely unrecognizable new dialog can still appear as `absent`; this is not an upstream version compatibility verdict.

Run `npm run build:shell && npm run check:settings-integration` for an isolated Electron check of structural changes, cleanup, remounting, native settings access, and marketplace persistence. This check runs in macOS/Windows CI. Its fixture does not replace compatibility checks against actual official Web UI releases.

## Runtime and connection boundaries

The entry point assembles services and retains startup, shutdown, and coordination across modules. The following modules own their state; dependencies expose operations and read-only queries instead of a shared mutable application context.

| Module | Ownership |
|---|---|
| `client-settings.ts` | Settings reads, field merging, and atomic writes |
| `runtime-environment.ts` | Bundled executable paths, command shims, login-shell PATH, and shim initialization cache |
| `runtime-catalog.ts` | PATH/npx/bundled/development command selection, version detection cache, and session source rejection |
| `web-ui-manager.ts` | Child generations, readiness promises, output diagnostics, and serialized stopping |
| `web-ui-probe.ts`, `loopback-port.ts` | API verification, native browser admission, and available-port probing; no process spawning |
| `runtime-survivor.ts`, `runtime-process.ts` | Survivor identity, adoption and termination, plus synchronous emergency disposal |
| `connection-controller.ts` | Connection intent generation, targets, per-spawn port selection, intentional replacement, fallback, and retry budget |

The controller exposes read-only state and explicit operations to the window layer. Delayed probes and readiness results must still match the initiating connection generation; the application supplies its quit state. Initial starts and all three retry paths (bundled-plugin withdrawal, failed source, and crash restart) select an automatic port again. Windows await `readyForConnection()` instead of directly publishing child readiness URLs.

`npm run check:connection-controller` covers delayed port probes, stale readiness, overlapping intentional stops, the three retry paths, and survivor precedence. `npm run check:runtime-survivor` starts an isolated real child to verify that unowned/recycled processes survive, a serving leftover is adopted, and restart stops the verified owned process. Both run in CI.

Existing Electron checks continue to cover connection switching, installed sources, automatic fallback, authentication occupancy, and plugin recovery. The automatic fallback check respects another program holding port 13080: it verifies 13080 when available and an OS-assigned port otherwise, without stopping other programs to free a test port.

`settings-server.ts` owns the private path, listening port and HTTP routes; callbacks retain application validation, confirmation dialogs and side effects. `native-menus.ts` builds menu templates from locale, update state and action callbacks. `npm run check:settings-server` exercises Host/private-path rejection, body limits, save results and updater readiness through real HTTP requests without reading a user profile.

## Preload and application modules

`preload.ts` initializes the bridge and document features. Under `preload/`, `bridge.ts` exposes fixed IPC operations, `theme.ts` observes appearance, `settings-observer.ts` coordinates detection and diagnostics, and `settings-navigation.ts` owns temporary official-navigation changes. Connection, update and API-key-help cards have separate modules. `pagehide` cancels observers, frame callbacks, timers and IPC subscriptions and restores official navigation; a back-forward-cache restoration mounts again.

`settings-commands.ts` owns save serialization, port-save generations and data-mode restart state. `plugin-recovery-controller.ts` owns recovery reentrancy. `update-controller.ts` owns update interactions, scheduling and installer handoff. `desktop-ipc.ts` registers business channels; `bridge-policy.ts` checks window identity, top-level frames, active origins and local handoff. `main-window.ts` creates windows and binds navigation/renderer events; `window-health.ts`, `window-theme.ts` and `locale-controller.ts` own recovery, appearance and local language tracking respectively. Dependencies use explicit operations and live queries; never cache mutable cross-module state at initialization.

`npm run build:shell && npm run check:official-settings` starts the bundled official UI with temporary DSH and Chromium homes, checks Chinese and English mounting, official navigation restoration and reopening, and reports the actual DSH version. It uses no real credentials and sends no model requests. Local coverage on 2026-09-05 was `0.1.2-rc.1`, not a claim about other versions. `check:settings-integration` separately covers structural variants and document teardown/restoration.

The official UI check runs in macOS/Windows application CI after preparing the target runtime. Windows argument/patch checks on macOS do not establish native console, installer or window behavior; native acceptance requires a Windows runner executing CI for these changes.

## Safety regression and packaging checks

`pnpm run check:safety` covers injected lock-write failures, nonzero Windows taskkill exits, early installer failure, repeated quit, bridge trust and framed output redaction using synthetic credentials. `check:browser-admission` uses isolated Electron requests to verify cross-port filtering, target changes and non-persistent native credentials. `check:connection-controller` covers services appearing during CLI detection and refusal to launch after a failed stop.

CI/release contracts include `check:dsh-browser-session`; application jobs include `check:auth-occupancy` and `check:browser-admission`. Both DMG architectures now have CI and release smoke jobs. Workflow configuration is not evidence that a runner has passed: validate Windows wrapper-tree termination and installer refusal/cancellation/early-exit recovery on Windows.

Local `pack` and `dist` run the explicit packaging gates in `package.json`, not all of CI. Typecheck, lint, connection, updater and settings integration still need their corresponding CI jobs. A successful local dist alone is not release verification.

`shot:readme` writes the two image names referenced by both READMEs. The older `shots/10-*` through `13-*` files are historical images, not outputs of the current numbered screenshot sequence.
