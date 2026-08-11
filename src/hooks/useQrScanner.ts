'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type ScannerState = 'idle' | 'starting' | 'running' | 'denied' | 'unsupported' | 'error'

/**
 * Which decoder is live. The UI must know: the two backends draw completely
 * different things. The native path paints into our own <video>, while
 * html5-qrcode injects its own <video> plus a scan-region graphic. Rendering
 * both at once put two boxes on screen with a dead black band above them.
 */
export type ScannerBackend = 'native' | 'fallback' | null

/**
 * QR scanning with two backends.
 *
 * Primary: the native BarcodeDetector, hardware-accelerated and by far the
 * smoothest on modern Android Chrome. iOS Safari doesn't ship it, so the
 * fallback is html5-qrcode, imported lazily so devices that don't need it never
 * download it.
 *
 * The `paused` flag is the important part: while a redemption panel is open the
 * scanner stops reporting, so repeated camera frames of the same QR cannot fire
 * the flow twice.
 */
export function useQrScanner({
  onScan,
  paused,
}: {
  onScan: (value: string) => void
  paused: boolean
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fallbackRef = useRef<{ stop: () => Promise<void> } | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const pausedRef = useRef(paused)
  const lastRef = useRef<{ value: string; at: number } | null>(null)

  const [state, setState] = useState<ScannerState>('idle')
  const [backend, setBackend] = useState<ScannerBackend>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  /** Debounce identical reads so one QR held in frame fires exactly once. */
  const emit = useCallback(
    (value: string) => {
      if (pausedRef.current) return
      const now = Date.now()
      const last = lastRef.current
      if (last && last.value === value && now - last.at < 2500) return
      lastRef.current = { value, at: now }
      onScan(value)
    },
    [onScan],
  )

  const stop = useCallback(async () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (fallbackRef.current) {
      try {
        await fallbackRef.current.stop()
      } catch {
        /* already stopped */
      }
      fallbackRef.current = null
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setBackend(null)
    setState('idle')
  }, [])

  const start = useCallback(async () => {
    setState('starting')
    setMessage(null)

    const hasNative = typeof window !== 'undefined' && 'BarcodeDetector' in window

    if (hasNative) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const Detector = (window as any).BarcodeDetector
        const formats: string[] = await Detector.getSupportedFormats()
        if (!formats.includes('qr_code')) throw new Error('no qr support')

        const detector = new Detector({ formats: ['qr_code'] })
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        })
        streamRef.current = stream

        const video = videoRef.current
        if (!video) throw new Error('no video element')
        video.srcObject = stream
        video.setAttribute('playsinline', 'true')
        await video.play()
        setBackend('native')
        setState('running')

        const tick = async () => {
          if (!streamRef.current) return
          try {
            if (!pausedRef.current && video.readyState >= 2) {
              const codes = await detector.detect(video)
              if (codes.length > 0 && codes[0].rawValue) emit(codes[0].rawValue)
            }
          } catch {
            /* transient decode failure — keep scanning */
          }
          rafRef.current = requestAnimationFrame(() => void tick())
        }
        void tick()
        return
      } catch (err) {
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          setState('denied')
          return
        }
        // Native path failed for another reason: fall through to the library.
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        setBackend(null)
      }
    }

    try {
      // Set before awaiting: the container div must already be mounted and
      // visible when html5-qrcode measures it, or it renders at zero height.
      setBackend('fallback')
      const { Html5Qrcode } = await import('html5-qrcode')
      const instance = new Html5Qrcode('qr-fallback-region', { verbose: false })
      fallbackRef.current = instance
      await instance.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 260, height: 260 } },
        (decoded) => emit(decoded),
        () => {
          /* per-frame miss — normal */
        },
      )
      setState('running')
    } catch (err) {
      setBackend(null)
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setState('denied')
      } else {
        setState('error')
        setMessage(err instanceof Error ? err.message : 'Could not start the camera.')
      }
    }
  }, [emit])

  useEffect(() => {
    return () => {
      void stop()
    }
  }, [stop])

  return { videoRef, state, backend, message, start, stop }
}
