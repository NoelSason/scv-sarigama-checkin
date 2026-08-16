/**
 * The shapes the analytics page is made of.
 *
 * Separate from `onam.ts` because that module is `server-only` — it holds a
 * database credential's worth of SQL — while these declarations are read by the
 * client components that render them. Types alone would erase at compile time,
 * but the seating constants are real runtime values the charts need, and one
 * module that both sides can import is clearer than a rule about which imports
 * happen to disappear.
 */

import type { LogRow } from './log-shape'
import type { ProgramPhase } from './program'

/** One run-sheet item, with the plan and what actually happened side by side. */
export type ProgramRow = {
  key: string
  number?: number
  title: string
  who?: string
  phase: ProgramPhase
  /** 'H:MM PM' as printed on the run sheet. */
  plannedAt: string
  plannedDuration: number
  /** 'H:MM PM' if somebody marked it, the scanner knows, or it can be inferred. */
  actualAt: string | null
  /**
   * Where `actualAt` came from, so a measurement is never mistaken for a guess:
   *
   *   scanner   — the first or last check-in scan. The hardest evidence here.
   *   marked    — somebody tapped it as it started.
   *   estimated — nobody marked it, but it sits between two items that were,
   *               so its time is interpolated across the gap.
   *   projected — after the last known start; planned time plus current drift.
   */
  source: 'scanner' | 'marked' | 'estimated' | 'projected' | null
  /** True when the time came off the check-in scanner, not a tap. */
  derived: boolean
  /** Positive is late. Only set where there is an actual time. */
  driftMinutes: number | null
  /** Where this item lands if the rest of the show runs to its planned length. */
  projectedAt: string | null
  status: 'done' | 'current' | 'upcoming'
}

export type ProgramState = {
  /** Server clock when this was read, so the page can say "as of". */
  now: string
  items: ProgramRow[]
  /** The last item with a known start — what the drift is measured at. */
  currentKey: string | null
  currentTitle: string | null
  /** Positive is behind. Measured at the last known start. */
  driftMinutes: number
  /** When the programme was actually called to order. */
  programStartedAt: string | null
  programPlannedAt: string
  /** Actual minutes elapsed ÷ planned minutes, over the programme so far. */
  paceRatio: number | null
  plannedEnd: string
  /** Finish if every remaining item takes exactly its planned length. */
  projectedEndAtPlannedPace: string | null
  /** Finish if the rest runs at the pace the show has actually been running. */
  projectedEndAtObservedPace: string | null
  minutesRemainingPlanned: number
  /**
   * Time lost (positive) or clawed back (negative) since the previously marked
   * item — the pace right now, not averaged over the whole show.
   */
  recentDriftChange: number | null
  recentSincePrevious: string | null
  /**
   * How much faster than the run sheet the rest has to move to still finish on
   * time. 1 means "planned length is enough"; 2 means "half the planned time".
   * Null once finishing on time is no longer arithmetically possible.
   */
  compressionToFinishOnTime: number | null
}

/**
 * A recommendation for next year, with the number that earns it.
 *
 * Computed rather than written down, for the same reason the chart captions
 * are: a tip that repeats a figure cannot drift away from it, and these figures
 * still move every time somebody marks a family present or ticks off a
 * run-sheet item. Anything that cannot cite a number does not belong here.
 */
export type Tip = {
  key: string
  category: 'Sadya' | 'Schedule' | 'Passes' | 'Money' | 'The desk'
  title: string
  /** What to do differently. */
  detail: string
  /** The measurement behind it. */
  evidence: string
}

export type Insight = {
  key: string
  label: string
  households: number
  sold: number
  came: number
  percent: number
}

export const LANES = 4
export const SEATS_PER_LANE = 20
export const SEATING_CAPACITY = LANES * SEATS_PER_LANE

