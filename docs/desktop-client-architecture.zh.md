# 桌面客户端——基于 dsh Web UI 公开接口的独立 Electron 应用

[English](desktop-client-architecture.md) | 中文

## 问题

`dsh` Web UI 是官方产品表面。桌面客户端需要保持为**独立第三方壳层**：拥有自己的产品身份与连接设置，同时运行真实 harness 会话。因此它只组合公开产品边界：需要本地运行时便通过 `dsh` CLI 启动 Web UI，主窗口直接加载 Web UI 源站，不导入任何 harness 内部包。

## 决策

客户端（本仓库 `dsh-desktop`）包含三层运行时结构：

- **Electron 主进程**（`src/main/`）：负责窗口、Web UI 运行时和桌面端在线更新。在线更新读取 GitHub Release 上的 `latest.json`（由发布流水线根据安装包与 SHA-256 生成），校验哈希后启动对应平台安装包；不使用 electron-updater，也不让 electron-builder 推断发布通道。更新清单与安装包下载都走 Electron 的 `net.fetch`（不携带凭据），因此沿用系统代理、PAC 与操作系统证书库——Node 自带的 fetch 三者都不认，Windows 上因此出现过「清单能读到（另一台主机）、安装包下载却只报 fetch failed」；Node fetch 保留为回退路径，失败原因从错误的 `cause` 链展开显示，各更新界面也都提供发布页链接以便手动下载。开发态默认不自动检查。**智能模式**先探测默认回环实例（并读取 web profile 补丁层 `cordis.patch.yml` 里配置的端口一并探测），否则启动 `dsh web --port 0`；探测复用的实例失联时自动回落到受管本地运行时。探测不到可复用实例时，按顺序从两个来源优先使用**用户自行安装的 dsh**。其一是 PATH 上的 `dsh`（排除客户端自己的 shim 目录），以一次 `--version` 运行验证——这同时证明 shebang 背后有可用的系统 Node 和一个能启动的 CLI。其二是 npx 已缓存的包，也是官方安装指令实际产生的那一份（`npx @deepseek-ai/dsh web` 不会往 PATH 里装任何东西）：读取 npm 缓存根目录（POSIX 为 `~/.npm/_npx`，Windows 为 `%LOCALAPPDATA%\npm-cache\_npx`，`npm_config_cache` 可覆盖两者），逐个检查条目的 `package.json` 是否确为 `@deepseek-ai/dsh`，再取其声明的 bin 与真实版本号，最近修改的匹配条目胜出。这里直接读缓存而不是再调一次 `npx`，因此该步骤离线且瞬时，并以用户自己的 Node 直接启动入口、中间没有包装进程——在 Windows 上这也避开了 `.cmd` shim 会引入的 cmd.exe 层。两个来源都不安装、不下载任何东西，缺失则直接跳过；检测每会话只做一次，且只在即将启动运行时的分支上执行，`DSH_DESKTOP_SKIP_INSTALLED_DSH=1` 可将某次运行固定到内置闭包。这类子进程跑在用户自己的 Node 上，因此不会收到 `ELECTRON_RUN_AS_NODE`（Windows 的 `.cmd`/`.bat` 包装器经平台 shell 启动，POSIX 路径永远不走 shell）。若已安装的运行时始终无法就绪，则只弃用那一个来源（PATH 失败不连坐 npx），再试仍启用的下一档，而不是把共享重试额度耗在同一个失败上。四种来源（复用本机实例 / PATH 上的 dsh / npx 缓存 / 内置）均可在连接设置里单独关闭，写入 `settings.json` 的 `smartRuntimes`；缺省全部开启。关掉复用后仍会探测同一组端口作为占用闸：客户端不会结束用户自己启动的实例，但只要它还在应答就拒绝再起本地运行时，避免两个写入者共用一份 `DSH_HOME`。`DSH_DESKTOP_SKIP_PROBE=1` 会同时跳过这道闸和复用连接。**固定地址模式**使用配置的 Web UI 源站，失败时保持该明确选择并提示用户，不自动改用其他服务。开发环境的命令依次从 `DSH_DESKTOP_DSH`、验证通过的用户安装 `dsh`、应用固定依赖中的 `@deepseek-ai/dsh`、同级检出与 PATH 解析。正式安装包必须携带完整的官方 CLI 运行时闭包；缺失时直接报告安装损坏，不会静默回退到 PATH。子进程监护包含有限重试、稳定窗口后的重试额度恢复、逐 generation 就绪状态、陈旧回调拦截与优雅退出（POSIX 为 SIGTERM→SIGKILL，Windows 为 `taskkill /T /F`）。Windows 上必须**先**遍历杀进程树、再终止直接子进程，顺序不能反：后代进程（harness 自己的 shell 子进程，以及用户安装的 `.cmd` shim 外面那层 cmd.exe 包装）只能从仍然存活的父进程往下走才能找到，先杀父进程会让真正占着端口的服务变成孤儿。未捕获异常或显式退出会完全跳过这套阶梯，因此进程退出时还会跑一次同步的兜底清理（Windows 用 `spawnSync` 调 `taskkill /T /F`，其他平台用 `SIGKILL`），同时避免 stdout 被关闭后下一条日志抛出致命的 EPIPE。打包后通过 Electron 的 Node 模式（`ELECTRON_RUN_AS_NODE`）运行内置 CLI，但不直接启动官方 bin：子进程先加载 `src/main/runtime-launcher.ts`（随安装包置于 app.asar 之外，入口路径经 `DSH_DESKTOP_RUNTIME_ENTRY` 传入以保持 `process.argv` 契约），它把 Node 模式变量从环境中摘除，并在 spawn 边界只对 `process.execPath` 目标补回——运行时自身重新拉起 Node 的两条路径（原生目录选择器 worker、Windows ACL 沙箱执行器）因此不受影响，而 Agent 的 shell 子进程不再继承该变量。契约由 `scripts/check-runtime-env.mjs` 固定，安装包冒烟会用打包后的 Electron 二进制再跑一遍同一契约。发布版还会把 Electron 内置 Node 以 `node` 之名、内置 CLI 以 `dsh` 之名、内置包管理器以 `pnpm` 之名写入 `~/.dsh-desktop/bin` 并**追加**到子进程 PATH 末尾（用户自己的工具优先）。macOS 发布版在启动它之前会在受限时间内合并 shell PATH：先交互式登录 shell（覆盖 `~/.zshrc`），失败再退回非交互登录 shell，供后续 Agent 子进程继承。
- **Agent PATH shim**：追加的 `~/.dsh-desktop/bin` 是纯桌面用户（从未安装过这些工具）的 Agent 找到 `node`、`dsh`、`pnpm` 的方式。`dsh` 并不是官方 bin：shim 跑的是 `dsh-cli.mjs`，一道默认拒绝的网关（`src/main/dsh-cli-policy.ts`），只放行可证明不会启动 profile 的调用（`plugin`、`--dump-config` / `--dump-default-config`、`--version`，以及官方 CLI 自己会因缺少 `--profile` 而报错的形态），其余退出码 2 并打印一段 Agent 可转述的英文说明。主进程仍然直接 spawn `runtime-launcher.mjs`，网关不在那条路上，也挡不住 Agent 直接执行客户端 exe。`pnpm` 是运行时闭包里那一份，走 `runtime-launcher.mjs` 而不是网关，以免生命周期脚本的子进程继承 `ELECTRON_RUN_AS_NODE`。它存在的唯一理由是让 `dsh plugin add` 能装预构建的市场 tarball——不是给用户当通用包管理器。内容寻址 store 留在 pnpm 的默认位置（卸载客户端清不掉的一处足迹），以便日后与用户自装的 pnpm 共享。若 profile 的 `package.json` 写了 `packageManager`，这份 pnpm 会静默下载并切换到该字段指定的版本；官方 `initProfile` 写出的清单没有该字段，客户端目前接受这一现状。闭合的是预构建 tarball（市场主流：`lib/` 已在包里、没有 `prepare`）。从 git 装、且 `package.json` 带 `"prepare": "tsc"` 的源码插件仍然装不上：pnpm 10+ 默认拦截未列入 `allowBuilds` 的生命周期脚本，用户得按官方 CLI 的提示自己改 `~/.dsh/profiles/web/pnpm-workspace.yaml`。客户端不自动往名单里加名字——那等于让尚未审查的插件无条件跑安装脚本，和市场「先审查再安装」冲突。macOS 上用户自装的 `dsh` / `pnpm` 只有靠 `restoreMacGuiPath()` 才会出现在 PATH 上；探测超时则回落到内置的那份。
- **窗口表面**：Electron ready 后立即显示一个本地 Loading 文档，运行时就绪后由同一安全窗口直接加载 **官方 Web UI 本体**。会话标题、控件和所有产品交互因此都是官方行为。preload 只暴露小型连接桥，并可在官方设置弹窗里追加明确标注的连接卡片、应用更新区块和 DeepSeek Key 帮助链接。仓库不维护或构建第二套产品 renderer。
- **内置插件接缝**：客户端运行时闭包可携带插件（当前是安全市场），并按官方 in-box bundle 的方式接入——`resolveBundleDir()` 解析 `dsh.profile.bundles` 时先查 dsh 安装目录再查 profile，而 `dsh plugin` 明确不碰非依赖项的 bundle。因此接入只需两步：把插件**复制**到 `<DSH_HOME>/profiles/node_modules`，以及把包名写进 profile 的 `dsh.profile.bundles`。复制而非软链是这个接缝能跨运行时的全部原因：Node 按 realpath 解析，软链会让插件的 `@deepseek-ai/*` 从客户端闭包里解析，等于把第二份 Service 类交给正在服务的运行时；真实目录则向上经 `profiles/node_modules` 解析——那一层由 harness 每次启动用**当前服务的那份安装**的依赖图 healing，正是 `dsh plugin add` 装的插件所走的路径。因此市场不再是特例。两步都可一步撤销，这是它敢自动执行的前提：插件在加载期抛错会让整棵插件树启动失败。接入面向客户端**启动**的每一个运行时，不再只是内置那份；把关的换成版本闸——插件按客户端自带的 dsh 编译，更旧的运行时可能缺它 import 的导出，故拒绝，更新的一律放行。客户端没启动的运行时（复用实例、固定地址）仍撤回：不是出于安全，而是客户端不掌握它的启动时机，无从知道改动何时生效。插件自身也有一道自保：其入口只经受保护的动态 `import()` 触达真正的实现，所以不兼容的运行时只损失市场本身。用户可在连接设置里关闭接入，该选择持久记在客户端自己的设置里（座位每次启动都会重新接入，没有记号的移除会自我撤销）；客户端已被卸载时，市场自己的已安装面板是仅剩的移除入口，副本带的归属标记正是为此。闭包里找不到插件时撤回条目与副本。全新 `DSH_HOME` 首次启动时还没有 web profile，就绪后再写入，供下一次启动加载。用户自行作为 profile 依赖安装过、且版本不低于闭包时完全不介入；更旧的覆盖会收回依赖、清掉 profile 里更近的旧安装。见 `src/main/bundled-plugin.ts`。
- **运行时锁定**：两个 harness 同时写同一份会话日志会造成永久损坏——各自的内存序号让日志出现重复 seq 与孤儿 inbox splice，受影响的会话再也无法恢复；而客户端不可能发现机器上的每一个 harness（官方 web 的端口既可来自 `--port`，也可写在 profile 补丁层，后者在命令行上留不下任何线索），所以排他不能依赖探测。客户端能可靠做到的是绝不同时跑两个**自己**的运行时：把自己 spawn 的子进程 pid、客户端 pid、启动时间与就绪后的源站记录在 `DSH_HOME` 下的 `.dsh-desktop-runtime.json`（经临时文件改名落盘——撕裂读会解析成「没有运行时」，那是唯一会以数据为代价的错误答案）。下次启动先读记录：仍在服务的遗留进程被优先接管（复用同一个 harness，会话照常共享），而不是在旁边再起一个——幸存者不是假设场景：Windows 安装器按进程名杀掉应用时会留下运行时子进程，新版再起一个就会成为同一 `DSH_HOME` 的第二个写入者。记录里还留着它出自哪一档来源：用户若已在连接设置里关掉那一档，客户端先停掉它再按新偏好解析，停不掉时仍旧接管——偏好不值得换来第二个写入者。记录是建议性的、自愈的：既不应答也不存在的子进程被清除而不是遵从，崩溃的客户端因此堵不住下次启动；接不上的遗留进程先清理再重启，连不上也结束不掉时客户端拒绝启动并说明原因。更新路径遵循同一条约束：安装包下载并通过 SHA-256 校验之后、拉起安装器之前才停止运行时——下载或校验失败、安装器最终没能启动时运行时都会保住或自动恢复（此前 Windows 上安装器按进程名杀应用时匹配不到 `node.exe` 子进程，旧运行时成为孤儿继续写 `~/.dsh`）。见 `src/main/runtime-lock.ts`。
- **设置接缝**：带随机私密路径的最小回环页面承载原生连接窗口，并把 `settings.json` 写入 `~/.dsh-desktop`。它不是 API carrier，不代理 `/api`、WebSocket 或 renderer 资源。

