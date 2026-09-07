# Windows 安装与升级消融记录

2026-09-07；基线提交 `1c19b67`，electron-builder `26.15.3`。

本轮检查了 `updater.ts`、`update-controller.ts`、NSIS include、模板补丁和安装 smoke 脚本，修改集中在后两者。目标是减少维护状态和补丁分支，并验证安装行为等价；不以删除功能或降低兼容性作为简化手段。

| 消融项 | 处理 | 实验结果 |
| --- | --- | --- |
| `dshExistingInstallFound` | 删除变量、初始化和同步赋值，直接判断恢复路径非空 | 修改前后各 24 个真实 NSIS 目录恢复用例通过 |
| `isNsisDetailsPatched` 提前返回 | 删除；每次验证并生成模板，以内容比较判定变化 | 24 组解压模板 A/B 输出及 `changed` 一致 |
| `hasFastExtractMark` | 删除无调用者的导出函数 | 仓库引用检查、现有检查通过 |
| 三份升级模板变更标志、全已修改时的快返分支 | 删除，结果按内容比较 | 8 种原始/缓存升级模板组合等价，二次执行无变化 |
| 五个文件的条件写入分支 | 合并为按文件内容比较的循环 | 已安装模板重复运行后，五个文件的修改时间均不变 |

移除快返判断还消除了一个校验漏洞：在已打补丁的上游宏中插入额外调用，旧实现直接返回成功，新实现拒绝该模板。此故障注入和旧布尔变量模板的迁移检查已加入 `check:nsis-details`。

直接解压、空目录检查、MAX_PATH 预算、暂存复制重试、旧版卸载补救、安装上下文切换和改名快捷方式修复均保留。这些机制各自承担实际行为，本轮没有证据支持删除。应用内下载来源/SHA-256 校验、停止运行时后再交接安装器、早退恢复也保留。

实验覆盖：

- 解压模板：LF/CRLF、预算 70/65/-1、原始模板/仅有进度补丁、重复应用，共 24 组。
- 升级模板：三个模板分别取原始或已修改状态，共 8 种组合；比较时仅将旧布尔条件归一为恢复路径条件。
- 原生 NSIS：用户/全局上下文 × 有/无恢复路径 × 有/无显式目录 × 原注册目录/恢复目录/手动修改目录，共 24 组，分别编译并运行修改前、后版本。程序仅验证变量和宏，不执行安装、卸载或注册表修改。
- `check:nsis-details`、TypeScript 类型检查、lint、`git diff --check`。
- 完整 NSIS 安装器编译通过（退出码 0）：`corepack pnpm exec electron-builder --win nsis --x64 --prepackaged release/win-unpacked --publish never --config.directories.output=.build/nsis-ablation-package`。

本次临时对照程序和基线保存在 `.build/capture-nsis.mjs`、`.build/compare-nsis.mjs`、`.build/native-nsis-ablation.mjs`，不进入发布包。

验证边界：原生目录宏实验不等同于完整安装/升级。完整安装器编译使用已有 `release/win-unpacked`，只用于检查当前 NSIS 模板与 include 的编译兼容性，不代表当前应用已完整重新打包。真实旧版升级、残留文件和深路径安装仍由干净 Windows runner 中的 `check-nsis-install.ps1`、`check-nsis-upgrade.ps1` 覆盖，本次未在本机执行这些场景，也未测量安装耗时变化。
