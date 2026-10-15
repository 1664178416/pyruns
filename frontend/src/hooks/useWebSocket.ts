import { useEffect, useRef, useCallback } from 'react'
import { createLogStream, createTaskEventStream } from '@/api'
import type { LogStreamMessage, TaskEventMessage } from '@/types'
import { usePageVisible } from './usePageVisible'

export type LogStreamStatus = 'idle' | 'connecting' | 'live' | 'reconnecting'
export type TaskEventStreamStatus = LogStreamStatus

interface UseLogStreamOptions {
  taskName: string | null
  onChunk: (message: LogStreamMessage) => void
  onDisconnect?: () => void
  onStatusChange?: (status: LogStreamStatus) => void
  onError?: (message: string) => void
  enabled?: boolean
  logFileName?: string
  offset?: number
  logIdentity?: string
  generationKey?: string
}

const LOG_STREAM_RECONNECT_BASE_MS = 750
const LOG_STREAM_RECONNECT_MAX_MS = 10_000
const LOG_STREAM_HEALTH_TIMEOUT_MS = 35_000
const TASK_EVENT_RECONNECT_BASE_MS = 750
const TASK_EVENT_RECONNECT_MAX_MS = 15_000

interface UseTaskEventsOptions {
  onInvalidate: () => void
  onStatusChange?: (status: TaskEventStreamStatus) => void
  enabled?: boolean
  generationKey?: string
}

export function useTaskEvents({
  onInvalidate,
  onStatusChange,
  enabled = true,
  generationKey = '',
}: UseTaskEventsOptions) {
  const pageVisible = usePageVisible()
  const wsRef = useRef<WebSocket | null>(null)
  const onInvalidateRef = useRef(onInvalidate)
  const onStatusChangeRef = useRef(onStatusChange)
  const generationKeyRef = useRef(generationKey)
  onInvalidateRef.current = onInvalidate
  onStatusChangeRef.current = onStatusChange
  generationKeyRef.current = generationKey

  useEffect(() => {
    if (!enabled || !pageVisible) {
      onStatusChangeRef.current?.('idle')
      return
    }

    let disposed = false
    let retryTimer: number | null = null
    let reconnectAttempt = 0
    const connectedGenerationKey = generationKey

    const connect = () => {
      if (disposed || generationKeyRef.current !== connectedGenerationKey) {
        return
      }

      onStatusChangeRef.current?.(reconnectAttempt > 0 ? 'reconnecting' : 'connecting')
      const ws = createTaskEventStream()
      wsRef.current = ws

      ws.onmessage = (event) => {
        if (
          disposed
          || wsRef.current !== ws
          || generationKeyRef.current !== connectedGenerationKey
        ) {
          return
        }
        try {
          const message = JSON.parse(event.data) as TaskEventMessage
          if (message.type === 'ready') {
            reconnectAttempt = 0
            onStatusChangeRef.current?.('live')
            onInvalidateRef.current()
          } else if (message.type === 'changed') {
            onInvalidateRef.current()
          }
        } catch { /* Ignore malformed task event messages. */ }
      }

      ws.onerror = () => ws.close()
      ws.onclose = (event) => {
        if (
          disposed
          || wsRef.current !== ws
          || generationKeyRef.current !== connectedGenerationKey
        ) {
          return
        }
        wsRef.current = null
        if (event?.code === 4409) {
          onStatusChangeRef.current?.('idle')
          return
        }
        reconnectAttempt += 1
        onStatusChangeRef.current?.('reconnecting')
        const retryDelay = Math.min(
          TASK_EVENT_RECONNECT_MAX_MS,
          TASK_EVENT_RECONNECT_BASE_MS * (2 ** Math.min(reconnectAttempt - 1, 5)),
        )
        retryTimer = window.setTimeout(connect, retryDelay)
      }
    }

    connect()

    return () => {
      disposed = true
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer)
      }
      const ws = wsRef.current
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        wsRef.current = null
        ws.close()
      }
    }
  }, [enabled, generationKey, pageVisible])
}

