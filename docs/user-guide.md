# DSH Desktop Pro user guide

[中文](user-guide.zh.md) | English

This guide covers the desktop client in detail: installing on Linux, connection modes, data and security, background operation and updates, the bundled runtime, and the preset plugin subscription. For an overview and downloads see the [README](../README_EN.md); for company rollouts see the [enterprise deployment guide](enterprise.md).

## Install on Linux x64

**Ubuntu 24.04 installer (DEB):** Download the file ending in `linux-amd64.deb` and run `sudo apt install ./actual-filename.deb` from its folder. Open **DSH Desktop Pro** from the application menu or run `dsh-desktop`. Installation sets up the launcher, icons and an application-scoped AppArmor profile; FUSE is not required. Quit the client before upgrading with the same command. `sudo apt remove dsh-desktop` removes the app while preserving settings and session data.

**Portable AppImage:**

1. Download the package whose filename ends in `linux-x86_64.AppImage`.
2. Place it in `~/Applications/` (create the directory if needed) and keep the original filename.
3. Allow execution in the file's properties, then double-click it. Alternatively, grant executable permission with:

   ```sh
   chmod +x ~/Applications/dsh-desktop-pro-*-linux-x86_64.AppImage
   ```

If FUSE 2 is missing, Ubuntu 24.04 users can install `libfuse2t64`. Alternatively, pass `--appimage-extract-and-run` when launching the AppImage. If double-clicking opens no window, run the file from a terminal to see the error. For user-namespace or Chromium sandbox restrictions, follow the [Linux installation and system requirements](development.md#linux-x64) to configure AppArmor. The client requires renderer sandboxing.

The current validation environment is Ubuntu 24.04 under WSL, with X11 and WSLg Wayland checks. Other distributions and full native GNOME/KDE desktop behavior need separate validation; the AppImage format does not establish compatibility with every Linux system. Tray integration, system notifications, and input methods depend on the desktop environment.

## Connection modes

| Mode | Behavior |
|---|---|
| **Smart** (default) | Tries a running official instance, a `dsh` on PATH, an npx-cached package, then the bundled runtime. |
| **Custom** | Connects to a specified Web UI address without starting a local runtime. |

Smart mode uses only runtimes already on the machine. It does not download or install Node.js. Connection settings can disable individual sources, but at least one must remain. The isolated data environment does not reuse running instances from the shared environment, so an installed, npx-cached, or bundled runtime must remain enabled. Source changes are staged until **Apply and reconnect** is selected. Unapplied changes can be undone.

For local services, automatic port selection tries 3080, then 13080, then an OS-assigned port. A fixed port can also be configured. A fixed port does not change automatically when occupied.

In the shared data environment, if the client detects a running official instance but the current settings do not allow reuse, it refuses to start another process and does not stop the user-owned process. Stop that instance in the terminal first, or switch to the isolated data environment.

Open **Desktop settings** from the tray menu, the macOS/Linux application menu, or with `Cmd+,` on macOS and `Ctrl+,` on Windows/Linux.

![Desktop settings: connection mode, runtime sources, and version information](images/dsh-desktop-setting.png)

Connection status values:

| Status | Meaning |
|---|---|
| Already running | Reuses a user-started instance |
| Client-started · bundled | Uses the runtime in the installer |
| Client-started · npx cache | Uses the npx-cached runtime |
| Client-started · installed | Uses the `dsh` on PATH |
| Custom address | Connects to an address without starting a runtime |

Client-started Web UIs use a loopback address. A Custom address can connect to a Web UI you manage; that deployment must provide authentication and network access. The client saves only the scheme, host, and port, dropping paths, query parameters, and fragments. For connections across machines, consult the [official documentation](https://github.com/deepseek-ai/deepseek-harness) for your runtime version.

See the [development guide](development.md#run-from-source) for runtime selection, port, and authentication details.

## Data and security

| Data | Default location | Owner |
|---|---|---|
| Shared conversations, credentials, model settings, and plugins | `~/.dsh` | Official dsh |
| Desktop settings, command shims, and update downloads | `~/.bruc3van-dsh-desktop` | Desktop client |
| Isolated conversations, credentials, model settings, and plugins | `~/.bruc3van-dsh-desktop/dsh` | Official dsh |

The **Data environment** setting switches between Shared and an isolated desktop environment after restart. Switching does not copy conversations or plugins from the previous environment.

When the new directory does not exist, the client migrates legacy `~/.dsh-desktop` data to `~/.bruc3van-dsh-desktop`. If moving fails, it copies the data and leaves the old directory in place.

Security controls include:

- Starts services through the official `dsh web` CLI and interacts through the Web UI's `/api` interfaces. The one-time preset subscription calls the runtime's own profile initialisation and edits two settings in the web profile.
- Enables Electron sandboxing and context isolation and disables Node integration.
- Restricts navigation to the current Web UI origin and opens external links in the system browser.
- Ignores environment overrides for update sources, data directories, and connection probes in packaged builds by default, unless unsafe debugging is explicitly enabled.
- Validates update metadata and installer filenames and verifies installer SHA-256.
- Allows capabilities such as file picking and voice input for client-managed local Web UIs; reused instances and Custom addresses receive more restricted permissions. Cross-origin frames, USB/HID/serial, geolocation, display capture, and storage escalation are denied by default.
- The preset subscription only writes an index address. The plugin list is fetched only when you open the Discover page, and the client never installs a plugin for you.

Windows installers support system notifications. Linux uses Chromium notifications. Current macOS packages are not fully signed, so notifications fall back to Dock badges, Dock attention, and in-app notices.

Use of this client remains subject to the terms and privacy policies of DeepSeek, model providers, and connected services. Users and those services are responsible for API keys, requests, charges, generated content, and Agent actions on local files and commands.

## Desktop behavior

- Closing the main window keeps the app running; reopen it from the tray or menu bar. On Linux without a tray, launch the installed app or the same AppImage again to restore the window. Use **DSH Desktop Pro → Quit** in the window menu or `Ctrl+Q` to exit.
- **Restart client** restarts client-managed local runtimes but does not stop a `dsh web` process started by the user.
- A local Web UI that exits unexpectedly receives a limited number of restart attempts.
- After system resume or a long idle, an invalid page reloads after the service becomes available.
- If a reused Smart-mode instance disappears, the client can try other enabled sources. A failed Custom address does not switch automatically.
- Uses runtime locks and local service probes to avoid starting duplicate runtimes on the same `DSH_HOME`. If it cannot safely adopt or stop an old process, it refuses to start a new one. These checks cannot stop users from launching additional instances through other terminals or tools.
- If plugins prevent Shared from starting, the user can remove the confirmed plugins and retry, or keep them and switch to the isolated environment.

Release builds check GitHub Releases after startup and do not repeat automatic checks within 12 hours. Manual checks are available from settings, the tray, and the macOS/Linux application menu.

The update window shows download, verification, and the next action. Failed downloads can be retried, and downloads can continue after the window closes.

On macOS, the client can replace and restart an app installed in a writable directory. It attempts to restore the previous app if replacement fails. Updates interrupt client-managed local tasks.

On Linux, updates download and verify the current package format (DEB or AppImage), then reveal the file. For DEB, quit the client and run `sudo apt install ./actual-filename.deb`; for AppImage, replace the original file. Tasks keep running during the download. Use **DSH Desktop Pro → Quit** or `Ctrl+Q` to exit, finish installing the update for your package format, and reopen it. Closing the main window only hides it; it does not quit the client. Verified downloads remain reusable after a client restart.

## Bundled runtime environment

- When starting a local runtime, release builds generate `node`, `dsh`, and `pnpm` command wrappers under `~/.bruc3van-dsh-desktop/bin` and append that directory to the runtime's PATH, inherited by Agent commands. User tools already on PATH take priority; the client does not modify the system PATH.
- The `node` command uses Electron's bundled Node.js, and `pnpm` ships with the installer. The client does not bundle `npm` or `npx`. If those commands are needed, install a complete Node.js distribution that includes npm/npx and ensure they are available on the PATH of the client-started runtime.
- The bundled `dsh` wrapper supports plugin management, version queries, and configuration exports. It rejects commands that start another runtime instance, such as `dsh web`.
- At runtime startup, the client clears its internal `ELECTRON_RUN_AS_NODE` setting so ordinary Agent shell commands do not accidentally use Electron's Node mode.
- The app does not use the macOS App Sandbox. Electron's window sandbox is separate from any Agent command sandbox; Agent actions also depend on the runtime's permission policy, sandbox configuration, and operating-system grants.
- The bundled runtime ships with the client and cannot be upgraded separately.

See [Desktop client architecture](desktop-client-architecture.md) and the [development guide](development.md) for implementation details.

## Preset plugin subscription

Official DSH ships a Custom plugin market (the **Discover** tab on the Plugins page), but it is off by default and has no index sources. The first time the client starts a local runtime, it does two things for you:

1. turns on the Custom plugin market;
2. adds the index `https://bruc3van.com/dsh-plugins/index.json`.

You can then browse, filter, and install plugins under **Plugins** → **Discover**; installation is done by the official plugin manager.

![After the first launch, the Plugins page's Discover tab already lists the curated plugins](images/dsh-desktop-discover.png)

The index comes from [awesome-dsh-plugin-pro](https://github.com/bruc3van/awesome-dsh-plugin-pro): repositories tagged `dsh-plugin` are collected daily, maintainers verify eligibility, exclude archived, disabled, and ineligible projects, and publish curated subscription entries ranked by stars. Counts follow source updates. **Being listed is not a security endorsement; review the source and permissions before installing.**

Rules:

- **Added once.** Once per data environment (the shared `~/.dsh` and the desktop-only environment). If you remove the subscription or turn the Custom plugin market off, the client does not add it back.
- **Your configuration wins.** If the profile already configures the Custom plugin market, the client changes nothing.
- **Only for runtimes the client starts.** Reusing a running local instance or connecting to a Custom address leaves that service's configuration alone.
- The edits are the bundle list in `~/.dsh/profiles/web/package.json` and one commented block appended to `cordis.patch.yml`; existing content and comments are kept as they are.

**Upgrading from an earlier version:** from 0.6.2 / 0.7.0-beta.5 the installer bundles a plugin market again: [DSH Market Pro](https://github.com/bruc3van/dsh-market-pro) (`dsh-market-pro`). When the client starts the local service it installs the market into the web profile and enables it, and a client upgrade updates it. A `safer-dsh-market` copy the client installed earlier is removed; a copy you installed yourself stays, but DSH Market Pro does not load while it is there, so uninstall it from the Plugins page first. To opt out, turn the switch off under Desktop settings → Data environment → Plugin marketplace; the next client-managed launch removes the client-installed copy.
