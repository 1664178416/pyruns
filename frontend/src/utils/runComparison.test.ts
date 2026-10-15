import { describe, expect, it } from 'vitest'
import { comparisonValue, metricRows, runDuration } from './runComparison'
import type { RunSummary } from '@/types'

describe('run comparison values', () => {
  it('preserves zero, false, null, missing fields and nested metric differences', () => {
    const rows = metricRows(
      { score: 0, enabled: false, nullable: null, nested: { a: 1, b: [1, 2] }, removed: 0 },
      { score: 0.5, enabled: true, nullable: false, nested: { b: [1, 3], a: 1 }, added: 0 },
    )
    expect(rows.find(row => row.key === 'score')).toMatchObject({ left: '0', right: '0.5', changed: true, delta: 0.5 })
    expect(rows.find(row => row.key === 'enabled')).toMatchObject({ left: 'false', right: 'true', delta: null })
    expect(rows.find(row => row.key === 'nullable')).toMatchObject({ left: 'null', right: 'false' })
    expect(rows.find(row => row.key === 'removed')).toMatchObject({ left: '0', right: 'Not recorded' })
    expect(rows.find(row => row.key === 'added')).toMatchObject({ left: 'Not recorded', right: '0' })
    expect(rows.find(row => row.key === 'nested')?.changed).toBe(true)
    expect(metricRows({ nested: { a: 1, b: 2 } }, { nested: { b: 2, a: 1 } })[0].changed).toBe(false)
    expect(comparisonValue([false, 0, null])).toBe('[\n  false,\n  0,\n  null\n]')
  })

  it('uses recorded duration including zero, falling back to old run timestamps', () => {
    const old = { start_time: '2026-10-15_10-00-00', finish_time: '2026-10-15_10-00-05', duration_seconds: null } as RunSummary
    expect(runDuration(old)).toBe('5.000s')
    expect(runDuration({ ...old, duration_seconds: 0 })).toBe('0.000s')
    expect(runDuration({ ...old, finish_time: null })).toBe('Not recorded')
  })

  it.each([[1, '1'], [true, 'true'], [null, 'null'], [undefined, 'Not recorded']])('preserves metric type differences: %s vs %s', (left, right) => {
    const row = metricRows({ value: left }, { value: right })[0]
    expect(row.changed).toBe(true)
    expect(row.left).not.toBe(row.right)
    expect(row.right).toBe(JSON.stringify(right))
  })
})
