# DSH Desktop Pro

[中文](README.md) | English

**A desktop client for DeepSeek Harness (`dsh`). Individuals install it and start working; in a company, IT sets up models, plugins, skills and tool permissions once, and employees sign in and get to work.**

> [!IMPORTANT]
> **This is an unofficial community project.** It is not developed, published, endorsed, or supported by DeepSeek. `DeepSeek`, `DeepSeek Harness`, `dsh`, and related names and marks belong to their respective owners.

![DSH Desktop Pro home](docs/images/dsh-desktop-home.png)

The client loads the official Web UI, and the installer includes a pinned version of the official `@deepseek-ai/dsh` runtime, so no separate Node.js or `dsh` CLI is needed. The client manages the runtime, the tray, notifications, updates and security controls; the organisation features come from the client together with an open-source management server.

## Two ways to use it

| | Personal | Organisation |
|---|---|---|
| Getting started | Enter your own API key | IT provides a configuration; employees sign in with their company account |
| Models | Your own DeepSeek or other model account | The company model gateway, with each employee's own key |
| Plugins and skills | Installed by you | Assigned by IT; people can add their own |
| Data directory | `~/.dsh` or the client's own directory | A separate organisation directory; a personal `~/.dsh` is never touched |
| Deployment | None | One configuration file, or the management server (Docker Compose) |

It is one installer. On a machine without an organisation configuration, the client behaves exactly as for personal use.

> [!NOTE]
> The organisation features arrived in 0.7.0 and are in beta. Until the final release the protocol between client and server may change, so upgrade both together. See the [roadmap](docs/roadmap.md) (in Chinese) for progress.

## Download

