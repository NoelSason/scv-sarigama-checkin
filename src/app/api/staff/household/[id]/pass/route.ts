import { NextResponse } from 'next/server'
import QRCode from 'qrcode'
import { z } from 'zod'
import { requireStaffApi } from '@/lib/auth'
import { findById, passUrl } from '@/lib/households'

export const dynamic = 'force-dynamic'

const Id = z.string().uuid()

/**
 * The household's QR, rendered for a staff screen so a guest without their
 * email can still be scanned in — the desk holds up the tablet and the door
 * scans it.
 *
 * PNG data URL rather than SVG because it has to survive being photographed off
 * one screen by another phone's camera; a wide quiet zone and high error
 * correction matter more here than file size.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaffApi('registration')
  if (!staff) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const { id } = await params
  if (!Id.safeParse(id).success) {
    return NextResponse.json({ error: 'INVALID' }, { status: 400 })
  }

  const household = await findById(id)
  if (!household) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  const url = passUrl(household.pass_token)
  const dataUrl = await QRCode.toDataURL(url, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 640,
    color: { dark: '#000000', light: '#ffffff' },
  })

  return NextResponse.json(
    {
      dataUrl,
      url,
      displayName: household.display_name,
      passEnabled: household.pass_enabled,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
