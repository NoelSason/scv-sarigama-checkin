'use server'

import { redirect } from 'next/navigation'
import { signInShared, signOut } from '@/lib/auth'

/**
 * Server actions live here, in a module marked 'use server', rather than being
 * declared inline inside a page or layout component.
 *
 * This is not a style preference. On Next 16.3.0 an inline server action stops
 * its whole subtree from hydrating — the HTML renders, but React never attaches
 * and no button on the page does anything. There is no console error and no
 * build warning; hydration just silently stops at that boundary.
 *
 * The sign-out action used to be declared inside the staff layout, so the
 * failure applied to the entire /staff tree: scanner, desk, and admin all
 * rendered perfectly and responded to nothing.
 *
 * Reproduced with two otherwise-identical probe pages, one with an inline
 * action and one without. If you ever add another action, add it here.
 */

export async function signInAction(formData: FormData): Promise<void> {
  const password = String(formData.get('password') ?? '')
  const result = await signInShared(password)
  if (!result.ok) redirect(`/staff/login?error=${encodeURIComponent(result.error)}`)
  redirect('/staff')
}

export async function signOutAction(): Promise<void> {
  await signOut()
  redirect('/staff/login')
}
