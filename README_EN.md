# DSH Desktop

[中文](README.md) | English

**A third-party DSH desktop client that uses the official Web UI and adds background operation, notifications, runtime selection, and a bundled safe marketplace.**

DSH Desktop is an independent Electron client for DeepSeek Harness (`dsh`). It loads the official Web UI. The desktop client manages runtime startup and connection, the tray, notifications, updates, and security controls.

> [!IMPORTANT]
> **This is an unofficial community project.** It is not developed, published, endorsed, or supported by DeepSeek. `DeepSeek`, `DeepSeek Harness`, `dsh`, and related names and marks belong to their respective owners.

Release installers include a pinned version of the official `@deepseek-ai/dsh` runtime. Starting the client and using its bundled runtime requires no separate installation of Node.js, pnpm, or the `dsh` CLI. Individual tasks or plugins may still require additional tools. The desktop client and official runtime have separate version numbers, both shown in Connection settings.

![DSH Desktop home](docs/images/dsh-desktop-home.png)

## Main features

- Keeps running after the main window closes and reopens from the tray or menu bar.
- Uses the official Web UI instead of maintaining a separate interface.
- Includes the official runtime in the installer.
- Can reuse a running dsh or use a PATH installation, npx cache, or the bundled runtime.
- Can share `~/.dsh` with the CLI or use an isolated desktop data environment.
- Includes a safe marketplace. Its plugin catalog stays offline until enabled by the user; **Safe install** uses a prompt to ask the Agent to review code before installation.
- Verifies update packages with SHA-256 before installation.
- Uses Electron sandboxing, context isolation, navigation restrictions, and permission controls.

## Quick start

### Download a release

