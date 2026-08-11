/**
 * Migration runner.
 *
 * Applies db/migrations/*.sql in filename order, recording each in
 * schema_migrations so re-running is a no-op. Each file runs inside its own
 * transaction, so a failure leaves the database on the last good migration
 * rather than half-applied.
 *
 *   npx dotenv -e .env.local -- npx tsx scripts/migrate.ts
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'

const MIGRATIONS_DIR = join(process.cwd(), 'db', 'migrations')

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')

  const client = new Client({ connectionString: url })
  await client.connect()

  await client.query(`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `)

  const applied = new Set(
    (await client.query<{ name: string }>('select name from schema_migrations')).rows.map(
      (r) => r.name,
    ),
  )

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  let ran = 0
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file}`)
      continue
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    process.stdout.write(`  apply ${file} … `)
    try {
      await client.query('BEGIN')
      await client.query(sql)
      await client.query('insert into schema_migrations (name) values ($1)', [file])
      await client.query('COMMIT')
      console.log('ok')
      ran++
    } catch (err) {
      await client.query('ROLLBACK')
      console.log('FAILED')
      console.error(err)
      await client.end()
      process.exit(1)
    }
  }

  console.log(ran === 0 ? 'Already up to date.' : `Applied ${ran} migration(s).`)
  await client.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
