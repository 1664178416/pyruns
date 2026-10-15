import { expect, test, type Page } from '@playwright/test'

const task = (name: string) => ({
  name, status: 'completed', task_kind: 'shell', dir: `/workspace/tasks/${name}`,
  config: {}, config_text: 'echo task', config_file: 'config.sh', preview_text: 'echo task',
  created_at: '2026-10-15_10-00-00', run_index: 2, pinned: false, notes: '', env: {},
  start_times: ['2026-10-15_10-00-00', '2026-10-15_11-00-00'],
  finish_times: ['2026-10-15_10-00-10', '2026-10-15_11-00-20'],
  durations: [10, 20], pids: [1, 2], exit_codes: [0, 1], run_statuses: ['completed', 'failed'],
  records: [], tracks: [],
})

function comparison(leftName = 'baseline', leftRun = 1, rightName = 'candidate', saved = true) {
  const run = (name: string, index: number) => ({
    task_name: name, run_index: index, reference: `${name}@${index}`, status: 'completed',
    start_time: '2026-10-15_10-00-00', finish_time: '2026-10-15_10-00-10',
    duration_seconds: index === 1 ? 10 : 20, exit_code: 0, source_state: 'Git abc123 clean',
    environment: { host: `server-${index}`, system: 'Linux', launcher: '/usr/bin/bash',
      assigned_gpu_ids: [], cuda_visible_devices: null, gpu_scope: 'detected', gpu_status: 'ok', gpus: [] },
    record: { accuracy: index === 1 ? 0 : 0.9, enabled: index !== 1, nested: { score: index } },
    input_available: name === rightName || saved,
  })
  return {
    schema_version: 1, left: run(leftName, leftRun), right: run(rightName, 2), input_diff: {
      schema_version: 1, available: saved, equal: saved ? false : null, changed_fields: saved ? ['payload_text'] : [],
      left: { reference: `${leftName}@${leftRun}`, available: saved }, right: { reference: `${rightName}@2`, available: true },
      diff: saved ? `--- ${leftName}@${leftRun}\n+++ ${rightName}@2\n-echo before\n+echo after\n` : '',
    },
  }
}

async function openComparison(page: Page, name = 'candidate') {
  await page.getByRole('button', { name: `Open details for ${name}` }).click()
  const panel = page.getByRole('dialog', { name: `Task details for ${name}` })
  const history = panel.locator('details').filter({ has: page.locator('summary').filter({ hasText: 'Run #2' }) })
  await history.locator('summary').click()
  await history.getByRole('button', { name: 'Compare runs', exact: true }).click()
  return panel.getByRole('region', { name: `Compare runs for ${name}@2` })
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/tasks?*', route => {
    const query = new URL(route.request().url()).searchParams.get('query')
    const tasks = ['candidate', 'baseline'].filter(name => !query || name.includes(query)).map(task)
    return route.fulfill({ json: { items: tasks, total: tasks.length, offset: 0, limit: 50, has_more: false,
      status_counts: { pending: 0, queued: 0, running: 0, completed: 2, failed: 0, cancelled: 0 } } })
  })
  for (const name of ['candidate', 'baseline']) {
    await page.route(`**/api/tasks/${name}?*`, route => route.fulfill({ json: task(name) }))
  }
})

