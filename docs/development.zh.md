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

1. 先检查 `http://127.0.0.1:3080`。如果这里已经运行官方 Web UI，桌面端直接复用它。此时浏览器和桌面端共享同一个 Harness 进程，会话状态可以实时同步。若你在 `~/.dsh/profiles/web/cordis.patch.yml` 里改过 `port`，客户端会把该端口一并探测；用 `dsh web --port <端口>` 临时指定的实例在命令行之外留不下任何线索，客户端探测不到，请在连接设置里手动填写地址。
2. 没有可复用实例时，找 PATH 上是否装有 `dsh`（`dsh --version` 能正常返回即算可用）。
3. 再找 npx 是否已经缓存过官方包。**官方安装方式 `npx @deepseek-ai/dsh web` 不会往 PATH 里装任何东西**，而是把完整的包留在 npm 缓存里（POSIX 在 `~/.npm/_npx/`，Windows 在 `%LOCALAPPDATA%\npm-cache\_npx\`）。只要你按官方文档跑过一次，这份包就能直接复用。
4. 都没有时，才使用安装包或项目依赖中固定的内置运行时。

第 2、3 步都跑在**你自己的 Node** 上，且只使用**已经存在**的包——不联网、不下载、不替你安装 Node.js；缓存里没有就直接跳过。客户端读取缓存包的 `package.json` 校验其确实是 `@deepseek-ai/dsh` 并取用真实版本号，不会误启动同路径下的其他东西。npx 缓存不会自行更新：若缓存版本低于内置运行时，客户端仍优先使用你的缓存，但会在连接设置里提示；重新运行一次 `npx @deepseek-ai/dsh web` 即可把缓存刷新到最新版。

启动的都是纯后台服务进程（`dsh web --port 0`），不会打开浏览器窗口，也不占用 3080；退出桌面端时，客户端启动的服务会被一并关闭。若选中的运行时启动失败，客户端会自动回退到内置运行时。连接设置里会显示当前用的是哪一种（本机安装 / npx 缓存 / 内置）及其版本。内置安全市场只随内置闭包接入（复用实例、用户自装的 dsh 与固定地址会撤回）；源码运行可用 `DSH_DESKTOP_SKIP_INSTALLED_DSH=1` 固定到内置闭包体验，见下文「开发与验证」与 README 的[「内置安全市场」](../README.md#内置安全市场)。

如果内置运行时无法启动，或希望使用其他实例，请打开**「设置 → 通用设置 → 连接」**修改连接；页面完全加载不出来时，启动界面会直接给出**「Web UI 连接…」**按钮。

## 开发与验证

```sh
pnpm run build          # 构建 Electron 主进程与 preload
pnpm run prepare:runtime # 准备内置 dsh 运行时闭包
pnpm run check:picker   # 验证内置 Win32 目录选择器兼容补丁
pnpm run check:runtime-env # 验证 Agent 执行环境不继承 Electron Node 模式变量
pnpm run check:bundled-plugin # 验证内置市场接入/撤回契约
pnpm run check:runtime-lock # 验证运行时锁定与更新安装时序
pnpm run dist           # 为当前平台生成安装包
pnpm run typecheck      # TypeScript 类型检查
pnpm run lint           # 检查源码与脚本
pnpm run check:updater  # 验证应用内更新检查、哈希校验与忽略版本
pnpm run audit          # 启动与浏览器界面冒烟验证
pnpm run smoke:package  # 验证打包应用确实使用内置 dsh 运行时
pnpm run shot           # 更新 shots/ 中的截图
pnpm run shot:readme    # 更新 README 使用的隐私安全截图
pnpm run e2e            # 发送真实请求并验证流式回复
```

除上述命令外，`scripts/` 里还有一组针对连接与运行时行为的回归检查：`check:connection`（连接切换）、`check:installed-runtime`（已安装运行时）、`check:runtime-resolution`（运行时解析）、`check:bundled-plugin`（内置市场接入 / 撤回）、`check:runtime-lock`（运行时锁定与更新时序）、`check:auto-fallback`（失联自动回落）与 `check:error-surface`（错误界面）。

`pnpm run e2e` 需要有效的 API Key。生产窗口直接加载官方 Web UI；仓库不维护第二套产品 renderer。`pnpm run check:updater` 用本地更新清单夹具验证检查、下载校验和忽略版本。

### 内置安全市场（开发）

- 市场版本固定在 `dsh-runtime/package.json` 的 `dsh-desktop-safe-market` tarball 依赖上，与官方运行时同处发布闭包、随安装包交付——升级该依赖版本即升级客户端内置的市场。
- 客户端只在解析到自己的内置闭包（`source: 'bundled'`）时接入市场：往 profile 的 `dsh.profile.bundles` 写一个条目、并建一条指向闭包的软链；复用实例、用户自装的 dsh 与固定地址一律撤回。新增 / 已存在 / 用户自装 / 旧覆盖抬升 / 撤回 / 弃置 / 异族目录 / 缺失插件 / 无 profile / 升级改指软链各情形的契约由 `check:bundled-plugin` 回归固定。
- 源码运行固定体验市场：`DSH_DESKTOP_SKIP_INSTALLED_DSH=1 pnpm run dev`（跳过已安装 dsh 检测，解析到内置闭包）。
- 市场的目录管线（每日自动采集 + 人工精选）、「先审查、再安装」提示词与安全边界在市场仓库维护；接入实现见 `src/main/bundled-plugin.ts`。

## 版本发布

发布版本时直接推送版本 tag；GitHub Actions 会以 tag 为唯一版本来源，并在构建时写入 `package.json`：

```sh
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions 会校验 tag 格式，并以 tag 作为发布版本分别构建：

- macOS Apple Silicon：DMG；
- macOS Intel：DMG；
- Windows x64：NSIS 安装程序。

Linux 安装包暂不在自动发布范围内；源码中的通用平台兼容逻辑仍予保留。

全部平台构建成功后，工作流会生成 SHA-256 校验文件和 `latest.json` 在线更新清单，并创建或更新对应的 GitHub Release。包含 `-rc`、`-beta` 等预发布标识的 tag 会自动标记为预发布版本；预发布不会成为 `/releases/latest` 上的更新源。

## 当前状态

桌面外壳、智能/固定地址模式、共享 `DSH_HOME`、托盘常驻、运行时监护、应用内在线更新、内置官方 `@deepseek-ai/dsh`、内置安全市场（先审查、再安装，随安装包发布）、macOS/Windows 打包和 tag 自动发布流程均已实现；同一 `DSH_HOME` 下有运行时锁定与遗留进程接管，智能模式会一并探测 profile 补丁层配置的端口。发布流水线会在空 PATH 下启动打包应用并探测 Web UI，阻止遗漏内置运行时的产物发布。当前自动产物尚未进行代码签名；macOS/Windows 签名与公证仍是面向普通用户无警告安装的发布前置条件。系统通知、OS Keychain 与语音输入也属于后续工作，见 [TODO](../TODO.md)。

欢迎提交贡献与问题反馈，尤其是 Windows 使用、固定地址连接和打包方面的反馈。
