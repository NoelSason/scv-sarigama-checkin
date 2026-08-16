import 'server-only'
import { query } from '@/lib/db'

/**
 * Everything the public report deliberately leaves out.
 *
 * Two kinds of thing live here:
 *
 *   1. **Detail about people.** Addresses, devices, whereabouts, individual
 *      payment amounts. All of it is recorded by the app for operational and
 *      security reasons, and none of it belongs on a page with no login.
 *   2. **Detail about the machinery.** Every correction with its reason, every
 *      sync, every webhook, every merge. Not sensitive so much as useless to a
 *      guest and essential to whoever has to run this again.
 *
 * This module is only ever called behind a staff check. It is a separate file
 * from `onam.ts` precisely so that "did we remember to gate this?" has one
 * answer at one import site rather than being a property of thirty queries
 * scattered through the public loader.
 */

const REAL = `not h.is_test and h.merged_into_id is null`

export type SensitiveAnalytics = {
  /** Where guests opened their pass, by the network they were on. */
  passOpenPlaces: { label: string; opens: number; households: number }[]
  /** What they opened it on. */
  passOpenDevices: { label: string; opens: number; households: number; bot: boolean }[]
  /** Where the door scans happened. */
  scanPlaces: { label: string; scans: number; guests: number }[]

  /** Who did the work, per volunteer. */
  staffActivity: {
    name: string
    role: string | null
    scans: number
    guests: number
    deskLookups: number
    corrections: number
    signIns: number
    lastSeen: string | null
  }[]

  /** Volunteer sign-ins, with the address and device they came from. */
  sessions: {
    name: string | null
    role: string | null
    at: string
    ip: string | null
    place: string | null
    /**
     * The raw user-agent, not a friendly family name.
     *
     * The classifier below is tuned for guest browsers opening a pass; run over
     * a volunteer session it mislabels scripts and CLI tools as crawlers. On a
     * security log the exact string is the useful thing anyway.
     */
    userAgent: string | null
    revoked: boolean
  }[]

  /** Every correction, with the reason somebody typed. */
  corrections: {
    at: string
    household: string
    delta: number
    reason: string
    staff: string | null
  }[]

  /** Every duplicate that had to be merged. */
  merges: {
    at: string
    survivor: string
    absorbed: string
    basis: string
    ticketsMoved: number
    redeemedMoved: number
  }[]

  /** Everything the importers refused to guess about. */
  reviews: {
    kind: string
    status: string
    summary: string
    household: string | null
    at: string
    resolvedAt: string | null
  }[]

  /** Every email, including the ones that failed. */
  emails: {
    kind: string
    status: string
    toEmail: string
    household: string | null
    at: string | null
    ticketsAtSend: number | null
    error: string | null
  }[]

  /** Raw payment traffic, per provider and event type. */
  paymentEvents: {
    provider: string
    eventType: string | null
    count: number
    cents: number | null
    errors: number
    firstAt: string | null
    lastAt: string | null
  }[]

  /** Refunds, which the public totals quietly net out. */
  refunds: { at: string; provider: string; cents: number; household: string | null }[]

  /** Spreadsheet sync health over the whole run. */
  syncs: {
    source: string
    status: string
    runs: number
    lastAt: string | null
    medianSeconds: number | null
    failures: number
  }[]

  /** Households flagged by a human so the sync would stop overwriting them. */
  locked: { name: string; reason: string | null; at: string }[]

  /** Contact details that collided — the duplicate detector's raw material. */
  contactCollisions: { value: string; kind: string; households: string[] }[]

  /** The programme registration answers collected at storefront checkout. */
  performanceSignups: {
    name: string
    kind: string | null
    type: string | null
    members: string | null
    wantsMedia: boolean | null
    wantsStage: boolean | null
    notes: string | null
  }[]

  /** Per-family ledger, the whole thing. */
  households: {
    name: string
    email: string | null
    phone: string | null
    purchased: number
    redeemed: number
    remaining: number
    childrenUnder6: number
    status: string
    method: string | null
    cents: number | null
    source: string | null
    passOpened: boolean
    createdAt: string
    notes: string | null
  }[]
}

