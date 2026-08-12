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
 * Live counters from the decoder.
 *
 * A phone that "isn't scanning" has several very different causes that all look
 * identical from the outside. These numbers separate them without a laptop and a
 * cable: misses climbing means frames reach the decoder and it simply cannot
 * read the code; misses frozen at zero means they never arrive.
 */
export type ScannerDiagnostics = {
  misses: number
  decodes: number
  video: string | null
  lastDecodeAt: number | null
}

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
  const missCountRef = useRef(0)
  const decodeCountRef = useRef(0)

  const [state, setState] = useState<ScannerState>('idle')
  const [backend, setBackend] = useState<ScannerBackend>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [diag, setDiag] = useState<ScannerDiagnostics>({
    misses: 0, decodes: 0, video: null, lastDecodeAt: null,
  })

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
              if (codes.length > 0 && codes[0].rawValue) {
                decodeCountRef.current += 1
                setDiag((d) => ({ ...d, decodes: decodeCountRef.current, lastDecodeAt: Date.now() }))
                emit(codes[0].rawValue)
              } else {
                missCountRef.current += 1
                if (missCountRef.current % 10 === 0) {
                  setDiag((d) => ({
                    ...d,
                    misses: missCountRef.current,
                    video: `${video.videoWidth}x${video.videoHeight}`,
                  }))
                }
              }
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
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import('html5-qrcode')
      const instance = new Html5Qrcode('qr-fallback-region', {
        verbose: false,
        // Only ever looking for one symbology. Skipping the other decoders is
        // free accuracy and speed on the phones that land here.
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
      })
      fallbackRef.current = instance
      await instance.start(
        { facingMode: 'environment' },
        {
          fps: 15,
          /**
           * No qrbox: decode the WHOLE frame.
           *
           * qrbox crops in video pixels before decoding, and every cropped size
           * has the same failure — a volunteer naturally holds the code close
           * enough to fill the viewfinder, which pushes its corner finder
           * patterns outside the crop. Without those three corners a QR is not
           * decodable at all, which looks exactly like a dead scanner: camera
           * live, code perfectly framed, nothing happening.
           *
           * Desktop never showed it because Chrome uses the native detector,
           * which crops nothing. Scanning the full frame costs a little CPU per
           * frame and removes the entire class of bug.
           */
          videoConstraints: {
            facingMode: 'environment',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        },
        (decoded) => {
          decodeCountRef.current += 1
          setDiag((d) => ({ ...d, decodes: decodeCountRef.current, lastDecodeAt: Date.now() }))
          emit(decoded)
        },
        () => {
          // Fires once per frame that contained no readable code — which is most
          // of them. Counted, not logged: a rising number is proof that frames
          // are reaching the decoder at all, which is the first thing worth
          // knowing when a phone "isn't scanning".
          missCountRef.current += 1
          if (missCountRef.current % 10 === 0) {
            const v = document.querySelector<HTMLVideoElement>('#qr-fallback-region video')
            setDiag((d) => ({
              ...d,
              misses: missCountRef.current,
              // Frame shape and displayed shape. These two ratios must match:
              // when they diverge the decode canvas is squashing the code and
              // nothing will ever read, however good the camera looks.
              video: v ? `${v.videoWidth}x${v.videoHeight}→${v.clientWidth}x${v.clientHeight}` : 'no video',
            }))
          }
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

  return { videoRef, state, backend, message, diag, start, stop }
}
