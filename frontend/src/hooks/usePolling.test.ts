import { describe, expect, it } from 'vitest'

import { normalizePollingInterval } from './usePolling'

describe('normalizePollingInterval', () => {
  it('keeps normal intervals and clamps busy-loop values', () => {
    expect(normalizePollingInterval(1500)).toBe(1500)
    expect(normalizePollingInterval(0)).toBe(250)
    expect(normalizePollingInterval(-100)).toBe(250)
  })

  it('uses a safe default for non-finite values', () => {
    expect(normalizePollingInterval(Number.NaN)).toBe(1000)
    expect(normalizePollingInterval(Number.POSITIVE_INFINITY)).toBe(1000)
  })
})
