/**
 * Create or update a volunteer login.
 *
 *   npm run create-staff -- --email a@b.com --name "Anna" --role scanner
 *
 * Omit --password and one is generated and printed. Print the credentials,
 * hand them out on paper, and don't email them around.
 *
 * Re-running for an existing email updates the name/role and resets the
 * password — which is the recovery path when a volunteer forgets theirs.
 */
import { query, queryOne } from '@/lib/db'
import { hashPassword } from '@/lib/tokens'
import { randomBytes } from 'node:crypto'

type Args = Record<string, string | boolean>

function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

/** Readable without being guessable: 4 words' worth of entropy, no ambiguous glyphs. */
function generatePassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'
  const bytes = randomBytes(14)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length])
    .join('')
    .replace(/(.{5})(.{5})(.*)/, '$1-$2-$3')
}

const ROLES = ['admin', 'registration', 'scanner'] as const
type Role = (typeof ROLES)[number]

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const email = typeof args.email === 'string' ? args.email.trim().toLowerCase() : ''
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  const role = (typeof args.role === 'string' ? args.role : 'scanner') as Role

  if (!email || !email.includes('@') || !name) {
    console.error(
      'Usage: npm run create-staff -- --email <email> --name "<name>" [--role admin|registration|scanner] [--password <pw>]',
    )
    process.exit(1)
  }
  if (!ROLES.includes(role)) {
    console.error(`--role must be one of: ${ROLES.join(', ')}`)
    process.exit(1)
  }

  const password = typeof args.password === 'string' ? args.password : generatePassword()
  const hash = await hashPassword(password)

  const existing = await queryOne<{ id: string }>('select id from staff_users where email = $1', [
    email,
  ])

  if (existing) {
    await query(
      `update staff_users
          set name = $1, role = $2::staff_role, password_hash = $3, active = true
        where id = $4`,
      [name, role, hash, existing.id],
    )
    // A password reset should also boot any device still holding a session.
    await query('update staff_sessions set revoked_at = now() where staff_id = $1', [existing.id])
    console.log(`Updated existing account (all existing sessions signed out).`)
  } else {
    await query(
      `insert into staff_users (email, name, role, password_hash)
       values ($1, $2, $3::staff_role, $4)`,
      [email, name, role, hash],
    )
    console.log('Created account.')
  }

  console.log('')
  console.log(`  name      ${name}`)
  console.log(`  email     ${email}`)
  console.log(`  role      ${role}`)
  console.log(`  password  ${password}`)
  console.log('')
  console.log('Write this down. It is not recoverable — re-run this command to reset it.')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
