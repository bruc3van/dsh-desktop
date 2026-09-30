# Windows 命令控制台补丁

对应 [Issue #16](https://github.com/bruc3van/dsh-desktop/issues/16) 和 [Issue #19](https://github.com/bruc3van/dsh-desktop/issues/19)。仅影响客户端内置的 DSH 运行时；外部 CLI / 远程服务需要在其运行环境升级或修复。

四个 `0.2.0-rc.2` 依赖通过 `pnpm patchedDependencies` 交付修复：

- 上游已为 Windows Job helper 和 fallback `spawnSubprocess` 设置 `windowsHide: true`，本次移除重复补丁并保留回归检查；不改变独立的交互终端实现。
- `dsh-win32-process` 的 `spawnCurrentTokenJobProcess` 给普通目标的 `CreateProcessW` 添加 `CREATE_NO_WINDOW`，保留 Unicode 环境、挂起创建、Job 关联及恢复执行流程。
- `dsh-sandbox-windows-acl` 的 runner 在没有控制台时创建自己的控制台并隐藏，让受限子进程继承。保留已有控制台，不隐藏用户终端；保存和恢复标准句柄，随后设置 Ctrl+C 行为。控制台分配失败时沿用原来的启动行为；恢复标准句柄失败则停止启动，避免命令输出被错误重定向。
- `dsh-subprocess-local` 在构造 Windows 目标环境时，仅当宿主为 Electron 且目标是自身可执行文件时补入 `ELECTRON_RUN_AS_NODE=1`，让该值随 Job IPC 到达第二层 ACL runner。Windows 路径和变量名按大小写不敏感处理。宿主的 spawn monkey-patch 无法覆盖 Job runner 的原生目标启动，这正是 #19 的缺口。ACL runner 启动后清除 JS 和原生环境中的该变量，防止扩散到用户命令。
- `dsh-sandbox-local` 的 Windows ACL 功能探测同时要求退出码 0 和约定 stdout 标记，拒绝 Electron GUI 空输出退出造成的伪成功。该探测仅用于多候选链；保留上游单候选链直接选择的行为，不宣称每次执行前都会探测。

另有 `dsh-plugin-manager` 补丁接收 launcher 提供的内置 pnpm 调用参数，在 execa 执行 Windows 命令转义前改用 Electron Node 加载内置 pnpm。CLI 和运行中的插件管理服务共用此适配；调用信息仅保存在进程内，pnpm 启动安装脚本前会清除 Electron Node 模式。`check:pnpm-runtime` 使用仅含系统工具的 PATH 验证真实插件安装及生命周期脚本。

Electron 固定为 `44.0.0`，与新版 `node-addon-require-builtin` 支持的运行时指纹一致。`check:pnpm-engine` 除了检查 Node 版本，还实际加载 dsh 所需的内部模块，避免仅凭 Node 版本满足要求就判定兼容。

#19 的回归覆盖实际 launcher → Windows Job runner → Electron ACL runner → pwsh 链，使用 `PwshLocalExecutor.spawnSpec` 构造请求，检查 `read-only`、`workspace-write` 和 `danger-full-access` 的输出、非零退出码、工作区内外写入及目标环境隔离。测试额外断言 IPC 环境，避免开发版 Electron 把 runner.js 当 GUI 应用加载时掩盖缺失变量的问题；旧的直接 ACL runner 测试不能覆盖这一跳。

设置 `DSH_DESKTOP_TEST_ELECTRON` 为已打包 `DSH Desktop.exe` 的绝对路径，可用同一脚本验证打包后的可执行文件。测试仍加载当前 `.build` launcher 和 `.runtime` 依赖，不代表该旧安装包已包含新补丁。

回归脚本使用自动解析的 PowerShell 绝对路径，并覆盖清空 PATH、无 PowerShell 7 候选时的 Windows PowerShell 5.1 回退。环境隔离按变量是否存在判断；非 Windows CI 也检查 ACL runner 在启动命令前保留 JS 和原生环境清理。嵌套测试最多执行六次命令，各有 20 秒内部期限，外层留 150 秒用于串行执行、启动和清理。

没有给受限子进程添加 `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE`，没有改变 token、ACL 或 Job 生命周期。上游代码记录这两个创建标志在受限 token 路径会导致 `STATUS_DLL_INIT_FAILED`；普通 current-token 路径的修复不能套到这里。

验证：先运行 `pnpm run build` 和 `pnpm run prepare:runtime`，再运行 `pnpm run check:win32-console`。所有平台检查实际部署补丁的控制台归属、句柄恢复、初始化顺序、失败分支、fallback / Job helper spawn 参数及目标创建标志。Windows 还通过实际 launcher 启动 Job runner，检查普通目标没有控制台、环境隔离、输入输出和退出码；通过 Electron Node 调用真实 Win32 绑定，并执行受限 cmd 子进程，检查隐藏控制台及两种模式的写入边界。CI、发布和本地 pack/dist 已接入该检查。缺少 launcher 时检查会直接提示先构建。

原生检查不等于可见桌面验收。发布前仍需在 Windows 桌面连续、并发执行 pwsh 命令并取消长命令，确认没有闪窗或残留进程。`AllocConsole` 后再 `ShowWindow` 不能从调用顺序上保证绝无短暂闪窗；需实机确认。

插件管理器桥接仅重写裸 `pnpm` / `pnpm.cmd`，显式路径继续由调用方选择。`extendEnv: false` 保持不继承父进程环境；桥接显式传入的 Node 模式和 launcher 坐标用于启动后立即清除，`CI=true` 仅作用于包管理器。桥接对象及其嵌套值冻结，全局属性不可写、不可删除；这用于防止意外改写，不构成进程内插件的安全隔离边界。

升级 DSH 时重新核对上述补丁及检查脚本；上游包含修复后删除对应补丁，不要直接套用旧的打包文件名。原生 picker 的 UTF-16 修复和 fallback spawn 的隐藏窗口修复已在上游，不再沿用 `0.1.2-rc.1` 的旧补丁。
