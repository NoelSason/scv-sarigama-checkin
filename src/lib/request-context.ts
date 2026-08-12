import { headers } from 'next/headers'

/**
 * Who is calling, from where, on what.
 *
 * Read from the incoming request rather than passed down through every call
 * site: threading a context object through forty functions is exactly the sort
 * of change that gets half-done, and a security log with holes in it is worse
 * than no log, because the holes are invisible.
 *
 * Geo comes from Vercel's edge headers, attached before the request reaches the
 * function. Nothing is looked up from a third party, so no address or guest
 * detail leaves the request path.
 *
 * City-level accuracy at best, and a VPN will show its exit node. Good enough to
 * answer "was this scanned from the venue or from another state", which is the
 * question worth asking.
 */

export type RequestContext = {
  ip: string | null
  userAgent: string | null
  geoCity: string | null
  geoRegion: string | null
  geoCountry: string | null
  requestPath: string | null
}

export const EMPTY_CONTEXT: RequestContext = {
  ip: null,
  userAgent: null,
  geoCity: null,
  geoRegion: null,
  geoCountry: null,
  requestPath: null,
}

/** `x-forwarded-for` is a chain; the client is the first entry. */
function clientIp(get: (k: string) => string | null): string | null {
  const forwarded = get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return get('x-real-ip') ?? get('cf-connecting-ip') ?? null
}

function decode(value: string | null): string | null {
  if (!value) return null
  // Vercel percent-encodes city names with spaces or accents.
  try {
    return decodeURIComponent(value) || null
  } catch {
    return value
  }
}

/**
 * Never throws. Called from scripts and background jobs that have no request at
 * all, where the honest answer is "no context" — not a crash that loses the
 * event we were trying to record.
 */
export async function requestContext(): Promise<RequestContext> {
  try {
    const h = await headers()
    const get = (k: string) => h.get(k)
    return {
      ip: clientIp(get),
      userAgent: get('user-agent'),
      geoCity: decode(get('x-vercel-ip-city')),
      geoRegion: decode(get('x-vercel-ip-country-region')),
      geoCountry: get('x-vercel-ip-country'),
      requestPath: get('x-invoke-path') ?? get('x-matched-path') ?? get('referer'),
    }
  } catch {
    return EMPTY_CONTEXT
  }
}

/** "Valencia, CA, US" — for a human reading a spreadsheet row. */
export function describeLocation(ctx: RequestContext): string | null {
  const parts = [ctx.geoCity, ctx.geoRegion, ctx.geoCountry].filter(Boolean)
  return parts.length ? parts.join(', ') : null
}
