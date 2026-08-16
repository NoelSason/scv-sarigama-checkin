/**
 * The Ponnonam 2026 run sheet.
 *
 * Content, not data: it lived in a spreadsheet, it changed several times in the
 * week before the event, and it is read by both the server and the browser. It
 * is checked in here so a change to the running order goes through the same
 * review as a change to the code, and so the analytics page has something to
 * compare the actual clock against.
 *
 * `at` is local wall-clock on the day of the event, 24-hour. Each item runs
 * until the next one starts; the last carries an explicit `until`.
 */

export type ProgramPhase = 'setup' | 'sadya' | 'program'

export type ProgramItem = {
  /** Stable id. Marks in `program_marks` are keyed on this — never renumber. */
  key: string
  /** Position on the printed run sheet, where it had one. */
  number?: number
  at: string
  /** Only on the final item, which has nothing after it to bound its length. */
  until?: string
  title: string
  who?: string
  phase: ProgramPhase
  /**
   * Filled from the check-in scanner rather than from a person tapping a
   * button — the first and last scan are a better record of when the Sadya
   * actually opened and closed than anyone's recollection.
   */
  derivedFrom?: 'firstScan' | 'lastScan'
}

export const PROGRAM: ProgramItem[] = [
  // ---------------------------------------------------------------- setup
  { key: 'mpr-opens', at: '08:00', title: 'MPR opens', who: 'BOT', phase: 'setup' },
  { key: 'pookkalam-setup', at: '08:15', title: 'Pookkalam and photo booth set up', who: 'Pookkalam Committee', phase: 'setup' },
  { key: 'stage-setup', at: '08:30', title: 'Stage and banner set up', who: 'Stage Committee', phase: 'setup' },
  { key: 'audio-setup', at: '08:30', title: 'Audio set up', who: 'Ramesh, Gautam, Venue Committee', phase: 'setup' },
  { key: 'tables-setup', at: '10:00', title: 'Dining tables and floor protection', who: 'Sadya + Venue Committee', phase: 'setup' },
  { key: 'leaf-setup', at: '11:15', title: 'Sadya leaf set up', who: 'Sadya Committee', phase: 'setup' },

  // ---------------------------------------------------------------- sadya
  { key: 'sadya-begins', at: '11:30', title: 'Sadya begins', who: 'Sadya Committee', phase: 'sadya', derivedFrom: 'firstScan' },
  { key: 'sadya-ends', at: '13:55', title: 'Sadya ends', who: 'Sadya + Venue Committee', phase: 'sadya', derivedFrom: 'lastScan' },

  // -------------------------------------------------------------- program
  { key: 'p01', number: 1, at: '13:55', title: 'Call to order', who: 'Abhilash or Jubil', phase: 'program' },
  { key: 'p02', number: 2, at: '13:58', title: 'Programme introduction, introducing the emcees', who: 'Deepthi Krishna', phase: 'program' },
  { key: 'p03', number: 3, at: '14:00', title: 'Emcees take the stage', who: 'Mridula & Suja', phase: 'program' },
  { key: 'p04', number: 4, at: '14:02', title: 'Welcoming Mahabali', who: 'Chendamelam team, Pulees, Hunter, Maveli', phase: 'program' },
  { key: 'p05', number: 5, at: '14:20', title: 'Thiruvathira', who: 'Lizzy, Parvathi, Pakhiyalakshmi, Mridula, Ivana, Gouri, Saira, Manasi', phase: 'program' },
  { key: 'p06', number: 6, at: '14:30', title: 'Onam message', who: 'Jubil Sason', phase: 'program' },
  { key: 'p07', number: 7, at: '14:35', title: 'Recognising the sponsors', who: 'Loans By Riju, Luxury Collective, Tharavadi Foods, Royal Tandoor, Malabar Gold, Aspirer Van Rentals', phase: 'program' },
  { key: 'p08', number: 8, at: '14:45', title: 'Onam Pallavies group songs', who: 'Arunima, Abhilash, Anju, Gautam, Ramesh, Justin, Priya, Kavitha, Nishi', phase: 'program' },
  { key: 'p09', number: 9, at: '14:55', title: 'Group dance', who: 'Juliana, Ava, Kristine, Rebecca', phase: 'program' },
  { key: 'p10', number: 10, at: '15:00', title: 'Group song', who: 'Nithin Ramesh & Amirah Alex', phase: 'program' },
  { key: 'p11', number: 11, at: '15:05', title: 'Mohiniyattam fusion — Harivarasanam', who: 'Niya & Arohi', phase: 'program' },
  { key: 'p12', number: 12, at: '15:10', title: 'Whistling performance', who: 'Amrit Jathin', phase: 'program' },
  { key: 'p13', number: 13, at: '15:15', title: 'Independence Day dance', who: 'Ivana, Dhiya, Abigail, Amirah, Seira', phase: 'program' },
  { key: 'p14', number: 14, at: '15:25', title: 'Odissi — Dekho Go Ago Sakhi', who: 'Prasanna Karthik', phase: 'program' },
  { key: 'p15', number: 15, at: '15:30', title: 'Song', who: 'Pranav Sreekanth & Nithin Ramesh', phase: 'program' },
  { key: 'p16', number: 16, at: '15:35', title: 'Semi-classical & cinematic fusion', who: 'Anjana Mohan & Neethu John', phase: 'program' },
  { key: 'p17', number: 17, at: '15:45', title: 'Light music — Sreeragamo', who: 'Pranav Nair', phase: 'program' },
  { key: 'p18', number: 18, at: '15:50', title: 'Classical dance — Endaro Mahaanubhaavulu', who: 'Aadhira, Aryaahi, Samanvi', phase: 'program' },
  { key: 'p19', number: 19, at: '15:55', title: 'Cinematic group dance', who: 'Arunima Prasad & Priya Justin', phase: 'program' },
  { key: 'p20', number: 20, at: '16:00', title: 'Pookkalam design winners', who: 'Prizes by Geethi Praveen & Jomina John', phase: 'program' },
  { key: 'p21', number: 21, at: '16:05', title: 'Dance + skit', who: 'Deepu, Shaibu, Sagar, Justin, Alex, Abhi', phase: 'program' },
  { key: 'p22', number: 22, at: '16:15', title: 'Semi-classical dance — Shiva medley', who: 'Parvathi & Kavitha', phase: 'program' },
  { key: 'p23', number: 23, at: '16:20', title: 'Rhythms & Ragas of Onam — instrumental', who: 'Justin & Josh', phase: 'program' },
  { key: 'p24', number: 24, at: '16:25', title: 'Group dance', who: 'Aedan Arun, Reuben Alex, Rohaan Alex', phase: 'program' },
  { key: 'p25', number: 25, at: '16:35', title: 'Solo dance', who: 'Pooja Sadasivam', phase: 'program' },
  { key: 'p26', at: '16:40', title: 'Kids art exhibit — appreciation', who: 'Avantika Jangeesh', phase: 'program' },
  { key: 'p27', number: 26, at: '16:45', title: 'The Pillars of Sarigama — Board of Trustees', who: '17 trustees', phase: 'program' },
  { key: 'p28', number: 27, at: '16:55', title: 'Jana Gana Mana', phase: 'program' },
  { key: 'p29', number: 28, at: '17:00', until: '17:05', title: 'Vote of thanks', who: 'Abhilash', phase: 'program' },
]

