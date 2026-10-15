import type { GPUWaitStatus } from '@/types'

export interface GPUWaitSummary {
  requestedGpuCount: number
  eligibleGpuCount: number | null
  waitedSeconds: number
  remainingSeconds: number | null
}

/** Normalize optional scheduler fields before rendering them in any UI. */
export function summarizeGpuWait(wait: GPUWaitStatus | null | undefined): GPUWaitSummary {
  const requested = Number(wait?.requested_gpu_count)
  const eligible = Number(wait?.eligible_gpu_count)
  const waited = Number(wait?.waited_seconds)
  const maxWait = Number(wait?.max_wait_seconds)
  const serverRemaining = wait?.remaining_seconds == null ? NaN : Number(wait.remaining_seconds)

  return {
    requestedGpuCount: Number.isFinite(requested) ? Math.max(1, Math.trunc(requested)) : 1,
    eligibleGpuCount: Number.isFinite(eligible) ? Math.max(0, Math.trunc(eligible)) : null,
    waitedSeconds: Number.isFinite(waited) ? Math.max(0, waited) : 0,
    remainingSeconds: Number.isFinite(serverRemaining)
      ? Math.max(0, serverRemaining)
      : Number.isFinite(maxWait) && maxWait > 0
        ? Math.max(0, maxWait - (Number.isFinite(waited) ? Math.max(0, waited) : 0))
        : null,
  }
}