function iso(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Coarse device family from a user-agent. Bots are flagged, not hidden. */
function device(ua: string | null): { label: string; bot: boolean } {
  const s = ua ?? ''
  if (!s) return { label: 'Not recorded', bot: false }
  if (/bot|crawler|spider|preview|facebookexternalhit|Twitterbot|Slackbot|WhatsApp|HeadlessChrome|curl|python-requests|Discordbot/i.test(s))
    return { label: 'Link preview or crawler', bot: true }
  if (/iPhone|iPod/.test(s)) {
    if (/CriOS/.test(s)) return { label: 'iPhone — Chrome', bot: false }
    if (/GSA/.test(s)) return { label: 'iPhone — Google app', bot: false }
    return { label: 'iPhone — Safari', bot: false }
  }
  if (/iPad/.test(s)) return { label: 'iPad', bot: false }
  if (/Android/.test(s)) {
    if (/SamsungBrowser/.test(s)) return { label: 'Android — Samsung Internet', bot: false }
    return { label: 'Android — Chrome', bot: false }
  }
  if (/Macintosh/.test(s)) return { label: 'Mac — desktop browser', bot: false }
  if (/Windows/.test(s)) return { label: 'Windows — desktop browser', bot: false }
  if (/Linux|X11/.test(s)) return { label: 'Linux — desktop browser', bot: false }
  return { label: 'Something else', bot: false }
}

export async function loadSensitive(): Promise<SensitiveAnalytics> {
  const [
    passPlaceRows,
    passDeviceRows,
    scanPlaceRows,
    staffRows,
    sessionRows,
    correctionRows,
    mergeRows,
    reviewRows,
    emailRows,
    paymentRows,
    refundRows,
    syncRows,
    lockedRows,
    collisionRows,
    performRows,
    householdRows,
  ] = await Promise.all([
    query<{ label: string; opens: number; households: number }>(
      `select coalesce(nullif(concat_ws(', ', geo_city, geo_region, geo_country), ''), 'Not recorded') as label,
              count(*)::int as opens, count(distinct household_id)::int as households
         from audit_logs where action = 'pass_opened'
        group by 1 order by 2 desc`,
    ),

    query<{ user_agent: string | null; opens: number; households: number }>(
      `select user_agent, count(*)::int as opens, count(distinct household_id)::int as households
         from audit_logs where action = 'pass_opened' group by 1`,
    ),

    query<{ label: string; scans: number; guests: number }>(
      `select coalesce(nullif(concat_ws(', ', r.geo_city, r.geo_region), ''), 'Not recorded') as label,
              count(*)::int as scans, coalesce(sum(r.quantity), 0)::int as guests
         from redemptions r join households h on h.id = r.household_id
        where ${REAL} group by 1 order by 2 desc`,
    ),

    // Who actually did the work on the day.
    query<{
      name: string
      role: string | null
      scans: number
      guests: number
      desk: number
      corrections: number
      sign_ins: number
      last_seen: unknown
    }>(
      `select u.name, u.role::text as role,
        (select count(*)::int from redemptions r where r.staff_user_id = u.id)                       as scans,
        (select coalesce(sum(r.quantity), 0)::int from redemptions r where r.staff_user_id = u.id)   as guests,
        (select count(*)::int from audit_logs a
          where a.actor_id = u.id::text and a.action = 'desk_lookup')                                as desk,
        (select count(*)::int from redemption_adjustments adj where adj.staff_user_id = u.id)        as corrections,
        (select count(*)::int from staff_sessions s where s.staff_id = u.id)                         as sign_ins,
        greatest(u.last_login_at,
                 (select max(r.created_at) from redemptions r where r.staff_user_id = u.id))         as last_seen
       from staff_users u order by 3 desc`,
    ),

    query<{
      name: string | null
      role: string | null
      created_at: unknown
      ip: string | null
      place: string | null
      user_agent: string | null
      revoked_at: unknown
    }>(
      `select u.name, u.role::text as role, s.created_at, s.ip,
              nullif(concat_ws(', ', s.geo_city, s.geo_region, s.geo_country), '') as place,
              s.user_agent, s.revoked_at
         from staff_sessions s left join staff_users u on u.id = s.staff_id
        order by s.created_at desc limit 100`,
    ),

    query<{ at: unknown; household: string; delta: number; reason: string; staff: string | null }>(
      `select adj.created_at as at, h.display_name as household, adj.quantity_delta as delta,
              adj.reason, u.name as staff
         from redemption_adjustments adj
         join households h on h.id = adj.household_id
         left join staff_users u on u.id = adj.staff_user_id
        order by adj.created_at desc`,
    ),

    query<{
      at: unknown
      survivor: string
      absorbed: string
      basis: string
      tickets_moved: number
      redeemed_moved: number
    }>(
      `select m.created_at as at, sv.display_name as survivor, ab.display_name as absorbed,
              m.basis, m.tickets_moved, m.redeemed_moved
         from household_merges m
         join households sv on sv.id = m.survivor_id
         join households ab on ab.id = m.absorbed_id
        order by m.created_at desc`,
    ),

    query<{
      kind: string
      status: string
      summary: string
      household: string | null
      at: unknown
      resolved_at: unknown
    }>(
      `select ri.kind, ri.status::text as status, ri.summary, h.display_name as household,
              ri.created_at as at, ri.resolved_at
         from review_items ri left join households h on h.id = ri.household_id
        order by ri.created_at desc limit 200`,
    ),

    query<{
      kind: string
      status: string
      to_email: string
      household: string | null
      at: unknown
      tickets_at_send: number | null
      error: string | null
    }>(
      `select e.kind, e.status, e.to_email, h.display_name as household,
              coalesce(e.sent_at, e.created_at) as at, e.tickets_at_send, e.error
         from email_deliveries e left join households h on h.id = e.household_id
        order by coalesce(e.sent_at, e.created_at) desc limit 400`,
    ),

    query<{
      provider: string
      event_type: string | null
      n: number
      cents: number | null
      errors: number
      first_at: unknown
      last_at: unknown
    }>(
      `select provider, event_type, count(*)::int as n, sum(amount_cents)::int as cents,
              count(*) filter (where error is not null)::int as errors,
              min(created_at) as first_at, max(created_at) as last_at
         from payment_events group by 1, 2 order by 3 desc`,
    ),

    query<{ at: unknown; provider: string; cents: number; household: string | null }>(
      `select p.created_at as at, p.provider, coalesce(p.amount_cents, 0) as cents,
              h.display_name as household
         from payment_events p left join households h on h.id = p.household_id
        where p.event_type ilike '%refund%' order by p.created_at desc`,
    ),

    query<{
      source: string
      status: string
      runs: number
      last_at: unknown
      median_seconds: string | null
      failures: number
    }>(
      `select source, status, count(*)::int as runs, max(started_at) as last_at,
              percentile_cont(0.5) within group (
                order by extract(epoch from (finished_at - started_at))
              )::numeric(10,2) as median_seconds,
              count(*) filter (where status = 'failed')::int as failures
         from sync_runs group by 1, 2 order by 3 desc`,
    ),

    query<{ name: string; reason: string | null; at: unknown }>(
      `select h.display_name as name, h.locked_reason as reason, h.locked_at as at
         from households h where h.locked_at is not null order by h.locked_at desc`,
    ),

    // The raw material the duplicate detector works from.
    query<{ value: string; kind: string; names: string[] }>(
      `select normalized_email as value, 'email' as kind, array_agg(display_name) as names
         from households h where ${REAL} and normalized_email is not null
        group by 1 having count(*) > 1
       union all
       select normalized_phone, 'phone', array_agg(display_name)
         from households h where ${REAL} and normalized_phone is not null
        group by 1 having count(*) > 1`,
    ),

    query<{
      name: string
      kind: string | null
      type: string | null
      members: string | null
      media: boolean | null
      stage: boolean | null
      notes: string | null
    }>(
      `select coalesce(nullif(perform_name, ''), customer_name) as name,
              perform_kind as kind,
              coalesce(nullif(perform_type_other, ''), perform_type) as type,
              perform_members as members, perform_media as media,
              perform_stage as stage, perform_notes as notes
         from pay_orders
        where perform_interested and not is_test
        order by created_at`,
    ),

    query<{
      name: string
      email: string | null
      phone: string | null
      purchased: number
      redeemed: number
      remaining: number
      kids: number
      status: string
      method: string | null
      cents: number | null
      source: string | null
      pass_opened: boolean
      created_at: unknown
      notes: string | null
    }>(
      `select h.display_name as name, h.email, h.phone,
              h.tickets_purchased as purchased, h.tickets_redeemed as redeemed,
              h.tickets_remaining as remaining, h.children_under_6 as kids,
              h.payment_status::text as status, h.payment_method::text as method,
              h.amount_paid_cents as cents, h.source,
              exists (select 1 from audit_logs a
                       where a.household_id = h.id and a.action = 'pass_opened') as pass_opened,
              h.created_at, h.notes
         from households h where ${REAL}
        order by h.display_name`,
    ),
  ])

  // Fold user agents into families, keeping bots visible rather than dropped —
  // an admin looking at this wants to know the link was previewed.
  const deviceTotals = new Map<string, { label: string; opens: number; households: number; bot: boolean }>()
  for (const row of passDeviceRows) {
    const d = device(row.user_agent)
    const cur = deviceTotals.get(d.label) ?? { label: d.label, opens: 0, households: 0, bot: d.bot }
    cur.opens += num(row.opens)
    cur.households += num(row.households)
    deviceTotals.set(d.label, cur)
  }

  return {
    passOpenPlaces: passPlaceRows.map((r) => ({
      label: r.label,
      opens: num(r.opens),
      households: num(r.households),
    })),

    passOpenDevices: [...deviceTotals.values()].sort((a, b) => b.opens - a.opens),

    scanPlaces: scanPlaceRows.map((r) => ({
      label: r.label,
      scans: num(r.scans),
      guests: num(r.guests),
    })),

    staffActivity: staffRows.map((r) => ({
      name: r.name,
      role: r.role,
      scans: num(r.scans),
      guests: num(r.guests),
      deskLookups: num(r.desk),
      corrections: num(r.corrections),
      signIns: num(r.sign_ins),
      lastSeen: iso(r.last_seen),
    })),

    sessions: sessionRows.map((r) => ({
      name: r.name,
      role: r.role,
      at: iso(r.created_at) ?? '',
      ip: r.ip,
      place: r.place,
      userAgent: r.user_agent,
      revoked: Boolean(r.revoked_at),
    })),

    corrections: correctionRows.map((r) => ({
      at: iso(r.at) ?? '',
      household: r.household,
      delta: num(r.delta),
      reason: r.reason,
      staff: r.staff,
    })),

    merges: mergeRows.map((r) => ({
      at: iso(r.at) ?? '',
      survivor: r.survivor,
      absorbed: r.absorbed,
      basis: r.basis,
      ticketsMoved: num(r.tickets_moved),
      redeemedMoved: num(r.redeemed_moved),
    })),

    reviews: reviewRows.map((r) => ({
      kind: r.kind,
      status: r.status,
      summary: r.summary,
      household: r.household,
      at: iso(r.at) ?? '',
      resolvedAt: iso(r.resolved_at),
    })),

    emails: emailRows.map((r) => ({
      kind: r.kind,
      status: r.status,
      toEmail: r.to_email,
      household: r.household,
      at: iso(r.at),
      ticketsAtSend: r.tickets_at_send === null ? null : num(r.tickets_at_send),
      error: r.error,
    })),

    paymentEvents: paymentRows.map((r) => ({
      provider: r.provider,
      eventType: r.event_type,
      count: num(r.n),
      cents: r.cents === null ? null : num(r.cents),
      errors: num(r.errors),
      firstAt: iso(r.first_at),
      lastAt: iso(r.last_at),
    })),

    refunds: refundRows.map((r) => ({
      at: iso(r.at) ?? '',
      provider: r.provider,
      cents: num(r.cents),
      household: r.household,
    })),

    syncs: syncRows.map((r) => ({
      source: r.source,
      status: r.status,
      runs: num(r.runs),
      lastAt: iso(r.last_at),
      medianSeconds: r.median_seconds === null ? null : num(r.median_seconds),
      failures: num(r.failures),
    })),

    locked: lockedRows.map((r) => ({
      name: r.name,
      reason: r.reason,
      at: iso(r.at) ?? '',
    })),

    contactCollisions: collisionRows.map((r) => ({
      value: r.value,
      kind: r.kind,
      households: r.names ?? [],
    })),

    performanceSignups: performRows.map((r) => ({
      name: r.name,
      kind: r.kind,
      type: r.type,
      members: r.members,
      wantsMedia: r.media,
      wantsStage: r.stage,
      notes: r.notes,
    })),

    households: householdRows.map((r) => ({
      name: r.name,
      email: r.email,
      phone: r.phone,
      purchased: num(r.purchased),
      redeemed: num(r.redeemed),
      remaining: num(r.remaining),
      childrenUnder6: num(r.kids),
      status: r.status,
      method: r.method,
      cents: r.cents === null ? null : num(r.cents),
      source: r.source,
      passOpened: Boolean(r.pass_opened),
      createdAt: iso(r.created_at) ?? '',
      notes: r.notes,
    })),
  }
}
