# SCV Sarigama Onam 2026 — Sadhya Check-In

Digital replacement for paper Sadhya meal tickets.
Live at **https://checkin.scvsarigama.com**

One household = one QR pass carrying N admissions. The QR identifies the family
and nothing else — the balance lives in Postgres and is checked on every scan.

So a family can screenshot the code, share it with their kids, and use it at
three different times, and it still cannot be used more times than they paid for.

**Passes are handed over in person.** A volunteer looks up the name, the QR
appears on their screen, and the guest scans it with their own phone to receive
it. No email is involved — which is what makes it work for the 40 of 92
households who paid by Zelle and left no contact details behind.

For volunteers on event day, read **[EVENT_DAY.md](./EVENT_DAY.md)** instead of this.

---

## How it fits together

```
Google Sheet (Zelle rows) ──┐
                            ├─► import ──► Neon Postgres ◄── atomic RPC ──► /staff/scan
Square Orders API (card) ───┘              (authoritative)
Square webhook (new sales) ─┘                    │
                                                 ├──► /p/{token}   guest pass
                                                 └──► /staff/*     desk + admin
```

Next.js 16 (App Router) on Vercel · Neon Postgres · Resend for email.

**Everything touching data is server-side.** The browser never holds a database
credential; every read and write goes through a route handler.

### Routes

| Route | Who | What |
|---|---|---|
| `/p/{token}` | guest, no login | The pass: QR, name, live balance |
| `/staff/scan` | volunteer | Scan → confirm → redeem → optional give-back |
| `/staff/registration` | volunteer | Search, walk-ins, payment, ticket fixes |
| `/staff/admin` | volunteer | Stats, review queue, reversals, CSV, emergency lookup |
| `/staff/admin/roster` | volunteer | Printable paper contingency roster |

---

## The three things that must not break

**1. Redemption is atomic.** `redeem_tickets()` puts every precondition in the
`WHERE` clause of a single `UPDATE`, so Postgres row locking serializes
concurrent scans. Twenty simultaneous attempts to take the last 3 tickets
produce exactly one success — this is asserted in the test suite and was
re-verified against production. `CHECK (tickets_redeemed <= tickets_purchased)`
backs it up independently, so even a direct `UPDATE` cannot over-redeem.

**2. Ticket counts are never inferred.**

| Source | Authority | Explicitly NOT used |
|---|---|---|
| Square | `line_item.quantity`, matched by **catalog variation ID** | the dollar amount; the variation's display name |
| Sheet | the `No Of People` column | `Amount Paid` |

The Square display name lies: a real Aug 9 order reads `(Ages 6+ [$25.00]) × 2`
and was charged $30, because the price rose mid-sale and the label went stale.
The sheet lies differently: rows like `Malabar Gold / $500 / 2` bundle a
donation with the tickets. Anything that can't be mapped confidently becomes a
`needs_review` row rather than a guess.

**3. Under-6 children never consume an admission.** They're recorded in
`children_under_6` for headcount honesty and shown at the desk, but they walk in
free with no ticket.

---

## Local setup

```bash
npm install
vercel env pull .env.local     # or copy .env.example and fill it in
npm run migrate
npm run seed                   # four demo households
npm run dev
```

`npm run create-staff -- --email you@example.com --name "You" --role admin`
creates an individual login. Day-to-day, volunteers use the shared password in
`STAFF_PASSWORD` instead.

### Commands

| Command | Does |
|---|---|
| `npm run migrate` | Apply `db/migrations/*.sql` (idempotent) |
| `npm run seed` | Create demo households · `-- --purge` to remove |
| `npm test` | Full suite, including the concurrency tests |
| `npm run create-staff` | Create/reset an individual staff login |
| `npx tsx scripts/import-sheet.ts --csv <file>` | Sheet dry run |
| `npx tsx scripts/import-square.ts` | Square dry run |
| `npx tsx scripts/square-catalog.ts` | List catalog variation IDs |

Imports are **dry-run by default** and write a preview CSV to `out-import/`.
`--commit` writes, in one transaction tagged with an `import_batches` row.

---

## Notes for whoever picks this up next

**Tests hit the real database.** They only create and delete rows with
`source = 'vitest'`, so they can't touch real guests or the seeded demos. That
scoping is deliberate — an earlier version keyed cleanup off `is_test` and
quietly deleted the demo households on every run.

**`ws` must stay a lazy import in `src/lib/db.ts`.** Importing it at module
scope crashes every database-backed function on Vercel at boot: empty 500, no
log, while the identical build serves fine locally. Only the transaction path
needs a WebSocket; the query path is SQL over HTTPS.

**Email cannot reach a real guest while `EMAIL_TEST_REDIRECT` is set.** The
redirect is applied inside the provider factory, not at call sites, so it can't
be bypassed by accident. Clearing it is a deliberate, one-time act.

**Google Sheets is an import source, not the ledger.** Nothing during the event
depends on it being reachable. If the sheet and the app disagree on event day,
the app wins.

**No offline redemption, ever.** Two phones offline at the same entrance would
both believe they had the last ticket. The scanner tells the volunteer to stop
instead. `/staff/admin/roster` is the paper fallback — print it beforehand.

---

## Environment

See `.env.example`. `DATABASE_URL` comes from the Neon integration; the rest are
set with `vercel env add`. Nothing secret is committed.

`out-import/` is gitignored because preview CSVs contain guest contact details.
