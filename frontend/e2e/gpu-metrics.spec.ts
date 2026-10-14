import { expect, test } from '@playwright/test'

test('GPU rules use free GiB and idle percent and retain fractional wait hours', async ({ page }, testInfo) => {
  await page.route('**/api/system/metrics**', route => route.fulfill({ json: {
    cpu_percent: 5, mem_percent: 10,
    gpus: [
      { id: 0, index: 0, name: 'GPU rule preview', uuid: 'GPU-0',
        util: 20, mem_used: 8192, mem_total: 24576, processes: [] },
      { id: 1, index: 1, name: 'GPU rule preview', uuid: 'GPU-1',
        util: 10, mem_used: 8192, mem_total: 24576, processes: [] },
    ],
  } }))
  await page.goto('/?token=pyruns-e2e-access-token')
  await page.getByRole('button', { name: 'Runtime', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Runtime settings' })
  await panel.getByRole('tab', { name: 'GPU', exact: true }).click()
  const enabled = panel.getByRole('switch', { name: 'GPU scheduling', exact: true })
  if (await enabled.getAttribute('aria-checked') !== 'true') await enabled.click()
  await panel.getByLabel('GPUs required', { exact: false }).fill('2')
  await panel.getByLabel('Minimum free memory', { exact: false }).fill('8')
  await panel.getByLabel('Minimum GPU idle', { exact: false }).fill('70')
  await panel.getByLabel('Stable for', { exact: false }).fill('0')
  await panel.getByLabel('Maximum wait', { exact: false }).fill('0.25')
  const preview = panel.getByRole('button', { name: /GPU 0 · GPU rule preview/ })
  await expect(preview).toContainText('Pass')
  await panel.getByLabel('Minimum GPU idle', { exact: false }).fill('90')
  await expect(preview).toContainText('Blocked')
  await preview.click()
  await expect(panel.getByText('• GPU idle 80% is below 90%')).toBeVisible()
  await expect(panel.getByText('Maximum memory use', { exact: true })).toHaveCount(0)
  await expect(panel.getByText('Tasks per GPU', { exact: true })).toHaveCount(0)
  const saved = page.waitForResponse(response => response.url().includes('/api/runtime') && response.request().method() === 'PATCH')
  await panel.getByRole('button', { name: 'Save', exact: true }).click()
  const response = await saved
  expect(response.ok()).toBe(true)
  const runtime = await response.json()
  expect(runtime.gpu_scheduler.gpus_per_task).toBe(2)
  expect(runtime.gpu_scheduler.task_mode).toBe('multi')
  expect(runtime.gpu_scheduler.min_idle_pct).toBe(90)
  expect(runtime.gpu_scheduler.stable_seconds).toBe(0)
  expect(runtime.gpu_scheduler.max_wait_seconds).toBe(900)
  await expect(panel.getByLabel('Maximum wait', { exact: false })).toHaveValue('0.25')
  await page.screenshot({ path: testInfo.outputPath('gpu-fixed-units.png'), fullPage: true })
})

test('unavailable GPU readings remain visible and cannot pass the scheduling preview', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/system/metrics**', route => route.fulfill({ json: {
    cpu_percent: 5, mem_percent: 10,
    gpus: [{
      id: 0, index: 0, name: 'Unknown readings GPU', uuid: 'GPU-UNKNOWN',
      util: null, mem_used: null, mem_total: 81920, processes: [],
    }],
  } }))

  await page.goto('/?token=pyruns-e2e-access-token')
  const card = page.getByRole('button', { name: 'View details for GPU 0 Unknown readings GPU' })
  await expect(card).toBeVisible()
  await expect(card).toContainText('Unknown')
  await expect(card).not.toContainText('0%')
  await card.click()
  const dialog = page.getByRole('dialog', { name: 'GPU 0 | Unknown readings GPU' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Unknown', { exact: true })).toHaveCount(2)
  await expect(dialog.getByText('Unknown / 80 GB', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close GPU details' }).click()

  await page.getByRole('button', { name: 'Runtime', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Runtime settings' })
  await panel.getByRole('tab', { name: 'GPU', exact: true }).click()
  const enabled = panel.getByRole('switch', { name: 'GPU scheduling', exact: true })
  if (await enabled.getAttribute('aria-checked') !== 'true') await enabled.click()
  const preview = panel.getByRole('button', { name: /GPU 0 · Unknown readings GPU/ })
  await expect(preview).toContainText('Blocked')
  await preview.click()
  await expect(panel.getByText('• Memory metrics unavailable; waiting for a valid reading.')).toBeVisible()
  await expect(panel.getByText('• Compute metrics unavailable; waiting for a valid reading.')).toBeVisible()
  await expect(panel.getByText('All current thresholds pass.', { exact: false })).toHaveCount(0)
  expect(errors).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('gpu-unavailable.png'), fullPage: true })
})
