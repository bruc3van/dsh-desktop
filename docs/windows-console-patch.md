# Windows 命令控制台补丁

对应 [Issue #16](https://github.com/bruc3van/dsh-desktop/issues/16)。仅影响客户端内置的 DSH 运行时；外部 CLI / 远程服务需要在其运行环境升级或修复。

两个 `0.1.2-rc.1` 依赖通过 `pnpm patchedDependencies` 交付修复：

- `dsh-subprocess-local` 的普通后台 spawn 在 Windows 设置 `windowsHide`，不改变独立的交互终端实现。
- `dsh-sandbox-windows-acl` 的 runner 在没有控制台时创建自己的控制台并隐藏，让受限子进程继承。保留已有控制台，不隐藏用户终端；保存和恢复标准句柄，随后设置 Ctrl+C 行为。控制台分配失败时沿用原来的启动行为；恢复标准句柄失败则停止启动，避免命令输出被错误重定向。

没有给受限子进程添加 `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE`，没有改变 token、ACL 或 Job 生命周期。上游当前记录这两个创建标志会导致 `STATUS_DLL_INIT_FAILED`。

验证：`pnpm run prepare:runtime` 后运行 `pnpm run check:win32-console`。所有平台检查实际部署补丁的控制台归属、句柄恢复、初始化顺序、失败分支和 spawn 参数；Windows 还通过 Electron Node 调用真实 Win32 绑定，并执行受限 cmd 子进程，检查输入输出、退出码及两种模式的写入边界。CI、发布和本地 pack/dist 已接入该检查。

原生检查不等于可见桌面验收。发布前仍需在 Windows 桌面连续、并发执行 pwsh 命令并取消长命令，确认没有闪窗或残留进程。`AllocConsole` 后再 `ShowWindow` 不能从调用顺序上保证绝无短暂闪窗；需实机确认。

升级 DSH 时重新核对两个补丁及检查脚本；上游包含修复后删除对应补丁，不要直接套用旧的打包文件名。
