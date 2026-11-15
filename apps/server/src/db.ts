/**
 * Storage behind one small interface, with two engines: PostgreSQL for
 * deployments and SQLite (Node's built-in `node:sqlite`) for evaluation and
 * tests.
 *
 * Queries are written once, in the subset both engines share: `$1` style
 * parameters, TEXT / BIGINT / INTEGER columns, no engine-specific functions,
 * no RETURNING, no JSON operators. Timestamps are epoch milliseconds,
 * booleans are 0/1 integers, structured values are JSON text. Keeping to that
 * subset is what lets other relational databases be added later.
 * @module @dsh-desktop-pro/server/db
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type Row = Record<string, unknown>
export type Param = string | number | null

export interface Db {
  readonly engine: 'sqlite' | 'postgres'
  all<T extends object = Row>(sql: string, params?: Param[]): Promise<T[]>
  get<T extends object = Row>(sql: string, params?: Param[]): Promise<T | undefined>
  run(sql: string, params?: Param[]): Promise<number>
  /** Serialised: concurrent transactions wait for each other. */
  transaction<T>(work: (db: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/** PostgreSQL returns BIGINT as a string; every number here fits a double. */
function normalise<T extends object>(row: Row): T {
  const out: Row = {}
  for (const [key, value] of Object.entries(row)) out[key] = typeof value === 'bigint' ? Number(value) : value
  return out as T
}

async function openSqlite(file: string): Promise<Db> {
  const { DatabaseSync } = await import('node:sqlite')
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const database = new DatabaseSync(file)
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  const sqliteSql = (sql: string): string => sql.replace(/\$(\d+)/g, '?$1')
  let chain: Promise<unknown> = Promise.resolve()
  const db: Db = {
    engine: 'sqlite',
    all: <T extends object>(sql: string, params: Param[] = []) => Promise.resolve(database.prepare(sqliteSql(sql)).all(...params).map(row => normalise<T>(row as Row))),
    get: <T extends object>(sql: string, params: Param[] = []) => {
      const row = database.prepare(sqliteSql(sql)).get(...params) as Row | undefined
      return Promise.resolve(row === undefined ? undefined : normalise<T>(row))
    },
    run: (sql, params = []) => Promise.resolve(Number(database.prepare(sqliteSql(sql)).run(...params).changes)),
    transaction<T>(work: (inner: Db) => Promise<T>): Promise<T> {
      const next = chain.then(async () => {
        database.exec('BEGIN IMMEDIATE')
        try {
          const result = await work(db)
          database.exec('COMMIT')
          return result
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
      })
      chain = next.catch(() => undefined)
      return next
    },
    close: () => { database.close(); return Promise.resolve() },
  }
  return db
}

async function openPostgres(url: string): Promise<Db> {
  const pg = await import('pg')
  const pool = new pg.default.Pool({ connectionString: url, max: 10 })
  const wrap = (query: (sql: string, params: Param[]) => Promise<{ rows: Row[]; rowCount: number | null }>): Omit<Db, 'transaction' | 'close' | 'engine'> => ({
    all: async <T extends object>(sql: string, params: Param[] = []) => (await query(sql, params)).rows.map(row => normalise<T>(row)),
    get: async <T extends object>(sql: string, params: Param[] = []) => {
      const row = (await query(sql, params)).rows[0]
      return row === undefined ? undefined : normalise<T>(row)
    },
    run: async (sql: string, params: Param[] = []) => (await query(sql, params)).rowCount ?? 0,
  })
  // Numeric columns arrive as numbers: BIGINT (20) and NUMERIC (1700).
  pg.default.types.setTypeParser(20, value => Number(value))
  return {
    engine: 'postgres',
    ...wrap((sql, params) => pool.query(sql, params)),
    async transaction<T>(work: (inner: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
        const inner: Db = {
          engine: 'postgres',
          ...wrap((sql, params) => client.query(sql, params)),
          transaction: () => Promise.reject(new Error('nested transactions are not supported')),
          close: () => Promise.resolve(),
        }
        const result = await work(inner)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
    close: () => pool.end(),
  }
}

/** `sqlite:<path>` (or `sqlite::memory:`) or a `postgres://` URL. */
export function openDb(url: string): Promise<Db> {
  if (url.startsWith('sqlite:')) return openSqlite(url.slice('sqlite:'.length) || ':memory:')
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return openPostgres(url)
  throw new Error('DATABASE_URL must start with sqlite: or postgres://')
}
