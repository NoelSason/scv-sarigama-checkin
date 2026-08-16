import { NextResponse } from 'next/server'
import { findByToken, logAuditThrottled } from '@/lib/households'
import { requestContext } from '@/lib/request-context'

export const dynamic = 'force-dynamic'

/**
 * Tracked links in the mailings: record who clicked, then get out of the way.
 *
 * Every link a guest can click in an email comes through here so the click can
 * be attributed to a household. The alternative — a tracking pixel — measures
 * mail-client behaviour rather than people: Apple Mail Privacy Protection
 * fetches images on delivery whether or not anyone looks, and Gmail proxies
 * them through its own cache, so both the count and the device behind it are
 * fiction. A click is somebody deciding to do something.
 *
 * Targets are named here rather than passed as a URL, so this can never be
 * turned into an open redirect that forwards to an attacker's page while
 * wearing our domain.
 */
const TARGETS: Record<string, () => string | undefined> = {
  /** The recording of the Onam programmes, linked from the thank-you mailing. */
  video: () => process.env.THANKYOU_VIDEO_URL?.trim(),
  /** The post-event feedback form, linked from the same mailing. */
  feedback: () => process.env.FEEDBACK_FORM_URL?.trim(),
}

/**
 * Where to send somebody whose link we cannot resolve.
 *
 * Never a dead end: an unknown target or an unconfigured URL means we got
 * something wrong, and the guest should still land somewhere that belongs to
 * the event rather than on an error page.
 */
function fallback(): string {
  return process.env.APP_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:3000'
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string; target: string }> },
) {
  const { token, target } = await params

  const destination = TARGETS[target]?.()
  if (!destination) {
    console.warn(`[track] no destination configured for target "${target}"`)
    return NextResponse.redirect(fallback(), 302)
  }

  // The click is recorded, but never at the cost of the click itself. A guest
  // who taps "Watch on YouTube" must reach YouTube whether or not the database
  // is reachable, so every failure here falls through to the redirect.
  try {
    const household = await findByToken(token)
    if (household) {
      const ctx = await requestContext()
      // Throttled per household, per address, per target. Mail apps and chat
      // clients fetch a link to build a preview and a guest may tap twice
      // waiting for the page; one row per person per link per five minutes is
      // the honest unit. Link-preview fetchers are still recorded — the user
      // agent is stored with the row, and the analytics separates them out the
      // same way it does for pass opens.
      await logAuditThrottled('link_clicked', `${household.id}:${ctx.ip ?? 'unknown'}:${target}`, 300, {
        actorType: 'guest',
        householdId: household.id,
        metadata: { target, guest: household.display_name },
      })
    }
  } catch (err) {
    console.error(`[track] failed to record click on "${target}":`, err)
  }

  // 302, not 301: a permanent redirect is cached by the browser and every later
  // click on the same link would skip this route entirely and go unrecorded.
  return NextResponse.redirect(destination, 302)
}
