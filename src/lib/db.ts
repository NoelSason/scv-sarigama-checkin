import { Pool, type PoolClient, type QueryResultRow } from 'pg'

/**
 * Single pooled connection to Neon.
 *
 * Lazy: constructing the Pool at module scope would throw during `next build`
 * before env vars exist. `globalThis` caching keeps one pool across hot
 * reloads in dev and across warm invocations on Vercel Fluid Compute.
 */
const globalForDb = globalThis as unknown as { __onamPool?: Pool }

function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  return url
}

export function pool(): Pool {
  if (!globalForDb.__onamPool) {
    globalForDb.__onamPool = new Pool({
      connectionString: connectionString(),
      // Neon terminates idle connections; keep the pool small and short-lived
      // so a serverless instance never holds more than it needs.
      max: 8,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    })
  }
  return globalForDb.__onamPool
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool().query<T>(text, params)
  return res.rows
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params)
  return rows[0] ?? null
}

/**
 * Run a set of statements in one transaction. Used by the import path so a
 * whole batch either lands or doesn't.
 *
 * Note: redemption does NOT use this. `redeem_tickets()` is atomic on its own
 * as a single statement — wrapping it would add nothing but latency.
 */
export async function transaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect()
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
