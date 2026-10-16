import { useEffect, useRef, useState } from 'react'
import { useTaskEvents, type TaskEventStreamStatus } from './useWebSocket'
import { usePolling } from './usePolling'
import { usePageVisible } from './usePageVisible'

function pageHidden() {
  return document.visibilityState === 'hidden'
}

// Events describe an already updated server snapshot. Disk reconciliation is
// reserved for fallback/visibility polls, and bursts share one list request.
export function useTaskRefresh(
  refresh: (fromDisk: boolean) => Promise<void>,
  generationKey: string,
  searching = false,
  foregroundLoading = false,
) {
  const [status, setStatus] = useState<TaskEventStreamStatus>('idle')
  const pageVisible = usePageVisible()
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const scheduleRef = useRef<(fromDisk?: boolean) => void>(() => {})
  const foregroundLoadingRef = useRef(foregroundLoading)
  foregroundLoadingRef.current = foregroundLoading
  const resumeRef = useRef<() => void>(() => {})
  const previousPageVisibleRef = useRef(pageVisible)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let inFlight = false
    let queued = false
    let needsDisk = false

    const run = async () => {
      if (disposed || pageHidden()) return
      if (inFlight || foregroundLoadingRef.current) {
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
        } while (!disposed && queued && !pageHidden() && !foregroundLoadingRef.current)
      } finally {
        inFlight = false
      }
    }
    scheduleRef.current = (fromDisk = false) => {
      if (disposed) return
      needsDisk ||= fromDisk
      if (pageHidden()) return
      if (inFlight || foregroundLoadingRef.current) {
        queued = true
      } else if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined
          void run()
        }, 120)
      }
    }
    resumeRef.current = () => {
      if (queued) scheduleRef.current()
    }
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [generationKey])

  useEffect(() => {
    const becameVisible = !previousPageVisibleRef.current && pageVisible
    previousPageVisibleRef.current = pageVisible
    if (becameVisible) {
      // Reconcile from disk after a hidden interval. The websocket's ready
      // event may arrive at the same time; the scheduler coalesces both into
      // one request while retaining the stronger disk refresh flag.
      scheduleRef.current(true)
    }
  }, [pageVisible])

  useEffect(() => {
    if (!foregroundLoading) resumeRef.current()
  }, [foregroundLoading])

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