/** '15:35' → minutes since midnight. */
export function planMinutes(at: string): number {
  const [h, m] = at.split(':').map(Number)
  return h * 60 + m
}

/** Planned length in minutes: until the next item starts. */
export function plannedDuration(index: number): number {
  const item = PROGRAM[index]
  if (item.until) return planMinutes(item.until) - planMinutes(item.at)
  const next = PROGRAM[index + 1]
  if (!next) return 5
  return Math.max(0, planMinutes(next.at) - planMinutes(item.at))
}

/** 'H:MM AM' from minutes since midnight, rolling past midnight if it has to. */
export function clockFromMinutes(total: number): string {
  const wrapped = ((Math.round(total) % 1440) + 1440) % 1440
  const h24 = Math.floor(wrapped / 60)
  const m = wrapped % 60
  const suffix = h24 >= 12 ? 'PM' : 'AM'
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h}:${String(m).padStart(2, '0')} ${suffix}`
}

/** "1h 40m late", "on time", "12m early" — drift as a sentence fragment. */
export function driftWords(minutes: number): string {
  const n = Math.round(minutes)
  if (n === 0) return 'exactly on time'
  const size = Math.abs(n)
  const h = Math.floor(size / 60)
  const m = size % 60
  const span = h > 0 ? `${h}h ${m}m` : `${m}m`
  return n > 0 ? `${span} behind` : `${span} ahead`
}
