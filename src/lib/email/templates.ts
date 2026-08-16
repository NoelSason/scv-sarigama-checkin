import type { Household } from '@/lib/households'

/**
 * The pass email — "Sarigama Express" ticketing.
 *
 * Type-only import above is deliberate: this module must stay free of runtime
 * dependencies so the CLI preview script can render it outside Next. The QR is
 * therefore *referenced* here and *generated* by the caller, which hands back a
 * content id — this file never imports the qrcode encoder.
 *
 * Layout rules, all forced by Gmail and Apple Mail:
 *   - tables, not flex or grid
 *   - inline styles only; Gmail strips <style> in many clients
 *   - the only image is an embedded (cid:) attachment, so nothing depends on
 *     "load remote content" and there is no tracking-pixel smell
 *   - the button is a padded table cell, not a styled <a> (Outlook ignores
 *     padding on inline elements)
 *   - every cell states its own background-color; dark-mode clients that
 *     invert unpainted cells otherwise punch holes through the ticket
 */

export const PASS_EMAIL_SUBJECT = 'Sarigama Express Ticketing — your Onam Sadhya pass 🎟️'

/** The week-of mailing: same pass, plus the details people ask for on the day. */
export const REMINDER_EMAIL_SUBJECT = 'Onam Sadhya — final details and your pass 🌼'

/** The after-the-event mailing: thanks, and the recording of the programmes. */
export const THANKYOU_EMAIL_SUBJECT =
  'Thank you for celebrating Onam with us — the full program video is up'

/**
 * Which mailing is being rendered.
 *
 *   pass     — "your payment arrived, here is your ticket"
 *   reminder — "it is tomorrow, here is where to go, and your ticket again"
 *
 * One template rather than two. The ticket, the QR and the skip-the-line rule
 * are identical in both, and a second copy of that markup would drift the first
 * time one of them changed.
 */
export type PassEmailVariant = 'pass' | 'reminder'

export type PassEmailHousehold = Pick<Household, 'display_name' | 'tickets_purchased'>

export type RenderedEmail = { subject: string; html: string; text: string }

/** Printed on the stub. A blank value drops the line rather than printing a guess. */
export type EventDetails = {
  dateLine: string | null
  venue: string | null
  /** Street address, for a phone's map app. */
  address: string | null
  /** When doors open / when the Sadhya is served. */
  timing: string | null
  /** Where to park, and anything to avoid. */
  parking: string | null
  /** Anything else that must be said once: entrances, accessibility, contacts. */
  notes: string | null
}

export type PassEmailOptions = {
  variant?: PassEmailVariant
  /**
   * A short line shown above everything else — an apology, a correction, a
   * "this replaces the earlier one". Sits at the top because a reader who has
   * already had two of these will not scroll to find out why.
   */
  notice?: string | null
  event?: EventDetails
  /**
   * Content id of the embedded QR image. Omitted, the QR panel is replaced by
   * the link — an email with a broken image where the ticket should be is worse
   * than one that never promised a ticket.
   */
  qrCid?: string | null
}

export function eventDetails(): EventDetails {
  return {
    dateLine: process.env.EVENT_DATE_LINE?.trim() || null,
    venue: process.env.EVENT_VENUE?.trim() || null,
    address: process.env.EVENT_ADDRESS?.trim() || null,
    timing: process.env.EVENT_TIMING?.trim() || null,
    parking: process.env.EVENT_PARKING?.trim() || null,
    notes: process.env.EVENT_NOTES?.trim() || null,
  }
}

