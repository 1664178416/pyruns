import { useEffect, useId, useRef, useState } from 'react'
import * as api from '@/api'
import { useWorkspaceStore } from '@/store'
import type { RunComparison, RunSummary } from '@/types'
import { errorMessage } from '@/utils/errors'
import { comparisonValue, metricRows, runDuration } from '@/utils/runComparison'
import ActionButton from '@/components/shared/ActionButton'
import CopyButton from '@/components/shared/CopyButton'

function signedDelta(value: string | number): string {
  const text = typeof value === 'string' ? value : String(Number(value.toPrecision(8)))
  return text.startsWith('-') || text === '0' ? text : `+${text}`
}

function ComparisonTable({ comparison, rows }: {
  comparison: RunComparison
  rows: { key: string; left: string; right: string; changed?: boolean; delta?: string | number | null }[]
}) {
  return (
    <table className="w-full table-fixed text-left text-xs">
      <thead>
        <tr className="border-b border-border-subtle text-txt-secondary">
          <th scope="col" className="w-1/4 py-2 pr-2 font-medium">Field</th>
          <th scope="col" className="px-2 py-2 font-medium [overflow-wrap:anywhere]">{comparison.left.reference}<span className="block font-normal">Baseline</span></th>
          <th scope="col" className="py-2 pl-2 font-medium [overflow-wrap:anywhere]">{comparison.right.reference}<span className="block font-normal">Selected run</span></th>
        </tr>
      </thead>
      <tbody>{rows.map(row => {
        const changed = row.changed ?? row.left !== row.right
        return (
          <tr key={row.key} className="border-b border-border-subtle last:border-b-0">
            <th scope="row" className="py-2 pr-2 align-top font-medium text-txt-secondary [overflow-wrap:anywhere]">{row.key}</th>
            <td className="px-2 py-2 align-top"><pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs text-txt-primary [overflow-wrap:anywhere]">{row.left}</pre></td>
            <td className="py-2 pl-2 align-top">
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs text-txt-primary [overflow-wrap:anywhere]">{row.right}</pre>
              {changed && <span className="mt-1 block text-2xs text-txt-secondary">Changed{row.delta != null ? ` · Δ ${signedDelta(row.delta)}` : ''}</span>}
            </td>
          </tr>
        )
      })}</tbody>
    </table>
  )
}

function summaryRows(left: RunSummary, right: RunSummary) {
  const fields: [string, (run: RunSummary) => unknown][] = [
    ['Status', run => run.status ?? undefined], ['Duration', runDuration],
    ['Exit code', run => run.exit_code ?? undefined], ['Started', run => run.start_time ?? undefined],
    ['Finished', run => run.finish_time ?? undefined], ['Source / Git', run => run.source_state ?? undefined],
  ]
  return fields.map(([key, read]) => ({ key, left: comparisonValue(read(left)), right: comparisonValue(read(right)) }))
}

function environmentRows(left: RunSummary, right: RunSummary) {
  const fields = ['host', 'system', 'launcher', 'conda_env', 'cuda_visible_devices', 'assigned_gpu_ids', 'gpu_scope', 'gpu_status', 'gpus'] as const
  const labels = ['Host', 'System', 'Launcher', 'Conda', 'CUDA visibility', 'Assigned GPUs', 'GPU scope', 'GPU discovery', 'GPU devices']
  return fields.map((field, index) => ({
    key: labels[index],
    left: comparisonValue(left.environment?.[field]), right: comparisonValue(right.environment?.[field]),
  }))
}