Download the installer for your system from [GitHub Releases](https://github.com/bruc3van/dsh-desktop-pro/releases). Release builds already contain the official dsh runtime and do not run npm installation on first launch.

| Your device | Package to choose |
|---|---|
| macOS, Apple Silicon (Apple M series) | `mac-arm64.dmg` |
| macOS, Intel | `mac-x64.dmg` |
| Windows, 64-bit Intel/AMD | `win-x64.exe` |
| Linux, 64-bit Intel/AMD | `linux-x86_64.AppImage` |
| Ubuntu 24.04, 64-bit Intel/AMD installer | `linux-amd64.deb` |

These are filename suffixes; the full name also includes the client version. For Linux installation steps and requirements see the [user guide](docs/user-guide.md#install-on-linux-x64).

macOS/Windows packages do not yet have full developer signing and notarization, so the operating system may block the first launch:

- **macOS:** Move the app to Applications and open it. Then go to **System Settings → Privacy & Security** and choose **Open Anyway**. If macOS reports that the app is damaged and does not show **Open Anyway**, run:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/DSH Desktop Pro.app"
  ```

- **Windows:** In Microsoft Defender SmartScreen, choose **More info**, then **Run anyway**.

## Getting started

**Personal use**

1. Enter an API key on first launch, or choose **Configure later**. Create a key at <https://platform.deepseek.com/api_keys> if needed; DeepSeek manages the account, balance, and charges.
2. Choose an Agent preset or model if needed.
3. Add and select a project folder as the conversation's workspace.
4. Start a conversation and send the task.

> [!TIP]
> A fresh data directory may start in English. Change the language under **Settings → General → Language**.

**Employees**

Once IT has placed the configuration, the client shows "Sign in to <company>". Click it, sign in with your company account in the system browser, and return to the client to use the models and plugins your company set up.

**IT administrators**

Start with the [enterprise deployment guide](docs/enterprise.md): try file mode on one computer first, then decide whether to run the management server.

## The client

- It keeps running in the background after the window closes and reopens from the tray or menu bar.
- An official Web UI already running on the machine is reused; otherwise the client starts and manages the bundled runtime. It can also connect to an address you specify.
- On first launch it subscribes to a curated plugin index you can browse and install from on the Discover page. The client only adds the subscription; it does not install plugins for you.
- It updates itself, and checks update packages against SHA-256 before installing.
- Windows run sandboxed with context isolation, and navigation and permissions are restricted.

Connection modes, data directories and updates are covered in the [user guide](docs/user-guide.md).

## Organisation features

![Management console overview: rollout progress, devices that need attention, and organisation figures](docs/images/console-overview-en.png)

### Two ways to deploy

- **File mode**: place one `managed.json` in a system directory; the client opens straight onto the company's model gateway, with plugin indexes, skills and tool restrictions applied. No server is needed, and the file can be signed against tampering.
- **Server mode**: run the open-source management server (Docker Compose + PostgreSQL); employees sign in with company SSO (any OpenID Connect provider), and IT manages everything below from the console.

### Configuration rollout

- Profiles bundle models, plugin indexes, skills and tool permissions, and are assigned to everyone, a department or a person.
- Online devices apply a changed configuration within seconds; offline, a device keeps using the last configuration within a grace period.
- The console shows whether each device runs the current configuration, and which devices failed and why.
- When IT allows it, employees can switch between organisation mode and personal mode. Organisation mode uses a separate data directory, so personal data is unaffected.

### Models, usage and limits

- The server's built-in model gateway connects to any OpenAI-compatible API, with as many upstreams as you need; LiteLLM can be used instead.
- The real key for the company's model service stays on the server; employees' machines hold only their own keys.
- Requests, tokens and cost by member, department and model, with a request log you can export for finance.
- Cost or token limits for the company, departments and people; when one is used up, requests are refused or continue on a cheaper model.

### Plugin market and skill library

- Plugins IT has reviewed go into the company plugin market at a pinned version and appear first on people's Discover page; a risky plugin can be blocked, which removes it from every computer.
- A skill library for the company's skills: install one for everyone, or let people choose in the client.

### Security and audit

- When an employee is disabled, their key stops working at once and their device removes the organisation's configuration.
- IT can disable specific tools. Disabled tools are not offered to the model, and blocked calls are recorded in the audit log.
- Each audit record is chained to the previous one, so edited or deleted records can be detected.
- Configuration sent to clients is signed and verified before it is applied.

The console is available in Chinese and English. For deployment steps see the [enterprise deployment guide](docs/enterprise.md).

## Status and roadmap

- **Now**: 0.7.0 beta. No new features are added before the final release, only hardening, fixes and pilot feedback.
- **Next beta**: Feishu (Lark), DingTalk and WeCom sign-in and directory sync (merged to the main branch, not yet released).
- **After the final release**: more charts of configuration rollout, devices and usage; finer audit filtering and export; employees submitting the skills they write to the company skill library, for colleagues to install once reviewed.

The [roadmap](docs/roadmap.md) (in Chinese) lists what each step must meet; the [CHANGELOG](CHANGELOG.md) records what has shipped.

## Documentation

- [User guide](docs/user-guide.md): connection modes, data and security, background operation and updates, the bundled runtime, the preset plugin subscription.
- [Enterprise deployment guide](docs/enterprise.md): file mode, server deployment, the model gateway, the console and SSO.
- [Desktop client architecture](docs/desktop-client-architecture.md): process model, trust boundary and design decisions.
- [Development guide](docs/development.md): running from source, verification and releases.
- [Roadmap](docs/roadmap.md) (in Chinese) and [architecture decision records](docs/adr): the plan and the decisions already made.
- [Contributing](CONTRIBUTING.md).

## FAQ

**Q: Can individuals use it?**

Yes. Without an organisation configuration the client is a complete personal desktop client and needs no server.

**Q: Does organisation mode read or change my personal data?**

No. Organisation mode uses a separate data directory and does not read or write a personal `~/.dsh`. After switching back to personal mode, your own sessions and plugins are still there.

**Q: Is this a browser wrapper?**

The window loads the official Web UI, but the client also manages runtimes, connections, the tray, notifications, permissions, updates and organisation configuration. It does not maintain a separate product interface.

**Q: Does the preset subscription install plugins automatically?**

No. The client only adds the index address. Whether and what to install is your choice on the Discover page, and installation is done by the official plugin manager.

## Related projects

- [awesome-dsh-plugin-pro](https://github.com/bruc3van/awesome-dsh-plugin-pro): source of the preset index. It collects plugin repositories daily and maintains exclusion records.
- [DSH Market Pro](https://github.com/bruc3van/dsh-market-pro): a marketplace for curated plugins, browsing, installation, updates, and optional post-install AI security review, bundled with the installer.
- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness): the upstream project for the official dsh and Web UI.

## License

[Apache-2.0](LICENSE)

From 0.6.0 this repository is licensed under the Apache License 2.0; releases up to and including 0.5.29 remain under the MIT License. The license covers only code and assets maintained in this repository. Official `@deepseek-ai/dsh` and other third-party dependencies use their own licenses. “DSH” identifies the compatible product and does not imply an official relationship.