test('compares arbitrary task runs on demand and retains metrics when an old input is missing', async ({ page }, testInfo) => {
  let comparisons = 0
  await page.route('**/api/tasks/candidate/runs/2/compare?*', route => {
    comparisons += 1
    const params = new URL(route.request().url()).searchParams
    const result = comparison(params.get('other_task')!, Number(params.get('other_run')), 'candidate', params.get('other_task') !== 'baseline')
    if (params.get('other_task') === 'candidate' && params.get('other_run') === '2') {
      result.input_diff.equal = true
      result.input_diff.changed_fields = []
      result.input_diff.diff = ''
    }
    return route.fulfill({ json: result })
  })
  await page.goto('/manager?token=pyruns-e2e-access-token')
  const region = await openComparison(page)
  expect(comparisons).toBe(0)
  await expect(region.getByLabel('Baseline task')).toHaveValue('candidate')
  await expect(region.getByLabel('Baseline run')).toHaveValue('1')
  await region.getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(region).toContainText('-echo before')
  await expect(region).toContainText('+echo after')
  await region.getByLabel('Baseline run').fill('2')
  await region.getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(region).toContainText('Run inputs are identical.')
  await region.getByLabel('Baseline task').fill('baseline')
  await region.getByLabel('Baseline run').fill('1')
  await expect(region.getByLabel('Run comparison results')).toHaveCount(0)
  await region.getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(region).toContainText('Input was not saved for baseline@1. Other run details remain comparable.')
  await expect(region.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'accuracy', exact: true }) })).toContainText('Δ +0.9')
  await expect(region.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'enabled', exact: true }) })).toContainText('false')
  await expect(region).toContainText('Git abc123 clean')
  await region.getByText('Runtime environment', { exact: true }).click()
  await expect(region).toContainText('server-1')
  await expect(region).toContainText('server-2')
  expect(comparisons).toBe(3)
  await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true)
  await page.screenshot({ path: testInfo.outputPath('run-comparison.png') })
})

test('edits and task switches abort pending comparisons and discard late results', async ({ page }) => {
  const delayed = comparison('delayed', 1)
  delayed.right.source_state = 'STALE COMPARISON MUST NOT APPEAR'
  await page.addInitScript(({ delayed }) => {
    const original = window.fetch.bind(window)
    const state = { aborts: 0, resolve: null as null | (() => void) }
    Object.assign(window, { comparisonRequestTest: state })
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), location.origin)
      if (url.pathname.endsWith('/compare') && url.searchParams.get('other_task') === 'delayed') {
        init?.signal?.addEventListener('abort', () => { state.aborts++ })
        // Simulate a transport that still produces a successful response after cancellation.
        return new Promise<Response>(resolve => { state.resolve = () => resolve(new Response(JSON.stringify(delayed), { status: 200 })) })
      }
      return original(input, init)
    }) as typeof window.fetch
  }, { delayed })
  await page.route('**/api/tasks/*/runs/2/compare?*', route => route.fulfill({ json: comparison() }))
  await page.goto('/manager?token=pyruns-e2e-access-token')
  let region = await openComparison(page)
  await region.getByLabel('Baseline task').fill('delayed')
  await region.getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(region.getByRole('status')).toHaveText('Loading run comparison…')
  await region.getByLabel('Baseline task').fill('baseline')
  await region.getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(region.getByLabel('Run comparison results')).toBeVisible()
  await page.evaluate(() => (window as any).comparisonRequestTest.resolve())
  await expect.poll(() => page.evaluate(() => (window as any).comparisonRequestTest.aborts)).toBe(1)
  await expect(region).not.toContainText('STALE COMPARISON MUST NOT APPEAR')

  await region.getByLabel('Baseline task').fill('delayed')
  await region.getByRole('button', { name: 'Compare', exact: true }).click()
  await expect(region.getByRole('status')).toHaveText('Loading run comparison…')
  await page.getByRole('dialog', { name: 'Task details for candidate' }).getByRole('button', { name: 'Close task details', exact: true }).click()
  region = await openComparison(page, 'baseline')
  await page.evaluate(() => (window as any).comparisonRequestTest.resolve())
  await expect.poll(() => page.evaluate(() => (window as any).comparisonRequestTest.aborts)).toBe(2)
  await expect(region).not.toContainText('STALE COMPARISON MUST NOT APPEAR')
  await expect(region.getByLabel('Baseline task')).toHaveValue('baseline')
  await expect(region.getByLabel('Run comparison results')).toHaveCount(0)
})
