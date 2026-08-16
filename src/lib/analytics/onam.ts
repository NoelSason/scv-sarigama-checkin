import 'server-only'
import { query } from '@/lib/db'
import { LOG_PAGE, type LogRow } from './log-shape'
import {
  LANES,
  SEATING_CAPACITY,
  SEATS_PER_LANE,
  type Bucket,
  type Insight,
  type OnamAnalytics,
  type ProgramRow,
  type Slice,
  type Tip,
} from './types'
import { PROGRAM, clockFromMinutes, planMinutes, plannedDuration } from './program'
import { BASELINE_DAY } from './demand'

export * from './types'
export { LOG_PAGE, type LogRow } from './log-shape'

/**
 * Everything the public Onam 2026 analytics page shows, in one round of
 * parallel queries.
 *
 * Three rules run through the whole file:
 *
 * 1. **The real cohort is `not is_test and merged_into_id is null`.**
 *    Rehearsal rows would inflate the catering headcount, and the absorbed
 *    half of a merged purchase would count the same family twice. Both are
 *    reported separately instead of being silently dropped.
 *
 * 2. **Admitted is derived from the ledger, not from `quantity`.**
 *    A scan that was later given back still has its row. The number of people
 *    a scan actually admitted is `quantity - sum(adjustments against it)`, so
 *    that is what every arrival figure is built from. It reconciles exactly to
 *    `households.tickets_redeemed`, which is asserted in the test suite.
 *
 * 3. **Marked-present guests are counted in headcount and nowhere else.**
 *    They were recorded days after the event with no observed arrival time, so
 *    putting them on a clock would invent data. Every time-based figure —
 *    per-hour arrivals, peak throughput, seating fill, the gap between scans —
 *    comes from scans only.
 *
 * All clock arithmetic happens in Postgres in America/Los_Angeles, so the page
 * reads identically on a phone in another timezone.
 */

const TZ = 'America/Los_Angeles'

/** Real guests: not a rehearsal row, not the absorbed half of a merge. */
const REAL = `not h.is_test and h.merged_into_id is null`

/**
 * People a scan actually let in.
 *
 * `quantity` is what the volunteer pressed; adjustments are what was handed
 * back afterwards. Only the difference ever ate.
 */
const NET_ADMITTED = `
  (r.quantity - coalesce(
    (select sum(a.quantity_delta)::int
       from redemption_adjustments a
      where a.related_redemption_id = r.id), 0))
`

type SliceRow = {
  key: string
  households: number
  guests: number
  cents: number
  checked_in: number
}


/**
 * The columns the log publishes, on a page with no login.
 *
 * This is a record of what the SYSTEM did — a scan, a correction, an email, a
 * sync — not a profile of the people it did it for. So the log publishes the
 * action, who performed it and which family it concerned, and nothing that
 * would describe a guest beyond that:
 *
 *   * No address, no device, no whereabouts. Those columns are simply not
 *     selected, and nothing downstream can add them back.
 *   * `detail` is a metadata blob, and the email rows carry the guest's own
 *     address inside it. Nobody reading this report needs it, and a public
 *     page is exactly where a harvestable list of addresses should not be, so
 *     they are masked on the way out rather than trusted not to appear.
 *
 * Doing it here, in the one shared SELECT, means neither the first page nor the
 * paging route can forget to.
 */
export const LOG_SELECT = `
  select event_id, occurred_at, category, action, actor, actor_type, actor_role,
         request_path, household,
         regexp_replace(detail,
           '[[:alnum:]._%+-]+@[[:alnum:].-]+\\.[[:alpha:]]{2,}',
           '[email hidden]', 'gi') as detail
    from event_stream`

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

/** '13:45' → '1:45 PM'. The page is read by organizers, not by engineers. */
function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const suffix = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`
}

function hourLabel(hhmm: string): string {
  const h = Number(hhmm.split(':')[0])
  const suffix = h >= 12 ? 'PM' : 'AM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour} ${suffix}`
}

function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function fromMinutes(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Turn sparse SQL buckets into a continuous, tiered, cumulative series.
 *
 * `stepMinutes` is the bucket width the query already grouped by; this fills in
 * the ones with nothing in them and grades each slot against the busiest.
 */
function buildSeries(
  rows: { at: string; scans: number; guests: number }[],
  stepMinutes: number,
  label: (hhmm: string) => string,
): Bucket[] {
  if (!rows.length) return []

  const byAt = new Map(rows.map((r) => [r.at, r]))
  const start = toMinutes(rows[0].at)
  const end = toMinutes(rows[rows.length - 1].at)
  const peak = rows.reduce((mx, r) => Math.max(mx, num(r.guests)), 0)

  const out: Bucket[] = []
  let running = 0
  for (let m = start; m <= end; m += stepMinutes) {
    const at = fromMinutes(m)
    const row = byAt.get(at)
    const guests = num(row?.guests)
    running += guests
    const intensity = peak ? guests / peak : 0
    out.push({
      at,
      label: label(at),
      scans: num(row?.scans),
      guests,
      cumulative: running,
      intensity,
      tier:
        guests === 0
          ? 'quiet'
          : intensity >= 0.8
            ? 'rush'
            : intensity >= 0.55
              ? 'busy'
              : intensity >= 0.25
                ? 'steady'
                : 'trickle',
    })
  }
  return out
}

/** Minutes since midnight, in the event's timezone, from any instant. */
function laMinutes(value: unknown): number | null {
  const at = iso(value)
  if (!at) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(at))
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  return h * 60 + m
}

/**
 * Automated fetchers, matched so they can be excluded from click counts.
 *
 * Used only to throw rows away — never to describe anybody. A mail app or a
 * chat client fetches a link the moment it is pasted, and counting those as a
 * guest opening something would overstate every figure here.
 */
const BOT_UA =
  'bot|crawler|spider|preview|facebookexternalhit|Twitterbot|Slackbot|WhatsApp|HeadlessChrome|curl|python-requests|GoogleOther|Discordbot'

const LINK_TARGET_LABELS: Record<string, string> = {
  video: 'The programme recording',
  feedback: 'The feedback form',
  unknown: 'Something else',
}

/** "40 minutes" / "1h 40m" — drift as a plain span, without the direction word. */
function driftWordsPlain(minutes: number): string {
  const size = Math.abs(Math.round(minutes))
  const h = Math.floor(size / 60)
  const m = size % 60
  return h > 0 ? `${h}h ${m}m` : `${m} minutes`
}

function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  })
}

/** Average minutes between one full turn of the hall filling and the next. */
function estimateTurnMinutes(turns: { filledAt: string | null }[]): number {
  const minutes = turns
    .map((t) => t.filledAt)
    .filter((v): v is string => Boolean(v))
    .map((label) => {
      const m = label.match(/^(\d+):(\d+)\s(AM|PM)$/)
      if (!m) return null
      let h = Number(m[1]) % 12
      if (m[3] === 'PM') h += 12
      return h * 60 + Number(m[2])
    })
    .filter((v): v is number => v !== null)
  if (minutes.length < 2) return 0
  const gaps: number[] = []
  for (let i = 1; i < minutes.length; i++) gaps.push(minutes[i] - minutes[i - 1])
  return Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length / 5) * 5
}

const METHOD_LABELS: Record<string, string> = {
  square: 'Square (card, in advance)',
  stripe: 'Stripe storefront',
  zelle: 'Zelle',
  cash: 'Cash at the door',
  complimentary: 'Complimentary',
  other: 'Other',
  unrecorded: 'Not recorded',
}

const SOURCE_LABELS: Record<string, string> = {
  square: 'Square online sales',
  google_sheets: 'Payments spreadsheet (Zelle)',
  walk_in: 'Walk-up at the desk',
  stripe: 'Storefront checkout',
  seed: 'Demo record',
}

const STATUS_LABELS: Record<string, string> = {
  paid: 'Paid',
  unpaid: 'Unpaid',
  pending: 'Pending',
  comped: 'Complimentary',
  refunded: 'Refunded',
  partially_refunded: 'Partly refunded',
  needs_review: 'Needed a human look',
}