客户端自己的连接设置放在 `~/.dsh-desktop`（可用 `DSH_DESKTOP_HOME` 覆盖）；本地子进程使用**官方 `DSH_HOME`（`~/.dsh`）**——会话、标题、凭据、模型配置与 `dsh` CLI 和浏览器端官方 Web UI 共享。窗口使用官方 logo（macOS 模板 Dock 图标、Windows/Linux 窗口图标）与标准标题栏（官方 Web UI 自带 header）。凭据接缝按原样使用：`DEEPSEEK_API_KEY` 经官方界面的设置写入。

开发/诊断环境变量 `DSH_DESKTOP_DSH` 和 `DSH_DESKTOP_NODE` 可覆盖 CLI 与 Node 路径。`DSH_DESKTOP_SKIP_PROBE=1` 与 `DSH_DESKTOP_PROBE_URL` 仅供自动化测试控制探测，不属于用户配置接口。

当前发布矩阵分别提供 macOS Apple Silicon、macOS Intel 与 Windows x64 安装包，每个原生 runner 只部署当前架构依赖。`dsh-runtime/package.json` 保留 Linux x64 原生可选包，供源码构建及未来恢复发布支持使用。固定版本的 Win32 原生目录选择器带有一份客户端自有、精确版本绑定的 pnpm 补丁：原实现通过 `koffi.view()` 读取用户选中的 COM 路径时会使 Electron 内置 Node 中止，补丁改为经 Win32 复制准确长度的 UTF-16 字节，并在 Windows 构建中使用 Electron 运行验证。新增发布架构或升级 dsh 时必须同步核对该清单、处理或删除此补丁，并运行对应平台的安装包 smoke。

