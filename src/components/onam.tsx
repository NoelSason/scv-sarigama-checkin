/**
 * Onam ornament.
 *
 * Four motifs carry the identity in-app: the kasavu band, the pookalam rings,
 * the nilavilakku lamp, and sparse falling petals. Elephants, snake-boats and
 * Kathakali faces are reserved for print and social — on a phone they would
 * fight the QR and the numbers.
 *
 * Everything here is decorative and marked aria-hidden. Nothing in this file
 * may overlap a QR quiet zone or sit inside a hit target.
 */

/** Nilavilakku — the lit brass lamp. The brand mark. */
export function Lamp({
  width = 34,
  glow = false,
  className = '',
  tone = 'brass',
}: {
  width?: number
  /** Breathing flame. Off automatically under prefers-reduced-motion. */
  glow?: boolean
  className?: string
  /** `brass` on ivory; `bright` on the dark raffle stage and the staff header. */
  tone?: 'brass' | 'bright'
}) {
  const body = tone === 'bright' ? '#E8B84B' : '#C8951C'
  return (
    <svg
      aria-hidden
      width={width}
      height={Math.round((width * 46) / 34)}
      viewBox="0 0 34 46"
      className={`${glow ? 'lamp-glow ' : ''}${className}`}
    >
      <ellipse cx="17" cy="8" rx="3.4" ry="5.6" fill="#E8871E" />
      <ellipse cx="17" cy="9.4" rx="1.6" ry="3.2" fill={tone === 'bright' ? '#FFD977' : '#E8B84B'} />
      <path d="M5 16 h24 a12 8 0 0 1 -24 0 z" fill={body} />
      <rect x="15.4" y="24" width="3.2" height="9" fill={body} />
      <path d="M8 38 h18 l3 5 h-24 z" fill={body} />
    </svg>
  )
}

/** Woven gold band. Card tops, header underline, footers. */
export function KasavuBand({ height = 6, className = '' }: { height?: number; className?: string }) {
  return <div aria-hidden className={`kasavu ${className}`} style={{ height }} />
}

/** The short centred band that closes every page. */
export function KasavuRule({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`mx-auto h-[5px] w-[120px] rounded-full ${className}`}
      style={{
        background:
          'repeating-linear-gradient(90deg, #C8951C 0 10px, #E8B84B 10px 16px, #8a6410 16px 19px)',
      }}
    />
  )
}

/** Pookalam rings cresting the top of a guest page, at 16% opacity. */
export function PookalamArc() {
  return <div aria-hidden className="pookalam-arc" />
}

/** The small pookalam medallion that heads the raffle card on a pass. */
export function PookalamDot({ size = 34 }: { size?: number }) {
  return (
    <div
      aria-hidden
      className="mx-auto rounded-full"
      style={{
        width: size,
        height: size,
        background:
          'radial-gradient(circle, #ffffff 0 4px, #E8B84B 4px 9px, #E8871E 9px 14px, #B3341B 14px 17px)',
      }}
    />
  )
}

/** ഓണാശംസകൾ — Onam greetings. Always rendered beside English context. */
export function Greeting({ className = '' }: { className?: string }) {
  return (
    <p lang="ml" className={`greeting ${className}`}>
      ഓണാശംസകൾ
    </p>
  )
}

const PETAL_COLORS = ['#E8871E', '#E8B84B', '#C05A12', '#F4D77C', '#B3341B']

/**
 * Petal field, laid out from a fixed seed rather than Math.random so the
 * server and the client produce the same flowers — a random field here would
 * hydrate-mismatch on every load.
 *
 * Lives outside the component because the generator mutates its seed as it
 * walks the sequence, and that is only safe in a plain function.
 */
function layOutPetals(count: number, seed: number): React.CSSProperties[] {
  let s = seed
  const rnd = () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }

  return Array.from({ length: count }, (_, i) => {
    const w = 8 + Math.round(rnd() * 7)
    return {
      left: `${Math.round(rnd() * 96)}%`,
      width: w,
      height: Math.round(w * 1.45),
      background: PETAL_COLORS[i % PETAL_COLORS.length],
      opacity: Number((0.5 + rnd() * 0.35).toFixed(2)),
      animationDuration: `${(9 + rnd() * 8).toFixed(1)}s`,
      animationDelay: `-${(rnd() * 16).toFixed(1)}s`,
    }
  })
}

/**
 * Sparse drifting petals for guest-facing pages. They sit behind the content
 * layer, so they can never cross a QR, and they are gone entirely under
 * prefers-reduced-motion.
 */
export function Petals({ count = 8, seed = 7 }: { count?: number; seed?: number }) {
  return (
    <>
      {layOutPetals(count, seed).map((style, i) => (
        <div key={i} aria-hidden className="petal" style={style} />
      ))}
    </>
  )
}

/** Wordmark used in the staff header: lamp + name. */
export function StaffWordmark({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-[7px]">
      <Lamp width={15} tone="bright" />
      {children}
    </span>
  )
}
