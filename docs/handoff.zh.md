# 交接说明（2026-08-18，v0.2.3 发布之后）

给换机器／换会话继续这项工作的人看：把已经确定的结论写下来，避免冷启动时重新
调研一遍。**内容是 2026-08-18 的快照**，情况变了请更新或删除本文件，不要让它
变成过期的地图。

---

## 项目

仓库 <https://github.com/bruc3van/dsh-desktop>（Electron 客户端，把 DeepSeek 官方
dsh Web UI 常驻桌面）。分支 `main`。Node 24、pnpm 11.16.0，
`pnpm install --frozen-lockfile` 起步。

核心不变量：**同一个 `DSH_HOME` 绝不能有第二个写入者。** 仓库里大量运行时锁、
遗留进程接管、拒绝启动的逻辑都是为这条服务的，改任何运行时解析相关代码前先理解
它（见 [桌面客户端架构](desktop-client-architecture.zh.md)）。

## v0.2.3 之后做了什么（不用重做）

v0.2.3 已正式发布，`/releases/latest` 指向它，三平台安装包 + `SHA256SUMS.txt` +
`latest.json` 齐全。发布过程连续失败三次，根因都是「只有真发一次版才会跑到」的
门禁问题，均已修复：

| 门禁 | 根因 | 只在哪里成立 |
|---|---|---|
| `check:pnpm-runtime` | `pathToFileURL` 把 `~` 编码成 `%7E`，pnpm 按字面量解析路径 | GitHub Windows runner 的 8.3 短路径 |
| `check:updater` | 起了 3 个 fixture 服务器只关了 1 个，listening handle 撑着事件循环 | 全平台 |
| `check:auto-fallback` | 取基线的谓词对「正被替换掉」的运行时已成立，抓到即将消失的 pid | macOS 确定性失败 |

同期还落地了 [`scripts/release-artifacts.mjs`](../scripts/release-artifacts.mjs)
（发布产物命名的单一事实来源）、更新 feed 要求三平台齐全才写、以及
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)——在此之前仓库只有 tag
触发的发布流水线，typecheck / lint / 契约检查第一次运行的时机就是发布本身。

之后完成的两项：

- **`check:installed-runtime` 已在 macOS 上放开。** 此前它被 `runner.os ==
  'Windows'` 限定，因为在 macos-15 上会在 `firstWindow()` 上超时。成因见下。
- **macOS DMG 有了安装冒烟**（[`scripts/smoke-dmg.mjs`](../scripts/smoke-dmg.mjs)，
  `pnpm run smoke:dmg`）：挂载 DMG → 确认卷里有 `.app` 和 Applications 拖放目标 →
  `ditto` 拷出来 → 卸载 → `codesign` 校验 → 对拷出来的 `.app` 跑 `smoke-package`。
  与 Windows 侧「静默安装 NSIS 再冒烟」对等。ci.yml 里新增的 `package` 作业会真打
  一次 DMG 并跑它，release.yml 的 macOS 两条腿也各跑一次。

## 还没定的事

**Playwright 偶尔看不见已经打开的窗口。** `check:installed-runtime` 在 GitHub
macos-15 上约每三次有一次在 `firstWindow()` 超时。带诊断跑到的现场是：主进程答
`ready: true`、窗口 `visible: true`、页面已经是 `http://127.0.0.1:…`——客户端全须
全尾，是 playwright-core 1.62.1 从没把这个窗口交出来。中招的总是运行时就绪最快的
那两个 npx 场景；本地加 CPU 负载、让目标提前起好，都复现不出来（0/24）。

上游成因没查到。当前做法是 `openApp()` 在**能证明客户端健康**（主进程报得出一个
未销毁的活窗口）时重启一次，其余情况第一次就带完整转储失败。升级 playwright-core
时值得回头看一眼；如果日志里那条 `relaunching … once` 警告开始频繁出现，值得往
upstream 报一个。

## 重要约束（踩过，别再踩）

**发布流水线只由 tag 触发，没有其他触发方式。** 任何新门禁步骤都必须先在
`ci.yml` 里跑绿，再进 `release.yml`。commit `686c1e7` 一口气往 `release.yml` 加了
三个从未在 CI 跑过的检查，直接导致 v0.2.3 失败三次，每次烧掉一轮完整构建。

`ci.yml` 支持 `workflow_dispatch`：调查这类只在 runner 上成立的问题时，推一个分支
再 `gh workflow run ci.yml --ref <branch>`，不必拿 main 当试验田。

改动落地的顺序：本地先跑通 → CI 验证 → CI 绿了再谈发布。

`CHANGELOG.md` 的 0.2.3 段落已经发出去了，新改动写到新的未发布段落里；纯 CI／
测试改动不进 CHANGELOG。

发布方式见 [开发文档的版本发布一节](development.zh.md#版本发布)：推版本 tag 即可，
tag 是版本号的唯一来源。

## 有用的命令

```sh
pnpm run lint
pnpm run typecheck
pnpm run check:release-artifacts     # 纯文件读，秒级
pnpm run check:installed-runtime     # 本地约 10 秒，35 条断言
pnpm run smoke:dmg                   # 需要先 electron-builder 打出 release/*.dmg

gh workflow run ci.yml --ref <branch>
gh run list --workflow=ci.yml --limit 3
gh api repos/bruc3van/dsh-desktop/actions/jobs/<id> \
  --jq '.steps[] | .conclusion + "  " + .name'
```
