import type { RunSummary } from '@/types'
import { parseTaskTimestampMillis } from './taskRuntime'

export function comparisonValue(value: unknown, quoteStrings = false): string {
  if (value === undefined) return 'Not recorded'
  if (value === null) return 'null'
  if (typeof value !== 'object') return typeof value === 'string' && quoteStrings ? JSON.stringify(value) : String(value)
  return JSON.stringify(value, (_, item) => (
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item
  ), 2)
}

export function metricRows(left: unknown, right: unknown) {
  const a = left && typeof left === 'object' && !Array.isArray(left) ? left as Record<string, unknown> : { Record: left }
  const b = right && typeof right === 'object' && !Array.isArray(right) ? right as Record<string, unknown> : { Record: right }
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().map(key => {
    const before = comparisonValue(a[key], true)
    const after = comparisonValue(b[key], true)
    const delta = typeof a[key] === 'number' && typeof b[key] === 'number'
      ? (b[key] as number) - (a[key] as number) : null
    return {
      key, left: before, right: after, changed: before !== after,
      delta: delta !== null && Number.isFinite(delta) ? delta : null,
    }
  })
}

export function runDuration(run: RunSummary): string {
  if (typeof run.duration_seconds === 'number' && Number.isFinite(run.duration_seconds)) {
    return `${run.duration_seconds.toFixed(3)}s`
  }
  const start = parseTaskTimestampMillis(run.start_time)
  const finish = parseTaskTimestampMillis(run.finish_time)
  return start !== null && finish !== null && finish >= start ? `${((finish - start) / 1000).toFixed(3)}s` : 'Not recorded'
}
