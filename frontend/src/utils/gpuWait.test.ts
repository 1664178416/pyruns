import { describe, expect, it } from 'vitest'

import { summarizeGpuWait } from './gpuWait'

describe('summarizeGpuWait', () => {
  it('normalizes scheduler diagnostics for a bounded wait', () => {
    expect(summarizeGpuWait({
      state: 'waiting',
      requested_gpu_count: 2,
      eligible_gpu_count: 1,
      waited_seconds: 12.4,
      max_wait_seconds: 60,
    })).toEqual({
      requestedGpuCount: 2,
      eligibleGpuCount: 1,
      waitedSeconds: 12.4,
      remainingSeconds: 47.6,
    })
  })

  it('prefers the server remaining time and handles incomplete payloads', () => {
    expect(summarizeGpuWait({
      state: 'waiting',
      requested_gpu_count: 0,
      eligible_gpu_count: Number.NaN,
      waited_seconds: -1,
      max_wait_seconds: 60,
      remaining_seconds: 8,
    })).toEqual({
      requestedGpuCount: 1,
      eligibleGpuCount: null,
      waitedSeconds: 0,
      remainingSeconds: 8,
    })
    expect(summarizeGpuWait(undefined).remainingSeconds).toBeNull()
  })
})
