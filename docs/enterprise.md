# Enterprise deployment guide

English | [中文](enterprise.zh.md)

For IT administrators: make DSH Desktop Pro work the moment it is installed, with models, plugins, skills and tool permissions set centrally.

DSH Desktop Pro is a community project, not a DeepSeek product. All enterprise features are open source (Apache-2.0); there is no paid edition and no seat limit.

## Two ways to manage

| | File mode | Server mode |
|---|---|---|
| Fits | Small teams whose configuration rarely changes | Organisations that need SSO, per-department settings, off-boarding and audit |
| Deploy | Nothing | The management server (Docker, with a built-in model gateway), optionally LiteLLM |
| Sign-in | None | Company SSO (any OpenID Connect provider) |
| Model keys | One shared gateway key | One personal gateway key each, revoked on off-boarding |
| Changes | Redistribute the file | Edit in the console; online devices apply within seconds |

Both use the same desired-state document and the same client logic, so a file-mode pilot moves to server mode without changes on the desktop.

## What employees experience

With an organisation configuration present, the client is in **enterprise mode**:

- File mode works immediately. Server mode shows "Sign in to <organisation>" with what signing in sets up, completed in the system browser.
- The default model is preselected; no API-key prompt appears.
- The runtime is always the bundled DSH (the version IT tested), in the client's own directory (`~/.bruc3van-dsh-desktop/enterprise/dsh`). **The personal `~/.dsh` is never touched.**
- Connection mode, runtime source and data environment cannot be changed; settings say who manages them.
- The tray adds "Export Diagnostics…" (names and states only, never secrets) and, in server mode, "Sign Out of Organisation…".
- Offline, the last configuration keeps working for a grace period (7 days by default).

By default a person cannot opt out of the organisation. For personally owned machines, choose "Allow" under Distribution in the console before downloading `enrollment.json` (it then carries `"allowPersonal": true`): the sign-in page, tray and settings offer "Use personal mode" — the person's own model key and `~/.dsh`, with no organisation configuration — and the organisation's data waits untouched until they switch back. The console marks such a device as switched to personal mode. In file mode, set `"allowPersonal": true` in `managed.json`.

Machines without an organisation configuration behave exactly as the personal client.

## Where configuration goes

IT places files in a system directory (not writable by standard users), via MDM, a configuration profile, software distribution, or the installer:

| System | Directory |
|---|---|
| macOS | `/Library/Application Support/DSH Desktop Pro/` |
| Windows | `%ProgramData%\DSH Desktop Pro\` |
| Linux | `/etc/dsh-desktop-pro/` |

`enrollment.json` selects server mode; `managed.json` alone selects file mode. A file that is present but invalid stops the client with a message to contact IT — it never silently falls back to personal mode.

## File mode

`managed.json` is a desired-state document; see the Chinese guide for a full example and the field table below.

Sign it so a modified file is refused:

```bash
node scripts/org-key.mjs generate ./org-keys
```

```bash
node scripts/org-key.mjs sign managed.json ./org-keys/organization-key.pem
```

Distribute the signed `managed.json` with `organization-keys.json`; keep `organization-key.pem` with IT. With `organization-keys.json` present, only a `managed.json` signed by one of those keys is accepted.

## Server mode

```bash
cd deploy
cp .env.example .env
docker compose up -d
```

Set at least `DSH_PUBLIC_URL`, `DSH_SERVER_SECRET` (32+ random characters; it encrypts stored keys — back it up), `POSTGRES_PASSWORD`, and a sign-in method: OpenID Connect (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`; register `<DSH_PUBLIC_URL>/v1/auth/oidc/callback`), or `DSH_DEV_LOGIN=1` for an internal trial only. Put an HTTPS reverse proxy in front for real use. A single-machine trial can use the built-in SQLite:

```bash
DSH_PUBLIC_URL=http://127.0.0.1:8080 DSH_SERVER_SECRET=$(openssl rand -base64 48) DSH_DEV_LOGIN=1 DSH_BOOTSTRAP_TOKEN=change-me pnpm run server
```

Either way, employees only ever hold a personal key the server issues, revoked the moment they are disabled:

- **Built-in gateway** (`DSH_GATEWAY=direct`, the default): the server forwards to any OpenAI-compatible API (DeepSeek, Qwen, Kimi, Zhipu, an internal vLLM). Set a default upstream with `DSH_UPSTREAM_URL` and `DSH_UPSTREAM_KEY`, or add upstreams in the console's model catalog; `DSH_TIMEZONE` (default `Asia/Shanghai`) sets the days, weeks and months that usage and limits follow. Profiles route models to `<DSH_PUBLIC_URL>/llm/v1`; only the models in the person's profiles are allowed, checked on every request. Every request is recorded — member, department, model, the model that answered, tokens (input, cache hits, output, reasoning), cost, time to first token, duration and result — never the conversation.
  - **Model catalog**: upstreams (address and an API key encrypted on the server; *Test connection* lists what they serve) and models: the ID and name people use, the upstream and the name it knows the model by, prices in yuan per million tokens (input, output, cache hit), context window and tags. A turned-off model stops at once; a model outside the catalog goes to the default upstream unpriced.
  - **Usage**: today, 7, 30 or 90 days of requests, tokens, cache-hit rate, cost, active members, time to first token and output speed; a daily trend; rankings by member, department, model and client; a request log filterable by failed, refused and switched requests; CSV export for finance and compliance (the export itself is audited). Cost is estimated from catalog prices, and unpriced calls are counted apart.
  - **Limits**: for the company total, a department total (including sub-departments), each member by default, or one member; on cost, tokens or requests; per minute, per rolling 5 hours, per day, week (from Monday) or month (from the 1st). When one is used up, requests are refused with a `429` that names the limit and its reset, with `Retry-After` — or continue on a chosen cheaper model. A request goes ahead only while every limit that applies has something left; a member's own limit replaces the member default with the same period and measure.
