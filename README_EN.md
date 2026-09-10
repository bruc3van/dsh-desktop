# DSH Desktop

[中文](README.md) | English

**A third-party DSH desktop client that uses the official Web UI and adds background operation, notifications, runtime selection, and a bundled safe marketplace.**

DSH Desktop is an independent Electron client for DeepSeek Harness (`dsh`). It loads the official Web UI. The desktop client manages runtime startup and connection, the tray, notifications, updates, and security controls.

> [!IMPORTANT]
> **This is an unofficial community project.** It is not developed, published, endorsed, or supported by DeepSeek. `DeepSeek`, `DeepSeek Harness`, `dsh`, and related names and marks belong to their respective owners.

Release installers include a pinned version of the official `@deepseek-ai/dsh` runtime. Users do not need to install Node.js, pnpm, or the `dsh` CLI. The desktop client and official runtime have separate version numbers, both shown in Connection settings.

![DSH Desktop home](docs/images/dsh-desktop-home.png)

## Main features

- Keeps running after the main window closes and reopens from the tray or menu bar.
- Uses the official Web UI instead of maintaining a separate interface.
- Includes the official runtime in the installer.
- Can reuse a running dsh or use a PATH installation, npx cache, or the bundled runtime.
- Can share `~/.dsh` with the CLI or use an isolated desktop data environment.
- Includes a safe marketplace. It is off by default and asks the Agent to review code before installation.
- Verifies update packages with SHA-256 before installation.
- Uses Electron sandboxing, context isolation, navigation restrictions, and permission controls.

## Quick start

### Download a release

Download the installer for your system from [GitHub Releases](https://github.com/bruc3van/dsh-desktop/releases). Release builds already contain the official dsh runtime and do not run npm installation on first launch.

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
4. Add a project folder when the task needs file access.
5. Start a conversation and send the task.

> [!TIP]
> A fresh data directory may start in English. Change the language under **Settings → General → Language**.

## Connection modes

| Mode | Behavior |
|---|---|
| **Smart** (default) | Tries a running official instance, a `dsh` on PATH, an npx-cached package, then the bundled runtime. |
| **Custom** | Connects to a specified Web UI address without starting a local runtime. |

Smart mode uses only runtimes already on the machine. It does not download or install Node.js. Connection settings can disable individual sources, but at least one must remain. Source changes are staged until **Apply and reconnect** is selected. Unapplied changes can be undone.

For local services, automatic port selection tries 3080, then 13080, then an OS-assigned port. A fixed port can also be configured. A fixed port does not change automatically when occupied.

If an official local instance is running but the current settings do not allow reuse, the client does not start another process or stop the user-owned process. Stop that instance in the terminal first.

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

Official dsh currently targets local use. It listens on `127.0.0.1` by default and rejects `0.0.0.0`. Remote and container instances are outside official support. If you connect through an SSH tunnel or similar setup, use a trusted network and HTTPS.

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

- Uses only the public `dsh web` CLI and `/api` protocol.
- Enables Electron sandboxing and context isolation and disables Node integration.
- Restricts navigation to the current Web UI origin and opens external links in the system browser.
- Prevents packaged builds from overriding update sources, data directories, or connection probes through environment variables.
- Validates update metadata and installer filenames and verifies installer SHA-256.
- Applies different permission policies to local and custom remote origins. Cross-origin frames, USB/HID/serial, geolocation, display capture, and storage escalation are denied by default.
- Keeps Safe Market off and offline until the user enables it.

Windows installers support system notifications. Linux uses Chromium notifications. Current macOS packages are not fully signed, so notifications fall back to Dock badges, Dock attention, and in-app notices.

Use of this client remains subject to the terms and privacy policies of DeepSeek, model providers, and connected services. Users and those services are responsible for API keys, requests, charges, generated content, and Agent actions on local files and commands.

## Desktop behavior

- Closing the main window keeps the app running; reopen it from the tray or menu bar.
- **Restart client** restarts client-managed local runtimes but does not stop a `dsh web` process started by the user.
- A local Web UI that exits unexpectedly receives a limited number of restart attempts.
- After system resume or a long idle, an invalid page reloads after the service becomes available.
- If a reused Smart-mode instance disappears, the client can try other enabled sources. A failed Custom address does not switch automatically.
- The client does not start two writers on the same `DSH_HOME`. If it cannot safely adopt or stop an old process, it refuses to start a new one.
- If plugins prevent Shared from starting, the user can remove the confirmed plugins and retry, or keep them and switch to the isolated environment.

Release builds check GitHub Releases after startup and do not repeat automatic checks within 12 hours. Manual checks are available from settings, the tray, and the macOS application menu.

The update window shows download, verification, and installation status. Failed downloads can be retried, and downloads can continue after the window closes.

On macOS, the client can replace and restart an app installed in a writable directory. It attempts to restore the previous app if replacement fails. Updates interrupt client-managed local tasks.

## Bundled runtime environment

- The installer provides `node`, `dsh`, and `pnpm` under `~/.bruc3van-dsh-desktop/bin`. User-installed versions remain first on PATH.
- This directory does not provide `npm` or `npx`. Install Node.js or connect to a runtime you manage when those commands are required.
- Internal `ELECTRON_RUN_AS_NODE` settings are not passed to Agent commands.
- The app does not use the macOS App Sandbox. Agent file access matches the current user process, and macOS may request access to protected folders.
- The bundled runtime ships with the client and cannot be upgraded separately.

See [Desktop client architecture](docs/desktop-client-architecture.md) and the [development guide](docs/development.md) for implementation details.

## Bundled Safe Market

The [Safe Market](https://github.com/bruc3van/dsh-desktop-safe-market) ships with the installer. It is prepared offline before the first client-managed runtime starts, after checking its peer dependencies. Reusing a running local instance or connecting to a custom address does not modify its plugin configuration. User-installed marketplace versions remain user-managed, including older versions.

The marketplace is off by default. Enabling it downloads the catalog and caches the last successful result. Turning off the client’s bundled-market switch removes the client-owned registration on the next managed runtime launch. The switch does not manage a marketplace installed by the user.

![Safe Market](docs/images/marketplace.png)

Catalog data comes from [awesome-dsh-plugin](https://github.com/bruc3van/awesome-dsh-plugin):

- Repositories tagged `dsh-plugin` are collected daily.
- Archived, discontinued, and ineligible projects are excluded.
- A maintained exclusion list is applied, and catalog data is validated before display.

**Safe install** does not run an installation command. It fills a new conversation with a security-review prompt but does not send it.

After the user sends the prompt, the Agent checks credential access, data exfiltration, remote code execution, install scripts, obfuscated files, and requested permissions. Installation uses the official command only after review.

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

Smart mode can reuse an updated local instance, or the client can connect to a Web UI you manage. The bundled runtime is fixed at release time and is updated with the desktop client.

**Q: Does Safe Market install plugins automatically?**

No. Safe Market is off by default. **Safe install** only fills a review prompt; it does not send the prompt or install the plugin without user action.

## Related projects

- [awesome-dsh-plugin](https://github.com/bruc3van/awesome-dsh-plugin): catalog data for Safe Market. It collects plugin repositories daily and maintains exclusion records.
- [dsh-desktop-safe-market](https://github.com/bruc3van/dsh-desktop-safe-market): the Safe Market implementation bundled with this client.
- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness): the upstream project for the official dsh and Web UI.

## License

[MIT](LICENSE)

The MIT License covers only code and assets maintained in this repository. Official `@deepseek-ai/dsh` and other third-party dependencies use their own licenses. “DSH” identifies the compatible product and does not imply an official relationship.
