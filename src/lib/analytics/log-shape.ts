/**
 * The log's shape and page size, shared by the server that queries it and the
 * client that pages through it.
 *
 * Split out of `onam.ts` because that module is `server-only` and this value is
 * a runtime constant the browser genuinely needs — the "load 100 more" button
 * has to ask for the same page size the first render used, and duplicating the
 * number in two files is how the two quietly stop matching.
 */

export const LOG_PAGE = 100

/**
 * One row of `event_stream`, minus the columns this page does not publish.
 *
 * Deliberately narrow: what happened, who did it, and which family it
 * concerned. Nothing that would describe a guest beyond that.
 */
export type LogRow = {
  event_id: string
  occurred_at: string
  category: string
  action: string
  actor: string | null
  actor_type: string | null
  actor_role: string | null
  request_path: string | null
  household: string | null
  detail: string | null
}

/**
 * The same row with the columns the public page refuses to publish.
 *
 * Only ever produced behind a staff check. Kept as a separate type so a
 * component that renders `LogRow` cannot accidentally be handed one of these
 * and start printing addresses.
 */
export type AdminLogRow = LogRow & {
  ip: string | null
  location: string | null
  user_agent: string | null
  actor_email: string | null
}
