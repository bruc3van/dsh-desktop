# DeepSeek Harness Desktop

[中文](README.md) | English

**Keep your Agent safely resident on your desktop: the official Web UI untouched, long tasks no longer hostage to a terminal or a browser tab, curated plugins reviewed before install.**

DeepSeek Harness Desktop is an independent Electron client for `dsh`. The window shows the official Web UI itself — not a look-alike; whatever the official product is, that is what the window shows. The real engineering lives outside the window: tasks keep running when you close it, the app stays resident in the tray, the Agent runs in a governed execution environment, plugins go through a review-before-install marketplace, and the connection and update paths are hardened layer by layer.

> [!IMPORTANT]
> **This is an unofficial, community-maintained third-party project.** It is not developed, published, endorsed, or supported by DeepSeek and does not represent DeepSeek. `DeepSeek`, `DeepSeek Harness`, `dsh`, and related names, logos, and trademarks belong to their respective owners. Report desktop-client issues to this repository, not to DeepSeek support.

Release packages bundle a pinned version of the official `@deepseek-ai/dsh` runtime. End users do not need to install Node.js, pnpm, or the `dsh` CLI separately. The desktop shell, installers, connection enhancements, and release signatures are independently maintained by this project and are not part of the official runtime. The desktop client and official `dsh` use independent version numbers; the connection settings page displays both for compatibility diagnostics.

![DeepSeek Harness Desktop home screen (dark theme)](docs/images/readme-home-dark.jpeg)

## Why use the desktop client?

Start from how Harness is actually used. Usage is shifting from *conversations* to *delegating long-running tasks*, and the pain of long tasks lives entirely outside the window: you dare not close the tab while a task runs; closing the terminal kills the service; the Agent's environment cannot find `node` or the tools configured in your shell; a process with file access runs an unhardened update path. The interface itself is the part least in need of a rewrite — the official Web UI evolves quickly, and what users want is exactly that, untouched.

So this project hands the interface back to the official product and **spends all engineering effort outside the window: residency and long tasks, the Agent's execution environment, the bundled safe marketplace, security hardening, connection and updates.** The benefits of this approach hold on their own:

| What users need | Our design choice |
|---|---|
| Long tasks are not hostage to a terminal or a browser tab | Closing the window does not quit the app; the service keeps running in the background, and the tray brings it back in one click |
| The Agent runs in *your* environment | Your running instance / PATH `dsh` / npx-cached package come first; macOS login-shell `PATH` alignment; `node` is always available |
| Security and privacy are the baseline | A small boundary plus layered hardening: public interfaces only; an unhijackable update path; least-privilege permissions |
| You want to know a plugin is safe before installing it | The bundled safe marketplace: a catalog collected daily and curated by hand, with the Agent reviewing the code before install |
| All of Harness's capabilities, nothing missing | The window shows the official Web UI itself — no interface rewrite |
| Day-zero official features | Delivery is decoupled from our own releases: Smart mode reuses the newest `dsh` you already have; the bundled runtime is only a fallback |
| Works out of the box, no environment setup | The installer carries the official runtime: no Node.js to install, no commands to type — launch and go |
| Work continues across terminal and desktop | Smart mode shares `~/.dsh` with the CLI and browser; Pinned address connects to a Web UI address you maintain |

And here is what that means in the product:

