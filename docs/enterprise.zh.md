# 企业部署指南

[English](enterprise.md) | 中文

这份指南写给 IT 管理员：怎样让公司员工装好 DSH Desktop Pro 就能直接用，模型、插件、Skill 和工具权限都由 IT 统一配置。

DSH Desktop Pro 是社区项目，不是 DeepSeek 官方产品。企业功能全部开源（Apache-2.0），没有付费版，也不限人数。

## 两种管理方式

| | 文件模式 | 服务端模式 |
|---|---|---|
| 适合 | 几十人以内、配置很少变的团队 | 需要统一登录、按部门下发、离职回收、审计的组织 |
| 需要部署 | 不需要 | 管理服务端（Docker，自带模型网关），需要时再加 LiteLLM |
| 员工登录 | 不需要 | 公司 SSO（任意 OpenID Connect） |
| 模型 Key | 全团队共用一个网关 Key | 每人一个网关 Key，停用即吊销 |
| 配置更新 | 重新分发文件 | 控制台修改，在线设备几秒内生效 |

两种方式用的是同一份「期望状态」配置格式，客户端用同一套逻辑应用它，所以可以先用文件模式试点，之后无缝换成服务端模式。

## 员工那边会发生什么

只要电脑上有企业配置，客户端就进入**企业模式**：

- 首次打开时：文件模式直接可用；服务端模式显示「登录 XX」，写明登录后会配好什么，在系统浏览器里完成公司 SSO 登录。
- 默认模型已经选好，不会弹出要求填 API Key 的窗口。
- 运行时固定用安装包内置的 DSH（IT 测过的版本），数据放在客户端自己的目录（`~/.bruc3van-dsh-desktop/enterprise/dsh`），**不碰员工个人的 `~/.dsh`**。
- 连接方式、运行时来源、数据环境不能修改，设置里会显示「由 XX 统一管理」。
- 托盘菜单多出「导出诊断信息…」，员工可以把诊断文件发给 IT；里面只有名称和状态，不含任何密钥。服务端模式还有「退出企业账号…」。
- 断网时继续用上次的配置，宽限期默认 7 天，可以配置。

### 能不能改用个人模式

默认不能：公司电脑上的员工只能用企业账号登录，绕不开组织配置。

员工自带电脑（BYOD）等场景，可以在控制台「注册与分发」里选「允许」再下载 `enrollment.json`（文件里会多一行 `"allowPersonal": true`）；文件模式在 `managed.json` 里写 `"allowPersonal": true`。这样：

- 登录页、托盘菜单和桌面设置里会出现「改用个人模式」。
- 个人模式和没装企业配置时一样：员工用自己的模型 Key，数据在个人的 `~/.dsh`，不应用任何组织配置。
- 组织的会话和配置原样保留在企业数据目录里，从托盘或设置选「使用 XX 账号登录」即可切回。
- 控制台的设备列表会把这台设备标成「员工改用了个人模式」，审计日志里也有记录。

没有企业配置的电脑完全不受影响，客户端行为和个人版一模一样。

## 配置放在哪里

IT 把文件放进系统目录（普通用户没有写权限）。可以用 MDM、配置描述文件、软件分发工具，或者直接打进安装包：

