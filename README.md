# DSH Desktop Pro

中文 | [English](README_EN.md)

**DeepSeek Harness（`dsh`）的桌面客户端。个人装好就能用；在公司里，IT 统一配置模型、插件、Skill 和工具权限，员工登录后即可开始工作。**

> [!IMPORTANT]
> **这是社区维护的非官方项目。** 本项目不是 DeepSeek 官方产品，也不代表 DeepSeek。`DeepSeek`、`DeepSeek Harness`、`dsh` 及相关名称和标识归各自权利人所有。

![DSH Desktop Pro 首页](docs/images/dsh-desktop-home.png)

客户端直接加载官方 Web UI，安装包内置固定版本的官方 `@deepseek-ai/dsh` 运行时，不需要另装 Node.js 或 `dsh` CLI。客户端负责运行时管理、托盘、通知、更新和安全控制；企业功能由客户端和开源的管理服务端共同提供。

## 两种用法

| | 个人使用 | 企业使用 |
|---|---|---|
| 怎么开始 | 安装后填入自己的 API Key | IT 下发配置，员工用公司账号登录 |
| 模型 | 自己的 DeepSeek 或其他模型账号 | 公司模型网关，员工用各自的 Key |
| 插件与 Skill | 内置插件市场（DSH Market Pro）与精选订阅，按需安装 | IT 统一下发，个人也可以另装 |
| 数据目录 | `~/.dsh` 或客户端独立目录 | 独立的企业目录，不碰个人 `~/.dsh` |
| 需要部署 | 不需要 | 一个配置文件，或管理服务端（Docker Compose） |

同一个安装包。没有企业配置的电脑，行为和个人使用完全一样。

> [!NOTE]
> 企业功能自 0.7.0 起正式提供，升级服务端时建议同步升级客户端以保持协议一致。后续规划见[路线图](docs/roadmap.md)。

## 下载安装

