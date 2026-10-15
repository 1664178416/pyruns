import { useEffect, useRef, useState } from 'react'
import { useTaskEvents, type TaskEventStreamStatus } from './useWebSocket'
import { usePolling } from './usePolling'

function pageHidden() {
  return document.visibilityState === 'hidden'
}

// Events describe an already updated server snapshot. Disk reconciliation is
// reserved for fallback/visibility polls, and bursts share one list request.
export function useTaskRefresh(
  refresh: (fromDisk: boolean) => Promise<void>,
  generationKey: string,
  searching = false,
) {
  const [status, setStatus] = useState<TaskEventStreamStatus>('idle')
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const scheduleRef = useRef<(fromDisk?: boolean) => void>(() => {})

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    let queued = false
    let needsDisk = false

    const run = async () => {
      if (disposed || pageHidden()) return
      if (inFlight) {
        queued = true
        return
      }
      inFlight = true
      try {
        do {
          queued = false
          const fromDisk = needsDisk
          needsDisk = false
          try {
            await refreshRef.current(fromDisk)
          } catch { /* The store exposes errors; fallback polling retries. */ }
        } while (!disposed && queued && !pageHidden())
      } finally {
        inFlight = false
      }
    }
    scheduleRef.current = (fromDisk = false) => {
      if (disposed) return
      needsDisk ||= fromDisk
      if (pageHidden()) return
      if (inFlight) {
        queued = true
      } else if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined
          void run()
        }, 120)
      }
    }
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [generationKey])

  useTaskEvents({
    onInvalidate: () => scheduleRef.current(),
    onStatusChange: setStatus,
    enabled: Boolean(generationKey),
    generationKey,
  })
  usePolling(
    () => scheduleRef.current(true),
    searching ? 30_000 : status === 'live' ? 60_000 : 5_000,
    Boolean(generationKey),
    false,
  )
  return status
}
