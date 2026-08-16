'use client'

import type { Tip } from '@/lib/analytics/types'
import { KasavuBand } from '@/components/onam'

/*
 * What to do differently next year.
 *
 * Every tip is generated from the figure that justifies it, and shows that
 * figure underneath. Nothing here is generic event advice — if the day did not
 * produce evidence for a recommendation, the recommendation does not appear.
 *
 * That also means these move: mark another family present, or tick off another
 * run-sheet item, and the numbers under each tip follow.
 */

const CATEGORY_TONE: Record<Tip['category'], string> = {
  Sadya: 'var(--green)',
  Schedule: 'var(--marigold-deep)',
  Passes: 'var(--gold-deep)',
  Money: 'var(--kumkum)',
  'The desk': 'var(--green-deep)',
}

export function Tips({ tips }: { tips: Tip[] }) {
  if (!tips.length) {
    return (
      <p className="text-[15px] text-black/70">
        Not enough recorded yet to draw anything useful out.
      </p>
    )
  }

  // Grouped so the person reading owns one of these areas next year and can
  // find their part without reading all of it.
  const categories = [...new Set(tips.map((t) => t.category))]

  return (
    <div className="space-y-6">
      {categories.map((category) => (
        <div key={category}>
          <h3
            className="text-xs font-black uppercase tracking-[0.2em]"
            style={{ color: CATEGORY_TONE[category] }}
          >
            {category}
          </h3>
          <ul className="mt-2 space-y-3">
            {tips
              .filter((t) => t.category === category)
              .map((tip) => (
                <li key={tip.key} className="card-banded">
                  <KasavuBand height={3} />
                  <div className="p-4">
                    <h4 className="display text-lg leading-6">{tip.title}</h4>
                    <p className="mt-1.5 text-[15px] leading-relaxed text-black/75">
                      {tip.detail}
                    </p>
                    <p className="mt-2.5 border-l-2 border-[var(--line-strong)] pl-3 text-sm leading-snug text-black/55">
                      {tip.evidence}
                    </p>
                  </div>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
