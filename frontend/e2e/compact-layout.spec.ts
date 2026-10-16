import { expect, test, type Locator, type Page } from '@playwright/test'

const taskName = 'controlled-memory-comparison-with-a-long-experiment-name_2026-10-16_12-01-36'

async function mockWorkspace(page: Page, taskCount = 1) {
  const workspace = {
    run_root: '/experiments/memory/_pyruns_', working_root: '/experiments/memory',
    tasks_dir: '/experiments/memory/_pyruns_/tasks', workspace_kind: 'shell',
    workspace_ready: true, script_path: '', script_name: 'Shell',
    native_file_picker: false, settings: {}, templates: [],
  }
  const task = {
    name: taskName, dir: `/experiments/memory/${taskName}`, status: 'completed',
    task_kind: 'shell', run_index: 2, created_at: '2026-10-16_12-01-36',
    config: {}, config_text: 'printf "recorded command\\n"', config_file: 'config.sh',
    preview_text: '', pinned: false, notes: '', env: {}, progress: 100,
    start_times: [], finish_times: [], pids: [], records: [], tracks: [],
  }
  const tasks = Array.from({ length: taskCount }, (_, index) => index === 0 ? task : {
    ...task, name: `layout-task-${index}`, dir: `/experiments/memory/layout-task-${index}`,
  })
  const summary = { total: 9, pending: 0, queued: 0, running: 0, completed: 8, failed: 1, cancelled: 0 }
  await page.addInitScript(() => localStorage.setItem('pyruns_language', 'en'))
  await page.route('**/api/workspace', route => route.fulfill({ json: workspace }))
  await page.route('**/api/dashboard?*', route => route.fulfill({ json: {
    workspace, summary, recent_tasks: [task], template_count: 0, active_task: null,
  } }))
  await page.route('**/api/system/metrics**', route => route.fulfill({ json: {
    cpu_percent: 11, mem_percent: 24,
    gpus: Array.from({ length: 6 }, (_, index) => ({
      id: index, index, uuid: `GPU-${index}`, name: 'NVIDIA A100-PCIE-40GB',
      util: index * 18, mem_used: index * 5120, mem_total: 40960, processes: [],
    })),
  } }))
  await page.route('**/api/tasks?*', route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset') || 0)
    return route.fulfill({ json: {
      items: tasks.slice(offset, offset + 200), total: taskCount, offset, limit: 200,
      has_more: offset + 200 < taskCount,
      status_counts: { ...summary, total: taskCount, completed: taskCount, failed: 0 },
    } })
  })
  await page.route(`**/api/tasks/${taskName}?*`, route => route.fulfill({ json: task }))
  await page.route(`**/api/tasks/${taskName}/logs?*`, route => {
    const selected = new URL(route.request().url()).searchParams.get('log_file_name') || 'run2.log'
    return route.fulfill({ json: {
      task_name: taskName, content: 'recorded command\n', offset: 17,
      selected_log: selected, available_logs: ['run1.log', 'run2.log'], log_identity: selected,
    } })
  })
  await page.routeWebSocket('**/api/tasks/events?*', socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
  })
}

async function expectInsideViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  const viewport = page.viewportSize()!
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1)
}

