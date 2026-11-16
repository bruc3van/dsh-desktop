# ADR-0005 可移植 SQL、全表 `tenant_id`、单仓库 monorepo

状态：已采纳

## 决定

- **数据库**：PostgreSQL 用于部署，Node 内置的 SQLite 用于试用和测试。SQL 只用两边都支持的子集：`$1` 形式的参数，TEXT / BIGINT / INTEGER 列，不用数据库特有的函数、`RETURNING` 和 JSON 运算符。时间用毫秒时间戳，布尔用 0/1，结构化数据存 JSON 文本。同一套检查（`check:server`）在 SQLite 和 PostgreSQL 上都要通过。以后要加达梦、人大金仓、OceanBase 等国产数据库，只需要再写一个引擎适配。
- **多租户**：所有表从第一版起都带 `tenant_id`，唯一键也包含它。现在一个部署只服务一个组织，但以后再加这个字段，就得改每一条查询和每一个唯一键。
- **审计**：只追加，用哈希链串起来，每条记录保存上一条的哈希，追加在读取链尾的事务里完成，并发写入也不会分叉。
- **仓库结构**：桌面端代码留在仓库根目录，不迁到 `apps/desktop`；新增 `packages/protocol`、`apps/server`、`apps/console` 作为 pnpm workspace 包。这样已有的 60 多个检查脚本、CI、发布流程、更新源和 appId 都不用动，老用户无感。
- **服务端没有构建步骤**：Node 24 直接运行 TypeScript 源码（只用可擦除的语法，不用参数属性、enum）。依赖只有 `pg` 和 `jose`。

## 放弃的方案

- **ORM**：多一层依赖和抽象，换来的可移植性用约定的 SQL 子集同样能做到。
- **把桌面端迁进 `apps/desktop`**：没有用户价值，却要改所有路径和发布流程，风险大。

## 修订（0.7.0-beta.3）：只承诺 PostgreSQL

正式部署只支持 PostgreSQL。SQLite 保留给单机试用、演示和自动检查，不承诺升级路径、并发和备份恢复。CI 新增 PostgreSQL 任务，服务端的四组检查（`check:server`、`check:gateway`、`check:market`、`check:oidc`）在真实的 PostgreSQL 上各用一个空库跑一遍；此前这些检查只在 SQLite 上跑过，而 Docker 部署默认用的是 PostgreSQL。

数据不再无限增长：逐请求的网关记录默认保留 400 天（`DSH_REQUEST_RETENTION_DAYS`），过期的登录残留每小时清理；审计日志默认永久保留，设置 `DSH_AUDIT_RETENTION_DAYS` 后清理旧事件，并把最后一条被删事件的哈希记为检查点，完整性校验从检查点开始，所以不留检查点地截掉开头仍会被发现。