- **Long tasks stay resident on the desktop.** Closing the window does not interrupt the task: the app stays in the tray / menu bar, the Harness service keeps running in the background, and one click brings the window back. A local service that exits unexpectedly gets a bounded number of restarts, and a blank page after system resume or a long idle recovers automatically once the service is reachable. A terminal window or a browser tab gives you none of that.
- **An engineered Agent execution environment.** An Agent is ultimately a process running commands on your machine, and its environment deserves engineering: your running instance and the `dsh` on PATH come first, so the Agent runs inside your own complete shell environment; on the bundled runtime, users without Node.js still get an Agent that can run `node`; `ELECTRON_RUN_AS_NODE` never leaks into Agent commands (otherwise Electron-based tools like `code` would fail); launching from Finder or the Dock still finds Homebrew, `~/.local/bin`, and tools exported from `~/.zshrc`. See [The Agent's execution environment on the bundled runtime](#the-agents-execution-environment-on-the-bundled-runtime).
- **Security is the identity, not a feature-list item.** An app that can read and write your files deserves the most conservative distribution: the client speaks only the public `dsh web` interface and never touches the official repo's internals; the window runs sandboxed with Node integration disabled and navigation locked to the official origin; in packaged builds the update source and data directories cannot be hijacked via environment variables; in-app updates verify SHA-256 before installing; the renderer gets only clipboard and fullscreen permissions; external links always open in the system browser. See [Security and privacy](#security-and-privacy).
- **A review-before-install marketplace.** The bundled marketplace ships with the installer and is off until enabled; its catalog comes from daily automatic collection plus manual curation at the data-source repo, and Safe install runs no install commands itself — it hands a security-review prompt to the Agent, which reads the code first and installs with the official command only once you are satisfied. See [The bundled safe marketplace](#the-bundled-safe-marketplace).
- **Day-zero official features.** The window loads the official Web UI itself, not a look-alike. When the official interface adds features or changes interactions, the official docs, tutorials, and shortcuts all match exactly — no "the tutorial shows something your screen doesn't". When the official project ships, upgrade the `dsh` you already have (or let the in-app update push the bundled runtime) and the desktop client follows with zero changes and zero waiting.
- **Launch and go — no command line required.** The installer carries the official runtime: no Node.js or pnpm to install, no commands to type, and first launch is just entering an API key. For newcomers that is the whole story; if you do know the command line, Smart mode and Pinned address are right there when you want them.
- **Smart mode reuses the instance you are already running.** It probes in order: the official instance on `127.0.0.1:3080` (including other ports configured in `~/.dsh/profiles/web/cordis.patch.yml`) → a `dsh` on PATH → an npx-cached package → the bundled runtime. Browser, CLI, and desktop then share one live Harness process, with sessions synced in real time.
- **Pinned address connects to a Web UI address you maintain.** Enter its address and connect directly; the client starts no runtime of its own — version, plugins, and environment stay entirely under your control. Official dsh is currently local-only: it listens on `127.0.0.1` by default and deliberately rejects the network-exposing `0.0.0.0` bind (which would enable remote code execution), so remote or containerized instances are not an officially supported scenario.
- **Transparent runtime status.** Five statuses describe exactly who started the runtime (reusing yours / bundled / npx-cached / installed / pinned address), and the client shows both its own version and the bundled dsh version, so troubleshooting never involves guessing.
- **A self-checking release pipeline.** An empty-PATH package smoke test (the artifact must really use its bundled runtime), an update-feed fixture, runtime-environment isolation checks, the Win32 picker patch, and a real-request e2e run — a set of gates that rejects artifacts that build but don't work. See the [development guide](docs/development.md).

## Quick start

### Download a release

Download the package for your system from [GitHub Releases](https://github.com/bruc3van/dsh-desktop/releases) and launch it. Release builds include the official `dsh` runtime, require no development tools, and do not run an npm install on first launch.

Automated packages are currently unsigned on macOS and Windows. The operating system may show a first-launch security warning; until signing and notarization are configured, this remains a known limitation of the "download and run" experience. Download only from this repository and verify the included `SHA256SUMS.txt`.

#### If the operating system blocks the first launch

- **macOS:** Current packages are not yet signed and notarized with an Apple Developer ID. Download the DMG only from this repository's Release and first verify its SHA-256 in Terminal:

  ```sh
  cd ~/Downloads
  shasum -a 256 dsh-desktop-*.dmg
  ```

  Compare the output with the matching file in `SHA256SUMS.txt` from the same Release. If it matches, drag the app to **Applications**, double-click it once, then open **System Settings → Privacy & Security** and choose **Open Anyway** in the Security section. Enter your login password when prompted. The button is available only for a limited time after the launch attempt. See [Apple's official instructions](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac).

  If macOS still says the app is damaged and **Open Anyway** is unavailable, run the following only after the SHA-256 has been verified:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness Desktop.app"
  open "/Applications/DeepSeek Harness Desktop.app"
  ```

  This removes the download quarantine attribute only from this app. It does not disable Gatekeeper globally and does not require `sudo`. If the checksum does not match, delete the file and download it again instead of running the command.
- **Windows:** If Microsoft Defender SmartScreen shows a protection prompt, first verify the download source and SHA-256 checksum. Then choose **More info → Run anyway** only if they match.

### First conversation

1. On first launch, enter your key in **Add an API key to get started**. You can also choose **Configure later** and return through **Settings → Models → DeepSeek**.
2. If you do not have a key, use **Create one on the DeepSeek platform** below the field; it opens <https://platform.deepseek.com/api_keys> in your system browser. The link is a desktop-client enhancement. DeepSeek manages the API account, balance, and usage charges.
3. Optionally choose a default Agent preset or model.
4. Add a project folder for workspace-aware tasks, or start a conversation directly.
5. Describe the outcome you want and send the message.

> [!TIP]
> With a fresh data directory, the official Web UI may initially appear in English. Use **Settings → General → Language** to switch languages.

## Two connection modes

The client serves two audiences, and both paths are first-class:

- **The bundled runtime** exists so the app works the moment it is installed. Releases carry a pinned official runtime; no Node.js, pnpm, or `dsh` CLI required.
- **Connecting to a full runtime you manage** exists for developers. Run `dsh web` in your own terminal and the desktop client is only the window onto it, leaving runtime version, plugins, and environment entirely under your control. Official dsh currently targets local use only (`127.0.0.1` by default; the network-exposing `0.0.0.0` bind is rejected), so instances on another machine or in a container are outside official support.

| Mode | Best for | Behavior |
|---|---|---|
| **Smart** (default) | Most local users | Tries in order: the official instance on `127.0.0.1:3080` → a `dsh` on PATH → an npx-cached official package → the bundled runtime. |
| **Pinned address** | A Web UI instance you maintain (official dsh currently targets local use only) | Connects to the Web UI address you provide and starts no runtime of its own. |

In Smart mode, an official Web UI already running in your terminal is reused as-is — the developer path: sessions stay shared with the desktop window while the Agent runs inside your own complete shell environment.

Smart mode uses only what **already exists** on your machine — a `dsh` on PATH or the official package npx has cached — nothing is downloaded, and Node.js is never installed for you. The official `dsh web` port can also be written in the web profile's patch layer (`~/.dsh/profiles/web/cordis.patch.yml`) besides the `--port` flag, and the client reads and probes those ports too — it will not start a second harness beside an instance you simply moved. When an npx-cached package is older than the bundled runtime, the connection settings say so (the cache still wins — it is what your last `npx @deepseek-ai/dsh` left behind; running it again refreshes it). Whatever the client starts is a plain background service (`dsh web --port 0`), shut down when you quit; if the chosen runtime fails to start, the client falls back to the bundled one automatically. If the bundled runtime cannot start, or you want another instance, open the application menu and choose **Web UI Connection…**. The full runtime-resolution order is documented in the [development guide](docs/development.md#run-from-source).

Enter an address and choose **Save and connect** to store and use it immediately. While a pinned address is active, **Switch to Smart mode** is shown as a separate escape; the address remains saved, so **Save and connect** can use it again later.

Connection status is described by **who started the runtime**, so "local" and "bundled" no longer overlap:

| Status | Meaning |
|---|---|
| Reusing the dsh you started | An instance you ran yourself (`127.0.0.1:3080` by default) |
| Client-started · bundled runtime | A background child using the runtime shipped in the installer |
| Client-started · npx-cached dsh | A background child using the official package npx already cached |
| Client-started · installed dsh | A background child using the `dsh` you installed on PATH |
| Pinned address | A direct connection; the client starts no runtime |

> Choosing **Save and connect** for `127.0.0.1:3080` — the default probe address — keeps the client in Smart mode. Smart already prefers that instance and can still fall back automatically when it stops.

Leave the Web UI address empty to return to Smart mode. Connection settings can be changed from the enhanced block in General Settings or from **Web UI Connection…** in the application menu.

> [!TIP]
> Connecting to an instance outside this machine is currently outside official support; if you still do (for example through your own SSH tunnel), use a trusted network and HTTPS where available. The configured address is a direct connection target, not a relay operated by this project.

## Security and privacy

The desktop shell and the Harness runtime keep separate responsibilities:

| Data | Default location | Owner |
|---|---|---|
| Conversations, credentials, model configuration, and official Harness state | `~/.dsh` | Official `dsh` runtime |
| Desktop connection preference | `~/.dsh-desktop/settings.json` | Desktop client |

Override these locations with `DSH_HOME` and `DSH_DESKTOP_HOME` respectively.

The client's security strategy is a small boundary plus layered hardening:

- **A small boundary.** The client uses only the public `dsh web` CLI and `/api` contract. It does not patch the official repository or import private Harness internals.
- **Window hardening.** The Electron window runs with context isolation and sandboxing enabled, Node integration disabled, navigation restricted to the configured Web UI origin, and external links opened in the system browser.
- **An update path that cannot be hijacked.** In packaged builds, the update source and GitHub API addresses, the data directories (`DSH_HOME`, `DSH_DESKTOP_HOME`), and the connection-probe switch cannot be overridden by environment variables. The updater validates installer filenames in the update manifest against path traversal outside the download directory.
- **Least-privilege permissions.** Renderer permission requests are limited to clipboard writes and fullscreen; camera, microphone, and other device permissions are rejected. Unauthorized in-page navigation and new-window redirects are blocked; only trusted origins are allowed.
- **Review before plugin install.** The bundled safe marketplace is off by default and only talks to the network once enabled; Safe install runs no install commands — it hands a review prompt to the Agent and only you decide whether to install with the official command; the market works with whichever runtime the client starts (the bundled one, a dsh you installed, an npx-cached one) — its plugin is copied into the profile the way any plugin is, so the client's internal copy is never handed to another runtime. See [The bundled safe marketplace](#the-bundled-safe-marketplace).

Use of this client remains subject to the terms and privacy policies of DeepSeek, model providers, and any connected service. Users and those services are responsible for API keys, model requests, charges, generated content, and Agent actions on local files or commands. The software is provided "as is" under the MIT License, without warranties of fitness, data preservation, service availability, model output, or third-party cost, except where applicable law requires otherwise.

## Desktop behavior

- Closing the main window keeps the app available in the system tray/menu bar.
- Reopen the window from the tray icon.
- Quit from the tray menu, application menu, or `Cmd+Q` on macOS.
- Packaged builds check GitHub Releases for a newer version a few seconds after launch (at most once every 12 hours). You can also check from **Settings → General → App updates**, the tray menu, or the macOS application menu. After you confirm, the client downloads the installer, verifies its SHA-256, and launches it — the local runtime is stopped only after the download and verification succeed and just before the installer starts, so a failed download or verification, or an installer that never launches, leaves the runtime intact or restores it. Unpackaged development builds do not auto-check.
- Never two writers on one `DSH_HOME`: the client records the runtime it started under `DSH_HOME`, and the next launch prefers to adopt a surviving legacy process (same harness, sessions shared) over starting beside it; it cleans up and restarts only when adoption is impossible, and refuses to start — with a reason — when a leftover process can be neither reached nor killed. Two harnesses appending to the same session store corrupt it permanently.
- If the official `127.0.0.1:3080` instance reused by Smart mode disappears, the client falls back to its managed local `dsh web`. A failed fixed remote connection never switches to a local service implicitly.
- If a locally managed Web UI exits unexpectedly, the client performs a small number of bounded restart attempts instead of retrying forever.
- If the page is unexpectedly blank after system resume or a long idle, the client verifies the Web UI and reloads it automatically.
- Before starting the local service, the packaged macOS app reads the user's shell `PATH` once — an interactive login shell first (three-second deadline), falling back to a plain login shell (two seconds) — and merges only absolute directories. This keeps Homebrew, `~/.local/bin`, and directories exported from `~/.zshrc` available to Agents when the app starts from Finder or the Dock.

## The Agent's execution environment on the bundled runtime

On the bundled runtime the Agent's capabilities match official `dsh` — same runtime, same `~/.dsh`, same OS-level sandboxing. The execution environment is aligned with "running dsh in your own terminal" as follows:

- **`node` is always available.** Packaged builds publish Electron's own Node under the name `node` in `~/.dsh-desktop/bin` and **append** that directory to the runtime's `PATH`. A user who never installed Node still gets an Agent that can run `node script.js`; a user who did keeps their own version first. The directory provides no `npm`/`npx` — for those (starting an MCP server with `npx`, say) install Node.js or use Pinned address mode. The shim works by setting `ELECTRON_RUN_AS_NODE` so Electron runs as Node, so **processes started through it, and their own children,** carry that variable: a node script that goes on to launch an Electron-based tool must clear it, or use a real Node.js install.
- **The Agent's environment stays clean.** The bundled runtime relies on `ELECTRON_RUN_AS_NODE` to run on Electron's Node, which is an implementation detail of how it is launched. The client removes that variable once the runtime starts and re-attaches it only where the runtime itself respawns Node (the native folder picker, the Windows ACL sandbox runner), so the Agent's own commands never inherit it — otherwise every Electron-based tool the Agent runs (`code`, for instance) would fail.
- **File permissions.** The app does not enable the App Sandbox, so the Agent's file access is that of an ordinary user process. On macOS the first access to Desktop, Documents, or Downloads is prompted in this app's name, and grants are recorded per application — permissions already given to your terminal do not carry over. The system prompt states the purpose.
- **Pinned version.** The bundled runtime ships with the installer and cannot be upgraded on its own. To track the latest official release, use Pinned address mode with a runtime you maintain — this is the developer path to day-zero official features.

## The bundled safe marketplace

The client installs the [safe marketplace](https://github.com/bruc3van/dsh-desktop-safe-market) (`dsh-desktop-safe-market`) shipped in the installer the way official in-box bundles are installed: the plugin is copied into `<DSH_HOME>/profiles/node_modules` and its name goes into the profile's `dsh.profile.bundles` — no dependencies written, no lockfile touched, no pnpm, no network; upgrading the plugin means upgrading the client. **Every runtime the client starts can use it**: the bundled one, a `dsh` you installed on PATH, and the cache `npx @deepseek-ai/dsh web` leaves behind. Copying the plugin into the profile rather than linking it into the closure is what makes that work — its `@deepseek-ai/*` imports then resolve upward to whichever runtime is serving, the same path a plugin you installed with `dsh plugin add` takes. A **Plugin marketplace** nav item then appears in settings, with two pages: **Plugins** shows the installed panel (view, disable/enable, and uninstall the plugins installed in the current profile as packages) above the community market, and **Skills** lists the skills actually resolvable in the current session. A pinned address still withdraws the entry — the client does not start that runtime (it may not even be this machine), so it cannot know when the change would take effect. Reusing an instance already running on 3080 re-seats it conservatively instead (name only, never a tree swap): that instance is demonstrably serving this profile, and once it stops the client falls back and re-gates the seat on its own next spawn.

**If you do not want it**: connection settings carry a marketplace switch (the enhanced connection card is currently Chinese-only — it is the checkbox below the address field). Turning it off removes the marketplace plugin immediately, and it stays gone across restarts. Even with the client already uninstalled, the market's own installed panel can uninstall the plugin — the official `dsh plugin` command does not manage this copy, so the panel is the last door.

![Plugin marketplace in settings: the curated catalog dealt evenly across categories, with the market's own version beside its title](docs/images/marketplace.png)

The market makes three deliberate choices:

- **A catalog collected daily and curated by hand.** The market reads only the `market.json` published by the data-source repo [awesome-dsh-plugin](https://github.com/bruc3van/awesome-dsh-plugin)'s daily snapshot pipeline: upstream automatically crawls repositories tagged `dsh-plugin` every day, requires a description, drops archived or discontinued projects, and applies the hand-maintained `curated.json` exclusion list; categories are dealt evenly — each category's strongest entry first, then the next-strongest — rather than sorted purely by stars. The market re-validates every row host-side before the page sees it. Installing a plugin is running someone else's code on your machine; this catalog separates "what plugins exist" from "what has at least passed a first manual gate".
- **Off by default; the network is opt-in.** While the market is off it makes no network requests. Enabling it fetches a catalog snapshot once and persists it (`$DSH_HOME/storages/safe_market.json`); later reads use ETag conditional requests, and when GitHub is unreachable the last catalog is reused. A plugin that starts talking to the network the moment it is installed has made the decision for you; this switch hands it back.
- **Review before install.** Safe install runs no install commands of its own: it opens a new session and **fills the input box with a security-review prompt without sending it**, so pressing Enter has the Agent actually read the repository code — credentials/token access, exfiltration to third parties, remote code execution, install scripts like `postinstall`, obfuscated files with no matching source, and permissions far beyond what the plugin claims; anything suspicious must stop and ask you, with reasons. Only once it is clean does the Agent install with the official `dsh plugin --profile web add` command. Review and install are therefore inseparable; sending is your decision, and **inclusion is not a security endorsement** — read the code yourself.

![After Safe install: the review prompt is written into a new session's composer and left there for you to send](docs/images/marketplace-sec-install.png)

A catalog row already installed into this profile is marked **Installed vX.Y.Z**, and its button reads **Review and upgrade** — the same review-first hand-off, whose prompt begins by having the Agent establish whether upstream actually publishes anything newer, and change nothing if it does not. Day-to-day management of what is installed lives in the installed panel at the top of the same page:

![The installed panel: version, live state, and the disable/enable and uninstall verbs](docs/images/marketplace-installed.png)

The **Skills** page lists the skills the current session can actually resolve. It is addressed by session because skill discovery is layered by the agent preset a session runs — read from the plugin's root context it would see only the global layer and report "no skills" while a dozen are in reach:

![The Skills page: what the current session resolves, with each skill's provider and invocation policy](docs/images/marketplace-skills.png)

The client treats this install with the same care as everything else it does: failure self-heals — a plugin that throws while loading fails the whole plugin tree (and the CLI sharing the profile), so a failed install is removed and not retried this session; the client never writes `bundles` when the plugin directory is missing or a non-symlink directory occupies `profiles/node_modules`, so your profile can never be corrupted; and if you installed the plugin yourself as a profile dependency at a version no older than the bundled copy, the client stays out of the way entirely — a stale overlay is lifted onto the closure. A runtime older than the dsh this client ships does not get the market at all: the plugin is built against that version and an older runtime may not export what it imports. Newer ones are allowed, and the plugin guards itself as well — its entry reaches the real body only through a guarded dynamic import, so meeting a runtime it cannot run on costs the market and nothing else. The market's full design (configuration, catalog protocol, security boundaries, and known limitations) lives in its [repository](https://github.com/bruc3van/dsh-desktop-safe-market).

## FAQ

**Q: Is this a browser wrapper, or a rewrite on the SDK?**

Neither: the window loads the official Web UI itself, but the client is not just "a web page in a frame" — runtime startup and reuse, connection management, window and navigation hardening, the tray, and in-app updates all live in the shell layer, and this repository maintains no second product renderer (trade-offs and rejected alternatives are documented in the [architecture notes](docs/desktop-client-architecture.md)). Desktop clients in the DeepSeek Harness ecosystem mostly take one of three routes; this project chose the third:

| Route | Approach | Structural cost |
|---|---|---|
| ① Self-built workbench UI (e.g. [RongleCat/deepseek-app](https://github.com/RongleCat/deepseek-app)) | The Harness engine runs inside the app; the interface is a self-built three-column workbench, not the official Web UI | Every new feature of the official product surface has to be re-implemented in that UI |
| ② Packaging wrapper (e.g. [anywhere-labs/deepseek-harness-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)) | Builds a desktop client on top of the official repository, covering service lifecycle, window and tray integration, UI adaptation, and installer releases | Official updates require merging upstream and cutting a new release before they can follow |
| ③ Native direct-connect (this project) | The window loads the official Web UI directly; engineering goes into residency and long tasks, the Agent's execution environment, security, and connection | No self-built UI; desktop enhancements are bounded by what the official interface can carry |

**Q: What's the main value for users?**

1. **Your Agent stays resident on the desktop**: closing the window does not quit the app, the tray brings it back in one click, and long tasks are no longer hostage to a terminal or a browser tab; the Agent's execution environment is governed — it reuses your own shell environment and PATH, and `node` is always available on the bundled runtime;
2. **A trustworthy way to run it**: public interfaces only, window sandboxing and navigation lockdown, an unhijackable update path with SHA-256 verification, least-privilege permissions — a process with file access deserves this treatment;
3. **The official experience, working as installed**: the window is the official Web UI itself, so official docs, tutorials, and shortcuts all match; the installer carries the official runtime — no Node.js, pnpm, or `dsh` CLI to install; Smart mode reuses the instance you are already running and shares `~/.dsh` sessions, and Pinned address connects straight to an address you maintain.

**Q: How is this different from just using a browser — besides not installing Node.js?**

The official browser path is: install Node.js, run `npx @deepseek-ai/dsh web`, then open the address it prints — and when that terminal closes, the service stops. The client turns this into a managed setup: closing the window does not quit the app, which stays in the tray, so long tasks no longer depend on a terminal you dare not close; the installer carries the runtime and launches with a double-click; Smart mode first probes the instance you're already running, then starts a background service from a `dsh` on PATH or an npx-cached package, and only falls back to its bundled runtime; on top of that come in-app updates and transparent display of the connection source and versions, which a plain browser tab does not have.

**Q: Why emphasize "day-zero official features"?**

A client with a self-built UI or modified source has to re-implement, or merge upstream and re-release, before it can follow an official update; this project's window loads the official Web UI directly, so whatever the official interface changes into is what the window shows. Along the update paths specifically: Smart mode reuses the `dsh` you already upgraded, and Pinned address connects to the newest instance you maintain — both are available the day the official project ships; the bundled runtime is pinned to the official version locked at release time and follows via in-app updates, slightly behind the official release.

**Q: Is there a plugin marketplace? What else is planned?**

Yes: the [safe marketplace](https://github.com/bruc3van/dsh-desktop-safe-market) shipped in the installer (shown in settings as **Plugin marketplace**). It is installed the way official in-box bundles are (copied into `profiles/node_modules`, with its name in `dsh.profile.bundles`) for whichever runtime the client starts, and is off until enabled — only then does it talk to the network. A pinned address withdraws that entry, because the client does not start that runtime; reusing an already-running local instance re-seats it conservatively (name only, never a tree swap). The daily-collected, hand-curated catalog and the review-before-install flow are described in [The bundled safe marketplace](#the-bundled-safe-marketplace). Capabilities of the official Web UI itself (skills, plugins, interactions) still appear in the window as the official project ships. Work on the desktop shell itself is listed in the [development guide](docs/development.md#project-status) and [TODO](TODO.md): macOS/Windows signing and notarization, system notifications, OS keychain integration, voice input, an independent update channel for the bundled runtime, and periodic probing of newly appeared instances.

## Development

Source development requires Node.js `^22.19.0 || >=24.0.0` and [pnpm](https://pnpm.io/). A separate `dsh` installation is not required:

```sh
git clone https://github.com/bruc3van/dsh-desktop.git
cd dsh-desktop
pnpm install
pnpm run dev
```

Build commands and gate scripts, runtime-resolution details, the release process, and current project status are documented in the [development guide](docs/development.md); for the process model, trust boundary, and design decisions see [Desktop client architecture](docs/desktop-client-architecture.md). Contributions and issue reports are welcome, especially around Windows behavior, Pinned address connections, and packaging.

## Related projects

**Maintained by the author**

- **[awesome-dsh-plugin](https://github.com/bruc3van/awesome-dsh-plugin)** — find the right plugin for your DeepSeek Harness (DSH) in 30 seconds. Not another repo list: every repository on GitHub tagged `dsh-plugin` is crawled daily by script and then verified one by one by a human — genuine plugins enter the catalog, topic riders land on the blacklist, and every exclusion reason is public to check. It also tells you who each plugin is for and where to start. The bundled safe marketplace's catalog data comes from it; see [The bundled safe marketplace](#the-bundled-safe-marketplace).
- **[dsh-desktop-safe-market](https://github.com/bruc3van/dsh-desktop-safe-market)** — the review-before-install DSH marketplace. It powers the **Plugins marketplace** bundled with this client: the catalog is collected daily and curated by hand, and Safe install hands a security-review prompt to the Agent, installing with the official command only after a clean reading. Configuration, the catalog protocol, and known limitations live in its repository.

**Official repositories**

- **[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)** — DeepSeek Harness: Everything is a Plugin. The upstream project behind the official `dsh` and Web UI: this client's window loads the official Web UI itself, and the bundled runtime is the official `@deepseek-ai/dsh` — this project is an unofficial third-party desktop client for it.

## License

[MIT](LICENSE)

The MIT License covers only code and assets maintained in this repository. The bundled official `@deepseek-ai/dsh` runtime and other third-party dependencies remain under their own licenses. "DeepSeek Harness" is used in the project name only to identify the compatible product; it does not imply an official relationship.
