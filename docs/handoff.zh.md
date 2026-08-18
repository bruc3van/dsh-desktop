# 交接说明（2026-08-18，v0.2.3 发布之后）

这份文件是给换一台机器（尤其是 macOS）继续这项工作的人／会话看的：把已经确定的
结论写下来，避免冷启动时重新调研一遍。**内容是 2026-08-18 的快照**，待办完成后
请更新或删除本文件，不要让它变成过期的地图。

整份文档可以直接作为提示词粘贴给新会话。

---

## 项目

仓库 <https://github.com/bruc3van/dsh-desktop>（Electron 客户端，把 DeepSeek 官方
dsh Web UI 常驻桌面）。分支 `main`，本文写作时 HEAD = `8784698`。Node 24、
pnpm 11.16.0，`pnpm install --frozen-lockfile` 起步。

核心不变量：**同一个 `DSH_HOME` 绝不能有第二个写入者。** 仓库里大量运行时锁、
遗留进程接管、拒绝启动的逻辑都是为这条服务的，改任何运行时解析相关代码前先理解
它（见 [桌面客户端架构](desktop-client-architecture.zh.md)）。

## 刚发生了什么（不用重做）

v0.2.3 已正式发布，`/releases/latest` 指向它，三平台安装包 + `SHA256SUMS.txt` +
`latest.json` 齐全，`latest.json` 三个平台键都在。

发布过程连续失败三次，根因都是「只有真发一次版才会跑到」的门禁问题，均已修复：

| 门禁 | 根因 | 只在哪里成立 |
|---|---|---|
| `check:pnpm-runtime` | `pathToFileURL` 把 `~` 编码成 `%7E`，pnpm 按字面量解析路径 | GitHub Windows runner 的 8.3 短路径 `C:\Users\RUNNER~1\...` |
| `check:updater` | 脚本起了 3 个 fixture 服务器、收尾只关了 1 个，listening handle 撑着事件循环，断言全过后进程不退出 | 全平台（本地曾出现挂了 20 小时的遗留进程） |
| `check:auto-fallback` | 取基线的谓词对「正被替换掉」的运行时已成立，抓到即将消失的 pid | macOS 确定性失败，Windows 恰好赢了竞态 |

分别改为：相对 `file:../fixture` 规格；统一 `listenOn()` 登记 + 收尾
`closeAllConnections()` + `close()`；新增 `waitForSettledLocalRuntime()`，等
`childPid` 稳定 2 秒再取基线。

同期落地的一轮 review 修复：

- 新增 [`scripts/release-artifacts.mjs`](../scripts/release-artifacts.mjs) 作为发布
  产物命名的单一事实来源（此前 `electron-builder.yml`、`latest.json`、下载表、
  `check:updater` fixture 四处各写一遍）；`check:release-artifacts` 负责与
  `electron-builder.yml` 对账，已做负向测试
- `write-update-feed.mjs` 要求三个平台齐全才写 feed。此前只在零产物时报错，而缺
  平台对用户是**完全静默**的：updater 把缺失的平台 key 读作「已是最新」
- 新增 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)（push/PR 触发）：
  `contracts` 作业跑 ubuntu + windows，`app` 作业跑 windows-latest + macos-15。
  此前仓库只有 tag 触发的发布流水线，typecheck / lint / 全部契约检查第一次运行
  的时机就是发布本身
- `smoke-package.mjs` 在 Windows 上按进程树收尾；`check-restart.mjs` 改在 process
  exit 清理临时目录

## 待办 1（主要）：`check:installed-runtime` 在 macOS 上跑不过

**这是唯一一个至今没有在 macOS 上验证过的检查。** 其余检查——包括上面两个修复
本身——都已在 macOS runner 上实跑通过，别去重复验证已经绿的东西。

目前它在 `ci.yml` 里被 `if: ${{ !cancelled() && runner.os == 'Windows' }}` 限定掉
了，注释里留了线索。**这是搁置，不是修复。**

复现（在 Mac 上）：

```sh
pnpm install --frozen-lockfile
pnpm run build
DSH_RUNTIME_TARGET=darwin-arm64 pnpm run prepare:runtime
node scripts/check-installed-runtime.mjs
```

已知事实，别重新推翻：

- 前 17 条断言在同一台 macOS runner 上全部通过，所以 **Electron 本身能启动**
- 失败点是 `scripts/check-installed-runtime.mjs:345` 的 `app.firstWindow()` 超时
  30 秒，属于「3. npx 缓存」那个场景（340 行起）
- 该场景特有的两点：`launch` 时 `pathDsh: false`（把 dsh 从 PATH 摘掉，系统 PATH
  仍在），以及 `npm_config_cache` 指向 `fixtureNpxCache()` 造的假缓存
- playwright 报的 error 里 `log` 是空数组，CI 上拿不到更多输出
- Windows 上本地和 CI 都稳定通过（本地约 35 秒）

在 Mac 本地能看到窗口和主进程 stdout，这是 CI 给不了的。请查清成因——可能是
fixture 的跨平台可移植性问题，也可能是产品在 macOS 上的真实行为差异（注意 macOS
有 login-shell PATH 还原这条路径，见 `smoke-package.mjs` 的注释）。**定位清楚再
改，不要靠加超时或加等待糊过去。**

完成的标准：去掉 `ci.yml` 里那个 `runner.os == 'Windows'` 限定和对应注释，推
main，确认 CI 的 macos-15 腿**真的跑了这一步并变绿**——要核对该 step 的
`conclusion` 不是 `skipped`，不能只看作业总体是绿的。

## 待办 2：macOS DMG 没有安装冒烟

Windows 侧有真实门禁：`release.yml` 里「验证 Windows NSIS 实际安装结果」会静默
安装 NSIS 包到临时目录，再对装出来的 exe 跑一遍 `smoke-package.mjs`。

macOS 侧没有对应的东西——`smoke:package` 跑的是 `release/mac-*/*.app` 这个**未打包
目录**，DMG 本身从来没有被挂载、拷贝、启动过。一个坏掉的 DMG 会照常发布。

做一个等价步骤：`hdiutil attach` → 从卷里拷出 `.app` → `detach` → 对拷出来的
`.app` 跑 `node scripts/smoke-package.mjs <path>`。

## 重要约束（这次踩过，别再踩）

**发布流水线只由 tag 触发，没有其他触发方式。** 所以任何新门禁步骤都必须先在
`ci.yml` 里跑绿，再考虑进 `release.yml`。commit `686c1e7` 一口气往 `release.yml`
加了三个从未在 CI 跑过的检查，直接导致 v0.2.3 失败三次，每次烧掉一轮完整构建。

同理，待办 2 做出来的 DMG 冒烟步骤，**先放 `ci.yml` 验证**，不要直接写进
`release.yml`。

改动落地的顺序：本地先跑通 → 推 main 让 CI 验证 → CI 绿了再谈发布。

`CHANGELOG.md` 的 0.2.3 段落已经发出去了，新改动写到新的未发布段落里。

发布方式见 [开发文档的版本发布一节](development.zh.md#版本发布)：推版本 tag 即可，
tag 是版本号的唯一来源。

## 有用的命令

```sh
pnpm run lint
pnpm run typecheck
pnpm run check:release-artifacts     # 纯文件读，秒级
pnpm run check:installed-runtime     # 待办 1 的目标
pnpm run check:auto-fallback         # macOS 上已验证通过，可作对照

gh run list --workflow=ci.yml --limit 3
gh api repos/bruc3van/dsh-desktop/actions/jobs/<id> \
  --jq '.steps[] | .conclusion + "  " + .name'
```