| 系统 | 目录 |
|---|---|
| macOS | `/Library/Application Support/DSH Desktop Pro/` |
| Windows | `%ProgramData%\DSH Desktop Pro\` |
| Linux | `/etc/dsh-desktop-pro/` |

- 有 `enrollment.json` → 服务端模式。
- 只有 `managed.json` → 文件模式。
- 文件存在但内容有误时，客户端**拒绝启动**，并提示联系 IT，不会悄悄退回个人模式。

## 文件模式

`managed.json` 就是一份期望状态文档，示例：

```json
{
  "schema": "dsh-desktop-pro/desired-state",
  "version": 1,
  "revision": 1,
  "issuedAt": "2026-11-15T00:00:00Z",
  "organization": { "id": "youjigeyisi", "name": "广州有几个意思科技有限公司" },
  "models": {
    "providers": {
      "company-gateway": {
        "displayName": "公司模型网关",
        "api": "openai-completions",
        "baseURL": "https://llm.youjigeyisi.example/v1",
        "credential": "DSH_ORG_GATEWAY_KEY",
        "models": [{ "id": "deepseek-chat", "name": "DeepSeek Chat" }]
      }
    },
    "default": { "provider": "company-gateway", "model": "deepseek-chat" }
  },
  "credentials": { "DSH_ORG_GATEWAY_KEY": "sk-团队网关虚拟Key" },
  "plugins": { "indexes": ["https://bruc3van.com/dsh-plugins/index.json"] },
  "tools": { "deny": ["bash", "pwsh", "run_code"], "message": "公司 IT 已禁用此工具" }
}
```

**签名（推荐）**：防止有人改了 `managed.json` 绕开策略。

```bash
node scripts/org-key.mjs generate ./org-keys
```

```bash
node scripts/org-key.mjs sign managed.json ./org-keys/organization-key.pem
```

把签好的 `managed.json` 和 `organization-keys.json` 一起分发。私钥 `organization-key.pem` 留在 IT 手里，不要放到员工电脑上。目录里有 `organization-keys.json` 时，客户端只接受签过名、且签名能验证通过的 `managed.json`。

## 服务端模式

### 部署

```bash
cd deploy
cp .env.example .env
docker compose up -d
```

`.env` 里至少要填：`DSH_PUBLIC_URL`（员工电脑访问服务端的地址）、`DSH_SERVER_SECRET`（32 位以上随机字符，用来加密存储的 Key，**务必备份**）、`POSTGRES_PASSWORD`，以及一种登录方式。

- **公司 SSO**：任意 OpenID Connect 提供方都可以，比如 Azure AD / Entra ID、Okta、Keycloak、Authing。在 IdP 里登记回调地址 `<DSH_PUBLIC_URL>/v1/auth/oidc/callback`，再填写 `OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`。
- **试用**：`DSH_DEV_LOGIN=1` 会提供一个只填邮箱的登录页，**只能在内网试用时开**。

正式使用时请在前面加一层 HTTPS 反向代理。

不想装 PostgreSQL 的话，单机试用可以用内置的 SQLite：

```bash
DSH_PUBLIC_URL=http://127.0.0.1:8080 DSH_SERVER_SECRET=$(openssl rand -base64 48) DSH_DEV_LOGIN=1 DSH_BOOTSTRAP_TOKEN=change-me pnpm run server
```

### 模型网关

不管用哪种网关，员工电脑上都只有服务端给他签发的个人 Key，真实的模型 Key 拿不到；员工停用后，个人 Key 立即失效。

**内置网关（`DSH_GATEWAY=direct`，默认）**：服务端自己做网关，对接任意 OpenAI 兼容接口，比如 DeepSeek、通义千问、Kimi、智谱，或者内网的 vLLM。上游可以在 `.env` 里设一个默认的，也可以在控制台「模型目录」里添加多个：

```
DSH_GATEWAY=direct
# 可选：默认上游。不设时，在控制台「模型目录」里添加上游。
DSH_UPSTREAM_URL=https://api.deepseek.com/v1
DSH_UPSTREAM_KEY=sk-...
# 用量按天、周、月统计和重置所用的时区，默认 Asia/Shanghai。
DSH_TIMEZONE=Asia/Shanghai
```

- 场景包里模型路由的网关地址填 `<DSH_PUBLIC_URL>/llm/v1`，凭据选 `DSH_ORG_GATEWAY_KEY`。控制台新建模型路由时会自动填好，也可以直接「从模型目录选择」。
- 网关只放行这个人的场景包里列出的模型；改了场景包，下一个请求就按新的来。
- 每个请求都会记录：成员、部门、模型、实际回答的模型、Token（输入、缓存命中、输出、推理）、费用、首字延迟、总耗时、结果和失败原因。**不记录对话内容。**

**模型目录**（控制台「模型目录」）：

- 上游：名称、接口地址和 API Key。Key 加密保存在服务端，控制台和员工都看不到；「测试连接」会列出上游提供的模型。
- 模型：员工用的模型 ID 和显示名、发往哪个上游、上游认的模型名、价格（元 / 百万 Token，分输入、输出、缓存命中）、上下文长度、标签。换模型版本时只改「上游的模型名」，员工那边不用动。
- 停用的模型立即不能用。不在目录里的模型发往默认上游，原样转发，不计费用。

**用量分析**（控制台「用量分析」）：按今天、7 天、30 天、90 天查看请求数、Token、缓存命中率、费用、活跃成员、首字延迟和输出速度；按天的趋势图；按成员、部门、模型、客户端排行；逐条请求明细，可按失败、被拦截、已降级筛选；导出 CSV 给财务对账或合规留档（导出本身也记入审计日志）。费用按目录价格估算，没有定价的模型单独标出。

**额度**（控制台「额度」）：

| 设置 | 可选 |
|---|---|
| 适用于 | 全公司合计、部门合计（含下级部门）、每位成员（默认）、指定成员 |
| 统计 | 费用（元）、Token 数、请求数 |
| 周期 | 每分钟、每 5 小时（滚动）、每天、每周（周一起）、每月（1 号起） |
| 用完后 | 拦截请求；或者改用指定的模型继续（通常是便宜的模型） |

- 一个请求要通过所有相关额度才放行。被拦截时，员工收到 `429`，错误里写明是哪条额度、什么时候重置，并带 `Retry-After`。
- 给某个人单独设了同周期、同指标的额度后，以他自己的为准，不再套用「每位成员（默认）」。
- 「额度」页列出个人额度用到 80% 以上的人；成员详情页能看到他的用量和每条生效额度的进度。

**LiteLLM（`DSH_GATEWAY=litellm`）**：已经在用 LiteLLM，或者需要内容审计、更多厂商协议时用。模型目录、用量分析和额度只对内置网关生效；用 LiteLLM 时请在它的管理界面里看用量、设预算。服务端通过 LiteLLM 的 `/key/generate` 给每个员工签发专属 Key，只放行场景包里列出的模型。真实的模型厂商 Key 只放在 LiteLLM 里（`deploy/litellm.env`）。`docker compose --profile litellm up -d` 会一起启动 LiteLLM。

**硬管控在网关**：模型白名单、预算、内容审计都在网关执行，员工绕不过去。客户端上的工具禁用、界面锁定属于软管控，作用是防止误操作，不是安全边界。

### 控制台

浏览器打开 `<DSH_PUBLIC_URL>/console/`。第一次登录用 `DSH_BOOTSTRAP_TOKEN`；建好管理员账号、能用 SSO 登录以后，把这个变量删掉。

- **成员**：导入 CSV（`name,email,department,role`，部门用 `/` 分隔层级，比如 `财务部/应付组`）、修改角色、停用或恢复、预览某个人实际会收到的配置。
- **场景包**：用 JSON 编辑一类人的配置，每次保存都是一个新版本，可以回滚到任意历史版本；绑定到全员、部门或个人。
- **设备**：每台设备当前生效的配置版本、应用结果、最后在线时间；可以吊销设备。
- **审计**：登录、设备注册、配置下发、应用结果、员工端的工具拦截、所有管理员操作（包括改模型目录、改额度、导出用量）都有记录。日志只追加，并用哈希链串起来，「校验完整性」可以发现任何一条被删改。
- **模型目录、用量分析、额度**：见上面「模型网关」。
- **插件市场、Skill 库**：见下面「插件市场与 Skill 库」。
- **注册与分发**：下载 `enrollment.json`。这个文件里只有服务地址和组织公钥，不含密钥，可以放心分发。

角色：**管理员**可以改所有配置；**审计员**只读。

### 插件市场与 Skill 库

**插件市场**：IT 审核过的插件清单。

- 先在「来源」里添加公开的插件索引（与 DSH 发现页同一种格式，例如 DSH 社区精选 `https://bruc3van.com/dsh-plugins/index.json`），服务端读取后，在控制台里搜索、挑选。
- 每个插件上架一个固定版本，可以写审核备注、设为「公司推荐」。来源后来改了内容，已上架的插件不受影响；要更新，在这里换版本。
- 公司内部的插件（内网 npm 私服或 Git 仓库）可以手动添加，版本同样要写死，Git 要固定到提交。
- 上架了插件后，每位员工的发现页最前面会多一个「<公司名> 精选插件」列表。员工自己决定装不装；要给一类人强制安装，在场景包的「必装插件」里点「从插件市场选择」。
- 「禁用」的插件加入所有人的禁止列表：已装的会被卸载，场景包里设为必装的也不会安装。
- 员工的插件列表地址每人一个，员工被停用后立即失效。这个列表本身不签名，只是推荐；必装和禁止以签名的配置为准。

