import { NextResponse } from 'next/server'
import { loadOnamAnalytics } from '@/lib/analytics/onam'

export const dynamic = 'force-dynamic'

/** Re-read every number on the analytics page. Read-only — never mutates. */
export async function GET() {
  const data = await loadOnamAnalytics()
  return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } })
}
