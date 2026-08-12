'use client'

import { useEffect, useRef } from 'react'

const COLORS = ['#ffd977', '#c8951c', '#fff9ec', '#8a6410', '#f0c14b', '#ffffff']

type Piece = {
  x: number
  y: number
  vx: number
  vy: number
  w: number
  h: number
  rot: number
  vrot: number
  color: string
  life: number
}

/**
 * Gold burst for the moment a name lands.
 *
 * Canvas rather than DOM: 180 elements each with their own transform would
 * fight the reel for the compositor, and this fires at exactly the moment the
 * winner panel is animating in. One canvas, one rAF loop, gone in four seconds.
 *
 * Keyed by the draw id from the parent, so re-mounting is what re-fires it.
 */
export function Confetti({ durationMs = 4200 }: { durationMs?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let w = window.innerWidth
    let h = window.innerHeight

    const size = () => {
      w = window.innerWidth
      h = window.innerHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    size()
    window.addEventListener('resize', size)

    // Two cannons at the lower corners plus a centre fountain — a single
    // centre burst reads as a puff; corners read as a celebration.
    const pieces: Piece[] = []
    const spawn = (ox: number, oy: number, angle: number, count: number, power: number) => {
      for (let i = 0; i < count; i++) {
        const a = angle + (Math.random() - 0.5) * 0.9
        const speed = power * (0.55 + Math.random() * 0.75)
        pieces.push({
          x: ox,
          y: oy,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          w: 6 + Math.random() * 7,
          h: 9 + Math.random() * 12,
          rot: Math.random() * Math.PI * 2,
          vrot: (Math.random() - 0.5) * 0.4,
          color: COLORS[(Math.random() * COLORS.length) | 0],
          life: 0,
        })
      }
    }

    spawn(0, h * 0.92, -Math.PI / 3.1, 70, 20)
    spawn(w, h * 0.92, -Math.PI + Math.PI / 3.1, 70, 20)
    spawn(w / 2, h * 0.62, -Math.PI / 2, 55, 17)

    const GRAVITY = 0.34
    const DRAG = 0.988

    let raf = 0
    let start = 0
    let stopped = false

    const frame = (now: number) => {
      if (stopped) return
      if (!start) start = now
      const elapsed = now - start

      ctx.clearRect(0, 0, w, h)

      // Fade the whole burst out over the last second rather than having
      // pieces blink off individually.
      const fade = Math.max(0, Math.min(1, (durationMs - elapsed) / 1000))
      ctx.globalAlpha = fade

      for (const p of pieces) {
        p.vy += GRAVITY
        p.vx *= DRAG
        p.vy *= DRAG
        p.x += p.vx
        p.y += p.vy
        p.rot += p.vrot
        p.life += 1

        if (p.y > h + 40) continue

        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rot)
        ctx.fillStyle = p.color
        // Squashing height by the spin angle fakes a flipping paper rectangle
        // for a fraction of the cost of drawing one in 3D.
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.life * 0.12)))
        ctx.restore()
      }

      ctx.globalAlpha = 1

      if (elapsed < durationMs) raf = requestAnimationFrame(frame)
      else ctx.clearRect(0, 0, w, h)
    }

    raf = requestAnimationFrame(frame)

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', size)
    }
  }, [durationMs])

  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none fixed inset-0 z-50" />
}
