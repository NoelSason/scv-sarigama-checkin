import 'server-only'
import { query } from '@/lib/db'

/**
 * Everything the admin overview shows, in one round of parallel queries.
 *
 * Shared by the page (first paint, server-rendered) and by the stats route
 * (the 20s poll), so the two can never disagree about what a number means.
 *
 * Test rows are excluded from every headline total and reported separately.
 * A seeded household counted into "admissions sold" would quietly corrupt the
 * kitchen's headcount, which is the one number the event actually runs on.
 */

export type OpsState = 'ok' | 'warn' | 'bad' | 'idle'

export type OpsItem = {
  key: string
  label: string
  state: OpsState
  /** Plain sentence. Colour is never the only signal. */
  detail: string
  at: string | null
}

export type Breakdown = { key: string; households: number; tickets: number }

export type RecentRedemption = {
  id: string
  householdId: string
  name: string
  quantity: number
  staff: string | null
  device: string | null
  reversed: boolean
  isTest: boolean
  at: string
}

export type RecentRegistration = {
  id: string
  name: string
  ticketsPurchased: number
  paymentStatus: string
  paymentMethod: string | null
  source: string | null
  isTest: boolean
  at: string
}

export type AdminStats = {
  generatedAt: string
  totals: {
    households: number
    ticketsSold: number
    ticketsRedeemed: number
    ticketsRemaining: number
    /** Remaining on passes that can actually be redeemed (paid + comped). */
    redeemableRemaining: number
    /** Recorded for headcount only — never redeemable. */
    childrenUnder6: number
    testHouseholds: number
  }
  byMethod: Breakdown[]
  byStatus: Breakdown[]
  recentRedemptions: RecentRedemption[]
  recentRegistrations: RecentRegistration[]
  openReviews: number
  emailFailures: number
  ops: OpsItem[]
}

