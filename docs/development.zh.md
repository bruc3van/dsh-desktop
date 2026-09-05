# 开发指南

[English](development.md)

本文收录从 README 迁出的开发者内容：从源码运行、开发与验证、版本发布与当前状态。安装使用与连接说明见 [README](../README.md)；进程模型、信任边界和设计取舍见[桌面客户端架构](desktop-client-architecture.zh.md)。

## 从源码运行

源码开发需要 Node.js `^22.19.0 || >=24.0.0` 和 [pnpm](https://pnpm.io/)；不需要另外安装 `dsh`。

```sh
git clone https://github.com/bruc3van/dsh-desktop.git
cd dsh-desktop
pnpm install
pnpm run dev
```

应用启动后，默认的**智能模式**会按以下顺序选择运行时：

1. 先检查 `http://127.0.0.1:3080`。如果这里已经运行官方 Web UI，桌面端直接复用它。此时浏览器和桌面端共享同一个 Harness 进程，会话状态可以实时同步。若你在 `~/.dsh/profiles/web/cordis.patch.yml` 里改过 `port`，或在连接设置里为客户端启动的服务固定过端口，客户端会把这些端口一并探测；用 `dsh web --port <端口>` 临时指定、又没写进补丁层或连接设置的实例在命令行之外留不下任何线索，请在连接设置里手动填写地址。
2. 没有可复用实例时，找 PATH 上是否装有 `dsh`（`dsh --version` 能正常返回即算可用）。
3. 再找 npx 是否已经缓存过官方包。**官方安装方式 `npx @deepseek-ai/dsh web` 不会往 PATH 里装任何东西**，而是把完整的包留在 npm 缓存里（POSIX 在 `~/.npm/_npx/`，Windows 在 `%LOCALAPPDATA%\npm-cache\_npx\`）。只要你按官方文档跑过一次，这份包就能直接复用。
4. 都没有时，才使用安装包或项目依赖中固定的内置运行时。

这四种来源都可以在连接设置里单独关闭（多选按钮），方便测试时固定到某一种；缺省全部开启，至少保留一种。未勾选的来源会被跳过，顺序不变。关掉「本机已运行」只表示客户端不再连接探测到的实例：客户端不会结束用户自己启动的进程。本机已安装 / npx / 内置由客户端自己拉起，关掉时会停掉当前子进程。但只要用户自己起的官方实例仍在应答，任何接下来会本地再拉起一份的设置变更都会被拒绝（关掉「本机已运行」、在未复用时切换那三档、或从自定义切回智能且未开启复用）——否则窗口会落到占用失败页，却没法替你关掉命令行。`DSH_DESKTOP_SKIP_PROBE=1` 会同时跳过这道占用闸和复用连接。`DSH_DESKTOP_SKIP_INSTALLED_DSH=1` 仍只在开发环境生效，会跳过 PATH 与 npx 探测。

第 2、3 步都跑在**你自己的 Node** 上，且只使用**已经存在**的包——不联网、不下载、不替你安装 Node.js；缓存里没有就直接跳过。客户端读取缓存包的 `package.json` 校验其确实是 `@deepseek-ai/dsh` 并取用真实版本号，不会误启动同路径下的其他东西。npx 缓存不会自行更新：若缓存版本低于内置运行时，客户端仍优先使用你的缓存，但会在连接设置里提示；重新运行一次 `npx @deepseek-ai/dsh web` 即可把缓存刷新到最新版。

启动的都是纯后台服务进程（自动端口依次尝试 3080、13080，再退到 `dsh web --port 0`；也可在连接设置里改成固定端口），rc.8 及以上会带 `--no-open`，不会打开浏览器窗口；退出桌面端时，客户端启动的服务会被一并关闭。若选中的运行时启动失败，客户端会按仍启用的来源依次回退（默认最后是内置运行时）。固定端口被占用时不会换口、也不会把三个来源各失败一遍。连接设置里会显示当前用的是哪一种（本机已安装 / npx 缓存 / 客户端内置）及其版本。内置安全市场会接入客户端启动的任一运行时（复用实例与自定义地址除外——那两种不由客户端启动），见下文「开发与验证」与 README 的[「内置安全市场」](../README.md#内置安全市场)。

如果内置运行时无法启动，或希望使用其他实例，请打开**「设置 → 桌面设置」**修改连接；页面完全加载不出来时，启动界面会直接给出**「Web UI 连接…」**按钮。

## 开发与验证

```sh
pnpm run build          # 构建 Electron 主进程与 preload
pnpm run prepare:runtime # 准备内置 dsh 运行时闭包
pnpm run check:picker   # 验证内置 Win32 目录选择器兼容补丁
pnpm run check:runtime-env # 验证 Agent 执行环境不继承 Electron Node 模式变量
pnpm run check:bundled-plugin # 验证内置市场接入/撤回/版本闸契约
pnpm run check:local-web-port # 验证本地服务端口与 --no-open spawn 参数
pnpm run check:runtime-lock # 验证运行时锁定与更新安装时序
pnpm run check:restart  # 验证托盘「重启」允许杀掉谁
pnpm run dist           # 为当前平台生成安装包
pnpm run typecheck      # TypeScript 类型检查
pnpm run lint           # 检查源码与脚本
pnpm run check:updater  # 验证应用内更新检查、哈希校验与忽略版本
pnpm run audit          # 启动与浏览器界面冒烟验证
pnpm run smoke:package  # 验证打包应用确实使用内置 dsh 运行时
pnpm run smoke:dmg      # 挂载 macOS DMG、拷出 .app，再对它跑上面那套冒烟
pnpm run shot           # 更新 shots/ 中的截图
pnpm run shot:readme    # 更新 README 使用的隐私安全截图
pnpm run e2e            # 发送真实请求并验证流式回复
```

除上述命令外，`scripts/` 里还有一组针对连接与运行时行为的回归检查：`check:connection`（连接切换）、`check:installed-runtime`（已安装运行时）、`check:runtime-resolution`（运行时解析）、`check:smart-runtimes`（智能连接来源开关）、`check:local-web-port`（本地服务端口）、`check:bundled-plugin`（内置市场接入 / 撤回）、`check:runtime-lock`（运行时锁定与更新时序）、`check:restart`（托盘「重启」允许杀掉谁）、`check:auto-fallback`（关掉复用或改用本机已安装 / npx / 内置会撞上占用时的拒绝，以及失联自动回落）与 `check:error-surface`（错误界面）。

`pnpm run e2e` 需要有效的 API Key（`export DEEPSEEK_API_KEY=…`，或在「设置 → 凭据」添加一次）。没有 Key 时它有意以退出码 2 失败：被跳过的真实往返不能显示为绿色。它还会在一次性临时 `DSH_HOME` 上运行，绝不会碰到你的真实会话。生产窗口直接加载官方 Web UI；仓库不维护第二套产品 renderer。`pnpm run check:updater` 用本地更新清单夹具验证检查、下载校验和忽略版本。

### 内置安全市场（开发）

- 市场版本固定在 `dsh-runtime/package.json` 的 `dsh-desktop-safe-market` npm 依赖上（精确版本号），与官方运行时同处发布闭包、随安装包交付——升级该依赖版本即升级客户端内置的市场。该包由上游打 tag 后经 GitHub Actions 带 provenance 发布；刚发布的版本还没达到 pnpm 的最小发布年龄，因此每次升级要同时把这个**精确版本**加进 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`——一次只放一版，不用通配符。
- 客户端向它**启动**的每一个运行时接入市场（内置 / PATH 上的 dsh / npx 缓存都算）：把插件**复制**到 `<DSH_HOME>/profiles/node_modules`，并往 profile 的 `dsh.profile.bundles` 写一个条目。复制而非软链是跨运行时的关键——Node 按 realpath 解析，软链会让插件的 `@deepseek-ai/*` 落回客户端闭包，把第二份 Service 类交给正在服务的运行时。副本目录带 `.dsh-desktop-seat.json` 标记归属；老客户端留下的软链会被自动换成副本。
- 把关的是版本闸（`runtimeRefusal()`）：插件按客户端自带的 dsh 编译，更旧的运行时可能缺它 import 的导出，拒绝；更新的放行；版本读不出来也拒绝，不猜。复用实例与固定地址仍撤回——客户端不掌握它们的启动时机。新增 / 已存在 / 用户自装 / 旧覆盖抬升 / 撤回 / 弃置 / 异族目录 / 缺失插件 / 无 profile / 升级重新复制 / 旧软链替换 / 版本闸各情形的契约由 `check:bundled-plugin` 回归固定。
- 移除路径有两条，覆盖不同时刻：客户端连接设置里的「安全市场」开关（关掉即撤条目 + 删副本，选择持久写进 `~/.bruc3van-dsh-desktop/settings.json`——座位每次启动都会重新接入，没有持久记号的移除会自我撤销）；以及市场自己的已安装面板，它会列出带 `.dsh-desktop-seat.json` 标记的座位并允许卸载——那是客户端已被卸载后仅剩的入口。
- 源码运行想固定用内置闭包（而不是你自己的 dsh）：`DSH_DESKTOP_SKIP_INSTALLED_DSH=1 pnpm run dev`。市场本身不再需要这个开关。
- 市场的目录管线（每日自动采集 + 人工精选）、「先审查、再安装」提示词与安全边界在市场仓库维护；接入实现见 `src/main/bundled-plugin.ts`。

## 版本发布

发布版本时直接推送版本 tag；GitHub Actions 会以 tag 为唯一版本来源，并在构建时写入 `package.json`：

```sh
git tag v0.4.0
git push origin v0.4.0
```

GitHub Actions 会校验 tag 格式，并以 tag 作为发布版本分别构建：

- macOS Apple Silicon：DMG；
- macOS Intel：DMG；
- Windows x64：NSIS 安装程序。

Linux 安装包暂不在自动发布范围内；源码中的通用平台兼容逻辑仍予保留。

全部平台构建成功后，工作流会生成 SHA-256 校验文件和 `latest.json` 在线更新清单，并创建或更新对应的 GitHub Release。包含 `-rc`、`-beta` 等预发布标识的 tag 会自动标记为预发布版本；预发布不会成为 `/releases/latest` 上的更新源。

## 当前状态

桌面外壳、智能/固定地址模式、共享 `DSH_HOME`、托盘常驻、运行时监护、应用内在线更新、系统通知权限、内置官方 `@deepseek-ai/dsh`、内置安全市场（先审查、再安装，随安装包发布）、macOS/Windows 打包和 tag 自动发布流程均已实现；同一 `DSH_HOME` 下有运行时锁定与遗留进程接管，智能模式会一并探测 profile 补丁层配置的端口。发布流水线会在空 PATH 下启动打包应用并探测 Web UI，阻止遗漏内置运行时的产物发布。当前自动产物尚无正式代码签名：Windows/Linux 使用原生通知，macOS 则将 Web Notification 降级为 Dock 角标、弹跳和应用内提醒；正式签名仍是面向普通用户无警告安装及使用 macOS 通知中心的前置条件。OS Keychain 与语音输入也属于后续工作，见 [TODO](../TODO.md)。

欢迎提交贡献与问题反馈，尤其是 Windows 使用、固定地址连接和打包方面的反馈。

## 桌面设置与页面模块

`src/main/pages/` 存放加载、错误、设置、更新提示和通知页的纯渲染函数，以及设置页脚本。语言、图标和动态文案由主进程传入；窗口生命周期、文件读取与调用方校验留在主进程。

`src/main/settings-adapter.ts` 集中管理官方设置 DOM 的只读探测。注入诊断区分 `absent`（未发现可识别弹窗）、`mounted`（入口已挂载）与 `unsupported`（已识别弹窗但结构不支持）。后者会撤销注入产生的导航和显示状态，同一文档内每种失败原因仅告警一次。主进程状态接口的 `settingsIntegration` 字段提供诊断，不包含页面文本、地址或密钥。无法识别的全新弹窗仍可能显示为 `absent`，此字段不用于判断上游版本兼容性。

运行 `npm run build:shell && npm run check:settings-integration`，用隔离的 Electron 实例验证结构变更、清理、重新挂载、原生设置入口和安全市场持久化。该检查已加入 macOS/Windows CI；模拟页面不代替实际官方 Web UI 的版本兼容验证。

## 运行时与连接边界

入口文件组装服务并保留启动、退出和跨模块协调。运行时状态由下列模块分别维护；模块之间传递操作与只读查询，不传递一个可任意修改的应用状态对象。

| 模块 | 负责的状态和操作 |
|---|---|
| `client-settings.ts` | 客户端设置的读取、字段合并与原子写入 |
| `runtime-environment.ts` | 内置程序路径、命令 shim、登录 shell 的 PATH，以及 shim 初始化缓存 |
| `runtime-catalog.ts` | PATH/npx/内置/开发覆盖命令选择、版本发现缓存和本次会话的来源拒绝状态 |
| `web-ui-manager.ts` | 当前子进程代际、就绪 Promise、输出诊断和串行停止流程 |
| `web-ui-probe.ts`、`loopback-port.ts`、`browser-admission.ts` | Web UI API 验证、精确 origin 的浏览器认证和可用端口探测，不启动进程 |
| `runtime-survivor.ts`、`runtime-process.ts` | 遗留进程的身份核对、接管和停止，以及异常退出时的同步清理 |
| `connection-controller.ts` | 连接代际、当前目标、每次启动的端口选择、主动替换、来源回退和重试预算 |

`connection-controller` 对窗口层提供只读状态和显式操作。异步探测与就绪结果仍须匹配发起时的连接代际；退出状态由应用层提供。初次启动和三条重试路径（内置插件撤回、来源失败、崩溃重启）都会重新选择自动端口。窗口层通过 `readyForConnection()` 等待就绪，不直接发布子进程的目标地址。

`npm run check:connection-controller` 验证延迟端口探测、过期就绪、并发主动停止、三条重试路径和遗留进程优先级。`npm run check:runtime-survivor` 启动隔离的真实子进程，验证无归属记录和已复用 PID 不会被结束、可用遗留进程会被接管、重启会停止经核实归属的进程。两项检查均接入 CI。

已有的 Electron 检查继续覆盖连接切换、已安装来源、自动回退、认证占用及插件恢复。自动端口回退检查允许本机其他程序占用 13080：空闲时验证回退至 13080，已占用时验证系统分配端口；测试不会为了固定端口而停止其他程序。

`settings-server.ts` 拥有私有路径、监听端口和 HTTP 路由；设置校验、确认弹窗和业务操作通过回调接入。`native-menus.ts` 根据语言、更新状态和操作回调生成菜单模板。`npm run check:settings-server` 通过实际 HTTP 请求验证 Host/私有路径、请求体上限、设置写入结果和更新器就绪状态，不读取真实用户配置。

## Preload 与主进程业务模块

`preload.ts` 只初始化桥接和文档功能。`preload/bridge.ts` 提供固定 IPC 接口；`theme.ts` 负责主题观察；`settings-observer.ts` 协调探测和诊断；`settings-navigation.ts` 管理官方导航的临时显示状态；连接卡片、更新卡片和 API Key 帮助分别位于独立模块。`pagehide` 会取消帧回调、观察器、定时器和 IPC 订阅，并恢复官方导航；从后退缓存恢复时重新挂载。

主进程的 `settings-commands.ts` 拥有保存队列、端口保存代际和数据环境重启状态；`plugin-recovery-controller.ts` 拥有兼容恢复防重入状态；`update-controller.ts` 负责更新交互、调度和安装器交接。`desktop-ipc.ts` 注册业务频道，`bridge-policy.ts` 核对调用窗口、顶层 frame、当前 origin 和本地交接窗口。`main-window.ts` 创建窗口并绑定导航和 renderer 事件；`window-health.ts` 管理空白窗口恢复；`window-theme.ts` 管理窗口主题；`locale-controller.ts` 跟踪本地语言设置。业务模块通过操作回调和实时查询协作，跨模块查询不得在初始化时缓存可变状态。

`npm run build:shell && npm run check:official-settings` 启动临时 DSH_HOME 和 Chromium 配置中的内置官方 UI，分别验证中文和英文的注入、官方导航恢复及重开，输出实际 DSH 版本。测试不使用真实凭据、不发送模型请求。2026-09-05 本机覆盖版本为 `0.1.2-rc.1`；这不代表其他版本也已验证。结构变体和文档销毁/恢复另由 `check:settings-integration` 覆盖。

官方 UI 检查已接入 macOS/Windows 应用 CI，并在准备目标平台运行时之后执行。本机 macOS 执行 Windows 参数或补丁契约检查时，不能把被跳过的原生控制台、安装器与窗口行为算作通过；Windows 原生验收需要实际 Windows runner 对当前改动执行 CI。

## 安全回归与打包检查

- `pnpm run check:safety`：模拟磁盘写失败、Windows taskkill 非零退出、安装器快速失败、重复退出，以及桥权限与输出脱敏；使用合成凭据。
- `pnpm run check:browser-admission`：隔离 Electron 实测跨端口请求、目标切换和内存凭据不落 cookie 库。
- `pnpm run check:connection-controller`：覆盖慢速检测期间出现外部服务，以及停止失败不启动后继。
- `check:dsh-browser-session` 进入 CI/release 的契约作业；`check:auth-occupancy` 与 `check:browser-admission` 进入应用作业。

CI 与 release 均配置 arm64 和 Intel 的 DMG 安装冒烟。配置了检查不等于已经在对应 runner 验证通过；Windows 仍需确认实际 `.cmd → node` 树终止，以及安装器拒绝／取消／快速退出后的恢复。

`pnpm run pack` / `pnpm run dist` 执行 `package.json` 中列出的打包门禁，不等同于全部 CI。类型、lint、连接集成、更新器和设置集成等仍须通过 CI 对应作业。发布前检查 CI、打包产物和目标平台 smoke，不能只依据本地 dist 成功。

`shot:readme` 直接更新 README 引用的 `docs/images/dsh-desktop-home.png` 与 `dsh-desktop-setting.png`。旧 `shots/10-*` 至 `13-*` 是历史图片；普通 `shot` 的编号不是它们的替换映射。
