import type { Household } from '@/lib/households'

/**
 * The pass email.
 *
 * Type-only import above is deliberate: this module must stay free of runtime
 * dependencies so the CLI preview script can render it outside Next.
 *
 * Layout rules, all forced by Gmail and Apple Mail:
 *   - tables, not flex or grid
 *   - inline styles only; Gmail strips <style> in many clients
 *   - no external images, so nothing depends on "load remote content"
 *   - the button is a padded table cell, not a styled <a> (Outlook ignores
 *     padding on inline elements)
 */

export const PASS_EMAIL_SUBJECT = 'Your SCV Sarigama Onam Sadhya Pass 🌼'

export type PassEmailHousehold = Pick<
  Household,
  'display_name' | 'tickets_purchased' | 'children_under_6'
>

export type RenderedEmail = { subject: string; html: string; text: string }

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

function childrenPhrase(count: number): string | null {
  if (count < 1) return null
  return count === 1
    ? 'Your little one under 6 is our guest — they eat free, and need no admission.'
    : `Your ${count} little ones under 6 are our guests — they eat free, and need no admission.`
}

const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

/**
 * The display face is Georgia here, not Playfair. Webfonts are stripped or
 * ignored across Gmail, Outlook and Apple Mail, so the closest thing to a
 * high-contrast serif that is genuinely everywhere is the right call.
 */
const SERIF = "Georgia, 'Times New Roman', serif"

/**
 * The kasavu band. `background-color` first so clients that drop
 * background-image — Outlook, parts of Gmail — still show a solid gold bar
 * rather than a white gap where the border should be.
 */
const KASAVU =
  'background-color:#C8951C;background-image:repeating-linear-gradient(90deg, #C8951C 0 14px, #E8B84B 14px 22px, #8a6410 22px 26px);'

export function renderPassEmail(
  household: PassEmailHousehold,
  passHref: string,
): RenderedEmail {
  const name = firstName(household.display_name)
  const admissions = admissionsPhrase(household.tickets_purchased)
  const children = childrenPhrase(household.children_under_6)

  const text = [
    `Hi ${name},`,
    '',
    'Your Onam payment has been received.',
    '',
    `Your reservation includes ${admissions}.`,
    '',
    'View your pass:',
    passHref,
    '',
    'You can save, screenshot, or share this pass with your family.',
    '',
    'At the Sadhya entrance, a volunteer will scan it and count only the',
    'admissions being used at that moment.',
    ...(children ? ['', children] : []),
    '',
    'ഓണാശംസകൾ — SCV Sarigama Onam 2026',
  ].join('\n')

  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#FBF6EA;margin:0;padding:0;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;background-color:#FFFDF6;border-radius:16px;border:1px solid #dfc98a;">
        <tr>
          <td height="7" style="${KASAVU}line-height:7px;font-size:0;">&nbsp;</td>
        </tr>
        <tr>
          <td align="center" style="padding:26px 24px 4px 24px;font-family:${FONT};">
            <div style="font-size:12px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#8a6410;">SCV Sarigama</div>
            <div style="font-family:${SERIF};font-size:32px;font-weight:700;color:#124a33;padding-top:4px;">Onam 2026</div>
            <div style="font-size:15px;font-weight:700;color:#C05A12;padding-top:4px;">ഓണാശംസകൾ</div>
            <div style="padding-top:12px;font-size:13px;color:#8a6410;letter-spacing:2px;">✿ &nbsp;✿ &nbsp;✿</div>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 28px 0 28px;font-family:${FONT};font-size:17px;line-height:1.6;color:#241f14;">
            <p style="margin:0 0 16px 0;">Hi ${escapeHtml(name)},</p>
            <p style="margin:0 0 16px 0;">Your Onam payment has been received.</p>
            <p style="margin:0;">Your reservation includes <strong style="color:#124a33;">${escapeHtml(admissions)}</strong>.</p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:24px 28px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#1c6b4a" style="border-radius:12px;border:1px solid #E8B84B;">
                  <a href="${escapeHtml(passHref)}" style="display:block;padding:16px 34px;font-family:${FONT};font-size:17px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:12px;">View my pass</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 28px;font-family:${FONT};font-size:16px;line-height:1.6;color:#3a372c;">
            <p style="margin:0 0 14px 0;">You can save, screenshot, or share this pass with your family.</p>
            <p style="margin:0;">At the Sadhya entrance, a volunteer will scan it and count only the admissions being used at that moment.</p>
          </td>
        </tr>
        ${
          children
            ? `<tr>
          <td style="padding:20px 28px 0 28px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#FFF6DF;border:1px solid #ecd9a6;border-radius:12px;">
              <tr>
                <td style="padding:14px 18px;font-family:${FONT};font-size:15px;line-height:1.6;color:#8a6410;">${escapeHtml(children)}</td>
              </tr>
            </table>
          </td>
        </tr>`
            : ''
        }
        <tr>
          <td style="padding:22px 28px 12px 28px;font-family:${FONT};font-size:13px;line-height:1.6;color:#7a7666;word-break:break-all;">
            If the button doesn&rsquo;t work, open this link:<br />
            <a href="${escapeHtml(passHref)}" style="color:#1c6b4a;">${escapeHtml(passHref)}</a>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:8px 28px 24px 28px;font-family:${FONT};font-size:12px;color:#9a9583;">
            SCV Sarigama Onam 2026
          </td>
        </tr>
        <tr>
          <td height="7" style="${KASAVU}line-height:7px;font-size:0;">&nbsp;</td>
        </tr>
      </table>
    </td>
  </tr>
</table>`

  return { subject: PASS_EMAIL_SUBJECT, html, text }
}