**Skill 库**：公司的 Skill 集中放在这里，在控制台里直接编辑 `SKILL.md` 和附带文件。

- 「所有人」：每位员工的电脑都会装上，员工不能移除。
- 「员工自选」：员工在客户端「设置 → 公司 Skill」里自己安装或移除，几秒内生效；控制台能看到谁装了。
- 改了文件，版本号加一，员工电脑在下次同步时更新。场景包里也能下发 Skill，同名时以场景包里的为准。

上架、下架、禁用、改 Skill、员工安装或移除 Skill，都记入审计日志。

### 场景包怎么合并

一个人可能同时适用多个场景包，按「全员 → 部门（从上级到下级）→ 个人」依次叠加：

- 模型路由、Skill、必装插件、更新设置：越具体的越优先。
- **禁用的工具、禁止的插件只会累加**：部门禁了 `bash`，个人场景包也取消不了。
- 离线宽限期取最短的那个。

### 离职和调岗

- **调岗**：在控制台改部门（或重新导入 CSV），员工电脑下次拉取配置时就会换成新部门的配置。
- **离职**：把成员停用。服务端会立即结束他的登录、吊销网关 Key、吊销他所有的设备。在线的员工电脑几秒内（离线的在下次联网时）会删掉组织下发的凭据、插件配置和 Skill，然后回到登录页。员工自己的会话记录会保留。