/** Timestamps arrive as Date or text depending on the column; normalise once. */
function iso(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function agoText(at: string | null): string {
  if (!at) return 'never'
  const mins = Math.round((Date.now() - new Date(at).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} hr ago`
  return `${Math.round(hours / 24)} days ago`
}

const MINUTE = 60_000

export async function loadStats(): Promise<AdminStats> {
  const [
    totalsRows,
    methodRows,
    statusRows,
    redemptionRows,
    registrationRows,
    reviewRows,
    emailRows,
    webhookRows,
    syncRows,
    lastRedemptionRows,
  ] = await Promise.all([
    query<{
      households: number
      sold: number
      redeemed: number
      remaining: number
      redeemable_remaining: number
      under6: number
      test_households: number
    }>(
      `select
         count(*) filter (where not is_test)::int                                   as households,
         coalesce(sum(tickets_purchased) filter (where not is_test), 0)::int        as sold,
         coalesce(sum(tickets_redeemed)  filter (where not is_test), 0)::int        as redeemed,
         coalesce(sum(tickets_remaining) filter (where not is_test), 0)::int        as remaining,
         coalesce(sum(tickets_remaining) filter (
           where not is_test and payment_status in ('paid','comped')), 0)::int      as redeemable_remaining,
         coalesce(sum(children_under_6)  filter (where not is_test), 0)::int        as under6,
         count(*) filter (where is_test)::int                                       as test_households
       from households`,
    ),
    query<{ key: string; households: number; tickets: number }>(
      `select coalesce(payment_method::text, 'unrecorded') as key,
              count(*)::int as households,
              coalesce(sum(tickets_purchased), 0)::int as tickets
         from households
        where not is_test
        group by 1
        order by 3 desc, 1 asc`,
    ),
    query<{ key: string; households: number; tickets: number }>(
      `select payment_status::text as key,
              count(*)::int as households,
              coalesce(sum(tickets_purchased), 0)::int as tickets
         from households
        where not is_test
        group by 1
        order by 3 desc, 1 asc`,
    ),
    query<{
      id: string
      household_id: string
      name: string
      quantity: number
      staff: string | null
      device: string | null
      reversed_at: unknown
      is_test: boolean
      created_at: unknown
    }>(
      `select r.id, r.household_id, h.display_name as name, r.quantity,
              u.name as staff, r.device_name as device, r.reversed_at,
              h.is_test, r.created_at
         from redemptions r
         join households h on h.id = r.household_id
         left join staff_users u on u.id = r.staff_user_id
        order by r.created_at desc
        limit 12`,
    ),
    query<{
      id: string
      name: string
      tickets_purchased: number
      payment_status: string
      payment_method: string | null
      source: string | null
      is_test: boolean
      created_at: unknown
    }>(
      `select id, display_name as name, tickets_purchased,
              payment_status::text as payment_status,
              payment_method::text as payment_method,
              source, is_test, created_at
         from households
        order by created_at desc
        limit 10`,
    ),
    query<{ open: number }>(`select count(*)::int as open from review_items where status = 'open'`),
    query<{ failed: number; pending: number; sent: number; last_sent: unknown }>(
      `select count(*) filter (where status = 'failed')::int  as failed,
              count(*) filter (where status = 'pending')::int as pending,
              count(*) filter (where status = 'sent')::int    as sent,
              max(sent_at) as last_sent
         from email_deliveries`,
    ),
    query<{ last_at: unknown; total: number }>(
      `select max(created_at) as last_at, count(*)::int as total
         from payment_events where provider = 'square'`,
    ),
    query<{
      source: string
      status: string
      started_at: unknown
      finished_at: unknown
      error: string | null
    }>(
      `select distinct on (source) source, status, started_at, finished_at, error
         from sync_runs
        order by source, started_at desc`,
    ),
    query<{ last_at: unknown }>(`select max(created_at) as last_at from redemptions`),
  ])

  const t = totalsRows[0]
  const email = emailRows[0]
  const webhook = webhookRows[0]

  const lastWebhookAt = iso(webhook?.last_at)
  const lastEmailAt = iso(email?.last_sent)
  const lastRedemptionAt = iso(lastRedemptionRows[0]?.last_at)
  const sheetSync = syncRows.find((r) => r.source === 'google_sheets')
  const sheetAt = iso(sheetSync?.finished_at ?? sheetSync?.started_at)

  const ops: OpsItem[] = [
    {
      key: 'database',
      label: 'Database',
      state: 'ok',
      detail: 'Connected. Every number on this page was just read live.',
      at: new Date().toISOString(),
    },
    {
      key: 'square',
      label: 'Square payments',
      state: !lastWebhookAt ? 'warn' : Date.now() - Date.parse(lastWebhookAt) > 24 * 60 * MINUTE ? 'warn' : 'ok',
      detail: !lastWebhookAt
        ? 'No Square payment has ever reached this app. If people are buying online, check the webhook setup.'
        : `Last payment received ${agoText(lastWebhookAt)}. ${webhook.total} total.`,
      at: lastWebhookAt,
    },
    {
      key: 'sheet',
      label: 'Google Sheet sync',
      state: !sheetSync ? 'warn' : sheetSync.status === 'failed' ? 'bad' : sheetSync.status === 'running' ? 'warn' : 'ok',
      detail: !sheetSync
        ? 'The sheet has never been synced. Anyone who signed up there is not in this app yet.'
        : sheetSync.status === 'failed'
          ? `Last sync FAILED ${agoText(sheetAt)}. ${sheetSync.error ?? 'No error detail recorded.'}`
          : sheetSync.status === 'running'
            ? `A sync started ${agoText(sheetAt)} and has not finished.`
            : `Last synced successfully ${agoText(sheetAt)}.`,
      at: sheetAt,
    },
    {
      key: 'email',
      label: 'Pass emails',
      state: email.failed > 0 ? 'warn' : email.sent === 0 ? 'idle' : 'ok',
      detail:
        email.failed > 0
          ? `${email.failed} email${email.failed === 1 ? '' : 's'} failed to send. Those families have no pass — look them up by name at the door.`
          : email.sent === 0
            ? 'No pass emails have been sent yet.'
            : `${email.sent} sent, none failed. Last one ${agoText(lastEmailAt)}.`,
      at: lastEmailAt,
    },
    {
      key: 'redemption',
      label: 'Last check-in',
      state: !lastRedemptionAt
        ? 'idle'
        : Date.now() - Date.parse(lastRedemptionAt) > 20 * MINUTE
          ? 'warn'
          : 'ok',
      detail: !lastRedemptionAt
        ? 'Nobody has been checked in yet. Normal before the doors open.'
        : Date.now() - Date.parse(lastRedemptionAt) > 20 * MINUTE
          ? `Nothing scanned for ${agoText(lastRedemptionAt).replace(' ago', '')}. If the line is moving, a scanner may be stuck — go check the door.`
          : `Working. Last admission ${agoText(lastRedemptionAt)}.`,
      at: lastRedemptionAt,
    },
  ]

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      households: t.households,
      ticketsSold: t.sold,
      ticketsRedeemed: t.redeemed,
      ticketsRemaining: t.remaining,
      redeemableRemaining: t.redeemable_remaining,
      childrenUnder6: t.under6,
      testHouseholds: t.test_households,
    },
    byMethod: methodRows,
    byStatus: statusRows,
    recentRedemptions: redemptionRows.map((r) => ({
      id: r.id,
      householdId: r.household_id,
      name: r.name,
      quantity: r.quantity,
      staff: r.staff,
      device: r.device,
      reversed: Boolean(r.reversed_at),
      isTest: r.is_test,
      at: iso(r.created_at) ?? new Date().toISOString(),
    })),
    recentRegistrations: registrationRows.map((r) => ({
      id: r.id,
      name: r.name,
      ticketsPurchased: r.tickets_purchased,
      paymentStatus: r.payment_status,
      paymentMethod: r.payment_method,
      source: r.source,
      isTest: r.is_test,
      at: iso(r.created_at) ?? new Date().toISOString(),
    })),
    openReviews: reviewRows[0].open,
    emailFailures: email.failed,
    ops,
  }
}
