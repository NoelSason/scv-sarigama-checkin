import { neon, neonConfig, Pool, type PoolClient } from '@neondatabase/serverless'

/**
 * Database access via Neon's driver.
 *
 * Two transports, chosen deliberately:
 *
 *   query()       — SQL over HTTPS. No connection setup, so a scanner lookup
 *                   or a redemption is one round trip. This is what the event
 *                   runs on, and why the <500ms target is comfortable.
 *
 *   transaction() — Postgres protocol over a WebSocket. Only needed where
 *                   several statements must land together (the import batch).
 *
 * redeem_tickets() is a single statement, so it is atomic over HTTP without a
 * transaction. Wrapping it would add a round trip and buy nothing.
 *
 * Plain TCP on 5432 is also supported by Neon but is unreliable on some
 * networks (it fails on this developer machine), so we don't use it anywhere.
 */

const globalForDb = globalThis as unknown as {
  __onamSql?: ReturnType<typeof neon>
  __onamPool?: Pool
}

function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  return url
}

function sqlClient() {
  // Lazy: building this at module scope would crash `next build` before env
  // vars exist.
  if (!globalForDb.__onamSql) {
    globalForDb.__onamSql = neon(connectionString())
  }
  return globalForDb.__onamSql
}

/**
 * WebSocket pool, for transactions only.
 *
 * `ws` is required lazily rather than imported at module scope: every request
 * path except the import batch uses HTTP, and pulling a WebSocket
 * implementation into those bundles is both wasted weight and — as this
 * project found out in production — a way to break the function at boot.
 */
export async function pool(): Promise<Pool> {
  if (!globalForDb.__onamPool) {
    if (!neonConfig.webSocketConstructor) {
      const { default: ws } = await import('ws')
      neonConfig.webSocketConstructor = ws
    }
    globalForDb.__onamPool = new Pool({ connectionString: connectionString() })
  }
  return globalForDb.__onamPool
}

/** Run one parameterised statement and return all rows. */
export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const rows = await sqlClient().query(text, params)
  return rows as T[]
}

/** Run one parameterised statement and return the first row, or null. */
export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

/**
 * Run several statements in one transaction. Used by the import path so a
 * whole batch either lands or doesn't.
 */
export async function transaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await (await pool()).connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