export async function loadOnamAnalytics(): Promise<OnamAnalytics> {
  // ---------------------------------------------------------------- day
  // Derived rather than hard-coded: rehearsal scans sit on earlier dates, and
  // whichever day actually fed people is the one with the arrivals on it.
  const dayRows = await query<{ day: string; guests: number }>(
    `select to_char(r.created_at at time zone '${TZ}', 'YYYY-MM-DD') as day,
            sum(${NET_ADMITTED})::int as guests
       from redemptions r
       join households h on h.id = r.household_id
      where ${REAL}
      group by 1
      having sum(${NET_ADMITTED}) > 0
      order by 2 desc
      limit 1`,
  )
  const eventDay = dayRows[0]?.day ?? null

  // Every service figure is scoped to the event day so a rehearsal scan three
  // days earlier cannot appear as an arrival.
  const dayScope = eventDay
    ? `and (r.created_at at time zone '${TZ}')::date = '${eventDay}'::date`
    : `and false`

  /*
   * How guests actually used their pass.
   *
   * The emailed QR and the pass page carry the *same* code — the email embeds
   * it as an attachment, encoding nothing but the pass URL — so a guest could
   * scan straight out of their inbox and never load the site. That makes these
   * two behaviours distinguishable for the first time, and the split is the
   * most interesting thing the logs know:
   *
   *   opened the page   → there is a `pass_opened` row
   *   inbox only        → emailed, scanned in, but no `pass_opened` row
   *   no pass at all    → never emailed; found by name at the desk
   *
   * Kicked off before the main batch is awaited so both sets of queries are in
   * flight at once.
   */
  const behaviourPromise = Promise.all([
    query<{ segment: string; households: number; sold: number; came: number }>(
      `with base as (
         select h.id, h.tickets_purchased as sold, h.tickets_redeemed as came,
           exists (select 1 from email_deliveries e
                    where e.household_id = h.id and e.status = 'sent')          as emailed,
           exists (select 1 from audit_logs a
                    where a.household_id = h.id and a.action = 'pass_opened')   as opened,
           exists (select 1 from audit_logs a
                    where a.household_id = h.id and a.action like 'scan\\_%')    as scanned,
           exists (select 1 from audit_logs a
                    where a.household_id = h.id and a.action = 'desk_lookup')   as desk
         from households h where ${REAL}
       )
       select case
                when not scanned and came = 0 and not opened then 'never_came'
                when opened                                   then 'opened_page'
                when emailed and scanned                      then 'inbox_only'
                when scanned or desk                          then 'desk_lookup'
                else 'other'
              end as segment,
              count(*)::int as households,
              coalesce(sum(sold), 0)::int as sold,
              coalesce(sum(came), 0)::int as came
         from base group by 1 order by 2 desc`,
    ),

    // How long after the pass landed did people look at it.
    query<{ band: string; households: number }>(
      `with sent as (select household_id, min(sent_at) as s from email_deliveries
                      where kind = 'pass' and status = 'sent' group by 1),
            opened as (select household_id, min(created_at) as o from audit_logs
                        where action = 'pass_opened' group by 1)
       select case when extract(epoch from (o - s)) / 60   <  10 then 'minutes'
                   when extract(epoch from (o - s)) / 3600 <   1 then 'within the hour'
                   when extract(epoch from (o - s)) / 3600 <   6 then 'later that day'
                   when extract(epoch from (o - s)) / 3600 <  24 then 'within a day'
                   when extract(epoch from (o - s)) / 86400 <  3 then 'a couple of days'
                   else 'the week of the event' end as band,
              count(*)::int as households
         from sent join opened using (household_id) where o >= s group by 1`,
    ),

    query<{ median: string; fastest: string; n: number }>(
      `with sent as (select household_id, min(sent_at) as s from email_deliveries
                      where kind = 'pass' and status = 'sent' group by 1),
            opened as (select household_id, min(created_at) as o from audit_logs
                        where action = 'pass_opened' group by 1)
       select percentile_cont(0.5) within group (order by extract(epoch from (o - s)) / 60)::numeric as median,
              min(extract(epoch from (o - s)) / 60)::numeric as fastest,
              count(*)::int as n
         from sent join opened using (household_id) where o >= s`,
    ),

    query<{ opens: number; households: number }>(
      `select n as opens, count(*)::int as households
         from (select household_id, count(*)::int as n from audit_logs
                where action = 'pass_opened' group by 1) x
        group by 1 order by 1`,
    ),

    // Did they pull it up at the door, or hours beforehand?
    query<{ band: string; opens: number }>(
      `with firstscan as (select r.household_id, min(r.created_at) as sc
                            from redemptions r join households h on h.id = r.household_id
                           where ${REAL} group by 1),
            opens as (select household_id, created_at as o from audit_logs
                       where action = 'pass_opened')
       select case when extract(epoch from (sc - o)) / 60 between -2 and 20 then 'at_the_door'
                   when o > sc                                             then 'after_admitted'
                   when extract(epoch from (sc - o)) / 3600 <= 4           then 'same_afternoon'
                   else 'well_before' end as band,
              count(*)::int as opens
         from opens join firstscan using (household_id) group by 1`,
    ),

    query<{ no_email: number; with_email: number }>(
      `select count(*) filter (where h.email is null)::int     as no_email,
              count(*) filter (where h.email is not null)::int as with_email
         from households h where ${REAL}`,
    ),
  ])

  const [
    totals,
    methodRows,
    sourceRows,
    statusRows,
    sizeRows,
    intakeRows,
    hourlyRows,
    fineRows,
    windowRows,
    scanShapeRows,
    gapRows,
    splitRows,
    deviceRows,
    emailRows,
    openRows,
    openDayRows,
    clickRows,
    clickBotRows,
    integrityRows,
    reviewRows,
    payOrderRows,
    walkInRows,
    raffleRows,
    noShowRows,
    logRows,
    logFirstPage,
    largestRows,
    programMarkRows,
    turnoutBySizeRows,
    openedVsNotRows,
    arrivalByChannelRows,
    partyByPhaseRows,
    quartileRows,
    leadTimeRows,
    deviceOverTimeRows,
  ] = await Promise.all([
    query<{
      households: number
      sold: number
      scanned: number
      cents: number
      under6: number
      tests: number
      merged: number
      marked: number
    }>(
      `select
         count(*) filter (where ${REAL})::int                                     as households,
         coalesce(sum(h.tickets_purchased) filter (where ${REAL}), 0)::int        as sold,
         coalesce(sum(h.tickets_redeemed)  filter (where ${REAL}), 0)::int        as scanned,
         coalesce(sum(h.amount_paid_cents) filter (where ${REAL}), 0)::int        as cents,
         coalesce(sum(h.children_under_6)  filter (where ${REAL}), 0)::int        as under6,
         count(*) filter (where h.is_test)::int                                   as tests,
         count(*) filter (where h.merged_into_id is not null)::int                as merged,
         coalesce((select sum(m.quantity)::int from attendance_marks m
                     join households hh on hh.id = m.household_id
                    where not hh.is_test and hh.merged_into_id is null), 0)::int  as marked
       from households h`,
    ),

    query<SliceRow>(
      `select coalesce(h.payment_method::text, 'unrecorded') as key,
              count(*)::int as households,
              coalesce(sum(h.tickets_purchased), 0)::int as guests,
              coalesce(sum(h.amount_paid_cents), 0)::int as cents,
              coalesce(sum(h.tickets_redeemed), 0)::int as checked_in
         from households h where ${REAL} group by 1 order by 4 desc`,
    ),

    query<SliceRow>(
      `select coalesce(h.source, 'unknown') as key,
              count(*)::int as households,
              coalesce(sum(h.tickets_purchased), 0)::int as guests,
              coalesce(sum(h.amount_paid_cents), 0)::int as cents,
              coalesce(sum(h.tickets_redeemed), 0)::int as checked_in
         from households h where ${REAL} group by 1 order by 4 desc`,
    ),

    query<SliceRow>(
      `select h.payment_status::text as key,
              count(*)::int as households,
              coalesce(sum(h.tickets_purchased), 0)::int as guests,
              coalesce(sum(h.amount_paid_cents), 0)::int as cents,
              coalesce(sum(h.tickets_redeemed), 0)::int as checked_in
         from households h where ${REAL} group by 1 order by 2 desc`,
    ),

    query<{ size: number; households: number; guests: number }>(
      `select h.tickets_purchased as size, count(*)::int as households,
              (h.tickets_purchased * count(*))::int as guests
         from households h where ${REAL} and h.tickets_purchased > 0
        group by 1 order by 1`,
    ),

    query<{ day: string; households: number; guests: number }>(
      `select to_char(h.created_at at time zone '${TZ}', 'YYYY-MM-DD') as day,
              count(*)::int as households,
              coalesce(sum(h.tickets_purchased), 0)::int as guests
         from households h where ${REAL} group by 1 order by 1`,
    ),

    // ------------------------------------------------------------- arrivals
    query<{ at: string; scans: number; guests: number }>(
      `select to_char(date_trunc('hour', r.created_at at time zone '${TZ}'), 'HH24:MI') as at,
              count(*)::int as scans,
              sum(${NET_ADMITTED})::int as guests
         from redemptions r join households h on h.id = r.household_id
        where ${REAL} ${dayScope}
        group by 1 having sum(${NET_ADMITTED}) > 0 order by 1`,
    ),

    // Five-minute resolution: the grain a serving line is actually felt at.
    query<{ at: string; scans: number; guests: number }>(
      `select to_char(
                date_trunc('hour', r.created_at at time zone '${TZ}')
                + make_interval(mins => 5 * floor(extract(minute from r.created_at at time zone '${TZ}') / 5)::int),
                'HH24:MI') as at,
              count(*)::int as scans,
              sum(${NET_ADMITTED})::int as guests
         from redemptions r join households h on h.id = r.household_id
        where ${REAL} ${dayScope}
        group by 1 having sum(${NET_ADMITTED}) > 0 order by 1`,
    ),

    // Busiest rolling 15 minutes, measured over the scans themselves rather
    // than over fixed buckets — a rush that straddles 12:58 is still a rush.
    query<{ at: string; guests: number }>(
      `select to_char(t.at at time zone '${TZ}', 'HH24:MI') as at, t.guests::int
         from (
           select r.created_at as at,
                  sum(${NET_ADMITTED}) over (
                    order by r.created_at
                    range between current row and interval '15 minutes' following) as guests
             from redemptions r join households h on h.id = r.household_id
            where ${REAL} ${dayScope}
         ) t
        order by t.guests desc nulls last limit 1`,
    ),

    query<{ scans: number; guests: number; avg_party: string; max_party: number; first_at: unknown; last_at: unknown }>(
      `select count(*)::int as scans,
              sum(${NET_ADMITTED})::int as guests,
              avg(${NET_ADMITTED})::numeric(6,2) as avg_party,
              max(${NET_ADMITTED})::int as max_party,
              min(r.created_at) as first_at,
              max(r.created_at) as last_at
         from redemptions r join households h on h.id = r.household_id
        where ${REAL} ${dayScope} and ${NET_ADMITTED} > 0`,
    ),

    query<{ median: string; longest: string }>(
      `select percentile_cont(0.5) within group (order by gap)::numeric(10,1) as median,
              max(gap)::numeric(10,1) as longest
         from (
           select extract(epoch from r.created_at
                    - lag(r.created_at) over (order by r.created_at)) as gap
             from redemptions r join households h on h.id = r.household_id
            where ${REAL} ${dayScope} and ${NET_ADMITTED} > 0
         ) g where gap is not null`,
    ),

    query<{ n: number }>(
      `select count(*)::int as n from (
         select r.household_id
           from redemptions r join households h on h.id = r.household_id
          where ${REAL} ${dayScope} and ${NET_ADMITTED} > 0
          group by 1 having count(*) > 1) x`,
    ),

    query<{ key: string; n: number; guests: number }>(
      `select coalesce(r.device_name, 'unnamed') as key, count(*)::int as n,
              sum(${NET_ADMITTED})::int as guests
         from redemptions r join households h on h.id = r.household_id
        where ${REAL} ${dayScope} group by 1 order by 3 desc`,
    ),


    query<{ kind: string; status: string; n: number }>(
      `select kind, status, count(*)::int as n from email_deliveries group by 1, 2`,
    ),

    query<{ opens: number; households: number }>(
      `select count(*)::int as opens, count(distinct household_id)::int as households
         from audit_logs where action = 'pass_opened'`,
    ),

    query<{ day: string; opens: number }>(
      `select to_char(created_at at time zone '${TZ}', 'YYYY-MM-DD') as day, count(*)::int as opens
         from audit_logs where action = 'pass_opened' group by 1 order by 1`,
    ),

    /**
     * Clicks on tracked links in the mailings, per link — plus a total row.
     *
     * Joined back to households and filtered by ${REAL} so a click from a test
     * household or a row since merged away never inflates the count.
     *
     * The grouping set is what makes the total honest. Distinct households
     * cannot be summed across the per-link rows: a family that clicked two
     * different links would be counted twice, and taking the largest single row
     * instead would undercount everyone who clicked only the other one. The
     * database counts them once, over the whole set, in the '*' row.
     *
     * Bots are excluded here rather than after the fact, so `clicks` and
     * `households` are both people and can be read against each other.
     */
    query<{ target: string; clicks: number; households: number }>(
      `select case when grouping(a.metadata->>'target') = 1
                   then '*'
                   else coalesce(a.metadata->>'target', 'unknown') end as target,
              count(*)::int as clicks,
              count(distinct a.household_id)::int as households
         from audit_logs a join households h on h.id = a.household_id
        where a.action = 'link_clicked' and ${REAL}
          and coalesce(a.user_agent, '') !~* '${BOT_UA}'
        group by grouping sets ((a.metadata->>'target'), ())
        order by 2 desc`,
    ),

    /**
     * Link-preview fetchers, counted separately so they never read as guests —
     * the same treatment pass opens get.
     */
    query<{ clicks: number }>(
      `select count(*)::int as clicks
         from audit_logs a join households h on h.id = a.household_id
        where a.action = 'link_clicked' and ${REAL}
          and coalesce(a.user_agent, '') ~* '${BOT_UA}'`,
    ),

    query<{
      scans: number
      reversed: number
      handed_back: number
      merges: number
      sheet_syncs: number
      square_events: number
      stripe_events: number
      sign_ins: number
    }>(
      `select
        (select count(*)::int from redemptions r join households h on h.id = r.household_id where ${REAL}) as scans,
        (select count(*)::int from redemptions r join households h on h.id = r.household_id
          where ${REAL} and r.reversed_at is not null)                                     as reversed,
        (select coalesce(sum(quantity_delta), 0)::int from redemption_adjustments)         as handed_back,
        (select count(*)::int from household_merges)                                       as merges,
        (select count(*)::int from sync_runs where source = 'google_sheets')               as sheet_syncs,
        (select count(*)::int from payment_events where provider = 'square')               as square_events,
        (select count(*)::int from payment_events where provider = 'stripe')               as stripe_events,
        (select count(*)::int from staff_sessions)                                         as sign_ins`,
    ),

    query<{ status: string; n: number }>(
      `select status::text, count(*)::int as n from review_items group by 1`,
    ),

    query<{ status: string; n: number; cents: number; donation: number; gold: number; silver: number }>(
      `select status, count(*)::int as n,
              coalesce(sum(amount_total_cents), 0)::int as cents,
              coalesce(sum(donation_cents), 0)::int as donation,
              coalesce(sum(sponsor_gold), 0)::int as gold,
              coalesce(sum(sponsor_silver), 0)::int as silver
         from pay_orders where not is_test group by 1`,
    ),

    query<{ name: string; at: unknown; guests: number; cents: number }>(
      `select h.display_name as name, h.created_at as at,
              h.tickets_purchased as guests, coalesce(h.amount_paid_cents, 0) as cents
         from households h where ${REAL} and h.source = 'walk_in' order by h.created_at`,
    ),

    // Standing wins only.
    //
    // A voided draw is one that was re-spun on stage — a rehearsal, a timing
    // check, or a name that came up and was put back. It never won anything,
    // and listing it next to a real winner reads as though fourteen prizes
    // were given out. The rows stay in the database as the record of what was
    // announced; they simply are not results.
    query<{ name: string; prize: string; entries: number; at: unknown }>(
      `select display_name as name, prize, entries_at_draw as entries, created_at as at
         from raffle_draws
        where voided_at is null
        order by created_at desc`,
    ),

    query<{
      id: string
      name: string
      purchased: number
      scanned: number
      missing: number
      method: string | null
      source: string | null
      marked: number
      note: string | null
    }>(
      `select h.id, h.display_name as name,
              h.tickets_purchased as purchased,
              h.tickets_redeemed  as scanned,
              h.tickets_remaining as missing,
              h.payment_method::text as method,
              h.source,
              coalesce(m.quantity, 0)::int as marked,
              m.note
         from households h
         left join attendance_marks m on m.household_id = h.id
        where ${REAL} and h.tickets_remaining > 0
        order by h.tickets_remaining desc, h.display_name asc`,
    ),

    query<{ category: string; n: number }>(
      `select category, count(*)::int as n from event_stream group by 1 order by 2 desc`,
    ),

    query<LogRow>(`${LOG_SELECT} order by occurred_at desc limit ${LOG_PAGE}`),

    query<{ name: string; guests: number }>(
      `select h.display_name as name, h.tickets_purchased as guests
         from households h where ${REAL} order by h.tickets_purchased desc limit 1`,
    ),

    query<{ item_key: string; started_at: unknown }>(
      `select item_key, started_at from program_marks`,
    ),

    // --------------------------------------------------------- deeper cuts
    //
    // Turnout by family size. A no-show is not evenly distributed: a party of
    // one either comes or doesn't, while a party of eight almost always has
    // somebody drop out, and the two failure modes want different fixes.
    query<{ band: string; households: number; sold: number; came: number }>(
      `select case when h.tickets_purchased = 1 then '1'
                   when h.tickets_purchased = 2 then '2'
                   when h.tickets_purchased between 3 and 4 then '3-4'
                   else '5+' end as band,
              count(*)::int as households,
              sum(h.tickets_purchased)::int as sold,
              sum(h.tickets_redeemed)::int as came
         from households h where ${REAL} and h.tickets_purchased > 0
        group by 1 order by 1`,
    ),

    // Did opening the pass beforehand predict turning up? The pass is the only
    // thing the app asked a guest to do before the day, so this is the closest
    // it gets to a measure of whether the digital pass earned its keep.
    query<{ opened: boolean; households: number; sold: number; came: number }>(
      `select exists (select 1 from audit_logs a
                       where a.household_id = h.id and a.action = 'pass_opened') as opened,
              count(*)::int as households,
              sum(h.tickets_purchased)::int as sold,
              sum(h.tickets_redeemed)::int as came
         from households h where ${REAL} and h.tickets_purchased > 0
        group by 1 order by 1 desc`,
    ),

    // When each channel's guests actually turned up. Walk-ups are excluded —
    // they arrived and bought in the same motion, so their arrival time says
    // nothing about the channel.
    query<{ key: string; first_at: unknown; median_min: string; last_at: unknown; guests: number }>(
      `select coalesce(h.source, 'unknown') as key,
              min(r.created_at) as first_at,
              percentile_cont(0.5) within group (
                order by extract(epoch from (r.created_at at time zone '${TZ}'))
              )::numeric as median_min,
              max(r.created_at) as last_at,
              sum(${NET_ADMITTED})::int as guests
         from redemptions r join households h on h.id = r.household_id
        where ${REAL} ${dayScope} and ${NET_ADMITTED} > 0
        group by 1 having sum(${NET_ADMITTED}) > 0 order by 5 desc`,
    ),

    // Did the big families come early and the small ones late, or the reverse?
    query<{ phase: string; scans: number; guests: number; avg_party: string }>(
      `select case when r.created_at < first_third.t then 'early'
                   when r.created_at < second_third.t then 'middle'
                   else 'late' end as phase,
              count(*)::int as scans,
              sum(${NET_ADMITTED})::int as guests,
              avg(${NET_ADMITTED})::numeric(6,2) as avg_party
         from redemptions r
         join households h on h.id = r.household_id
         cross join lateral (
           select min(r2.created_at) + (max(r2.created_at) - min(r2.created_at)) / 3 as t
             from redemptions r2 join households h2 on h2.id = r2.household_id
            where not h2.is_test and h2.merged_into_id is null
              and (r2.created_at at time zone '${TZ}')::date
                  = (r.created_at at time zone '${TZ}')::date
         ) first_third
         cross join lateral (
           select min(r3.created_at) + 2 * (max(r3.created_at) - min(r3.created_at)) / 3 as t
             from redemptions r3 join households h3 on h3.id = r3.household_id
            where not h3.is_test and h3.merged_into_id is null
              and (r3.created_at at time zone '${TZ}')::date
                  = (r.created_at at time zone '${TZ}')::date
         ) second_third
        where ${REAL} ${dayScope} and ${NET_ADMITTED} > 0
        group by 1`,
    ),

    // The clock time by which a quarter, half, three-quarters and all of the
    // guests had arrived. One line each, and between them the whole shape of
    // the service.
    query<{ q: number; at: unknown }>(
      `with arrivals as (
         select r.created_at,
                sum(${NET_ADMITTED}) over (order by r.created_at
                  rows between unbounded preceding and current row) as running,
                sum(${NET_ADMITTED}) over () as total
           from redemptions r join households h on h.id = r.household_id
          where ${REAL} ${dayScope} and ${NET_ADMITTED} > 0
       )
       select q, min(created_at) as at
         from arrivals, unnest(array[25, 50, 75, 90]) as q
        where running >= total * q / 100.0
        group by q order by q`,
    ),

    // How far ahead of the day each family committed. Walk-ups are day-of by
    // definition; the bulk import is not a purchase date and is filtered out
    // by looking only at rows created after it.
    query<{ band: string; households: number; guests: number }>(
      `select case when h.source = 'walk_in' then 'On the day, at the desk'
                   when h.created_at::date >= date '2026-08-15' then 'On the day, in advance'
                   when h.created_at::date >= date '2026-08-12' then 'The final few days'
                   else 'Already on the books' end as band,
              count(*)::int as households,
              sum(h.tickets_purchased)::int as guests
         from households h where ${REAL} group by 1 order by 3 desc`,
    ),

    // Which scanner carried the load as the afternoon went on.
    query<{ device: string; at: string; guests: number }>(
      `select coalesce(r.device_name, 'unnamed') as device,
              to_char(date_trunc('hour', r.created_at at time zone '${TZ}'), 'HH24:MI') as at,
              sum(${NET_ADMITTED})::int as guests
         from redemptions r join households h on h.id = r.household_id
        where ${REAL} ${dayScope} and ${NET_ADMITTED} > 0
        group by 1, 2 order by 2, 1`,
    ),
  ])

  const [
    segmentRows,
    timeToOpenRows,
    openSpeedRows,
    opensPerRows,
    openVsArrivalRows,
    emailAddressRows,
  ] = await behaviourPromise

  const t = totals[0]
  const shape = scanShapeRows[0]

  // ------------------------------------------------------------------ money
  const totalCents = num(t.cents)
  const admissionsSold = num(t.sold)
  const scannedIn = num(t.scanned)
  const markedPresent = num(t.marked)
  const guestsWhoAte = scannedIn + markedPresent
  const stillUnaccounted = Math.max(0, admissionsSold - guestsWhoAte)

  const paidOrders = payOrderRows.find((r) => r.status === 'paid')
  const pendingOrders = payOrderRows.find((r) => r.status === 'pending')

  const walkIns = walkInRows.map((r) => ({
    name: r.name,
    at: iso(r.at) ?? '',
    guests: num(r.guests),
    cents: num(r.cents),
  }))

  // -------------------------------------------------------------- arrivals
  //
  // Zero-filled to a continuous timeline. The gaps ARE the finding — a chart
  // built only from the buckets that had a scan in them silently closes up
  // every lull and makes a stop-start afternoon look like a steady stream.
  const fine = buildSeries(fineRows, 5, clockLabel)
  const hourly = buildSeries(hourlyRows, 60, hourLabel)

  const peakHourRow = hourly.reduce<Bucket | null>(
    (best, b) => (!best || b.guests > best.guests ? b : best),
    null,
  )
  const peakFiveRow = fine.reduce<Bucket | null>(
    (best, b) => (!best || b.guests > best.guests ? b : best),
    null,
  )
  const peakFifteenRow = windowRows[0] ?? null

  // Which clock time each notional seating of 80 filled, read off the
  // cumulative arrival curve.
  const seatings: OnamAnalytics['service']['seatings'] = []
  const totalArrived = fine.length ? fine[fine.length - 1].cumulative : 0
  const seatingCount = Math.min(12, Math.ceil(totalArrived / SEATING_CAPACITY))
  for (let i = 1; i <= seatingCount; i++) {
    const target = i * SEATING_CAPACITY
    const hit = fine.find((b) => b.cumulative >= target)
    seatings.push({
      seating: i,
      filledAt: hit ? hit.label : null,
      guests: Math.min(target, totalArrived) - (i - 1) * SEATING_CAPACITY,
      full: Boolean(hit),
    })
  }

  const peakFifteenGuests = num(peakFifteenRow?.guests)
  const peakGuestsPerHour = peakFifteenGuests * 4

  // The longest stretch with nobody arriving at all — the counterpart to the
  // rush, and the thing that says whether the seatings really were staggered.
  let longestLull: OnamAnalytics['service']['longestLull'] = null
  let runStart: Bucket | null = null
  let runLength = 0
  const closeRun = (endIndex: number) => {
    if (runStart && runLength * 5 > (longestLull?.minutes ?? 0)) {
      longestLull = {
        from: runStart.label,
        to: fine[endIndex]?.label ?? runStart.label,
        minutes: runLength * 5,
      }
    }
    runStart = null
    runLength = 0
  }
  fine.forEach((b, i) => {
    if (b.guests === 0) {
      if (!runStart) runStart = b
      runLength++
    } else {
      closeRun(i)
    }
  })
  closeRun(fine.length - 1)

  const firstScan = iso(shape?.first_at)
  const lastScan = iso(shape?.last_at)
  const durationMinutes =
    firstScan && lastScan
      ? Math.round((Date.parse(lastScan) - Date.parse(firstScan)) / 60000)
      : 0

  // -------------------------------------------------------------- emails
  const emailsFor = (kind: string, status: string) =>
    num(emailRows.find((r) => r.kind === kind && r.status === status)?.n)
  const emailsFailed = emailRows
    .filter((r) => r.status === 'failed')
    .reduce((sum, r) => sum + num(r.n), 0)

  const realHouseholds = num(t.households)
  const householdsOpenedPass = num(openRows[0]?.households)

  // ---------------------------------------------------- thank-you clicks
  const clickTotals = clickRows.find((r) => r.target === '*')
  const thankyouClicks = num(clickTotals?.clicks)
  const thankyouHouseholds = num(clickTotals?.households)
  const botClicks = num(clickBotRows[0]?.clicks)
  const thankyouSent = emailsFor('thankyou', 'sent')

  const reviewsFor = (status: string) => num(reviewRows.find((r) => r.status === status)?.n)
  const integrity = integrityRows[0]

  // -------------------------------------------------------------- run sheet
  //
  // The plan lives in program.ts; the actual times come from taps recorded in
  // program_marks, plus two that the scanner already knows better than anyone
  // — the Sadya opened when the first guest was checked in and closed when the
  // last one was.
  const marks = new Map(programMarkRows.map((r) => [r.item_key, iso(r.started_at)]))
  const derivedActuals: Record<string, string | null> = {
    firstScan,
    lastScan,
  }

  const actualFor = (item: (typeof PROGRAM)[number]): string | null =>
    item.derivedFrom ? derivedActuals[item.derivedFrom] : (marks.get(item.key) ?? null)

  // The anchor is the latest item anybody has a real start time for. Drift is
  // measured there, and everything after it is projected from it — projecting
  // from an earlier item would ignore time already lost.
  let anchorIndex = -1
  PROGRAM.forEach((item, i) => {
    if (actualFor(item)) anchorIndex = i
  })

  const anchor = anchorIndex >= 0 ? PROGRAM[anchorIndex] : null
  const anchorActual = anchor ? laMinutes(actualFor(anchor)) : null
  const anchorPlanned = anchor ? planMinutes(anchor.at) : null
  const driftMinutes =
    anchorActual !== null && anchorPlanned !== null ? anchorActual - anchorPlanned : 0

  const programStartItem = PROGRAM.find((i) => i.key === 'p01')!
  const programStartedAt = actualFor(programStartItem)
  const programStartActual = laMinutes(programStartedAt)
  const programStartPlanned = planMinutes(programStartItem.at)

  // How compressed the show has been running: actual elapsed ÷ planned
  // elapsed, over the programme only. Below 1 means items are finishing faster
  // than the run sheet allowed for.
  const paceRatio =
    programStartActual !== null &&
    anchorActual !== null &&
    anchorPlanned !== null &&
    anchorPlanned > programStartPlanned
      ? (anchorActual - programStartActual) / (anchorPlanned - programStartPlanned)
      : null

  /*
   * Fill in the items nobody had a free hand to mark.
   *
   * Between two items that DO have real times, the ones in between are not
   * unknowable — the run sheet says how the planned minutes were meant to be
   * divided among them, and the two anchors say how many actual minutes there
   * were to divide. Spreading the actual elapsed time across the gap in
   * proportion to the planned lengths is a far better answer than a blank.
   *
   * It is still an inference, and it is labelled as one everywhere it appears.
   * Nothing on this page treats an estimate as a measurement: drift, pace and
   * the finish projection are all computed from the marked items only.
   */
  const knownMinutes = PROGRAM.map((item) => laMinutes(actualFor(item)))

  const estimatedMinutes: (number | null)[] = PROGRAM.map((item, i) => {
    if (knownMinutes[i] !== null) return null

    let before = -1
    for (let j = i - 1; j >= 0; j--) if (knownMinutes[j] !== null) { before = j; break }
    let after = -1
    for (let j = i + 1; j < PROGRAM.length; j++) if (knownMinutes[j] !== null) { after = j; break }
    if (before < 0 || after < 0) return null

    const plannedSpan = planMinutes(PROGRAM[after].at) - planMinutes(PROGRAM[before].at)
    const actualSpan = knownMinutes[after]! - knownMinutes[before]!
    // Two items sharing a planned time (the Sadya ending as the programme is
    // called to order) leave nothing to interpolate across.
    if (plannedSpan <= 0) return knownMinutes[before]!
    const throughPlan = (planMinutes(item.at) - planMinutes(PROGRAM[before].at)) / plannedSpan
    return Math.round(knownMinutes[before]! + throughPlan * actualSpan)
  })

  const programItems: ProgramRow[] = PROGRAM.map((item, i) => {
    const known = knownMinutes[i]
    const estimated = estimatedMinutes[i]
    const planned = planMinutes(item.at)
    const status =
      anchorIndex < 0 ? 'upcoming' : i < anchorIndex ? 'done' : i === anchorIndex ? 'current' : 'upcoming'

    const projected =
      status === 'upcoming' && anchorIndex >= 0 ? planned + driftMinutes : null

    const shownMinutes = known ?? estimated ?? projected
    const source: ProgramRow['source'] =
      known !== null
        ? item.derivedFrom
          ? 'scanner'
          : 'marked'
        : estimated !== null
          ? 'estimated'
          : projected !== null
            ? 'projected'
            : null

    return {
      key: item.key,
      number: item.number,
      title: item.title,
      who: item.who,
      phase: item.phase,
      plannedAt: clockFromMinutes(planned),
      plannedDuration: plannedDuration(i),
      actualAt: shownMinutes === null ? null : clockFromMinutes(shownMinutes),
      source,
      derived: Boolean(item.derivedFrom),
      // Drift is only claimed where the time is real or inferred from real
      // ones — never for an item that is merely projected forward.
      driftMinutes: shownMinutes === null || source === 'projected' ? null : shownMinutes - planned,
      projectedAt: projected === null ? null : clockFromMinutes(projected),
      status,
    }
  })

  // Everything still to run, at its planned length.
  const minutesRemainingPlanned = PROGRAM.slice(Math.max(0, anchorIndex) + 1).reduce(
    (sum, _item, offset) => sum + plannedDuration(Math.max(0, anchorIndex) + 1 + offset),
    0,
  )

  const lastItem = PROGRAM[PROGRAM.length - 1]
  const plannedEndMinutes =
    planMinutes(lastItem.until ?? lastItem.at) + (lastItem.until ? 0 : plannedDuration(PROGRAM.length - 1))

  // Pace right now, rather than averaged over the whole show. A programme that
  // clawed back an hour early on and has been slipping ever since looks fine on
  // the cumulative number and is not fine — this is the one an organiser
  // standing at the side of the stage actually needs.
  let recentDriftChange: number | null = null
  let recentSincePrevious: string | null = null
  if (anchorIndex > 0 && anchorActual !== null && anchorPlanned !== null) {
    for (let i = anchorIndex - 1; i >= 0; i--) {
      const prev = PROGRAM[i]
      const prevActual = laMinutes(actualFor(prev))
      if (prevActual === null) continue
      const prevDrift = prevActual - planMinutes(prev.at)
      recentDriftChange = driftMinutes - prevDrift
      recentSincePrevious = prev.title
      break
    }
  }

  // What the rest would have to do to still land on the run sheet's finish.
  const minutesLeftOnTheClock = anchorActual === null ? null : plannedEndMinutes - anchorActual
  const workRemaining = plannedDuration(Math.max(0, anchorIndex)) + minutesRemainingPlanned
  const compressionToFinishOnTime =
    minutesLeftOnTheClock === null || minutesLeftOnTheClock <= 0 || workRemaining <= 0
      ? null
      : workRemaining / minutesLeftOnTheClock

  // Once the terminal item is marked the show is over, and a panel still
  // forecasting a finish time for an event that already ended reads as broken.
  const terminalItem = PROGRAM[PROGRAM.length - 1]
  const terminalActual = laMinutes(actualFor(terminalItem))
  const finished = terminalActual !== null

  const program: OnamAnalytics['program'] = {
    now: new Date().toISOString(),
    items: programItems,
    currentKey: anchor?.key ?? null,
    currentTitle: anchor?.title ?? null,
    driftMinutes,
    programStartedAt,
    programPlannedAt: clockFromMinutes(programStartPlanned),
    paceRatio,
    plannedEnd: clockFromMinutes(plannedEndMinutes),
    projectedEndAtPlannedPace:
      anchorActual === null
        ? null
        : clockFromMinutes(anchorActual + plannedDuration(anchorIndex) + minutesRemainingPlanned),
    projectedEndAtObservedPace:
      anchorActual === null || paceRatio === null
        ? null
        : clockFromMinutes(
            anchorActual + paceRatio * (plannedDuration(anchorIndex) + minutesRemainingPlanned),
          ),
    minutesRemainingPlanned,
    finished,
    actualEnd: terminalActual === null ? null : clockFromMinutes(terminalActual),
    ranMinutes:
      terminalActual !== null && programStartActual !== null
        ? terminalActual - programStartActual
        : null,
    startDriftMinutes:
      programStartActual === null ? null : programStartActual - programStartPlanned,
    recentDriftChange,
    recentSincePrevious,
    compressionToFinishOnTime,
  }

  // ------------------------------------------------------- pass behaviour
  const SEGMENT_LABELS: Record<string, { label: string; detail: string }> = {
    opened_page: {
      label: 'Opened the live pass',
      detail: 'Loaded the pass page on their own phone, where the balance updates as they use it.',
    },
    inbox_only: {
      label: 'Scanned straight from the inbox',
      detail:
        'Never opened the page. The email carries the same QR as an attachment, so they showed the email — or a screenshot of it — at the door.',
    },
    desk_lookup: {
      label: 'Found by name at the desk',
      detail: 'No pass in hand. A volunteer searched for them and pulled the code up.',
    },
    never_came: {
      label: 'Never checked in',
      detail: 'Bought admissions the scanner never saw.',
    },
    other: { label: 'Something else', detail: 'Did not fall into any of the patterns above.' },
  }

  const OPEN_TIMING_LABELS: Record<string, string> = {
    at_the_door: 'Pulled it up at the door',
    same_afternoon: 'Earlier that afternoon',
    well_before: 'Well beforehand',
    after_admitted: 'After they were already inside',
  }

  const TIME_TO_OPEN_ORDER = [
    'minutes',
    'within the hour',
    'later that day',
    'within a day',
    'a couple of days',
    'the week of the event',
  ]

  const LEAD_TIME_ORDER = [
    'Already on the books',
    'The final few days',
    'On the day, in advance',
    'On the day, at the desk',
  ]

  const insightRow = (r: { band?: string; opened?: boolean; households: number; sold: number; came: number }, label: string): Insight => ({
    key: label,
    label,
    households: num(r.households),
    sold: num(r.sold),
    came: num(r.came),
    percent: num(r.sold) ? Math.round((num(r.came) / num(r.sold)) * 100) : 0,
  })

  /*
   * ---------------------------------------------------------------- demand
   *
   * The bulk import is the closest thing to a snapshot of what was known before
   * the final week — every record in it was a sale that already existed — so
   * anything created after it is genuinely late demand rather than an artefact
   * of when the data landed.
   */
  let demandRunning = 0
  const buildup = intakeRows.map((r) => {
    demandRunning += num(r.guests)
    return {
      day: r.day,
      label: dayLabel(r.day),
      added: num(r.guests),
      running: demandRunning,
      baseline: r.day === BASELINE_DAY,
    }
  })

  const knownAtBaseline = buildup.find((b) => b.baseline)?.running ?? 0
  const lateDemand = admissionsSold - knownAtBaseline
  const lateOnTheDay = num(buildup.find((b) => b.day === eventDay)?.added)

  const demand: OnamAnalytics['demand'] = {
    sold: admissionsSold,
    ate: guestsWhoAte,
    knownAtBaseline,
    lateDemand,
    lateOnTheDay,
    latePercent: knownAtBaseline ? Math.round((lateDemand / knownAtBaseline) * 100) : 0,
    buildup,
  }

  /*
   * ------------------------------------------------------------------ tips
   *
   * Each one is generated from the figure that justifies it, and each is
   * guarded so it only appears when the day actually produced that evidence. A
   * page that recommends staffing the rush harder when there was no rush is
   * worse than one that recommends nothing.
   */
  const tips: Tip[] = []
  const push = (t: Tip) => tips.push(t)

  const sadyaEnds = programItems.find((i) => i.key === 'sadya-ends')
  const callToOrder = programItems.find((i) => i.key === 'p01')

  // The single most expensive scheduling mistake on the run sheet: the Sadya
  // was booked to end at the same minute the programme was called to order.
  if (sadyaEnds && callToOrder && sadyaEnds.plannedAt === callToOrder.plannedAt) {
    push({
      key: 'changeover',
      category: 'Schedule',
      title: 'Leave a real gap between the Sadya and the stage',
      detail:
        'The run sheet had the meal ending and the programme starting at the same minute, with no time to clear leaves, reset the floor or get people seated. Book 30 minutes of changeover and the whole afternoon stops starting in deficit.',
      evidence: `Sadya planned to end ${sadyaEnds.plannedAt}, programme planned to open ${callToOrder.plannedAt}${
        sadyaEnds.actualAt && callToOrder.actualAt
          ? ` — the meal actually ran to ${sadyaEnds.actualAt} and the first word was said at ${callToOrder.actualAt}`
          : ''
      }.`,
    })
  }

  if (callToOrder?.driftMinutes && callToOrder.driftMinutes > 10) {
    push({
      key: 'start-late',
      category: 'Schedule',
      title: 'The programme never recovers what the start loses',
      detail:
        'Time lost before the first item is the hardest to win back, because every later item is somebody who rehearsed for a fixed length. Protect the start rather than planning to make it up.',
      evidence: `Opened ${driftWordsPlain(callToOrder.driftMinutes)} behind, and the gap was still ${driftWordsPlain(driftMinutes)} by ${anchor?.title ?? 'later in the show'}.`,
    })
  }

  // The most expensive lesson of the day, and the one most likely to repeat.
  if (demand.lateDemand > 0) {
    push({
      key: 'order-late',
      category: 'Sadya',
      title: `Add about ${Math.round(demand.latePercent / 5) * 5}% on top of whatever the headcount says that week`,
      detail:
        'Any number fixed a week out is a number a quarter of the crowd has not joined yet. Either push every deadline that depends on it as late as it will go, or carry a late-demand buffer on top of the sheet.',
      evidence: `${demand.knownAtBaseline} admissions were on the books once every existing sale was in one place. ${demand.lateDemand} more arrived afterwards — ${demand.lateOnTheDay} of them on the day itself — finishing at ${demand.sold} sold and ${demand.ate} guests accounted for.`,
    })
  }

  if (demand.lateOnTheDay > 0) {
    push({
      key: 'day-of-demand',
      category: 'Money',
      title: 'The day itself is a sales channel, not an afterthought',
      detail:
        'A large share of the late demand landed on the morning of the event — people deciding that day, and walk-ups at the door. Plan for it: a staffed desk, a card reader, and real headroom rather than treating it as an exception.',
      evidence: `${demand.lateOnTheDay} admissions were added on the event day, ${Math.round((demand.lateOnTheDay / demand.sold) * 100)}% of everything sold.`,
    })
  }

  if (peakFifteenRow && peakFifteenGuests > 0) {
    push({
      key: 'staff-the-rush',
      category: 'Sadya',
      title: `Staff hardest around ${clockLabel(peakFifteenRow.at)}`,
      detail: `The queue is heavily front-loaded — it is not a steady stream across the whole service. Put the most servers and the most scanners on the floor for the hour either side of the peak, and let the tail run light.`,
      evidence: `${peakFifteenGuests} guests came through in fifteen minutes at the peak — a rate of ${peakGuestsPerHour} an hour, about ${Math.round(peakFifteenGuests / LANES)} per lane.`,
    })
  }

  const q50 = quartileRows.length ? laMinutes(quartileRows.find((r) => num(r.q) === 50)?.at) : null
  const q90 = quartileRows.length ? laMinutes(quartileRows.find((r) => num(r.q) === 90)?.at) : null
  if (q50 !== null && q90 !== null && firstScan) {
    const openedAt = laMinutes(firstScan)!
    push({
      key: 'front-loaded',
      category: 'Sadya',
      title: 'Set out for the first half, not the average',
      detail:
        'Guests do not arrive evenly. The back end of service is much thinner than the front, so trays laid out at an even rate run short early and sit picked-over late.',
      evidence: `Doors effectively opened ${clockFromMinutes(openedAt)}; half the room was in by ${clockFromMinutes(q50)} and nine in ten by ${clockFromMinutes(q90)}.`,
    })
  }

  const fullTurns = seatings.filter((s) => s.full)
  if (fullTurns.length >= 2) {
    const first = fullTurns[0]
    const second = fullTurns[1]
    push({
      key: 'seatings',
      category: 'Sadya',
      title: `Plan on about ${estimateTurnMinutes(fullTurns)} minutes a turn`,
      detail: `With ${LANES} lanes of roughly ${SEATS_PER_LANE}, the hall turns over in a predictable rhythm. Knowing the real turn time lets you tell a waiting family how long, instead of guessing.`,
      evidence: `${SEATING_CAPACITY} seated by ${first.filledAt}, ${SEATING_CAPACITY * 2} by ${second.filledAt}${
        fullTurns[2] ? `, ${SEATING_CAPACITY * 3} by ${fullTurns[2].filledAt}` : ''
      }.`,
    })
  }

  if (stillUnaccounted > 0 || markedPresent > 0) {
    push({
      key: 'scan-to-the-end',
      category: 'The desk',
      title: 'Keep scanning until the last guest',
      detail:
        'The scanner was abandoned once the line thinned and the numbers stopped matching the room. A second person on a phone for the last half hour costs nothing and keeps the headcount honest — it is the number the catering order is built from next year.',
      evidence: `${admissionsSold - scannedIn} admissions were never scanned${
        markedPresent > 0 ? `, of which ${markedPresent} have since been confirmed as having eaten anyway` : ''
      }.`,
    })
  }

  const inboxSeg = segmentRows.find((r) => r.segment === 'inbox_only')
  const openedSeg = segmentRows.find((r) => r.segment === 'opened_page')
  if (inboxSeg && openedSeg && num(inboxSeg.households) > num(openedSeg.households)) {
    push({
      key: 'email-is-the-pass',
      category: 'Passes',
      title: 'The email is the pass — the website is the backup',
      detail:
        'Most families never opened the site at all; they scanned the QR straight out of their inbox. Effort spent on the email — subject line, the code being large and near the top, resending cleanly — buys more than effort spent on the pass page.',
      evidence: `${num(inboxSeg.households)} families scanned from the inbox against ${num(openedSeg.households)} who opened the live pass.`,
    })
  }

  const noEmail = num(emailAddressRows[0]?.no_email)
  if (noEmail > 0) {
    push({
      key: 'collect-contacts',
      category: 'Passes',
      title: 'Collect a contact from every payer, especially Zelle',
      detail:
        'Anyone who pays without leaving an address cannot be sent anything — no pass, no reminder, no thank-you. Every one of them becomes a name search at a busy desk. Ask for a phone number at minimum when the money arrives.',
      evidence: `${noEmail} of ${noEmail + num(emailAddressRows[0]?.with_email)} families left no email address at all.`,
    })
  }

  const openedEffect = openedVsNotRows.map((r) => ({
    opened: r.opened,
    pct: num(r.sold) ? Math.round((num(r.came) / num(r.sold)) * 100) : 0,
  }))
  const withOpen = openedEffect.find((r) => r.opened)
  const withoutOpen = openedEffect.find((r) => !r.opened)
  if (withOpen && withoutOpen && Math.abs(withOpen.pct - withoutOpen.pct) <= 3) {
    push({
      key: 'opens-predict-nothing',
      category: 'Passes',
      title: 'Do not chase people who have not opened their pass',
      detail:
        'It looks like a useful signal and it is not. Families who never opened their pass turned up at the same rate as those who did, so a "you haven\'t opened yours" reminder would target the wrong people and annoy the right ones.',
      evidence: `${withOpen.pct}% turnout among families who opened their pass, ${withoutOpen.pct}% among those who never did.`,
    })
  }

  if (walkIns.length > 0) {
    push({
      key: 'walk-ups',
      category: 'Money',
      title: 'Budget for walk-ups, and staff a desk for them',
      detail:
        'People turn up on the day without having paid, and they are worth real money. Have a float, a card reader and someone whose only job is taking payment — the ten that came through last time all landed mid-service.',
      evidence: `${walkIns.length} families bought ${walkIns.reduce((s, w) => s + w.guests, 0)} admissions at the desk on the day, worth ${formatMoney(walkIns.reduce((s, w) => s + w.cents, 0))}.`,
    })
  }

  const merges = num(integrityRows[0]?.merges)
  if (merges > 0) {
    push({
      key: 'duplicates',
      category: 'Money',
      title: 'Expect the same family to pay twice, through two channels',
      detail:
        'Somebody Zelles, then their spouse buys online, and the ledger has two half-families that each look short. Reconcile before the passes go out, not at the door, or a guest is turned away holding a valid ticket for admissions the volunteer cannot see.',
      evidence: `${merges} duplicate households had to be merged.`,
    })
  }

  const handedBack = num(integrityRows[0]?.handed_back)
  if (handedBack > 0) {
    push({
      key: 'over-counting',
      category: 'The desk',
      title: 'Over-counting at the door is the common mistake',
      detail:
        'Almost every correction ran the same way — more admissions taken than people walked in. Have the volunteer say the number out loud to the family before confirming, and the give-back queue mostly disappears.',
      evidence: `${handedBack} admissions had to be restored after the fact.`,
    })
  }

  const sizeRanked = [...turnoutBySizeRows]
    .map((r) => ({
      band: r.band,
      pct: num(r.sold) ? Math.round((num(r.came) / num(r.sold)) * 100) : 0,
    }))
    .sort((a, b) => a.pct - b.pct)
  if (sizeRanked.length >= 2 && sizeRanked[sizeRanked.length - 1].pct - sizeRanked[0].pct >= 15) {
    push({
      key: 'turnout-by-size',
      category: 'Sadya',
      title: 'Discount the small bookings when you count heads',
      detail:
        'Single-seat bookings are much less reliable than family blocks — one person changing their plans cancels the whole row. Weight the catering estimate towards the larger parties.',
      evidence: `${sizeRanked[0].pct}% of admissions turned up among families who bought ${sizeRanked[0].band === '5+' ? '5 or more' : sizeRanked[0].band}, against ${sizeRanked[sizeRanked.length - 1].pct}% among those who bought ${sizeRanked[sizeRanked.length - 1].band === '5+' ? '5 or more' : sizeRanked[sizeRanked.length - 1].band}.`,
    })
  }

  if (admissionsSold > 0 && guestsWhoAte > 0) {
    const shortfall = Math.round(((admissionsSold - guestsWhoAte) / admissionsSold) * 100)
    if (shortfall >= 3) {
      push({
        key: 'cook-for',
        category: 'Sadya',
        title: `Order for about ${100 - shortfall}% of what you sell`,
        detail:
          'Not everyone who buys a seat eats one. Ordering against the number sold pays for meals nobody collects; this is the gap to plan against, and it should hold as long as the crowd does.',
        evidence: `${admissionsSold} admissions sold, ${guestsWhoAte} guests accounted for — a ${100 - shortfall}% turnout.`,
      })
    }
  }

  if (splitRows[0] && num(splitRows[0].n) > 0) {
    push({
      key: 'split-parties',
      category: 'The desk',
      title: 'Families arrive in pieces — the shared pass is doing its job',
      detail:
        'One QR carrying several admissions gets screenshotted and passed around, and parts of a family turn up separately. That is the design working, not a problem, but it means a pass showing "3 remaining" is normal and volunteers should not challenge it.',
      evidence: `${num(splitRows[0].n)} families were scanned in more than one group.`,
    })
  }

  const slice = (rows: SliceRow[], labels: Record<string, string>): Slice[] =>
    rows.map((r) => ({
      key: r.key,
      label: labels[r.key] ?? r.key,
      households: num(r.households),
      guests: num(r.guests),
      cents: num(r.cents),
      checkedIn: num(r.checked_in),
    }))

  return {
    generatedAt: new Date().toISOString(),
    eventDay,

    headline: {
      guestsWhoAte,
      scannedIn,
      markedPresent,
      admissionsSold,
      households: realHouseholds,
      moneyCents: totalCents,
      childrenUnder6: num(t.under6),
      stillUnaccounted,
      turnoutPercent: admissionsSold ? Math.round((guestsWhoAte / admissionsSold) * 100) : 0,
    },

    service: {
      firstScan,
      lastScan,
      durationMinutes,
      hourly,
      fine,
      peakHour: peakHourRow ? { label: peakHourRow.label, guests: peakHourRow.guests } : null,
      peakFifteen: peakFifteenRow
        ? { label: clockLabel(peakFifteenRow.at), guests: peakFifteenGuests }
        : null,
      peakFive: peakFiveRow ? { label: peakFiveRow.label, guests: peakFiveRow.guests } : null,
      peakGuestsPerHour,
      longestLull,
      averagePartySize: num(shape?.avg_party),
      largestParty: num(shape?.max_party),
      medianSecondsBetweenScans: Math.round(num(gapRows[0]?.median)),
      longestQuietMinutes: Math.round(num(gapRows[0]?.longest) / 60),
      splitParties: num(splitRows[0]?.n),
      seatings,
      busiestLanePressure: Math.round(peakFifteenGuests / LANES),
    },

    money: {
      totalCents,
      byMethod: slice(methodRows, METHOD_LABELS),
      averagePerAdmissionCents: admissionsSold ? Math.round(totalCents / admissionsSold) : 0,
      averagePerHouseholdCents: realHouseholds ? Math.round(totalCents / realHouseholds) : 0,
      walkInCents: walkIns.reduce((s, w) => s + w.cents, 0),
      walkInAdmissions: walkIns.reduce((s, w) => s + w.guests, 0),
      donationCents: num(paidOrders?.donation) + num(pendingOrders?.donation),
      sponsorGold: num(paidOrders?.gold),
      sponsorSilver: num(paidOrders?.silver),
      abandonedCheckouts: num(pendingOrders?.n),
    },

    registration: {
      bySource: slice(sourceRows, SOURCE_LABELS),
      byStatus: slice(statusRows, STATUS_LABELS),
      householdSizes: sizeRows.map((r) => ({
        size: num(r.size),
        households: num(r.households),
        guests: num(r.guests),
      })),
      intake: intakeRows.map((r) => ({
        day: r.day,
        label: dayLabel(r.day),
        households: num(r.households),
        guests: num(r.guests),
      })),
      largestHousehold: largestRows[0]
        ? { name: largestRows[0].name, guests: num(largestRows[0].guests) }
        : null,
      walkIns,
    },

    passes: {
      passEmailsSent: emailsFor('pass', 'sent'),
      reminderEmailsSent: emailsFor('reminder', 'sent'),
      emailsFailed,
      householdsOpenedPass,
      passOpens: num(openRows[0]?.opens),
      openRatePercent: realHouseholds
        ? Math.round((householdsOpenedPass / realHouseholds) * 100)
        : 0,
      opensByDay: openDayRows.map((r) => ({
        day: r.day,
        label: dayLabel(r.day),
        opens: num(r.opens),
      })),
    },

    thankyou: {
      sent: thankyouSent,
      failed: emailsFor('thankyou', 'failed'),
      households: thankyouHouseholds,
      clicks: thankyouClicks,
      clickRatePercent: thankyouSent
        ? Math.round((thankyouHouseholds / thankyouSent) * 100)
        : 0,
      // The '*' row is the cross-link total and is reported above as `clicks`
      // and `households`; it is not one of the links.
      byTarget: clickRows
        .filter((r) => r.target !== '*')
        .map((r) => ({
          target: r.target,
          label: LINK_TARGET_LABELS[r.target] ?? r.target,
          clicks: num(r.clicks),
          households: num(r.households),
        })),
      botClicks,
    },

    integrity: {
      scans: num(integrity?.scans),
      reversedScans: num(integrity?.reversed),
      admissionsHandedBack: num(integrity?.handed_back),
      duplicateHouseholdsMerged: num(integrity?.merges),
      reviewsOpened: reviewRows.reduce((s, r) => s + num(r.n), 0),
      reviewsResolved: reviewsFor('resolved') + reviewsFor('dismissed'),
      reviewsStillOpen: reviewsFor('open'),
      sheetSyncs: num(integrity?.sheet_syncs),
      squareEvents: num(integrity?.square_events),
      stripeEvents: num(integrity?.stripe_events),
      testHouseholds: num(t.tests),
      devices: deviceRows.map((r) => ({
        key: r.key,
        label: r.key,
        count: num(r.guests),
        detail: `${num(r.n)} scans`,
      })),
      staffSignIns: num(integrity?.sign_ins),
    },

    raffle: raffleRows.map((r) => ({
      name: r.name,
      prize: r.prize,
      entries: num(r.entries),
      at: iso(r.at) ?? '',
    })),

    noShows: noShowRows.map((r) => ({
      id: r.id,
      name: r.name,
      purchased: num(r.purchased),
      scannedIn: num(r.scanned),
      missing: num(r.missing),
      method: r.method,
      source: r.source,
      markedPresent: num(r.marked),
      markedNote: r.note,
    })),

    logCategories: logRows.map((r) => ({
      key: r.category,
      label: r.category,
      count: num(r.n),
    })),
    logTotal: logRows.reduce((s, r) => s + num(r.n), 0),
    logFirstPage,

    program,
    demand,
    tips,

    insights: {
      turnoutBySize: turnoutBySizeRows.map((r) =>
        insightRow(r, r.band === '5+' ? '5 or more' : `${r.band} admissions`),
      ),

      passOpenedEffect: openedVsNotRows.map((r) =>
        insightRow(r, r.opened ? 'Opened their pass beforehand' : 'Never opened their pass'),
      ),

      arrivalByChannel: arrivalByChannelRows.map((r) => ({
        key: r.key,
        label: SOURCE_LABELS[r.key] ?? r.key,
        firstAt: laMinutes(r.first_at) === null ? null : clockFromMinutes(laMinutes(r.first_at)!),
        // percentile_cont over epoch-seconds of the local timestamp: divide
        // back down to minutes-of-day.
        medianAt: r.median_min ? clockFromMinutes((Number(r.median_min) / 60) % 1440) : null,
        lastAt: laMinutes(r.last_at) === null ? null : clockFromMinutes(laMinutes(r.last_at)!),
        guests: num(r.guests),
      })),

      partyByPhase: (['early', 'middle', 'late'] as const)
        .map((phase) => {
          const r = partyByPhaseRows.find((x) => x.phase === phase)
          return {
            phase,
            label:
              phase === 'early'
                ? 'First third of service'
                : phase === 'middle'
                  ? 'Middle third'
                  : 'Last third',
            scans: num(r?.scans),
            guests: num(r?.guests),
            averageParty: num(r?.avg_party),
          }
        })
        .filter((r) => r.scans > 0),

      quartiles: quartileRows.map((r) => ({
        percent: num(r.q),
        at: iso(r.at) ?? '',
        label: laMinutes(r.at) === null ? '—' : clockFromMinutes(laMinutes(r.at)!),
      })),

      leadTime: leadTimeRows
        .map((r) => ({
          key: r.band,
          label: r.band,
          households: num(r.households),
          guests: num(r.guests),
        }))
        .sort((a, b) => LEAD_TIME_ORDER.indexOf(a.key) - LEAD_TIME_ORDER.indexOf(b.key)),

      deviceOverTime: [...new Set(deviceOverTimeRows.map((r) => r.device))].map((device) => ({
        device,
        hours: deviceOverTimeRows
          .filter((r) => r.device === device)
          .map((r) => ({ label: hourLabel(r.at), guests: num(r.guests) })),
      })),
    },

    passBehaviour: {
      segments: segmentRows
        .filter((r) => num(r.households) > 0)
        .map((r) => ({
          key: r.segment,
          label: SEGMENT_LABELS[r.segment]?.label ?? r.segment,
          detail: SEGMENT_LABELS[r.segment]?.detail ?? '',
          households: num(r.households),
          sold: num(r.sold),
          came: num(r.came),
        })),

      timeToOpen: timeToOpenRows
        .map((r) => ({ band: r.band, label: r.band, households: num(r.households) }))
        .sort((a, b) => TIME_TO_OPEN_ORDER.indexOf(a.band) - TIME_TO_OPEN_ORDER.indexOf(b.band)),

      medianMinutesToOpen: openSpeedRows[0]?.median ? Math.round(num(openSpeedRows[0].median)) : null,
      fastestMinutesToOpen: openSpeedRows[0]?.fastest
        ? Math.round(num(openSpeedRows[0].fastest))
        : null,
      householdsWhoOpened: num(openSpeedRows[0]?.n),

      opensPerHousehold: opensPerRows.map((r) => ({
        opens: num(r.opens),
        households: num(r.households),
      })),

      openVsArrival: (['at_the_door', 'same_afternoon', 'well_before', 'after_admitted'] as const)
        .map((band) => ({
          band,
          label: OPEN_TIMING_LABELS[band],
          opens: num(openVsArrivalRows.find((r) => r.band === band)?.opens),
        }))
        .filter((r) => r.opens > 0),

      householdsWithoutEmail: num(emailAddressRows[0]?.no_email),
      householdsWithEmail: num(emailAddressRows[0]?.with_email),
    },
  }
}