export type Slice = {
  key: string
  label: string
  households: number
  /** Admissions bought under this key. */
  guests: number
  cents: number
  /** Admissions of those that were actually scanned in. */
  checkedIn: number
}
/**
 * How busy a slot was, relative to the busiest slot of the day.
 *
 * A tier rather than a raw ratio because the chart pairs colour with a written
 * word — "the rush", "quiet" — and colour is never the only signal.
 */
export type Tier = 'rush' | 'busy' | 'steady' | 'trickle' | 'quiet'

export type Bucket = {
  at: string
  label: string
  scans: number
  guests: number
  cumulative: number
  /** 0–1 against the busiest slot of the same resolution. */
  intensity: number
  tier: Tier
}
export type Histogram = { size: number; households: number; guests: number }
export type NamedCount = { key: string; label: string; count: number; detail?: string }

export type NoShow = {
  id: string
  name: string
  purchased: number
  scannedIn: number
  missing: number
  method: string | null
  source: string | null
  /** Admissions somebody has since marked as "they ate, we just missed them". */
  markedPresent: number
  markedNote: string | null
}

export type OnamAnalytics = {
  generatedAt: string
  /** The day the Sadhya was served, derived from where the arrivals are. */
  eventDay: string | null

  headline: {
    guestsWhoAte: number
    scannedIn: number
    markedPresent: number
    admissionsSold: number
    households: number
    moneyCents: number
    childrenUnder6: number
    stillUnaccounted: number
    turnoutPercent: number
  }

  service: {
    firstScan: string | null
    lastScan: string | null
    /** Minutes from first to last scan. */
    durationMinutes: number
    hourly: Bucket[]
    fine: Bucket[]
    peakHour: { label: string; guests: number } | null
    peakFifteen: { label: string; guests: number } | null
    peakFive: { label: string; guests: number } | null
    /** Sustained throughput at the peak, extrapolated to an hour. */
    peakGuestsPerHour: number
    /** The longest run of five-minute slots with nobody arriving. */
    longestLull: { from: string; to: string; minutes: number } | null
    averagePartySize: number
    largestParty: number
    medianSecondsBetweenScans: number
    longestQuietMinutes: number
    splitParties: number
    /** Clock time each notional seating of 80 filled up. */
    seatings: { seating: number; filledAt: string | null; guests: number; full: boolean }[]
    busiestLanePressure: number
  }

  money: {
    totalCents: number
    byMethod: Slice[]
    averagePerAdmissionCents: number
    averagePerHouseholdCents: number
    walkInCents: number
    walkInAdmissions: number
    /** Storefront orders that carried more than admissions. */
    donationCents: number
    sponsorGold: number
    sponsorSilver: number
    abandonedCheckouts: number
  }

  registration: {
    bySource: Slice[]
    byStatus: Slice[]
    householdSizes: Histogram[]
    intake: { day: string; label: string; households: number; guests: number }[]
    largestHousehold: { name: string; guests: number } | null
    walkIns: { name: string; at: string; guests: number; cents: number }[]
  }

  passes: {
    passEmailsSent: number
    reminderEmailsSent: number
    emailsFailed: number
    householdsOpenedPass: number
    passOpens: number
    openRatePercent: number
    /** When guests looked at their pass, by day. */
    opensByDay: { day: string; label: string; opens: number }[]
  }

  /**
   * The after-the-event thank-you, measured by clicks rather than opens.
   *
   * There is no open rate here on purpose. A tracking pixel would report Apple
   * Mail prefetching the image on delivery and Gmail fetching it through its
   * own cache as though both were people, and nothing in the response can tell
   * those apart afterwards. A click is a decision, so that is what is counted —
   * `households` is the honest "how many families engaged with this" number.
   */
  thankyou: {
    sent: number
    failed: number
    /** Distinct households that clicked any tracked link, bots excluded. */
    households: number
    /** Every recorded click, bots excluded. */
    clicks: number
    /** Clicking households as a share of those the mailing was sent to. */
    clickRatePercent: number
    /** Per link, so a mailing carrying more than one can be compared. */
    byTarget: { target: string; label: string; clicks: number; households: number }[]
    /** Link-preview fetchers, kept separate so they never read as guests. */
    botClicks: number
  }

  integrity: {
    scans: number
    reversedScans: number
    admissionsHandedBack: number
    duplicateHouseholdsMerged: number
    reviewsOpened: number
    reviewsResolved: number
    reviewsStillOpen: number
    sheetSyncs: number
    squareEvents: number
    stripeEvents: number
    testHouseholds: number
    devices: NamedCount[]
    scanLocations: NamedCount[]
    staffSignIns: number
  }

  /** Standing winners only. Re-spun (voided) draws are not results. */
  raffle: { name: string; prize: string; entries: number; at: string }[]

  /** The run sheet against the clock. */
  program: ProgramState

  insights: {
    /** Did big families no-show more than small ones? */
    turnoutBySize: Insight[]
    /** Did opening the pass beforehand predict turning up? */
    passOpenedEffect: Insight[]
    /** When each channel's guests actually arrived. */
    arrivalByChannel: {
      key: string
      label: string
      firstAt: string | null
      medianAt: string | null
      lastAt: string | null
      guests: number
    }[]
    /** Early, middle and late thirds of the service. */
    partyByPhase: { phase: string; label: string; scans: number; guests: number; averageParty: number }[]
    /** Clock time by which 25 / 50 / 75 / 90% of guests had arrived. */
    quartiles: { percent: number; at: string; label: string }[]
    /** How far ahead of the day each family committed. */
    leadTime: { key: string; label: string; households: number; guests: number }[]
    /** Guests admitted per device, per hour. */
    deviceOverTime: { device: string; hours: { label: string; guests: number }[] }[]
  }

  /**
   * How guests actually used the pass.
   *
   * The emailed QR and the pass page carry the same code, so scanning out of
   * the inbox and opening the site are genuinely different behaviours — and
   * the logs can tell them apart.
   */
  passBehaviour: {
    segments: { key: string; label: string; detail: string; households: number; sold: number; came: number }[]
    timeToOpen: { band: string; label: string; households: number }[]
    medianMinutesToOpen: number | null
    fastestMinutesToOpen: number | null
    householdsWhoOpened: number
    opensPerHousehold: { opens: number; households: number }[]
    devices: { key: string; label: string; opens: number; households: number }[]
    /** Link-preview fetchers, counted separately so they never read as guests. */
    botOpens: number
    openVsArrival: { band: string; label: string; opens: number }[]
    openLocations: { label: string; opens: number; households: number }[]
    householdsWithoutEmail: number
    householdsWithEmail: number
  }

  /**
   * The catering order against what actually turned up.
   *
   * The order was placed about a week out, against the headcount as it stood.
   * Late demand then moved the headcount a long way, which is the single most
   * expensive thing the day has to teach.
   */
  catering: {
    ordered: number
    sold: number
    ate: number
    /** Meals short against the people who actually ate. */
    shortAgainstAte: number
    /** Meals short against everything that was sold. */
    shortAgainstSold: number
    /** Admissions already on the books when the order went in. */
    knownAtOrder: number
    /** Admissions added after that. */
    lateDemand: number
    /** Of the late demand, how much landed on the event day itself. */
    lateOnTheDay: number
    /** Late demand as a share of what was known. */
    latePercent: number
    /** Running total by day, for the demand curve. */
    buildup: { day: string; label: string; added: number; running: number; baseline: boolean }[]
    /** The day the running total passed the order. Null if it never did. */
    crossedOn: string | null
  }

  /** What to do differently next year, each with the figure behind it. */
  tips: Tip[]

  noShows: NoShow[]
  logCategories: NamedCount[]
  logTotal: number
  /** First page of the log, server-rendered so the list is populated on arrival. */
  logFirstPage: LogRow[]
}