- **LiteLLM** (`DSH_GATEWAY=litellm`): when you already run LiteLLM or need its guardrails and provider protocols. The model catalog, usage and limits apply to the built-in gateway; with LiteLLM, use its own admin UI for usage and budgets. The server issues each person a LiteLLM key (`/key/generate`) limited to their profile's models. Real provider keys stay in LiteLLM (`deploy/litellm.env`).

**Hard limits live in the gateway**; the client's tool denials and locked settings prevent accidents but are not a security boundary.

The console is at `<DSH_PUBLIC_URL>/console/`: members (CSV import with `/`-separated department paths, roles, disable, preview), profiles (JSON editor, immutable versions, rollback, bindings to everyone / department / person), devices (applied revision and result, revoke), model catalog, usage and limits (above), plugin market and skill library (below), audit (append-only, hash-chained, with an integrity check; catalog, limit and export changes included), and the `enrollment.json` download (server address and public keys only). Administrators edit; auditors read.

**Plugin market.** Add public plugin indexes as sources (the format the DSH Discover page reads, such as the DSH community picks at `https://bruc3van.com/dsh-plugins/index.json`); the server reads them and you search and pick in the console. Each approved plugin is pinned to one version, with a review note and an optional recommendation; later changes at the source do not reach it until you change the version. Internal plugins (an intranet npm registry or a Git repository pinned to a commit) can be added by hand. Once something is approved, everyone's Discover page lists "<organisation> plugins" first. People decide what to install; to install a plugin for a group, use *Choose from the plugin market* under a profile's required plugins. Blocked plugins join everyone's blocked list, so they are removed and never installed. Each person has their own address for the list, which stops working when they are disabled. The list itself is not signed and only recommends; required and blocked plugins come from the signed configuration.

**Skill library.** Edit `SKILL.md` and its reference files in the console. A skill for *Everyone* is installed on every computer and cannot be removed there; an optional skill is installed or removed by each person under *Settings → Company skills* in the client, within seconds, and the console shows who has it. Changing the files raises the version. A profile skill with the same name wins. Approvals, withdrawals, blocks, skill changes and people installing or removing skills are all audited.

Profiles apply everyone → departments (top down) → person. Settings follow the most specific profile; **denied tools and blocked plugins only accumulate**; the shortest offline grace wins. Disabling a member ends their sessions, revokes their gateway key and devices; online clients learn within seconds (others when they reconnect), remove the organisation's credentials, plugin settings and skills and returns to sign-in, keeping the person's sessions.

## Fields

| Field | Effect |
|---|---|
| `models.providers` / `models.default` | Model routes (OpenAI-compatible, Responses, Anthropic) and the default model |
| `credentials` | Credential values written to DSH's credential file; profiles name them, never contain them |
| `plugins.indexes` | Plugin index sources on the Discover page |
| `plugins.registry` / `fallbackRegistries` | npm registry for plugin installation (intranet mirrors) |
| `plugins.required` / `blocked` | Plugins installed at an exact version or commit / removed and never installed |
| `skills` | Skills written to `<data home>/skills` |
| `tools.deny` / `message` | Tools refused before they run, and the reason the model sees |
| `updates.feedUrl` / `autoCheck` | Intranet update feed, or no automatic checks |
| `offline.graceDays` | Days a cached configuration keeps working offline |
| `allowPersonal` | File mode only: allow switching to personal mode (server mode sets it in `enrollment.json`) |

Denied tools are taken out of the model's tool list. A call that still arrives (a tool from a plugin installed mid-session) is refused with the configured reason and reported to the audit log — tool name and time only, never arguments. `run_code`, the code-mode transport, cannot be unlisted, only refused.

## Known limitations

- On the very first start, required plugins install once the runtime has created its data directory; on later starts they are in place before the window opens.
- Limits count completed requests, so requests sent at the same moment can overshoot a limit slightly.
- Cost is an estimate from catalog prices; the provider's bill is authoritative.
- Required plugins from the market install at their exact version from the profile's npm registry; a registry set on an approved plugin is used only when people install it from Discover.
- The Discover page caches the plugin list for about 10 minutes, so approvals and withdrawals can take a while to show; blocks and required plugins arrive with the configuration within seconds.
- Sign-in is standard OpenID Connect today; Feishu, DingTalk and WeCom sign-in and directory sync, staged rollout and offline install bundles are planned.