test('desktop keeps six GPUs and recent work compact without crowding log actions', async ({ page, isMobile }, testInfo) => {
  test.skip(isMobile, 'Desktop density is checked with a fine pointer.')
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockWorkspace(page, 201)
  await page.goto('/?token=pyruns-e2e-access-token')

  const gpus = page.getByRole('button', { name: /^View details for GPU \d / })
  await expect(gpus).toHaveCount(6)
  const gpuSurface = await gpus.first().evaluate(element => getComputedStyle(element).backgroundColor)
  const gpuChannels = gpuSurface.match(/\d+/g)?.map(Number) ?? []
  expect(gpuChannels).toHaveLength(3)
  // GPU telemetry uses a pale, low-saturation surface in the light theme.
  // Keep this guard broad enough for theme tuning while preventing a return to
  // dark/navy cards that disappear against the white dashboard.
  expect(Math.min(...gpuChannels)).toBeGreaterThanOrEqual(220)
  expect(Math.max(...gpuChannels) - Math.min(...gpuChannels)).toBeLessThanOrEqual(28)
  for (const gpu of await gpus.all()) {
    const box = await gpu.boundingBox()
    expect(box!.height).toBeLessThanOrEqual(100)
  }
  const recentTask = page.getByRole('button').filter({ hasText: taskName })
  await expectInsideViewport(page, recentTask)
  expect((await recentTask.boundingBox())!.y).toBeLessThanOrEqual(500)
  await page.screenshot({ path: testInfo.outputPath('compact-dashboard-desktop.png') })

  await recentTask.click()
  const actions = page.getByRole('toolbar', { name: 'Log actions' })
  await expect(actions).toBeVisible()
  // Measure the common task context and action container, without depending on CSS utilities.
  const header = actions.locator('xpath=../..')
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(48)
  for (const action of [
    page.getByRole('combobox', { name: 'Select task log file' }),
    actions.getByRole('button', { name: 'View Details', exact: true }),
    actions.getByRole('button', { name: 'Copy current log', exact: true }),
    actions.getByRole('button', { name: 'Run', exact: true }),
  ]) await expectInsideViewport(page, action)
  const pagination = page.getByLabel('Monitor task pagination', { exact: true })
  const footer = pagination.locator('xpath=..')
  expect((await pagination.boundingBox())!.height).toBeLessThanOrEqual(32)
  expect((await footer.boundingBox())!.height).toBeLessThanOrEqual(88)
  await expectInsideViewport(page, footer.getByRole('button', { name: 'Export', exact: true }))
  await pagination.getByRole('button', { name: 'Next page', exact: true }).click()
  await expect(pagination).toContainText('201')
  await expect(pagination.getByRole('button', { name: 'Previous page', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'View layout-task-200, completed', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('compact-monitor-desktop.png') })
})

test('375px layout keeps GPU details and log controls reachable without horizontal overflow', async ({ page, isMobile }, testInfo) => {
  test.skip(!isMobile, 'The narrow layout is checked with touch input.')
  await page.setViewportSize({ width: 375, height: 812 })
  await mockWorkspace(page)
  await page.goto('/?token=pyruns-e2e-access-token')
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'View details for GPU 0 NVIDIA A100-PCIE-40GB' }).click()
  const gpuDialog = page.getByRole('dialog', { name: 'GPU 0 | NVIDIA A100-PCIE-40GB' })
  await expect(gpuDialog).toBeVisible()
  await gpuDialog.getByRole('button', { name: 'Close GPU details' }).click()
  const gpuRow = page.getByRole('button', { name: 'View details for GPU 0 NVIDIA A100-PCIE-40GB' })
  const usageTracks = gpuRow.locator('.gpu-usage-track')
  await expect(usageTracks).toHaveCount(2)
  for (const track of await usageTracks.all()) {
    const box = await track.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThan(120)
    expect(box!.x + box!.width).toBeLessThanOrEqual(375)
  }
  await page.screenshot({ path: testInfo.outputPath('compact-dashboard-mobile.png') })

  await page.getByRole('link', { name: 'Monitor', exact: true }).click()
  const selectLog = page.getByRole('combobox', { name: 'Select task log file' })
  await expectInsideViewport(page, selectLog)
  await selectLog.selectOption('run1.log')
  await expect(selectLog).toHaveValue('run1.log')
  const details = page.getByRole('button', { name: 'View Details', exact: true })
  await expectInsideViewport(page, details)
  await details.click()
  await expect(page.getByRole('dialog', { name: `Task details for ${taskName}`, exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('compact-monitor-mobile.png') })
})