/** "Kavitha Raveendra Raja" → "Kavitha". Falls back to the whole name. */
export function firstName(displayName: string): string {
  const first = displayName.trim().split(/[\s,]+/)[0]
  return first && first.length > 1 ? first : displayName.trim()
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function admissionsPhrase(count: number): string {
  return count === 1 ? '1 Sadhya admission' : `${count} Sadhya admissions`
}

/**
 * Stated unconditionally. children_under_6 is carried by the schema but no
 * import populates it — neither Square nor the payments sheet asks — so a
 * count-specific sentence would be a number we invented. Everyone gets the
 * rule instead, and it is true for everyone.
 */
const UNDER_6_NOTE =
  'If you have little ones under 6, they eat free — they need no admission and nothing extra to show at the door.'

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

/**
 * The display face is Georgia here, not Playfair. Webfonts are stripped or
 * ignored across Gmail, Outlook and Apple Mail, so the closest thing to a
 * high-contrast serif that is genuinely everywhere is the right call.
 */
const SERIF = "Georgia, 'Times New Roman', serif"

const CREAM = '#FBF6EA'
const CARD = '#FFFDF6'
/** The ticket sits on the card, so it needs its own tint to read as an object. */
const TICKET = '#FFF8E7'
const GREEN = '#124a33'
const GREEN_MID = '#1c6b4a'
const GOLD = '#C8951C'
const GOLD_LIGHT = '#E8B84B'
const GOLD_DEEP = '#8a6410'
const INK = '#241f14'

/**
 * The kasavu band. `background-color` first so clients that drop
 * background-image — Outlook, parts of Gmail — still show a solid gold bar
 * rather than a white gap where the border should be.
 */
const KASAVU =
  `background-color:${GOLD};background-image:repeating-linear-gradient(90deg, ${GOLD} 0 14px, ${GOLD_LIGHT} 14px 22px, ${GOLD_DEEP} 22px 26px);`

/** One label/value line on the ticket stub. */
function stubRow(label: string, value: string, last = false): string {
  const rule = last ? '' : 'border-bottom:1px solid #eddfbc;'
  return `<tr>
    <td style="padding:0 22px;background-color:${TICKET};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
        <tr>
          <td width="82" valign="top" style="padding:10px 0;font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${GOLD_DEEP};${rule}">${escapeHtml(label)}</td>
          <td valign="top" align="right" style="padding:10px 0;font-family:${FONT};font-size:14px;font-weight:600;color:${INK};${rule}">${escapeHtml(value)}</td>
        </tr>
      </table>
    </td>
  </tr>`
}

/**
 * The QR panel. Pure black on pure white with its quiet zone untouched — the
 * gold frame stops at the panel edge and never intrudes on the code.
 *
 * The alt text carries the instruction, so a client with images disabled still
 * renders a sentence that tells the guest what to do instead of a broken box.
 */
function qrPanel(qrCid: string): string {
  return `<tr>
    <td align="center" style="padding:4px 22px 0 22px;background-color:${TICKET};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border:1px solid #e2cf95;border-radius:14px;">
        <tr>
          <td align="center" style="padding:14px;background-color:#ffffff;border-radius:14px;">
            <img src="cid:${escapeHtml(qrCid)}" width="216" height="216" alt="Your Sadhya pass QR code — show this at the entrance, or open the link below." style="display:block;width:216px;height:216px;border:0;outline:none;text-decoration:none;image-rendering:pixelated;" />
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:10px 22px 0 22px;background-color:${TICKET};font-family:${FONT};font-size:13px;line-height:1.5;color:#6f6a58;">
      Show this code at the Sadhya entrance &middot; screenshot-friendly
    </td>
  </tr>`
}

/** One "WHEN / WHERE / PARKING" line. Absent values drop out entirely. */
function detailRow(label: string, value: string, last = false): string {
  const rule = last ? '' : 'border-bottom:1px solid #d7e7dd;'
  return `<tr>
    <td width="74" valign="top" style="padding:9px 0;font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${GREEN_MID};${rule}">${escapeHtml(label)}</td>
    <td valign="top" style="padding:9px 0 9px 12px;font-family:${FONT};font-size:15px;line-height:1.5;color:${INK};${rule}">${escapeHtml(value)}</td>
  </tr>`
}

/**
 * The final-details panel, shown only on the reminder.
 *
 * Every line is optional and a blank one is omitted rather than printed empty —
 * an address line reading "Where:" with nothing after it is worse than no
 * address line, because a guest cannot tell whether it is missing or wrong.
 */
function eventPanel(event: EventDetails): string {
  const rows = [
    event.dateLine ? detailRow('When', event.dateLine) : '',
    event.timing ? detailRow('Time', event.timing) : '',
    event.venue ? detailRow('Where', event.venue) : '',
    event.address ? detailRow('Address', event.address) : '',
    event.parking ? detailRow('Parking', event.parking, true) : '',
  ].filter(Boolean)
  if (rows.length === 0 && !event.notes) return ''

  // Close the border on whichever row ended up last.
  const body = rows.join('').replace(/border-bottom:1px solid #d7e7dd;(?![\s\S]*border-bottom:1px solid #d7e7dd;)/g, '')

  return `<tr>
    <td style="padding:22px 30px 0 30px;background-color:${CARD};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#EAF5EE;border:1px solid #b9dcc7;border-radius:14px;">
        <tr>
          <td style="padding:16px 20px;background-color:#EAF5EE;border-radius:14px;">
            <div style="font-family:${FONT};font-size:11px;font-weight:800;letter-spacing:2.2px;text-transform:uppercase;color:${GREEN_MID};padding-bottom:8px;">&#127800; Final details</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">${body}</table>
            ${
              event.notes
                ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#FFF1D6;border:1px solid ${GOLD};border-radius:11px;margin-top:14px;">
                     <tr>
                       <td style="padding:13px 16px;background-color:#FFF1D6;border-radius:11px;font-family:${FONT};font-size:15px;line-height:1.55;font-weight:700;color:#7a4d05;">
                         &#9200; ${escapeHtml(event.notes)}
                       </td>
                     </tr>
                   </table>`
                : ''
            }
          </td>
        </tr>
      </table>
    </td>
  </tr>`
}

/**
 * Links carried by the thank-you mailing.
 *
 * Passed in rather than read from the environment here, so the caller can hand
 * each household its own tracked link. See `trackedLinkUrl`.
 *
 * `feedback` is optional and drops the whole block when absent, the same rule
 * the pass stub follows for the venue and the parking: an unset value removes
 * the section rather than printing a button that goes nowhere.
 */
export type ThankYouLinks = {
  video: string
  feedback?: string | null
}

/**
 * The after-the-event mailing: thanks, the volunteers, the programme video, and
 * the ask for feedback.
 *
 * Shares the pass email's shell — same kasavu bands, same card, same tables and
 * inline styles — because it lands in the same inbox a week later and should
 * read as being from the same people. What it deliberately does not share is
 * the ticket: there is nothing left to admit anyone to, and a QR on a thank-you
 * note only invites somebody to try scanning it.
 *
 * The feedback ask sits after the video rather than before it. The video is the
 * thing people opened the email for; asking for ten minutes of their opinion
 * before giving them what they came for is how a thank-you turns into a survey.
 */
export function renderThankYouEmail(
  household: PassEmailHousehold,
  links: ThankYouLinks,
): RenderedEmail {
  const name = firstName(household.display_name)
  const link = escapeHtml(links.video)
  const feedbackHref = links.feedback?.trim() || null
  const feedback = feedbackHref ? escapeHtml(feedbackHref) : null

  const text = [
    'SCV SARIGAMA — ONAM 2026',
    'ഓണാശംസകൾ',
    '',
    `Hi ${name},`,
    '',
    'Thank you for spending Onam with us. More than a hundred families came',
    'through the doors and over three hundred of us sat down to the sadhya',
    'together.',
    '',
    '--- TO OUR VOLUNTEERS ---',
    'None of it happens without you. Thank you to everyone who built and dressed',
    'the stage, put together the photobooth, ran the sound and the lights and',
    'every last cable, handled the food from start to finish, and served the',
    'sadhya leaf by leaf. You were there before the first guest arrived and still',
    'there after the last one left. The day belonged to you.',
    '',
    '--- THE PROGRAMS ---',
    'Watch all performances from this year on our YouTube channel. Consider',
    'subscribing while you are there — it is where every Sarigama performance',
    'ends up, and it is the easiest way to catch next year’s.',
    links.video,
    '',
    ...(feedbackHref
      ? [
          '--- TELL US HOW IT WENT ---',
          'We are already thinking about next year, and the people who were there',
          'are the only ones who can tell us what to change. It takes two minutes,',
          'and you can be as blunt as you like.',
          feedbackHref,
          '',
        ]
      : []),
    "Photos from the day are coming shortly — we'll share them in the WhatsApp",
    'group, so keep an eye out there.',
    '',
    'And if you have photos or video of your own, send them our way — we would',
    'love to add them.',
    '',
    'Onam is the one day we get to be a little closer to home. Thank you for',
    'making it feel that way.',
    '',
    'See you at the next one.',
    '',
    'SCV Sarigama · Onam 2026',
  ].join('\n')

  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${CREAM};margin:0;padding:0;">
  <tr>
    <td align="center" style="padding:28px 12px;background-color:${CREAM};">

      <!-- preheader: shown in the inbox list, hidden in the body -->
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;">The full recording of the programs is up &mdash; and photos are on their way.</div>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background-color:${CARD};border-radius:18px;border:1px solid #dfc98a;overflow:hidden;">

        <tr><td height="8" style="${KASAVU}line-height:8px;font-size:0;">&nbsp;</td></tr>

        <!-- masthead -->
        <tr>
          <td align="center" style="padding:30px 24px 6px 24px;background-color:${CARD};font-family:${FONT};">
            <div style="font-size:10px;font-weight:700;letter-spacing:3.4px;text-transform:uppercase;color:${GOLD_DEEP};">SCV Sarigama</div>
            <div style="font-family:${SERIF};font-size:36px;font-weight:700;line-height:1.15;color:${GREEN};padding-top:8px;">Thank You</div>
            <div style="font-size:15px;font-weight:700;color:#C05A12;padding-top:6px;">&#3384;&#3423;&#3390;&#3368;&#3405;&#3405;&#3396;&#3391;</div>
            <div style="padding-top:14px;font-size:13px;color:${GOLD_DEEP};letter-spacing:3px;">&#10047; &nbsp;&#10047; &nbsp;&#10047;</div>
          </td>
        </tr>

        <!-- letter -->
        <tr>
          <td style="padding:18px 30px 0 30px;background-color:${CARD};font-family:${FONT};font-size:17px;line-height:1.6;color:${INK};">
            <p style="margin:0 0 14px 0;">Hi ${escapeHtml(name)},</p>
            <p style="margin:0 0 14px 0;">Thank you for spending Onam with us. More than a hundred families came through the doors and over three hundred of us sat down to the sadhya together.</p>
          </td>
        </tr>

        <!-- volunteers -->
        <tr>
          <td style="padding:8px 30px 0 30px;background-color:${CARD};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#EAF5EE;border:1px solid #b9dcc7;border-radius:14px;">
              <tr>
                <td style="padding:18px 20px;font-family:${FONT};background-color:#EAF5EE;border-radius:14px;">
                  <div style="font-size:11px;font-weight:800;letter-spacing:2.2px;text-transform:uppercase;color:${GREEN_MID};padding-bottom:8px;">To our volunteers</div>
                  <div style="font-size:16px;line-height:1.65;color:${INK};">None of it happens without you. Thank you to everyone who built and dressed the stage, put together the photobooth, ran the sound and the lights and every last cable, handled the food from start to finish, and served the sadhya leaf by leaf. You were there before the first guest arrived and still there after the last one left. The day belonged to you.</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- the programme video -->
        <tr>
          <td style="padding:14px 30px 0 30px;background-color:${CARD};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#FFF1D6;border:1px solid ${GOLD};border-radius:14px;">
              <tr>
                <td style="padding:18px 20px;font-family:${FONT};background-color:#FFF1D6;border-radius:14px;">
                  <div style="font-size:11px;font-weight:800;letter-spacing:2.2px;text-transform:uppercase;color:${GOLD_DEEP};padding-bottom:6px;">The programs</div>
                  <div style="font-size:15px;line-height:1.6;color:${INK};padding-bottom:14px;">Watch all performances from this year on our YouTube channel. Consider subscribing while you&rsquo;re there &mdash; it&rsquo;s where every Sarigama performance ends up, and it&rsquo;s the easiest way to catch next year&rsquo;s.</div>
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" style="background-color:#C05A12;border-radius:10px;">
                        <a href="${link}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:700;color:${CARD};text-decoration:none;">Watch on YouTube</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        ${
          feedback
            ? `<!-- feedback -->
        <tr>
          <td style="padding:14px 30px 0 30px;background-color:${CARD};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${CREAM};border:1px solid #e4d3a4;border-radius:14px;">
              <tr>
                <td style="padding:18px 20px;font-family:${FONT};background-color:${CREAM};border-radius:14px;">
                  <div style="font-size:11px;font-weight:800;letter-spacing:2.2px;text-transform:uppercase;color:${GOLD_DEEP};padding-bottom:6px;">Tell us how it went</div>
                  <div style="font-size:15px;line-height:1.6;color:${INK};padding-bottom:14px;">We&rsquo;re already thinking about next year, and the people who were there are the only ones who can tell us what to change. It takes two minutes, and you can be as blunt as you like.</div>
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" style="background-color:${GREEN};border-radius:10px;">
                        <a href="${feedback}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:700;color:${CARD};text-decoration:none;">Share your feedback</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>`
            : ''
        }

        <!-- photos, and the sign-off -->
        <tr>
          <td style="padding:22px 30px 0 30px;background-color:${CARD};font-family:${FONT};font-size:17px;line-height:1.6;color:${INK};">
            <p style="margin:0 0 14px 0;">Photos from the day are coming shortly &mdash; we&rsquo;ll share them in the WhatsApp group, so keep an eye out there.</p>
            <p style="margin:0 0 14px 0;">And if you have photos or video of your own, send them our way &mdash; we&rsquo;d love to add them.</p>
            <p style="margin:0 0 14px 0;">Onam is the one day we get to be a little closer to home. Thank you for making it feel that way.</p>
            <p style="margin:0 0 4px 0;">See you at the next one.</p>
          </td>
        </tr>

        <!-- fallback links -->
        <tr>
          <td style="padding:22px 30px 14px 30px;background-color:${CARD};font-family:${FONT};font-size:13px;line-height:1.6;color:#7a7666;word-break:break-all;">
            If the buttons don&rsquo;t work, open ${feedback ? 'these links' : 'this link'}:<br />
            ${feedback ? 'Video: ' : ''}<a href="${link}" style="color:${GREEN_MID};">${link}</a>
            ${feedback ? `<br />Feedback: <a href="${feedback}" style="color:${GREEN_MID};">${feedback}</a>` : ''}
          </td>
        </tr>

        <!-- footer -->
        <tr>
          <td align="center" style="padding:6px 30px 26px 30px;background-color:${CARD};font-family:${FONT};font-size:12px;line-height:1.7;color:#9a9583;">
            <div style="font-size:13px;color:${GOLD_DEEP};letter-spacing:3px;padding-bottom:8px;">&#10047; &nbsp;&#10047; &nbsp;&#10047;</div>
            SCV Sarigama &middot; Onam 2026
          </td>
        </tr>

        <tr><td height="8" style="${KASAVU}line-height:8px;font-size:0;">&nbsp;</td></tr>
      </table>
    </td>
  </tr>
</table>`

  return { subject: THANKYOU_EMAIL_SUBJECT, html, text }
}

export function renderPassEmail(
  household: PassEmailHousehold,
  passHref: string,
  options: PassEmailOptions = {},
): RenderedEmail {
  const { event = eventDetails(), qrCid = null, variant = 'pass', notice = null } = options
  const isReminder = variant === 'reminder'

  const name = firstName(household.display_name)
  const admissions = admissionsPhrase(household.tickets_purchased)
  const count = household.tickets_purchased

  const detailLines = [
    event.dateLine ? `When:    ${event.dateLine}` : '',
    event.timing ? `Time:    ${event.timing}` : '',
    event.venue ? `Where:   ${event.venue}` : '',
    event.address ? `Address: ${event.address}` : '',
    event.parking ? `Parking: ${event.parking}` : '',
    event.notes ? `Note:    ${event.notes}` : '',
  ].filter(Boolean)

  const text = [
    'SARIGAMA EXPRESS TICKETING',
    'SCV Sarigama — Onam 2026',
    '',
    `Hi ${name},`,
    '',
    ...(notice ? [notice, ''] : []),
    isReminder
      // Not "again": this mailing now also goes to people buying in the last
      // days, for whom it is the first pass they have ever received.
      ? 'Onam is nearly here. Final details are below, and your pass is attached.'
      : 'Your Onam payment has been received, and your Sadhya pass is ready.',
    ...(isReminder && detailLines.length ? ['', '--- FINAL DETAILS ---', ...detailLines] : []),
    '',
    '*** SKIP THE CHECK-IN LINE ***',
    'Because you have this email, you are already checked in. Do not queue at',
    'the registration desk — walk straight to the Sadhya entrance and show the',
    'pass below.',
    '',
    '--- YOUR TICKET ---',
    `Guest:   ${household.display_name}`,
    `Admits:  ${admissions}`,
    ...(event.dateLine ? [`When:    ${event.dateLine}`] : []),
    ...(event.venue ? [`Where:   ${event.venue}`] : []),
    '',
    ...(qrCid
      ? [
          'Your QR code is attached to this email and shown in the message above.',
          'Open the link below if you would rather show it from the web page:',
        ]
      : ['Open your pass here and show the QR code at the entrance:']),
    passHref,
    '-------------------',
    '',
    'You can save, screenshot, or share this pass with your family.',
    '',
    'At the Sadhya entrance a volunteer will scan it and count only the',
    'admissions being used at that moment — so the rest of your party can',
    'arrive later on the same pass.',
    '',
    UNDER_6_NOTE,
    '',
    'ഓണാശംസകൾ — SCV Sarigama Onam 2026',
  ].join('\n')

  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${CREAM};margin:0;padding:0;">
  <tr>
    <td align="center" style="padding:28px 12px;background-color:${CREAM};">

      <!-- preheader: shown in the inbox list, hidden in the body -->
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;">${isReminder ? 'Final details inside — plus your pass, so you can skip the check-in line.' : 'You&rsquo;re already checked in — skip the line and walk straight to the Sadhya entrance.'}</div>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background-color:${CARD};border-radius:18px;border:1px solid #dfc98a;overflow:hidden;">

        <!-- kasavu band -->
        <tr><td height="8" style="${KASAVU}line-height:8px;font-size:0;">&nbsp;</td></tr>

        <!-- masthead -->
        <tr>
          <td align="center" style="padding:30px 24px 6px 24px;background-color:${CARD};font-family:${FONT};">
            <div style="font-size:10px;font-weight:700;letter-spacing:3.4px;text-transform:uppercase;color:${GOLD_DEEP};">Sarigama Express Ticketing</div>
            <div style="font-family:${SERIF};font-size:36px;font-weight:700;line-height:1.15;color:${GREEN};padding-top:8px;">Onam 2026</div>
            <div style="font-size:15px;font-weight:700;color:#C05A12;padding-top:6px;">ഓണാശംസകൾ</div>
            <div style="padding-top:14px;font-size:13px;color:${GOLD_DEEP};letter-spacing:3px;">&#10047; &nbsp;&#10047; &nbsp;&#10047;</div>
          </td>
        </tr>

        <!-- greeting -->
        <tr>
          <td style="padding:18px 30px 0 30px;background-color:${CARD};font-family:${FONT};font-size:17px;line-height:1.6;color:${INK};">
            <p style="margin:0 0 14px 0;">Hi ${escapeHtml(name)},</p>
            ${
              notice
                ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#FFF1D6;border:1px solid ${GOLD};border-radius:12px;margin:0 0 16px 0;">
                     <tr><td style="padding:13px 16px;background-color:#FFF1D6;border-radius:12px;font-family:${FONT};font-size:15px;line-height:1.55;color:#7a4d05;">${escapeHtml(notice)}</td></tr>
                   </table>`
                : ''
            }
            <p style="margin:0;">${
              isReminder
                ? 'Onam is nearly here. Final details are below, and your pass is included.'
                : 'Your Onam payment has been received, and your Sadhya pass is ready.'
            }</p>
          </td>
        </tr>

        ${isReminder ? eventPanel(event) : ''}

        <!-- ============ SKIP THE LINE ============ -->
        <tr>
          <td style="padding:22px 30px 0 30px;background-color:${CARD};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#EAF5EE;border:1px solid #b9dcc7;border-radius:14px;">
              <tr>
                <td style="padding:16px 20px;font-family:${FONT};background-color:#EAF5EE;border-radius:14px;">
                  <div style="font-size:11px;font-weight:800;letter-spacing:2.2px;text-transform:uppercase;color:${GREEN_MID};padding-bottom:6px;">&#9889; Skip the check-in line</div>
                  <div style="font-size:16px;line-height:1.6;color:${GREEN};font-weight:600;">If you got this email, you&rsquo;re already checked in. Don&rsquo;t queue at the registration desk &mdash; walk straight to the Sadhya entrance and show the code below.</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- ============ THE TICKET ============ -->
        <tr>
          <td style="padding:22px 30px 0 30px;background-color:${CARD};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${TICKET};border:1px solid #e2cf95;border-radius:16px;overflow:hidden;">

              <!-- ticket header bar -->
              <tr>
                <td bgcolor="${GREEN}" style="padding:12px 18px;background-color:${GREEN};">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
                    <tr>
                      <td align="left" style="font-family:${FONT};font-size:10px;font-weight:800;letter-spacing:2.4px;text-transform:uppercase;color:${GOLD_LIGHT};">Sadhya Admission Pass</td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- guest -->
              <tr>
                <td align="center" style="padding:20px 22px 14px 22px;background-color:${TICKET};font-family:${SERIF};font-size:24px;font-weight:700;line-height:1.25;color:${INK};word-break:break-word;">
                  ${escapeHtml(household.display_name)}
                </td>
              </tr>

              ${
                qrCid
                  ? qrPanel(qrCid)
                  : `<tr>
                <td align="center" style="padding:0 22px;background-color:${TICKET};font-family:${FONT};font-size:14px;line-height:1.6;color:#6f6a58;">
                  Open your pass with the button below to show your QR code at the entrance.
                </td>
              </tr>`
              }

              <!-- perforation -->
              <tr>
                <td style="padding:20px 22px 2px 22px;background-color:${TICKET};font-size:0;line-height:0;">
                  <div style="border-top:2px dashed #dcc79a;font-size:0;line-height:0;">&nbsp;</div>
                </td>
              </tr>

              <!-- admits -->
              <tr>
                <td align="center" style="padding:16px 22px 6px 22px;background-color:${TICKET};font-family:${FONT};">
                  <div style="font-size:10px;font-weight:700;letter-spacing:2.6px;text-transform:uppercase;color:${GOLD_DEEP};">Admits</div>
                  <div style="font-family:${SERIF};font-size:56px;line-height:1;font-weight:700;color:${GREEN_MID};padding:8px 0 6px 0;">${count}</div>
                  <div style="font-size:13px;font-weight:600;letter-spacing:0.4px;color:#6f6a58;padding-bottom:10px;">${count === 1 ? 'Sadhya admission' : 'Sadhya admissions'}</div>
                </td>
              </tr>

              <!-- stub detail rows -->
              ${event.dateLine ? stubRow('When', event.dateLine) : ''}
              ${event.venue ? stubRow('Where', event.venue) : ''}
              ${stubRow('Ticketing', 'Sarigama Express', true)}

              <!-- CTA -->
              <tr>
                <td align="center" style="padding:22px 22px 26px 22px;background-color:${TICKET};">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" bgcolor="${GREEN_MID}" style="border-radius:12px;border:1px solid ${GOLD_LIGHT};background-color:${GREEN_MID};">
                        <a href="${escapeHtml(passHref)}" style="display:block;padding:16px 38px;font-family:${FONT};font-size:17px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">Open my pass &rarr;</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

            </table>
          </td>
        </tr>

        <!-- how it works -->
        <tr>
          <td style="padding:24px 30px 0 30px;background-color:${CARD};font-family:${FONT};font-size:16px;line-height:1.65;color:#3a372c;">
            <p style="margin:0 0 14px 0;">You can save, screenshot, or share this pass with your family &mdash; everyone can use the same code.</p>
            <p style="margin:0;">At the Sadhya entrance a volunteer will scan it and count only the admissions being used at that moment &mdash; so the rest of your party can arrive later on the same pass.</p>
          </td>
        </tr>

        <!-- under 6 -->
        <tr>
          <td style="padding:20px 30px 0 30px;background-color:${CARD};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#FFF6DF;border:1px solid #ecd9a6;border-radius:12px;">
              <tr>
                <td style="padding:14px 18px;background-color:#FFF6DF;border-radius:12px;font-family:${FONT};font-size:15px;line-height:1.6;color:${GOLD_DEEP};">${UNDER_6_NOTE}</td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- fallback link -->
        <tr>
          <td style="padding:24px 30px 14px 30px;background-color:${CARD};font-family:${FONT};font-size:13px;line-height:1.6;color:#7a7666;word-break:break-all;">
            If the button doesn&rsquo;t work, open this link:<br />
            <a href="${escapeHtml(passHref)}" style="color:${GREEN_MID};">${escapeHtml(passHref)}</a>
          </td>
        </tr>

        <!-- footer -->
        <tr>
          <td align="center" style="padding:6px 30px 26px 30px;background-color:${CARD};font-family:${FONT};font-size:12px;line-height:1.7;color:#9a9583;">
            <div style="font-size:13px;color:${GOLD_DEEP};letter-spacing:3px;padding-bottom:8px;">&#10047; &nbsp;&#10047; &nbsp;&#10047;</div>
            SCV Sarigama &middot; Onam 2026<br />
            Sarigama Express Ticketing
          </td>
        </tr>

        <tr><td height="8" style="${KASAVU}line-height:8px;font-size:0;">&nbsp;</td></tr>
      </table>
    </td>
  </tr>
</table>`

  return {
    subject: isReminder ? REMINDER_EMAIL_SUBJECT : PASS_EMAIL_SUBJECT,
    html,
    text,
  }
}