export function useLogStream({
  taskName,
  onChunk,
  onDisconnect,
  onStatusChange,
  onError,
  enabled = true,
  logFileName,
  offset,
  logIdentity,
  generationKey = '',
}: UseLogStreamOptions) {
  const pageVisible = usePageVisible()
  const wsRef = useRef<WebSocket | null>(null)
  const onChunkRef = useRef(onChunk)
  const onDisconnectRef = useRef(onDisconnect)
  const onStatusChangeRef = useRef(onStatusChange)
  const onErrorRef = useRef(onError)
  const offsetRef = useRef(offset)
  const logIdentityRef = useRef(logIdentity)
  const generationKeyRef = useRef(generationKey)
  onChunkRef.current = onChunk
  onDisconnectRef.current = onDisconnect
  onStatusChangeRef.current = onStatusChange
  onErrorRef.current = onError
  offsetRef.current = offset
  logIdentityRef.current = logIdentity
  generationKeyRef.current = generationKey

  const disconnect = useCallback(() => {
    const ws = wsRef.current
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      wsRef.current = null
      ws.close()
    }
  }, [])

  useEffect(() => {
    if (!taskName || !enabled || !pageVisible) {
      disconnect()
      // Commit any buffered chunks before a later connection resumes at its offset.
      if (!pageVisible) onDisconnectRef.current?.()
      onStatusChangeRef.current?.('idle')
      return
    }

    let disposed = false
    let retryTimer: number | null = null
    let healthTimer: number | null = null
    let reconnectAttempt = 0
    const connectedGenerationKey = generationKey

    const connect = () => {
      if (disposed || generationKeyRef.current !== connectedGenerationKey) {
        return
      }

      onStatusChangeRef.current?.(reconnectAttempt > 0 ? 'reconnecting' : 'connecting')
      const ws = createLogStream(taskName, {
        logFileName,
        offset: offsetRef.current,
        logIdentity: logIdentityRef.current,
      })
      wsRef.current = ws
      let unhealthy = false
      const failRead = (message: string) => {
        if (disposed || wsRef.current !== ws || unhealthy) return
        unhealthy = true
        if (healthTimer !== null) window.clearTimeout(healthTimer)
        onErrorRef.current?.(message)
        onStatusChangeRef.current?.('reconnecting')
        onDisconnectRef.current?.()
        ws.close()
      }

      ws.onopen = () => {
        if (
          disposed
          || wsRef.current !== ws
          || generationKeyRef.current !== connectedGenerationKey
        ) {
          return
        }
        healthTimer = window.setTimeout(() => {
          failRead('Live log reads timed out. Retrying with incremental polling.')
        }, LOG_STREAM_HEALTH_TIMEOUT_MS)
      }

      ws.onmessage = (ev) => {
        if (
          disposed || unhealthy
          || wsRef.current !== ws
          || generationKeyRef.current !== connectedGenerationKey
        ) {
          return
        }
        try {
          const msg = JSON.parse(ev.data) as LogStreamMessage
          if (msg.type === 'error') {
            failRead(msg.detail || 'Live log reads failed. Retrying with incremental polling.')
            return
          }
          if (['ready', 'heartbeat', 'chunk', 'reset'].includes(msg.type)) {
            if (healthTimer !== null) window.clearTimeout(healthTimer)
            healthTimer = window.setTimeout(() => {
              failRead('Live log reads timed out. Retrying with incremental polling.')
            }, LOG_STREAM_HEALTH_TIMEOUT_MS)
            reconnectAttempt = 0
            onStatusChangeRef.current?.('live')
            onErrorRef.current?.('')
          }
          if ((msg.type === 'chunk' && msg.content) || msg.type === 'reset') {
            onChunkRef.current(msg)
          }
        } catch { /* Ignore malformed third-party log messages. */ }
      }

      ws.onerror = () => ws.close()
      ws.onclose = (event) => {
        if (
          disposed
          || wsRef.current !== ws
          || generationKeyRef.current !== connectedGenerationKey
        ) {
          return
        }
        wsRef.current = null
        if (healthTimer !== null) window.clearTimeout(healthTimer)
        if (!unhealthy) onDisconnectRef.current?.()
        if (event?.code === 4409) {
          onStatusChangeRef.current?.('idle')
          return
        }
        reconnectAttempt += 1
        onStatusChangeRef.current?.('reconnecting')
        const retryDelay = Math.min(
          LOG_STREAM_RECONNECT_MAX_MS,
          LOG_STREAM_RECONNECT_BASE_MS * (2 ** Math.min(reconnectAttempt - 1, 4)),
        )
        retryTimer = window.setTimeout(connect, retryDelay)
      }
    }

    connect()

    return () => {
      disposed = true
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer)
      }
      if (healthTimer !== null) window.clearTimeout(healthTimer)
      const ws = wsRef.current
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        wsRef.current = null
        ws.close()
      }
    }
  }, [taskName, enabled, disconnect, generationKey, logFileName, pageVisible])

  return { disconnect }
}
