import { t, useTranslation } from '@/i18n'
import { useEffect, useRef, useState } from 'react'
import * as api from '@/api'
import type { RunInput } from '@/types'
import { errorMessage } from '@/utils/errors'
import ActionButton from '@/components/shared/ActionButton'
import CopyButton from '@/components/shared/CopyButton'
import RunComparisonView from './RunComparisonView'

export default function RunInputView({ name, run }: { name: string; run: number }) {
  useTranslation()
  const [mode, setMode] = useState<'input' | 'compare' | null>(null)
  const [input, setInput] = useState<RunInput | null>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])

  const load = async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setMode('input')
    setError('')
    setLoading(true)
    try {
      const result = await api.getRunInput(name, run, controller.signal)
      if (!controller.signal.aborted) setInput(result.input)
    } catch (caught) {
      if (!controller.signal.aborted) setError(errorMessage(caught))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }
  const text = mode === 'input' ? input?.payload_text : undefined

  return (
    <div className="mt-3 space-y-2" aria-label={t('Saved input for run {{run}}', { run })}>
      <div className="flex flex-wrap gap-1">
        <ActionButton onClick={() => void load()} aria-pressed={mode === 'input'}>{t('Saved input')}</ActionButton>
        <ActionButton onClick={() => { request.current?.abort(); setLoading(false); setError(''); setMode(mode === 'compare' ? null : 'compare') }} aria-expanded={mode === 'compare'}>{t('Compare runs')}</ActionButton>
      </div>
      {mode === 'compare' && <RunComparisonView name={name} run={run} />}
      {loading && <p className="text-xs text-txt-secondary" role="status">{t('Loading saved input…')}</p>}
      {error && <p className="text-xs text-rose-500" role="alert">{error}</p>}
      {!loading && !error && mode === 'input' && input === null && (
        <p className="text-xs text-txt-secondary">{t('Input was not saved for this run.')}</p>
      )}
      {!loading && !error && mode === 'input' && input && (
        <dl className="space-y-1 break-all text-xs text-txt-secondary">
          <div><dt className="inline font-medium">{t('Working directory')}: </dt><dd className="inline">{input.workdir}</dd></div>
          {input.shell_executable && <div><dt className="inline font-medium">{t('Shell')}: </dt><dd className="inline">{input.shell_executable}</dd></div>}
          <div><dt className="inline font-medium">{t('Saved overrides')}: </dt><dd className="inline font-mono">{JSON.stringify(input.environment)}</dd></div>
        </dl>
      )}
      {!loading && !error && text && (
        <div className="overflow-hidden rounded-md bg-surface-base">
          <div className="flex items-center justify-between gap-2 px-3 pt-2">
            <span className="text-xs text-txt-secondary">{t('Input captured before launch')}</span>
            <CopyButton value={text} label={t('Copy saved input')} size="xs" />
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all px-3 pb-3 pt-1 font-mono text-xs leading-relaxed text-txt-primary">{text}</pre>
        </div>
      )}
    </div>
  )
}