## 后果

- `pnpm run dev` 构建并启动客户端；`pnpm run shot` / `pnpm run audit` / `pnpm run e2e` 驱动 Playwright 验证。`pnpm run check:picker` 验证部署后的补丁，并在 Windows 上通过 Electron Node 检查 Unicode COM 路径读取。`pnpm run smoke:package` 在空 PATH 下启动打包应用，要求它明确选择内置 CLI 并通过 `host.describe` 探针。
- 客户端对本地 `dsh web` 与任何可达的 Web UI 实例表现一致（唯一耦合是 Web UI 源站），macOS / Windows / Linux 均支持；本地与探测连接均呈现对应实例的原生官方界面。官方 dsh 目前只面向本机使用（默认监听 `127.0.0.1`，暴露到网络的 `0.0.0.0` 绑定会被拒绝），远程实例不在官方支持范围内。
- 会话运行 Web UI 自己的组合（官方 web profile）——内容搜索、`/` 命令与技能菜单、后台任务、消息操作（fork、反馈）、plan 模式、待处理队列、agent 预设、权限选择器、goal 芯片、模型目录，以及会话标题/重命名——因为界面本身就是官方 web 应用。
- 模型可见的身份由官方 web profile 自己的 surface prompt（"Web GUI"）设定；客户端不附加任何自己的部分。

## 备选方案

| 已否决 | 一句话原因 |
|---|---|
| 直接拼装大量细粒度 harness 包（旧架构） | 发布后的 `@deepseek-ai/dsh` CLI 已提供更稳定、完整的公开运行边界 |
| 维护第二套生产 renderer | 会重复实现官方产品表面，并持续与官方行为漂移 |
| 通过桌面 carrier 反代 `/api`、WebSocket 与资源 | 直接加载官方 Web UI 源站边界更小，也更忠实 |
| 自定义 renderer 直接跨源调用 `/api` | 当前没有生产自定义 renderer；官方页面只访问自己的源站 |
| 在 Electron 主进程内运行 harness | Electron 的 Node 落后于引擎范围，原生模块需要按 Electron ABI 重编 |
