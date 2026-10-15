import { useEffect, useRef, useState } from 'react'
import * as api from '@/api'
import type { RunInput, RunInputDiff } from '@/types'
import { errorMessage } from '@/utils/errors'
import ActionButton from '@/components/shared/ActionButton'
import CopyButton from '@/components/shared/CopyButton'

export default function RunInputView({ name, run }: { name: string; run: number }) {
  const [mode, setMode] = useState<'input' | 'diff' | null>(null)
  const [input, setInput] = useState<RunInput | null>()
  const [diff, setDiff] = useState<RunInputDiff>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])

  const load = async (next: 'input' | 'diff') => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setMode(next)
    setError('')
    setLoading(true)
    try {
      if (next === 'input') {
        const result = await api.getRunInput(name, run, controller.signal)
        if (!controller.signal.aborted) setInput(result.input)
      } else {
        const result = await api.getRunInputDiff(name, run, run - 1, controller.signal)
        if (!controller.signal.aborted) setDiff(result)
      }
    } catch (caught) {
      if (!controller.signal.aborted) setError(errorMessage(caught))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }
  const text = mode === 'input' ? input?.payload_text : diff?.diff

  return (
    <div className="mt-3 space-y-2" aria-label={`Saved input for run ${run}`}>
      <div className="flex flex-wrap gap-1">
        <ActionButton onClick={() => void load('input')} aria-pressed={mode === 'input'}>Saved input</ActionButton>
        {run > 1 && <ActionButton onClick={() => void load('diff')} aria-pressed={mode === 'diff'}>Compare with previous run</ActionButton>}
      </div>
      {loading && <p className="text-xs text-txt-secondary" role="status">Loading saved input…</p>}
      {error && <p className="text-xs text-rose-500" role="alert">{error}</p>}
      {!loading && !error && mode === 'input' && input === null && (
        <p className="text-xs text-txt-secondary">Input was not saved for this run.</p>
      )}
      {!loading && !error && mode === 'input' && input && (
        <dl className="space-y-1 break-all text-xs text-txt-secondary">
          <div><dt className="inline font-medium">Working directory: </dt><dd className="inline">{input.workdir}</dd></div>
          {input.shell_executable && <div><dt className="inline font-medium">Shell: </dt><dd className="inline">{input.shell_executable}</dd></div>}
          <div><dt className="inline font-medium">Saved overrides: </dt><dd className="inline font-mono">{JSON.stringify(input.environment)}</dd></div>
        </dl>
      )}
      {!loading && !error && mode === 'diff' && diff && (
        <p className="text-xs text-txt-secondary">
          {!diff.available ? 'Saved input is unavailable for one of these runs.' : diff.equal ? 'Run inputs are identical.' : `${diff.left.reference} → ${diff.right.reference}`}
        </p>
      )}
      {!loading && !error && text && (
        <div className="overflow-hidden rounded-md bg-surface-base">
          <div className="flex items-center justify-between gap-2 px-3 pt-2">
            <span className="text-xs text-txt-secondary">{mode === 'input' ? 'Input captured before launch' : 'Input differences'}</span>
            <CopyButton value={text} label={mode === 'input' ? 'Copy saved input' : 'Copy input differences'} size="xs" />
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all px-3 pb-3 pt-1 font-mono text-xs leading-relaxed text-txt-primary">{text}</pre>
        </div>
      )}
    </div>
  )
}