## 配置项一览

| 字段 | 作用 |
|---|---|
| `models.providers` | 模型路由（OpenAI 兼容 / Responses / Anthropic 协议），`credential` 填凭据的名字 |
| `models.default` | 新会话默认使用的模型 |
| `credentials` | 凭据的值，写进 DSH 自己的凭据文件，配置文件里只出现名字（服务端模式下由服务端为每个人生成） |
| `plugins.indexes` | 插件页「发现」里订阅的插件列表（服务端模式下，插件市场有上架插件时自动排在第一个） |
| `plugins.registry` / `fallbackRegistries` | 安装插件用的 npm 源，用于内网私服 |
| `plugins.required` | 必装插件，必须固定精确版本或 Git 提交 |
| `plugins.blocked` | 禁止的插件，已装的会被卸载（服务端模式下包含插件市场里禁用的插件） |
| `skills` | 下发到 `<数据目录>/skills` 的 Skill（服务端模式下包含 Skill 库里给所有人的和员工自己装的） |
| `tools.deny` / `message` | 禁用的工具，以及告诉模型的原因 |
| `updates.feedUrl` / `autoCheck` | 内网更新源，或者关闭自动检查更新 |
| `offline.graceDays` | 断网后继续使用缓存配置的天数 |
| `allowPersonal` | 仅文件模式：允许员工改用个人模式（服务端模式在 `enrollment.json` 里设置） |

常见的工具名：`bash`、`pwsh`、`run_code`（代码执行）、`terminal_open` 等终端工具、`write` / `edit` / `apply_patch`（写文件）、`web_fetch` / `web_search`。

### 工具禁用怎么生效

- 被禁用的工具不会出现在模型的工具列表里。
- 万一被调用（比如运行中途装上的插件带来的工具），会被拦下，模型收到配置的原因；每次拦截都会上报到控制台的审计日志，只记工具名和时间，不记参数。
- `run_code`（代码模式的执行入口）没法从列表里去掉，只能拦截调用。

## 已知限制

- 第一次启动时，必装插件要等运行时建好数据目录后才装，会晚一点生效；之后每次启动都在打开窗口前装好。
- 额度按已完成的请求计算：同时发出的几个请求可能让用量略微超过上限。
- 费用是按目录价格的估算，以上游厂商的账单为准。
- 插件市场的必装插件只按精确版本安装；上架时指定的 npm 私服地址只用于发现页安装，必装时用场景包里的 npm 源。
- 员工的发现页会缓存插件列表约 10 分钟，上架、下架后可能要等一会儿才显示；禁用和必装随配置几秒内生效。
- 公司 SSO 目前支持标准 OpenID Connect；飞书、钉钉、企业微信的登录和组织同步、灰度发布、离线安装包还在后续版本里。