export default function RunComparisonView({ name, run }: { name: string; run: number }) {
  const id = useId()
  const workspaceEpoch = useWorkspaceStore(state => state.workspaceEpoch)
  const [otherTask, setOtherTask] = useState(name)
  const [otherRun, setOtherRun] = useState(String(Math.max(1, run - 1)))
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [suggestionsTruncated, setSuggestionsTruncated] = useState(false)
  const [comparison, setComparison] = useState<RunComparison>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)

  useEffect(() => {
    request.current?.abort()
    setComparison(undefined)
    setError('')
    setLoading(false)
    setOtherTask(name)
    setOtherRun(String(Math.max(1, run - 1)))
    return () => { request.current?.abort() }
  }, [name, run, workspaceEpoch])

  useEffect(() => {
    const controller = new AbortController()
    setSuggestions([])
    setSuggestionsTruncated(false)
    if (!otherTask.trim()) return () => controller.abort()
    const timer = window.setTimeout(() => {
      void api.getTasks({
        query: otherTask.trim(), searchField: 'name', summary: true, compact: true,
        includeLogs: false, limit: 20, sort: 'name_asc', refresh: false,
      }, controller.signal).then(page => {
        if (controller.signal.aborted) return
        setSuggestions(page.items.map(task => task.name))
        setSuggestionsTruncated(page.has_more)
      }).catch(() => { /* An exact task name remains usable when suggestions fail. */ })
    }, 250)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [otherTask, workspaceEpoch])

  const edit = () => {
    request.current?.abort()
    setLoading(false)
    setComparison(undefined)
    setError('')
  }
  const compare = async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setComparison(undefined)
    setError('')
    try {
      const result = await api.compareRuns(name, run, otherTask.trim(), Number(otherRun), controller.signal)
      if (!controller.signal.aborted) setComparison(result)
    } catch (caught) {
      if (!controller.signal.aborted) setError(errorMessage(caught))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  const metrics = comparison ? comparison.metric_rows ?? metricRows(comparison.left.record ?? {}, comparison.right.record ?? {}) : []
  const diff = comparison?.input_diff
  return (
    <section className="space-y-3 border-t border-border-subtle pt-3" aria-label={`Compare runs for ${name}@${run}`}>
      <p className="text-xs leading-5 text-txt-secondary">Compare {name}@{run} with any run in this workspace. Enter a task name and its run number.</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void compare() }}>
        <label htmlFor={`${id}-task`} className="min-w-0 flex-1 basis-40 space-y-1 text-xs text-txt-secondary">
          <span className="block">Baseline task</span>
          <input id={`${id}-task`} required list={`${id}-tasks`} value={otherTask} onChange={event => { edit(); setOtherTask(event.target.value) }}
            className="touch-input min-h-11 w-full min-w-0 rounded-md border border-border bg-surface-base px-2.5 py-2 text-txt-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-9" />
          <datalist id={`${id}-tasks`}>{suggestions.map(task => <option key={task} value={task} />)}</datalist>
        </label>
        <label htmlFor={`${id}-run`} className="w-24 space-y-1 text-xs text-txt-secondary">
          <span className="block">Baseline run</span>
          <input id={`${id}-run`} type="number" required min={1} step={1} value={otherRun} onChange={event => { edit(); setOtherRun(event.target.value) }}
            className="touch-input min-h-11 w-full rounded-md border border-border bg-surface-base px-2.5 py-2 tabular-nums text-txt-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-9" />
        </label>
        <ActionButton type="submit" variant="secondary" disabled={loading || !otherTask.trim()}>{loading ? 'Comparing…' : 'Compare'}</ActionButton>
      </form>
      {suggestionsTruncated && <p className="text-xs text-txt-secondary">Showing 20 task suggestions. Type more characters or enter the exact name.</p>}
      {loading && <p role="status" className="text-xs text-txt-secondary">Loading run comparison…</p>}
      {error && <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">{error}</p>}
      {comparison && <div className="space-y-4" aria-label="Run comparison results">
        <div><h4 className="text-xs font-semibold text-txt-primary">Run summary</h4><ComparisonTable comparison={comparison} rows={summaryRows(comparison.left, comparison.right)} /></div>
        <div>
          <h4 className="text-xs font-semibold text-txt-primary">Summary metrics</h4>
          {metrics.length ? <ComparisonTable comparison={comparison} rows={metrics} /> : <p className="py-2 text-xs text-txt-secondary">No summary metrics recorded.</p>}
          {metrics.some(row => row.delta !== null && row.changed) && <p className="text-xs text-txt-secondary">Δ = selected run − baseline. Metric direction depends on the experiment.</p>}
        </div>
        <details><summary className="min-h-11 cursor-pointer py-2 text-xs font-semibold text-txt-primary">Runtime environment</summary><ComparisonTable comparison={comparison} rows={environmentRows(comparison.left, comparison.right)} /></details>
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-txt-primary">Saved input differences</h4>
          <p className="text-xs text-txt-secondary">{!diff?.available
            ? `Input was not saved for ${[comparison.left, comparison.right].filter(item => !item.input_available).map(item => item.reference).join(' and ')}. Other run details remain comparable.`
            : diff.equal ? 'Run inputs are identical.' : `${diff.changed_fields.length} input fields changed.`}</p>
          {diff?.diff && <div className="overflow-hidden rounded-md bg-surface-base">
            <div className="flex justify-end px-3 pt-2"><CopyButton value={diff.diff} label="Copy input differences" size="xs" /></div>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap px-3 pb-3 font-mono text-xs leading-relaxed text-txt-primary [overflow-wrap:anywhere]">{diff.diff}</pre>
          </div>}
        </div>
      </div>}
    </section>
  )
}
