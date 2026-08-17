# 项目 TODO

## dsh 共存与运行时诊断

- [x] 区分并展示当前运行来源：客户端内置、本机已安装的 dsh、本机 `127.0.0.1:3080` 复用实例、用户配置的固定地址实例。
- [x] 单独展示客户端内置 dsh 版本：设置页「桌面客户端 v… · 内置 dsh … · 本机 dsh …」（`bundledDshVersion()`）。
- [ ] 通过 `host.describe` 响应提取并展示当前连接实例的实际 dsh 版本；`probeWebUi()` 目前只检查 `result.ok` 就丢弃了响应其余字段（含版本信息）。
- [ ] 当前实例版本与内置版本不一致时给出非阻断提示，并说明只要 API 兼容即可继续使用。
- [ ] 当其他端口存在独立 dsh 进程、客户端准备以同一个 `DSH_HOME` 启动内置实例时，评估并提示并发运行风险（目前端口探测只针对默认地址 `127.0.0.1:3080`）。shim 网关收窄了 Agent 侧的触发面（经 shim 执行 `dsh web` / `dsh --profile …` 会被拦截），但没有关闭该问题：用户自装的 dsh、直接执行客户端 exe、以及客户端自己的启动路径都不经过网关。
- [x] 共存回归测试主体场景：只安装 npx/npm 包、默认端口实例正在运行、PATH 本机安装优先、启动失败自动回退、固定地址切换（`scripts/check-installed-runtime.mjs`、`check-connection-switch.mjs`、`check-auto-fallback.mjs`）。
- [ ] 补充共存回归测试缺失场景：其他端口实例正在运行、实例版本与内置版本不一致。

## 官方 dsh 运行时更新

- [x] 优先使用本地已安装 dsh：检测 PATH 上的 CLI 与 npx 已缓存的官方包（官方安装指令 `npx @deepseek-ai/dsh web` 不进 PATH），在默认端口没有可复用实例时启动它；内置运行时作为可靠回退（启动失败会自动回退）。
- [x] 把上述优先级做成设置项：连接设置里用多选按钮开关四种智能连接来源（复用本机实例 / PATH 上的 dsh / npx 缓存 / 内置），写入 `ClientSettings.smartRuntimes`；缺省全部开启。至少保留一种。PATH 启动失败只弃用 PATH，再试仍启用的 npx 或内置。
- [ ] 复用 `/desktop/probe` 的探测结果做周期性提示：目前只在打开连接设置时填入一次地址，运行中新出现的官方实例不会主动提示（主进程无周期探测定时器）。
- [ ] 明确外部运行时模式的更新边界：README 已有一句提及，还需专门章节说明用户通过 npm/npx 更新官方包并重启本地 dsh 后，桌面客户端无需同步升级。
- [ ] 评估内置官方运行时的独立更新通道，使后续兼容版本可以不发布新版桌面客户端；更新包须按平台构建并经过完整依赖、校验签名、兼容性冒烟、原子切换和失败回滚（目前 `updater.ts` 只更新桌面客户端整体）。
- [ ] 为运行时更新清单记录 dsh 版本、平台/架构、最低桌面客户端版本和 Node/Electron 兼容范围；不兼容时要求升级桌面客户端，而不是强行更新运行时。

## 插件安装边界

打包版内置运行时现在能装市场这类**预构建 tarball**，不能自动装「源码仓库 + `prepare` 脚本」那一类。这是有意留下的缺口，不是漏做。

- **能装（市场主流）**：发布物里已经带编译好的 `lib/`，`package.json` 没有 `prepare`。`dsh plugin add <tarball>` 只是下载、解压、再拉两三个小依赖（市场自己就是这种；一次安装不需要 tsc / 构建工具链）。
- **装不上（git + prepare）**：仓库只有源码，安装时要现场编译。例如某插件 `package.json` 写了 `"prepare": "tsc"`，命令是 `dsh plugin add github:someone/dsh-weather`。pnpm 10+ 默认拦截未列入 `allowBuilds` 的生命周期脚本，clone 完会停住，提示去改 `~/.dsh/profiles/web/pnpm-workspace.yaml`。dsh CLI 已经打印这条提示。
- **不自动往 `allowBuilds` 里加名字**：那等于让刚下载、尚未审查的插件无条件跑 `prepare` / `postinstall`，和市场「先审查再安装」直接冲突。确要装这类插件，按 CLI 提示自己改名单即可。
