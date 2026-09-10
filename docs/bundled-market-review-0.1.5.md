# DSH 0.1.5 内置市场安装方式审查

审查日期：2026-09-10。对象为客户端未提交代码、npm 发布的 `dsh-desktop-safe-market@0.5.0` 和实际部署的 `@deepseek-ai/dsh@0.1.5-rc.1`。当日 npm 的 DSH `latest`、`next` 均为 `0.1.5-rc.1`。

## 结论

现有离线内置 bundle 的方向符合 DSH 的组合机制，正常启动路径可用，但客户端对用户安装的接管、首次启动和版本来源的一致性尚不能称为最佳实践。更新市场版本不要求先重构这些流程；本次仅更新发布包与依赖声明，以下问题保留为后续安装流程改造范围。

官方区分安装目录内置 bundle 与通过 `dsh plugin --profile <name> add <package>` 安装的 profile 依赖。bundle patch 从安装目录优先解析；Loader 的裸模块名则使用 profile 的模块查找路径。参考 [官方 bundle 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/README.md)；版本相关判断以本次部署包的 `dsh-app-boot/lib/index.js`、`dsh/lib/plugin-Ddi42qoW.js` 为准，不能用 master 文档代替固定版本源码。

## 当前流程与官方契约

1. 发布时把市场包放进客户端的 runtime 依赖树，固定版本与 lockfile，不要求用户启动时联网安装。
2. `seatBundledPlugin()` 把市场复制到 `$DSH_HOME/profiles/node_modules/dsh-desktop-safe-market`，写入 `.dsh-desktop-seat.json` 所有权标记，并加入 web profile 的 `dsh.profile.bundles`。
3. 复制而非链接到客户端 runtime，是为了让市场的 DSH Service 导入使用实际运行的 DSH 依赖，避免外部 runtime 加载第二套 Service 类。
4. DSH 0.1.5 的 `healProfilesModuleFallback()` 会维护共享 fallback，并通过 profile 自有的 `.dsh-module-fallback` 补齐仅 bundle 需要的依赖；它保留 pnpm 管理的 profile 安装。客户端注释中“只增加条目”并不完整：上游也会更新安装依赖对应的既有链接，但本次验证中不会覆盖不属于该安装依赖图的市场所有权目录。

临时 profile 的官方 `loadProfileDirectory()` + `healProfilesModuleFallback()` 实测：正常内置市场可解析，所有权标记保留，市场从 profile 解析的 Cordis 与运行 DSH 的 Cordis 路径一致。上述新增官方机制与当前正常内置路径没有直接冲突。

## 已确认的改进点

### 用户较新版覆盖并不具有完整的版本一致性

`seatBundledPlugin()` 保留较新或同版的用户安装，但内置 runtime 的 `resolveBundleDir()` 仍首先选取 runtime 中的市场包读取 patch；Loader 的 profile 模块解析可以选择用户安装版本。

用临时 profile 放入测试版本 `99.0.0` 和独立 patch，调用官方加载器并在新进程解析模块后，确认 patch 来自随包市场，模块 manifest 来自 `99.0.0`。测试版本仅为隔离 fixture，未安装到用户环境。

这证明“保留用户较新版”不等于所有层都来自该版本；当新版改变 bundle patch 时可能产生不一致。未声称当前 `0.5.0` 已因此启动失败。

### 接管旧用户安装绕过了包管理器

`liftStaleOverlay()` 直接删除 profile 的市场 dependency 和 `node_modules` 入口，不调用 pnpm、不协调 profile 的 lockfile。它还将用户主动固定的旧版视为可以自动替换的版本，混合了客户端内置内容和用户依赖的管理职责。

建议保留用户安装的所有权，不因版本较旧自动接管。若产品明确需要迁移，应提供单独迁移策略，并通过官方 CLI/pnpm 维护依赖、锁文件和 bundle 列表的一致性。

### 首次启动的登记发生在 profile 加载后

缺少 web profile 时 `seatBundledPlugin()` 返回未登记；`onManagedReady()` 再登记市场。此时 DSH 已完成本次 bundle 列表读取，因此首次启动不能保证市场立即加载。现有 package smoke 先用 CLI 初始化 profile，验证的是初始化后的启动，不能作为首次启动体验的证据。

建议在启动前通过固定版本 DSH 的 profile 初始化能力完成准备，再加载市场，避免复制官方模板到客户端后长期维护第二份。

### 外部 runtime 的兼容判断仍偏宽

当前版本门槛允许所有较新 runtime；采用已经运行的实例时 `serving: true` 跳过版本门槛，运行实例的 home 与 profile 也没有在此路径得到证明。市场的动态导入保护是降级措施，不能证明所有较新版本都满足 `^0.1.5-rc.1` 的 peer 范围。

建议使用实际 peer 范围及可验证的运行时能力，不能仅以“服务已经运行”作为注入共享 profile 的依据。

## 建议的后续方向

- 保留离线内置发布方式，依赖版本由发布 lockfile 决定；用户插件继续走官方 profile CLI。
- 分清客户端管理的内置市场和用户显式安装的市场，只升级客户端拥有的副本。
- 确保 bundle patch、服务端模块、客户端模块和依赖都来自同一确定版本；不能只检查 profile 中的版本号。
- 若改用应用自有 profile，可评估官方 `loadProfileDirectory()`；共享模式仍需明确的迁移策略，不能直接更换用户现有 profile。
- 为后续重构增加冷启动、用户旧版/新版覆盖、共享与独立 home、外部 runtime、禁用/卸载/重启的集成覆盖。当前仅有 seat 的单元测试不足以覆盖官方解析优先级。

## 本次版本更新

- 固定 `dsh-desktop-safe-market` 为 `0.5.0`，同步精确发布年龄豁免、lockfile 与更新日志。
- `0.5.0` 已原生声明 DSH `^0.1.5-rc.1` peers，删除旧 `0.4.3` 所需的 13 项 DSH peer overrides。
- 保留 runtime 部署脚本对所有 DSH 包版本一致性的检查，防止移除 overrides 后出现混合版本。
- 本次没有迁移用户 profile，也没有更改现有安装、接管、禁用或卸载行为。

## 验证结果

- npm 发布包 integrity 与 lockfile 一致；锁文件不再包含 `0.4.3` 市场包。
- `prepare:runtime` 使用 frozen lockfile 部署成功，231 个 DSH 包均为 `0.1.5-rc.1`。
- `build`、`lint`、`typecheck`、`check:bundled-plugin`、`check:runtime-lock`、`check:runtime-env`、`check:win32-console` 通过。
- 在 `0.5.0` 上重跑官方加载器的临时 profile 验证，正常内置路径通过；用户覆盖的 patch/模块来源不一致仍可复现。
- Windows 独立验证包的市场 manifest 为 `0.5.0`，DSH 为 `0.1.5-rc.1`；`smoke:package` 通过，市场 describe 返回版本与包内版本一致，settings/installed API、认证 Web API 和空 PATH 下的 CLI shim 均通过。
- 本地 `.build` 含历史验证产物，本次用临时打包配置只收集四个应用构建入口，其他资源配置保持原值，输出至 `release/market-050-verification`。这验证了 Windows 解包应用，不等同于完整 pack/dist 发布流水线、安装器或 macOS 验证。