Download the installer for your system from [GitHub Releases](https://github.com/bruc3van/dsh-desktop/releases). Release builds already contain the official dsh runtime and do not run npm installation on first launch.

The current release workflow provides installers for macOS Apple Silicon, macOS Intel, and Windows x64. Linux has no prebuilt installer at present; see the development guide to run from source.

Current packages do not yet have full developer signing and notarization, so the operating system may block the first launch.

**If the operating system blocks the first launch**

- **macOS:** Move the app to Applications and open it. Then go to **System Settings → Privacy & Security** and choose **Open Anyway**.

  If macOS reports that the app is damaged and does not show **Open Anyway**, run:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/DSH Desktop.app"
  ```

- **Windows:** In Microsoft Defender SmartScreen, choose **More info**, then **Run anyway**.

### Start a conversation

1. Enter an API key on first launch, or choose **Configure later**.
2. Create a key at <https://platform.deepseek.com/api_keys> if needed. DeepSeek manages the account, balance, and charges.
3. Choose an Agent preset or model if needed.
4. Add and select a project folder as the conversation's workspace.
5. Start a conversation and send the task.

> [!TIP]
> A fresh data directory may start in English. Change the language under **Settings → General → Language**.

## Connection modes

| Mode | Behavior |
|---|---|
| **Smart** (default) | Tries a running official instance, a `dsh` on PATH, an npx-cached package, then the bundled runtime. |
| **Custom** | Connects to a specified Web UI address without starting a local runtime. |

Smart mode uses only runtimes already on the machine. It does not download or install Node.js. Connection settings can disable individual sources, but at least one must remain. The isolated data environment does not reuse running instances from the shared environment, so an installed, npx-cached, or bundled runtime must remain enabled. Source changes are staged until **Apply and reconnect** is selected. Unapplied changes can be undone.

For local services, automatic port selection tries 3080, then 13080, then an OS-assigned port. A fixed port can also be configured. A fixed port does not change automatically when occupied.

In the shared data environment, if the client detects a running official instance but the current settings do not allow reuse, it refuses to start another process and does not stop the user-owned process. Stop that instance in the terminal first, or switch to the isolated data environment.

Open **Desktop settings** from the tray menu, the macOS application menu, or with `Cmd+,` on macOS and `Ctrl+,` on Windows/Linux.

![Desktop settings: connection mode, runtime sources, Safe Market, and version information](docs/images/dsh-desktop-setting.png)

Connection status values:

| Status | Meaning |
|---|---|
| Already running | Reuses a user-started instance |
| Client-started · bundled | Uses the runtime in the installer |
| Client-started · npx cache | Uses the npx-cached runtime |
| Client-started · installed | Uses the `dsh` on PATH |
| Custom address | Connects to an address without starting a runtime |

Client-started Web UIs use a loopback address. A Custom address can connect to a Web UI you manage; that deployment must provide authentication and network access. The client saves only the scheme, host, and port, dropping paths, query parameters, and fragments. For connections across machines, consult the [official documentation](https://github.com/deepseek-ai/deepseek-harness) for your runtime version.

See the [development guide](docs/development.md#run-from-source) for runtime selection, port, and authentication details.

## Data and security

| Data | Default location | Owner |
|---|---|---|
| Shared conversations, credentials, model settings, and plugins | `~/.dsh` | Official dsh |
| Desktop settings, command shims, and update downloads | `~/.bruc3van-dsh-desktop` | Desktop client |
| Isolated conversations, credentials, model settings, and plugins | `~/.bruc3van-dsh-desktop/dsh` | Official dsh |

The **Data environment** setting switches between Shared and an isolated desktop environment after restart. Switching does not copy conversations or plugins from the previous environment.

When the new directory does not exist, the client migrates legacy `~/.dsh-desktop` data to `~/.bruc3van-dsh-desktop`. If moving fails, it copies the data and leaves the old directory in place.

Security controls include:

- Starts services through the official `dsh web` CLI and interacts through the Web UI's `/api` interfaces. Preparing the bundled market also calls runtime profile-loading modules and adjusts plugin configuration.
- Enables Electron sandboxing and context isolation and disables Node integration.
- Restricts navigation to the current Web UI origin and opens external links in the system browser.
- Ignores environment overrides for update sources, data directories, and connection probes in packaged builds by default, unless unsafe debugging is explicitly enabled.
- Validates update metadata and installer filenames and verifies installer SHA-256.
- Allows capabilities such as file picking and voice input for client-managed local Web UIs; reused instances and Custom addresses receive more restricted permissions. Cross-origin frames, USB/HID/serial, geolocation, display capture, and storage escalation are denied by default.
- Keeps Safe Market's plugin catalog offline until the user enables it.

Windows installers support system notifications. Linux uses Chromium notifications. Current macOS packages are not fully signed, so notifications fall back to Dock badges, Dock attention, and in-app notices.

Use of this client remains subject to the terms and privacy policies of DeepSeek, model providers, and connected services. Users and those services are responsible for API keys, requests, charges, generated content, and Agent actions on local files and commands.

## Desktop behavior

- Closing the main window keeps the app running; reopen it from the tray or menu bar.
- **Restart client** restarts client-managed local runtimes but does not stop a `dsh web` process started by the user.
- A local Web UI that exits unexpectedly receives a limited number of restart attempts.
- After system resume or a long idle, an invalid page reloads after the service becomes available.
- If a reused Smart-mode instance disappears, the client can try other enabled sources. A failed Custom address does not switch automatically.
- Uses runtime locks and local service probes to avoid starting duplicate runtimes on the same `DSH_HOME`. If it cannot safely adopt or stop an old process, it refuses to start a new one. These checks cannot stop users from launching additional instances through other terminals or tools.
- If plugins prevent Shared from starting, the user can remove the confirmed plugins and retry, or keep them and switch to the isolated environment.

Release builds check GitHub Releases after startup and do not repeat automatic checks within 12 hours. Manual checks are available from settings, the tray, and the macOS application menu.

The update window shows download, verification, and installation status. Failed downloads can be retried, and downloads can continue after the window closes.

On macOS, the client can replace and restart an app installed in a writable directory. It attempts to restore the previous app if replacement fails. Updates interrupt client-managed local tasks.

## Bundled runtime environment

- When starting a local runtime, release builds generate `node`, `dsh`, and `pnpm` command wrappers under `~/.bruc3van-dsh-desktop/bin` and append that directory to the runtime's PATH, inherited by Agent commands. User tools already on PATH take priority; the client does not modify the system PATH.
- The `node` command uses Electron's bundled Node.js, and `pnpm` ships with the installer. The client does not bundle `npm` or `npx`. If those commands are needed, install a complete Node.js distribution that includes npm/npx and ensure they are available on the PATH of the client-started runtime.
- The bundled `dsh` wrapper supports plugin management, version queries, and configuration exports. It rejects commands that start another runtime instance, such as `dsh web`.
- At runtime startup, the client clears its internal `ELECTRON_RUN_AS_NODE` setting so ordinary Agent shell commands do not accidentally use Electron's Node mode.
- The app does not use the macOS App Sandbox. Electron's window sandbox is separate from any Agent command sandbox; Agent actions also depend on the runtime's permission policy, sandbox configuration, and operating-system grants.
- The bundled runtime ships with the client and cannot be upgraded separately.

See [Desktop client architecture](docs/desktop-client-architecture.md) and the [development guide](docs/development.md) for implementation details.

## Bundled Safe Market

The [Safe Market](https://github.com/bruc3van/dsh-desktop-safe-market) ships offline with the installer. The desktop setting to load the bundled market at startup is on by default. The client prepares the plugin for client-started runtimes with compatible dependencies, without an online installation. Reusing a running local instance or connecting to a Custom address does not modify its plugin configuration.

The **Enable Safe Market** control inside the market page governs network access to the plugin catalog. It is off by default and independent of the desktop startup setting. Enabling it saves that choice and caches the last successful catalog. Turning off the desktop startup setting removes the client-owned copy and registration on the next client-managed runtime launch. User installations that have not been transferred to client management are unaffected by this switch.

When starting a local runtime, the client can upgrade an older market enabled in the Web profile from a regular package installation or a GitHub release tag from the market's official repository. It replaces that version offline with the bundled copy, takes over management, and removes the old dependency pin and pnpm lockfile entry. Equal or newer versions, other custom sources (such as file/link/git), and unrecognized versions or lockfiles are preserved. Connecting to an existing service does not replace its market. A migrated market follows client updates and the desktop startup setting.

Dependency checks use the runtime selected for this launch. Stale automatic links to optional dependencies in a shared data directory do not block the market when the selected runtime does not provide those dependencies. Required dependencies and explicitly installed user dependencies still undergo compatibility checks.

The desktop startup setting controls the next runtime launch. The adjacent local installation and registration status does not prove the market is loaded in the current session. After the market uninstalls itself, its UI may remain for that session. With the startup setting enabled, the next client-started local service attempts to restore the bundled copy; with it disabled, no restoration is attempted. Any remaining user installation is reported rather than treated as a restored bundled copy.

Open **Safe Market** from the start page to browse the plugin catalog in the right pane, filter by name or category, and view installed plugins.

![Opening the bundled Safe Market from the start page to browse plugins](docs/images/marketplace-start-view.png)

![Safe Market](docs/images/marketplace.png)

Catalog data comes from [awesome-dsh-plugin](https://github.com/bruc3van/awesome-dsh-plugin):

- Repositories tagged `dsh-plugin` are collected daily.
- Archived, discontinued, and ineligible projects are excluded.
- A maintained exclusion list is applied, and catalog data is validated before display.

**Safe install** does not run an installation command. It fills a new conversation with a security-review prompt but does not send it.

After the user sends the prompt, it asks the Agent to check credential access, data exfiltration, remote code execution, install scripts, obfuscated files, and requested permissions. A passing review can proceed to installation with the official command; suspicious findings or installation approval requirements pause the process for the user. Sending the prompt authorizes this review-and-install flow; a second confirmation after review is not guaranteed.

**Catalog inclusion is not a security endorsement. Review the result before installation.**

![Safe install first fills a review prompt](docs/images/marketplace-sec-install.png)

Installed plugins can be viewed, enabled, disabled, or removed. Installed but unloaded plugins are also listed.

![Installed plugin management](docs/images/marketplace-installed.png)

If the marketplace is incompatible with the active runtime, the client stops loading it without disabling other plugins. See the [Safe Market repository](https://github.com/bruc3van/dsh-desktop-safe-market) for configuration, protocol, and limitations.

## FAQ

**Q: Is this a browser wrapper?**

The window loads the official Web UI, but the client also manages runtimes, connections, the tray, notifications, permissions, and updates. It does not maintain a separate product interface. See the [architecture document](docs/desktop-client-architecture.md).

**Q: How is this different from opening the Web UI in a browser?**

The browser workflow normally requires Node.js, a running `dsh web` terminal process, and manual browser access. The desktop client includes a runtime, manages it in the background, and provides tray controls, notifications, connection settings, and in-app updates.

**Q: How can I use the latest official dsh?**

Update the official `dsh` on PATH or the npx-cached runtime and enable that source in Smart mode. You can also reuse an updated local instance or connect to a Web UI you manage through a Custom address. Smart mode follows source order; it does not compare every source and select the newest version. The bundled runtime is fixed at release time and is updated with the desktop client.

**Q: Does Safe Market install plugins automatically?**

Clicking **Safe install** only fills a review prompt; it does not send the prompt or install anything. After the user sends it, the Agent follows the prompt to review the artifact and can proceed to installation if it passes. Suspicious findings or approval requirements pause the flow for the user.

## Related projects

- [awesome-dsh-plugin](https://github.com/bruc3van/awesome-dsh-plugin): catalog data for Safe Market. It collects plugin repositories daily and maintains exclusion records.
- [dsh-desktop-safe-market](https://github.com/bruc3van/dsh-desktop-safe-market): the Safe Market implementation bundled with this client.
- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness): the upstream project for the official dsh and Web UI.

## License

[MIT](LICENSE)

The MIT License covers only code and assets maintained in this repository. Official `@deepseek-ai/dsh` and other third-party dependencies use their own licenses. “DSH” identifies the compatible product and does not imply an official relationship.
