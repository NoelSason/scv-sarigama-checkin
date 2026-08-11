/**
 * Lists the Onam item's catalog variations so the SQUARE_VARIATION_* env vars
 * can be filled in.
 *
 * This is the ONLY place display names are used, and only to help a human read
 * the output. The names carry a stale price ("Ages 6+ [$25.00]" on an item that
 * charges $30), so the ids below are the real contract — copy those.
 *
 *   npx dotenv -e .env.local -- npx tsx scripts/square-catalog.ts
 *   npx dotenv -e .env.local -- npx tsx scripts/square-catalog.ts --search "Onam" --sku ONAMEXPERIENCE2024
 *
 * Read-only: it calls SearchCatalogObjects and nothing else.
 */
import {
  findCatalogItems,
  findVariationsBySku,
  squareClient,
  type CatalogVariation,
} from '../src/lib/square'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}

function money(v: CatalogVariation): string {
  if (v.priceCents == null) return 'variable price'
  return `$${(v.priceCents / 100).toFixed(2)} ${v.currency ?? ''}`.trim()
}

/** Suggestion only — a human confirms before these go into .env.local. */
function guessEnvVar(name: string | null): string | null {
  const n = (name ?? '').toLowerCase()
  if (n.includes('under')) return 'SQUARE_VARIATION_UNDER6'
  if (n.includes('sponsor')) return 'SQUARE_VARIATION_SPONSOR'
  if (n.includes('age') || n.includes('adult') || n.includes('6+')) return 'SQUARE_VARIATION_ADULT'
  return null
}

async function main() {
  const search = arg('search', 'Onam')
  const sku = arg('sku', 'ONAMEXPERIENCE2024')

  const client = squareClient()
  const items = await findCatalogItems(client, search.split(/\s+/).filter(Boolean))

  if (items.length === 0) {
    console.log(`No catalog items matched "${search}".`)
  }

  const suggestions = new Map<string, CatalogVariation>()

  for (const item of items) {
    console.log(`\nITEM  ${item.name ?? '(unnamed)'}`)
    console.log(`  id  ${item.id}`)
    if (item.variations.length === 0) console.log('  (no variations returned)')
    for (const v of item.variations) {
      console.log(`  VARIATION  ${v.name ?? '(unnamed)'}`)
      console.log(`    id       ${v.id}`)
      console.log(`    sku      ${v.sku ?? '—'}`)
      console.log(`    price    ${money(v)}   <- current catalog price`)
      const envVar = guessEnvVar(v.name)
      if (envVar && !suggestions.has(envVar)) suggestions.set(envVar, v)
    }
  }

  const bySku = await findVariationsBySku(client, sku)
  if (bySku.length > 0) {
    console.log(`\nVariations with SKU ${sku}:`)
    for (const v of bySku) {
      console.log(`  ${v.id}  ${v.name ?? '(unnamed)'}  ${money(v)}`)
      const envVar = guessEnvVar(v.name)
      if (envVar && !suggestions.has(envVar)) suggestions.set(envVar, v)
    }
  }

  if (suggestions.size > 0) {
    console.log('\n--- suggested .env.local (VERIFY EACH ID AGAINST THE NAME ABOVE) ---')
    for (const [envVar, v] of suggestions) {
      console.log(`${envVar}=${v.id}   # ${v.name ?? '(unnamed)'}`)
    }
    if (suggestions.size < 3) {
      console.log(
        `\n! Only ${suggestions.size} of 3 variations were matched by name. Fill the rest in by hand.`,
      )
    }
  }

  console.log(
    '\nNote: a variation display name may quote an out-of-date price. Match on the id, never the name.',
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
