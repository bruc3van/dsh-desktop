# CI 消融实验（2026-09-07）

基线：`8e320a894a31f09434a227fc473667e67fb43617`。范围为 GitHub Actions 调度和重复配置，不修改产品代码或测试断言。

## 变更与覆盖

| 实验项 | 处理 | 验证依据 |
| --- | --- | --- |
| 分开的 contracts/app 作业 | 合并为三平台 contracts 矩阵 | Windows 去掉一次安装、一次构建；原有逐平台检查命令集合没有缺失 |
| Windows 两次 runtime-env | 保留准备运行时后的严格闭包检查 | 同一个脚本仍验证 launcher，且 `DSH_DESKTOP_REQUIRE_RUNTIME_CLOSURE=1` 要求闭包存在；Linux 继续验证 launcher |
| 发布矩阵的 smoke 字段 | 删除字段，直接执行 smoke:package | 三个平台原字段值完全相同，展开后的命令不变 |
| 应用检查的失败后继续执行 | 保留，补充前置步骤成功条件 | build 依赖 install，runtime 依赖 build，应用检查依赖 runtime；取消时停止 |
| NSIS fast/dirty/deep、两个架构的 DMG、升级测试 | 保留 | 验证不同的安装路径和平台行为；两个 package 作业解析后的对象与基线完全相同 |

正常成功路径下的命令数（含依赖安装和构建，不含 setup action）：

| 平台 | 修改前 | 修改后 |
| --- | ---: | ---: |
| Linux | 21 | 21 |
| Windows | 42 | 39 |
| macOS arm64 | 22 | 40 |

macOS 增加了 18 项原先只在 Linux/Windows 执行的源码检查，以统一检查流程。PR 的检查 job 数从 4 降为 3；main/手动触发的总 job 数从 7 降为 6。此变更减少重复环境准备，不保证缩短关键路径。

## 验证方法和限制

- 用 js-yaml 解析修改前后工作流，展开各平台正常成功路径，比较命令集合，并断言安装包作业保持一致。
- 本机依次执行基线和修改后 Windows 检查序列，包含 build、prepare:runtime 和 Electron 检查；复用已安装依赖，跳过两组的根目录 install。日志与逐命令结果位于 `%TEMP%/dsh-ci-ablation-20260907/`，临时驱动脚本为 `%TEMP%/dsh-ci-ablation.mjs`。
- 这不是两个隔离的冷启动 runner：基线也能读到本机已有的运行时闭包，缓存和执行顺序影响耗时，因此时间不能用于宣称 CI 提速。
- 对新条件表达式的前置步骤状态、取消和平台组合做了 2,268 次本地断言。此检查验证布尔条件，不代替 GitHub Actions 调度器实测。
- actionlint v1.7.12 检查全部三个工作流；关闭本机不可用的 ShellCheck 集成。
- 最近的基线 [CI 34087739597](https://github.com/bruc3van/dsh-desktop/actions/runs/34087739597) 全部成功：Windows 源码检查约 95 秒、应用检查约 377 秒，Windows 安装包约 461 秒。合并后能否缩短总耗时，需要新工作流的线上运行结果。
- 应用检查的状态名称统一为 `Contracts <os>`。本次读取 main 的传统保护规则返回 Branch not protected，仓库 rulesets 列表为空；若未来配置必需检查，应使用新名称。
- 实验仅在本地执行；未运行修改后的 Linux/macOS runner 或安装包测试，不将其报告为线上验证通过。

## 本机结果

| 流程 | 命令执行 | 结果 |
| --- | ---: | --- |
| 基线 | 40 | 40 通过 |
| 精简后 | 38 | 37 通过，1 次端口冲突失败 |

精简后的 `check:installed-runtime` 在 `automatic-retry-port` 场景接管 `127.0.0.1:3080` 时返回 `EADDRINUSE`。同一检查在基线通过。调查时监听 PID 为 38076，命令是 npm 缓存中的官方 dsh `web --port 3080 --no-open`；父进程是 16:04:00 启动的 `DSH Desktop.exe`，其父进程为 Explorer。该客户端在对照期间启动，改变了端口环境，未停止它或放宽断言。

因此不能将新版报告为全部通过：还需要在 3080 空闲的环境重新验证该检查，以及执行修改后的线上 CI。其余源码、运行时、Electron 检查全部通过，工作流语法和命令覆盖对比通过。两组不是受控冷启动实验，且其中一组提前结束了一个测试，不比较总耗时或推导提速比例。
