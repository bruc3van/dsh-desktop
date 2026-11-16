# Development guide

[中文](development.zh.md)

This document collects the developer-facing content moved out of the README: running from source, development and verification, releasing, and project status. For installation, usage, and connection behavior see the [user guide](user-guide.md); for the process model, trust boundary, and design decisions see [Desktop client architecture](desktop-client-architecture.md).

## Run from source

Source development requires Node.js `^22.19.0 || >=24.0.0` and [pnpm](https://pnpm.io/). A separate `dsh` installation is not required.

```sh
git clone https://github.com/bruc3van/dsh-desktop-pro.git
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

What gets started is always a plain background service (automatic mode tries port 3080, then 13080, then `dsh web --port 0`; Connection settings can instead pin a port) — rc.8 and newer get `--no-open`, so not a browser window — and the client shuts it down when you quit. If the chosen runtime fails to start, the client walks the remaining enabled sources (the bundled runtime last, when it is still enabled). A pinned port that is already taken is not replaced, and the source ladder is not walked against the same dead bind. Connection settings show which runtime is in use (installed / npx cache / bundled) and its version. The preset plugin subscription applies only when the client starts the runtime itself (reused instances and custom addresses are left untouched); see the user guide's [preset plugin subscription](user-guide.md#preset-plugin-subscription).

If the bundled runtime cannot start, or you want to use another instance, open **Settings → Desktop settings**. If the page cannot load at all, the startup surface offers **Web UI connection…**.

## Development and verification

```sh
pnpm run build          # build the Electron main process and preload
pnpm run prepare:runtime # prepare the bundled dsh runtime closure
pnpm run check:picker   # verify the bundled Win32 picker compatibility patch
pnpm run check:runtime-env # verify the Agent environment does not inherit Electron's Node-mode variable
pnpm run check:preset-subscription # verify the preset subscription is offered once and never overrides the user
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

In addition, `scripts/` contains a family of regression checks for connection and runtime behavior: `check:connection` (mode switching), `check:installed-runtime` (installed runtime), `check:runtime-resolution` (runtime resolution), `check:smart-runtimes` (Smart-mode source toggles), `check:local-web-port` (local-bind port), `check:preset-subscription` (preset plugin subscription), `check:runtime-lock` (runtime lock and update ordering), `check:restart` (who the tray Restart may stop), `check:auto-fallback` (occupancy refusal when reuse is turned off or managed sources would spawn beside a live instance, then loss-of-instance fallback), and `check:error-surface` (error UI).

`pnpm run e2e` needs a valid API key (export `DEEPSEEK_API_KEY=…`, or add one once via 设置 → 凭据). Without one it exits with code 2 on purpose: a skipped live round trip must not look green. It also runs against a throwaway `DSH_HOME`, so it never touches your real sessions. The production window loads the official Web UI; this repository does not maintain a second product renderer. `pnpm run check:updater` drives a local update-feed fixture through check, hash verification, and dismiss.

### Enterprise mode and the management server (development)

- The protocol lives in `packages/protocol` (desired state, signatures, enrollment, profile merge, device proofs) and is shared by client and server. The desktop bundles it with esbuild; the server runs TypeScript directly on Node 24, so only erasable syntax is allowed (no parameter properties, no enums).
- Client: `src/main/enterprise/` — `managed-source.ts` picks the mode, `reconcile.ts` is the file-only reconciler, `managed-boot.ts` applies it in the launcher, `plugin-sync.ts` installs and removes plugins once the runtime is up, `server-session.ts` handles sign-in and device identity, `controller.ts` ties them together, and `policy-plugin.ts` is the shipped tool-policy plugin (`.build/policy-plugin.mjs`).
- In development, `DSH_DESKTOP_MANAGED_DIR` points at a temporary directory instead of the system one (packaged builds ignore it).
- Server: `pnpm run server` (SQLite in `./data` by default); see `deploy/.env.example`, and add `DSH_DEV_LOGIN=1 DSH_BOOTSTRAP_TOKEN=…` for a trial. The console is at `/console/`.
- Checks: `check:protocol`, `check:enterprise`, `check:server` (set `DSH_CHECK_DATABASE_URL=postgres://…` to run it on PostgreSQL), `check:gateway` (the built-in model gateway), and `check:enterprise-file` / `check:enterprise-server` (file and server mode in a real Electron window, including a first message through the official UI).
- File-mode signing: `node scripts/org-key.mjs generate|sign`.

### Preset plugin subscription (development)

- Only a client-managed `dsh web` spawn carries the request (`DSH_DESKTOP_PRESET_SUBSCRIPTION`); `runtime-launcher` handles it before DSH reads the profile. Ordinary `dsh` / `plugin` / `pnpm` shim calls, adopted instances, pinned addresses, and raw CLIs without a verifiable package anchor never edit a profile.
- The launcher first calls the selected DSH version's own `initProfile()`, so a first-ever launch already gets the subscription; it then checks that the installation provides `@deepseek-ai/dsh-experimental-plugin-market-bundle`, and makes no edit and no record when it does not.
- There are exactly two edits: the bundle is appended to `dsh.profile.bundles`, and a `plugin-market` row with `config.indexes` is written to `cordis.patch.yml`. The patch layer is edited as text, never re-serialised: only the official `[]` template and a top-level block sequence are handled, comments, `!!js` and line endings are kept, and the result must still parse. An existing `plugin-market` row is the user's configuration and is left as is.
- `.dsh-desktop-preset.json` in each `DSH_HOME` records offered addresses; once recorded, the client never edits again, so a removed subscription or a disabled market stays that way.
- From source the runtime runs on your own Node. With Node 26.0 behind DSH's undici dispatcher, `fetch` leaves Brotli bodies undecoded and Discover reports the index as invalid; packaged builds run on Electron's Node 24 and are unaffected. Capture README images from a packaged build with `DSH_DESKTOP_SHOT_APP=<packaged executable> pnpm run shot:readme`.
- `check:preset-subscription` covers the profile shapes; `check:preset-runtime` also runs the real `initProfile()` and `--dump-config` against the prepared runtime; `smoke:package` starts the packaged app from an empty home and confirms the subscription through the official `pluginMarket/listIndexes`. See `src/main/preset-subscription.ts` and `src/main/preset-subscription-boot.ts`.

## Linux x64

Linux targets are x64 AppImage and DEB, using Ubuntu 24.04 as the validation baseline. ARM64, RPM, Snap and Flatpak packages are not provided. Other distributions and full GNOME/KDE desktop behavior need separate validation.

Install the DEB with `sudo apt install ./dsh-desktop-<version>-linux-amd64.deb`. The app lives in `/opt/DSH Desktop Pro/` and can be launched with `dsh-desktop` or from the application menu. Its `/etc/apparmor.d/dsh-desktop-deb` profile grants user namespaces only to the installed executable. Quit before upgrading with the same command. `sudo apt remove dsh-desktop` preserves user data in `~/.bruc3van-dsh-desktop` and `~/.dsh`.

Both packages include Node, pnpm and dsh. Make it executable before launching. On Ubuntu 24.04, install `libfuse2t64` if FUSE 2 is missing, or use `--appimage-extract-and-run`. System graphics libraries and a kernel/system policy allowing Chromium sandboxing are still required; the app does not automatically disable its renderer sandbox.

Ubuntu 24.04 restricts unprivileged user namespaces by default; see the [Ubuntu release notes](https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890). If double-clicking opens no window, run the AppImage from a terminal to see the startup error. For user-namespace or Chromium sandbox errors, place the AppImage in `~/Applications/`, download the supplied [AppArmor profile](../resources/dsh-desktop.apparmor), and have an administrator install it. Also remove any `--no-sandbox` flag from the launch command or desktop shortcut:

```sh
sudo install -m 0644 dsh-desktop.apparmor /etc/apparmor.d/dsh-desktop
sudo apparmor_parser -r /etc/apparmor.d/dsh-desktop
```

This profile matches only DSH Desktop Pro AppImages in that directory and permits their sandbox namespaces without disabling the system restriction. WSL has different kernel/policy behavior and cannot validate this profile's enforcement on a real Ubuntu desktop. If the system has no configured Documents directory, upstream default-workspace creation may fail; **Choose workspace** can select an existing project folder.

Closing the window keeps its renderer and background tasks alive. If the desktop has no tray, launching the same AppImage again restores the window. Use **DSH Desktop Pro → Quit** or `Ctrl+Q` to exit. In-app updates download, verify and reveal the new AppImage; quit, manually replace the original file, then reopen it.

Build on a native Linux filesystem with a separate dependency installation:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run build
DSH_RUNTIME_TARGET=linux-x64 corepack pnpm run prepare:runtime
corepack pnpm exec electron-builder --linux AppImage deb --x64 --publish never
```

The artifact is `dsh-desktop-pro-<version>-linux-x86_64.AppImage`; its update-feed key is `linux-x64`. `check:linux` exercises Koffi, Sharp, ripgrep, PTY, Landlock read permissions and real window close/recovery. `smoke:appimage` extracts the actual AppImage and checks its payload, offline plugin installation and AppRun startup, then verifies standalone startup and a menu restart that replaces both the desktop and its managed runtime. It uses extract-and-run by default; set `DSH_SMOKE_APPIMAGE_FUSE=1` to validate FUSE mode. A headless host can use Xvfb and D-Bus:

```sh
xvfb-run -a dbus-run-session -- corepack pnpm run check:linux
xvfb-run -a dbus-run-session -- corepack pnpm run smoke:appimage
```

Linux CI runs on PRs, main pushes and manual dispatch, retaining successful test packages as Actions artifacts for 14 days. Automated smoke does not cover model API round trips, a real tray, notification activation, input methods or full Wayland desktop acceptance.

DEB artifacts use `dsh-desktop-pro-<version>-linux-amd64.deb` and the separate `linux-deb-x64` update key. AppImage retains `linux-x64` for older clients. FPM adds a dpkg-owned `resources/package-type` marker only to DEB; the app selects its update format from this marker, not environment variables. DEB updates download and verify the file for manual installation with `apt`, without privilege escalation or stopping tasks.

`smoke:deb` only runs on ephemeral GitHub Actions Linux runners because it changes the system package database. It rebuilds the current payload with version `0.0.0` as an upgrade fixture, then checks installation, upgrade, desktop integration, AppArmor loading, the installed runtime/native modules, removal and user-data retention. This exercises the dpkg upgrade path, not compatibility with a historical payload. Native GNOME/KDE, Wayland, notifications and input methods still require desktop acceptance testing.


## Releasing a version

To release a version, push its tag directly. GitHub Actions treats the tag as the single version source and writes it to `package.json` during the build:

```sh
git tag v0.4.0
git push origin v0.4.0
```

GitHub Actions validates the tag format, uses the tag as the release version, then builds:

- macOS Apple Silicon: DMG;
- macOS Intel: DMG;
- Windows x64: NSIS installer;
- Linux x64: AppImage and DEB.

Linux packages are built on a native Ubuntu runner and uploaded only after the actual AppImage payload passes smoke tests. `latest.json` requires complete assets for all four platform keys.

After every platform succeeds, the workflow generates SHA-256 checksums and `latest.json` for the in-app updater, then creates or updates the matching GitHub Release. Tags containing prerelease identifiers such as `-rc` or `-beta` are marked as prereleases automatically and do not become the `/releases/latest` update feed.

## Project status

The desktop shell, Smart/Pinned address modes, shared `DSH_HOME`, tray behavior, runtime supervision, in-app updates, system-notification permissions, bundled official `@deepseek-ai/dsh`, the bundled safe marketplace (review-before-install, shipped in the installer), macOS/Windows/Linux packaging, and tag-based release automation are implemented; a runtime lock with legacy-process adoption keeps a second harness from writing one `DSH_HOME`, and Smart mode also probes ports configured in the profile's patch layer. The release workflow launches each packaged app without system Node/pnpm and probes its Web UI, preventing artifacts that accidentally omit the bundled runtime. Automated artifacts still lack formal signing: Windows/Linux use native notifications, while macOS preserves Web Notification behavior through Dock badges, bouncing, and in-app reminders. Proper signing remains a prerequisite for warning-free installation and macOS Notification Center delivery. OS keychain integration and voice input are also future work — see [TODO](../TODO.md).

Contributions and issue reports are welcome, especially around Windows behavior, Pinned address connections, and packaging.

## Desktop settings and page modules

`src/main/pages/` contains pure renderers for loading, error, settings, update, and notice pages, plus the settings script. The main process supplies locale, icon, and dynamic copy, and retains window lifecycle, filesystem access, and caller authorization.

`src/main/settings-adapter.ts` owns read-only detection of the official settings DOM. Integration diagnostics distinguish `absent` (no recognizable dialog), `mounted` (entry attached), and `unsupported` (recognizable dialog with an unsupported structure). Unsupported structures trigger cleanup of injected navigation and display changes. Each failure reason is logged once per document. The main-process status field `settingsIntegration` contains fixed codes, without page text, addresses, or credentials. An entirely unrecognizable new dialog can still appear as `absent`; this is not an upstream version compatibility verdict.

Run `npm run build:shell && npm run check:settings-integration` for an isolated Electron check of structural changes, cleanup, remounting, native settings access, and marketplace persistence. This check runs in macOS/Windows/Linux CI. Its fixture does not replace compatibility checks against actual official Web UI releases.

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

The controller exposes read-only state and explicit operations to the window layer. Delayed probes and readiness results must still match the initiating connection generation; the application supplies its quit state. Initial starts and both retry paths (failed source and crash restart) select an automatic port again. Windows await `readyForConnection()` instead of directly publishing child readiness URLs.

Mutually exclusive states are one discriminated union each, moved by named functions and only derived at the point of use; do not rebuild the same fact from several booleans:

| State | Where | Values |
|---|---|---|
| `ConnectionSource` | `connection-controller.ts` | `connect` (an address the user entered), `probe` (a detected instance, reused), `local` (started by the client) |
| `MainSurface` | `main-window.ts`, held by `index.ts` | `loading`, `failure`, `page` |
| `Admission` | `index.ts` | `admitted`, `pending`, `refused`; in enterprise mode a reopened window consults it first and starts no runtime until admitted |
| `Shutdown` | `index.ts` | `running`, `restart-scheduled`, `restart-requested`, `stopping` (with `restart`); an acknowledged restart is not swallowed by a plain quit that follows, and a restart asked for after `stopping` is refused and logged |
| Update phase | `updater.ts` | `UpdaterPhase`; `installInProgress()` answers whether a download, install or pending restart is under way |

The enterprise controller keeps only `offlineReason`: a value means offline, so the status endpoint and the report always carry the reason. On the server, `sessionStands()` in `auth.ts` is the single test for a live session; refresh tokens, access tokens, the console cookie and the bootstrap session all go through it.

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
