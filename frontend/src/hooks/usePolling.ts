import { useEffect, useRef } from 'react'

const MIN_POLL_INTERVAL_MS = 250
const DEFAULT_POLL_INTERVAL_MS = 1000

/** Keep caller-provided polling intervals from creating a busy timer loop. */
export function normalizePollingInterval(intervalMs: number) {
  if (!Number.isFinite(intervalMs)) {
    return DEFAULT_POLL_INTERVAL_MS
  }
  return Math.max(MIN_POLL_INTERVAL_MS, intervalMs)
}

export function usePolling(
  callback: () => void | Promise<void>,
  intervalMs: number,
  enabled = true,
  immediate = true,
  refreshWhenVisible = true,
) {
  const savedCallback = useRef(callback)
  const inFlightRef = useRef(false)
  const ticketRef = useRef(0)
  const effectiveIntervalMs = normalizePollingInterval(intervalMs)
  savedCallback.current = callback

  useEffect(() => {
    if (!enabled) return

    let refreshOnReturn = false
    const tick = () => {
      if (inFlightRef.current) {
        return
      }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return
      }

      inFlightRef.current = true
      const ticket = ++ticketRef.current
      let result: void | Promise<void>
      try {
        result = savedCallback.current()
      } catch {
        inFlightRef.current = false
        return
      }

      void Promise.resolve(result)
        .catch(() => {})
        .finally(() => {
          if (ticketRef.current === ticket) {
            inFlightRef.current = false
            if (refreshOnReturn) {
              refreshOnReturn = false
              tick()
            }
          }
        })
    }

    if (immediate) {
      tick()
    }

    let id: ReturnType<typeof setInterval> | undefined
    const handleVisibilityChange = () => {
      clearInterval(id)
      if (document.visibilityState === 'hidden') return
      if (refreshWhenVisible) {
        if (inFlightRef.current) refreshOnReturn = true
        else tick()
      }
      id = setInterval(tick, effectiveIntervalMs)
    }
    if (document.visibilityState !== 'hidden') id = setInterval(tick, effectiveIntervalMs)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      ticketRef.current += 1
      inFlightRef.current = false
    }
  }, [effectiveIntervalMs, enabled, immediate, refreshWhenVisible])
}