从 [GitHub Releases](https://github.com/bruc3van/dsh-desktop-pro/releases) 下载对应系统的安装包。发布版已经包含官方 dsh 运行时，首次启动不会执行 npm 安装。

| 你的设备 | 选择的安装包 |
|---|---|
| macOS，Apple Silicon（Apple M 系列） | `mac-arm64.dmg` |
| macOS，Intel | `mac-x64.dmg` |
| Windows，Intel/AMD 64 位 | `win-x64.exe` |
| Linux，Intel/AMD 64 位 | `linux-x86_64.AppImage` |
| Ubuntu 24.04，Intel/AMD 64 位安装版 | `linux-amd64.deb` |

表中列出文件名后缀，实际文件名还包含客户端版本号。Linux 的安装步骤和系统要求见[使用指南](docs/user-guide.zh.md#linux-x64-安装)。

macOS/Windows 安装包尚未完成正式开发者签名认证，首次打开时系统可能拦截：

- **macOS**：将应用拖入“应用程序”并打开。然后前往“系统设置 → 隐私与安全性”，点击“仍要打开”。如果系统提示“已损坏，无法打开”且没有“仍要打开”按钮，在终端执行：

  ```sh
  xattr -dr com.apple.quarantine "/Applications/DSH Desktop Pro.app"
  ```

- **Windows**：在 Microsoft Defender SmartScreen 中点击“更多信息”，再点击“仍要运行”。

## 开始使用

**个人使用**

1. 首次启动时输入 API Key，或选择“稍后配置”。没有 Key 时，可在 <https://platform.deepseek.com/api_keys> 创建；账户、余额和费用由 DeepSeek 开放平台管理。
2. 根据需要选择 Agent 预设或模型。
3. 添加并选择项目文件夹，作为会话的工作区。
4. 新建会话并发送任务。

> [!TIP]
> 全新数据目录可能默认显示英文。可在 **Settings → General → Language** 中切换语言。

**企业员工**

IT 放好配置后，打开客户端会显示「登录 公司名」。点击后在系统浏览器里完成公司账号登录，回到客户端就能直接使用公司配置好的模型和插件。

**IT 管理员**

从[企业部署指南](docs/enterprise.zh.md)开始：先用文件模式在一台电脑上试，再决定是否部署管理服务端。

## 客户端

- 关闭窗口后继续在后台运行，可从托盘或菜单栏重新打开。
- 本机已有官方 Web UI 在运行时直接复用，否则由客户端启动并管理内置运行时；也可以连接指定地址。
- 首次启动自动订阅一份精选插件列表，在「发现」页浏览和安装；客户端只添加订阅，不替你安装插件。
- 内置 [DSH Market Pro](https://github.com/bruc3van/dsh-market-pro)（个人模式默认启用，可在桌面设置中关闭）：一站式管理插件、技能与 33 个精选 / 托管 MCP 服务器，支持一键批量更新、安装后 AI 安全审查，以及对话内 AI 原生选插件与配 MCP（`/dsh-market-pro`、`/dsh-mcp-pro`，可随时在市场设置中关闭）。
- 自动更新，更新包安装前校验 SHA-256。
- 窗口启用沙箱和上下文隔离，并限制页面导航与权限。

连接方式、数据目录和更新的细节见[使用指南](docs/user-guide.zh.md)。

## 企业功能

![管理控制台概览：配置生效进度、需要处理的设备和组织数据](docs/images/console-overview.png)

### 两种部署方式

- **文件模式**：把一份 `managed.json` 放到系统目录，员工打开客户端就能用公司的模型网关，插件订阅、Skill 和工具禁用一并生效。不需要服务端；配置文件可以签名防篡改。
- **服务端模式**：部署开源的管理服务端（Docker Compose + PostgreSQL），员工用公司 SSO（任意 OpenID Connect）登录，IT 在控制台里管理下面的全部内容。

### 配置下发

- 按全员、部门或个人下发「场景包」：模型、插件订阅、Skill 和工具权限打包在一起。
- 配置修改后，在线设备几秒内应用新版本；断网时在宽限期内继续使用上次的配置。
- 控制台显示每台设备是否已应用当前配置，以及出错的设备和原因。
- IT 允许时，员工可以在企业模式和个人模式之间切换；企业模式使用独立的数据目录，个人数据不受影响。

### 模型、用量与额度

- 服务端自带模型网关，对接任意 OpenAI 兼容接口，可以接多个上游；也可以改用 LiteLLM。
- 公司模型服务的真实 Key 只保存在服务端，员工电脑上只有各自的 Key。
- 按成员、部门和模型查看请求数、Token 和费用，可以导出明细给财务对账。
- 给全公司、部门和个人设置费用或 Token 额度；用完后拦截，或改用便宜的模型继续。

### 插件市场与 Skill 库

- IT 审核过的插件固定版本上架到公司插件市场，员工在「发现」页最前面看到；有风险的插件一键禁用，所有电脑都会卸载。
- 公司的 Skill 集中放在 Skill 库：可以给所有人装上，也可以让员工在客户端里自己选装。

### 安全与审计

- 员工停用后，他的 Key 立即失效，设备上的企业配置自动清除。
- IT 可以禁用指定工具，被禁用的工具不会提供给模型；调用被拦下时会记入审计日志。
- 审计日志逐条串联校验，被改动或删除的记录可以被发现。
- 下发给客户端的配置带签名，客户端校验后才应用。

控制台支持中文和英文。部署步骤见[企业部署指南](docs/enterprise.zh.md)。

## 版本状态与路线图

- **当前**：0.7.0 正式版，已包含企业文件 / 服务端双模式、SSO 与飞书 / 钉钉 / 企业微信身份源同步、组织自主加入、全新对齐官方规范的客户端界面、首次安装引导页以及内置 [DSH Market Pro](https://github.com/bruc3van/dsh-market-pro)。
- **后续方向**：更多配置分发、设备和用量图表；更细的审计筛选与导出；员工把自己写的 Skill 提交到公司 Skill 库，审核后同事直接安装。

每一步的完成标准见[路线图](docs/roadmap.md)，已发布的内容以 [CHANGELOG](CHANGELOG.md) 为准。

## 文档

- [使用指南](docs/user-guide.zh.md)：连接方式、数据与安全、后台运行与更新、内置运行环境、预置插件订阅。
- [企业部署指南](docs/enterprise.zh.md)：文件模式、服务端部署、模型网关、控制台和 SSO。
- [桌面客户端架构](docs/desktop-client-architecture.zh.md)：进程模型、信任边界和设计取舍。
- [开发指南](docs/development.zh.md)：从源码运行、验证和发布。
- [路线图](docs/roadmap.md)与[架构决策记录](docs/adr)：计划和已经定下的取舍。
- [贡献指南](CONTRIBUTING.md)。

## 常见问题

**Q：个人用户能用吗？**

能。没有企业配置时，客户端就是一个完整的个人桌面客户端，不需要部署任何服务。

**Q：企业模式会读取或改动我的个人数据吗？**

不会。企业模式使用独立的数据目录，不读写个人的 `~/.dsh`。切回个人模式后，个人的会话和插件都还在。

**Q：这是浏览器套壳吗？**

窗口加载官方 Web UI，但客户端还负责运行时管理、连接、托盘、通知、权限控制、更新和企业配置。项目不维护另一套产品界面。

**Q：预置订阅会自动安装插件吗？**

不会。客户端只添加订阅地址，装不装、装哪个由你在「发现」页决定，安装由官方插件管理器完成。

## 相关项目

- [awesome-dsh-plugin-pro](https://github.com/bruc3van/awesome-dsh-plugin-pro)：预置订阅列表的数据来源。每日采集插件仓库并维护排除记录。
- [DSH Market Pro](https://github.com/bruc3van/dsh-market-pro)：面向 Agent 的 DSH 插件与 MCP 市场，提供精选与全量插件目录、一键批量更新、33 个精选与托管 MCP 管理、技能浏览、对话内 AI 选型（`/dsh-market-pro`、`/dsh-mcp-pro`）及安装后 AI 安全审查，随安装包内置。
- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)：官方 dsh 和 Web UI 的上游项目。

## 许可证

[Apache-2.0](LICENSE)

0.6.0 起本仓库改用 Apache License 2.0；0.5.29 及更早的版本仍按 MIT 许可证授权。许可证只适用于本仓库维护的代码和素材。官方 `@deepseek-ai/dsh` 及其他第三方依赖使用各自许可证。“DSH”仅用于说明兼容对象，不表示官方关系。
