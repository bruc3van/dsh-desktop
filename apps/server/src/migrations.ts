/**
 * Schema migrations, applied in order and recorded in `schema_migrations`.
 * Every table carries `tenant_id` from the first version, even though a
 * deployment serves one organisation today: adding it later would mean
 * rewriting every query and every unique key.
 * @module @dsh-desktop-pro/server/migrations
 */

import type { Db } from './db.ts'

const MIGRATIONS: Array<{ id: number; statements: string[] }> = [
  {
    id: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, config_revision BIGINT NOT NULL DEFAULT 1, created_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS org_keys (
        tenant_id TEXT NOT NULL, key_id TEXT NOT NULL, public_key TEXT NOT NULL, private_key_sealed TEXT NOT NULL,
        active INTEGER NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (tenant_id, key_id))`,
      `CREATE TABLE IF NOT EXISTS departments (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, external_id TEXT, created_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT, role TEXT NOT NULL, status TEXT NOT NULL,
        department_id TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (tenant_id, email)`,
      `CREATE TABLE IF NOT EXISTS external_identities (
        tenant_id TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, created_at BIGINT NOT NULL,
        PRIMARY KEY (tenant_id, provider, subject))`,
      `CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, current_version INTEGER NOT NULL,
        created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS profile_versions (
        tenant_id TEXT NOT NULL, profile_id TEXT NOT NULL, version INTEGER NOT NULL, spec TEXT NOT NULL, note TEXT,
        created_by TEXT, created_at BIGINT NOT NULL, PRIMARY KEY (profile_id, version))`,
      `CREATE TABLE IF NOT EXISTS profile_bindings (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, profile_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
        priority INTEGER NOT NULL, created_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, public_key TEXT NOT NULL, platform TEXT, arch TEXT,
        hostname TEXT, client_version TEXT, dsh_version TEXT, status TEXT NOT NULL, applied_revision BIGINT, applied_result TEXT,
        applied_problems TEXT, applied_at BIGINT, served_revision BIGINT, created_at BIGINT NOT NULL, last_seen_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS login_flows (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, client_redirect TEXT, client_state TEXT, code_challenge TEXT,
        oidc_state TEXT, oidc_nonce TEXT, oidc_verifier TEXT, expires_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS auth_codes (
        code_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, client_redirect TEXT NOT NULL,
        code_challenge TEXT NOT NULL, expires_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, refresh_hash TEXT,
        created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, revoked INTEGER NOT NULL)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS sessions_refresh ON sessions (refresh_hash)`,
      `CREATE TABLE IF NOT EXISTS access_tokens (
        token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, session_id TEXT NOT NULL, user_id TEXT NOT NULL, expires_at BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS gateway_keys (
        tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, gateway TEXT NOT NULL, key_sealed TEXT NOT NULL, expires_at BIGINT,
        created_at BIGINT NOT NULL, PRIMARY KEY (tenant_id, user_id, gateway))`,
      `CREATE TABLE IF NOT EXISTS audit_events (
        seq BIGINT NOT NULL, tenant_id TEXT NOT NULL, at BIGINT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL,
        target TEXT, detail TEXT, source TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (tenant_id, seq))`,
    ],
  },
  {
    id: 2,
    statements: [
      // Personal keys of the built-in gateway, stored only as hashes.
      `CREATE TABLE IF NOT EXISTS proxy_keys (
        key_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at BIGINT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS proxy_keys_user ON proxy_keys (tenant_id, user_id)`,
      // Requests through the built-in gateway, per person and day.
      `CREATE TABLE IF NOT EXISTS gateway_usage (
        tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL, requests BIGINT NOT NULL,
        prompt_tokens BIGINT NOT NULL, completion_tokens BIGINT NOT NULL, PRIMARY KEY (tenant_id, user_id, day))`,
      // Whether a device is in personal mode (the person opted out on an enrolled machine).
      `ALTER TABLE devices ADD COLUMN mode TEXT`,
    ],
  },
  {
    id: 3,
    statements: [
      // Upstream model services the built-in gateway forwards to. The key is
      // sealed with the server secret; `default` is DSH_UPSTREAM_URL and lives
      // in the environment, not here.
      `CREATE TABLE IF NOT EXISTS upstreams (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL, key_sealed TEXT,
        created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
      // The model catalog: the names people use, where each goes, and what it costs.
      // Prices are micro-yuan per million tokens (2.5 yuan → 2500000); NULL is unpriced.
      `CREATE TABLE IF NOT EXISTS catalog_models (
        tenant_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, upstream_id TEXT NOT NULL, upstream_model TEXT NOT NULL,
        input_price BIGINT, output_price BIGINT, cache_read_price BIGINT, context_window BIGINT, tags TEXT NOT NULL,
        recommended INTEGER NOT NULL, enabled INTEGER NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
        PRIMARY KEY (tenant_id, id))`,
      // One row per request through the built-in gateway. `day` is the local
      // day in the server's time zone, so daily totals group without engine-specific date functions.
      `CREATE TABLE IF NOT EXISTS gateway_requests (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, department_id TEXT, started_at BIGINT NOT NULL, day TEXT NOT NULL,
        endpoint TEXT NOT NULL, model TEXT NOT NULL, served_model TEXT, upstream_id TEXT, fallback_from TEXT, client TEXT, stream INTEGER NOT NULL,
        status TEXT NOT NULL, http_status INTEGER NOT NULL, error TEXT, stop_reason TEXT,
        input_tokens BIGINT NOT NULL, cache_read_tokens BIGINT NOT NULL, output_tokens BIGINT NOT NULL, reasoning_tokens BIGINT NOT NULL,
        cost_micros BIGINT, ttft_ms BIGINT, duration_ms BIGINT NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS gateway_requests_time ON gateway_requests (tenant_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS gateway_requests_user ON gateway_requests (tenant_id, user_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS gateway_requests_department ON gateway_requests (tenant_id, department_id, started_at)`,
      `CREATE INDEX IF NOT EXISTS gateway_requests_day ON gateway_requests (tenant_id, day)`,
      // Limits on the built-in gateway: who they cover, over what window, of what, and what happens when spent.
      `CREATE TABLE IF NOT EXISTS quotas (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT, period TEXT NOT NULL, metric TEXT NOT NULL,
        amount BIGINT NOT NULL, action TEXT NOT NULL, fallback_model TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
    ],
  },
  {
    id: 4,
    statements: [
      // Public plugin indexes administrators pick plugins from; `document` is the last fetched index.
      `CREATE TABLE IF NOT EXISTS market_sources (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT, plugin_count INTEGER NOT NULL,
        document TEXT, fetched_at BIGINT, error TEXT, created_at BIGINT NOT NULL)`,
      // The organisation's plugin catalog: approved plugins pinned to one version, and blocked package names.
      `CREATE TABLE IF NOT EXISTS market_plugins (
        tenant_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, entry TEXT NOT NULL, version TEXT, version_entry TEXT,
        source_id TEXT, featured INTEGER NOT NULL, note TEXT, reviewed_by TEXT, reviewed_at BIGINT NOT NULL,
        PRIMARY KEY (tenant_id, name))`,
      // The skill library: skills installed for everyone, or that each person chooses.
      `CREATE TABLE IF NOT EXISTS market_skills (
        tenant_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, distribution TEXT NOT NULL, files TEXT NOT NULL,
        version INTEGER NOT NULL, created_by TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY (tenant_id, id))`,
      `CREATE TABLE IF NOT EXISTS skill_subscriptions (
        tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, skill_id TEXT NOT NULL, created_at BIGINT NOT NULL,
        PRIMARY KEY (tenant_id, user_id, skill_id))`,
    ],
  },
]

export async function migrate(db: Db): Promise<void> {
  await db.run('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)')
  const applied = new Set((await db.all<{ id: number }>('SELECT id FROM schema_migrations')).map(row => row.id))
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue
    await db.transaction(async (tx) => {
      for (const statement of migration.statements) await tx.run(statement)
      await tx.run('INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)', [migration.id, Date.now()])
    })
  }
}
