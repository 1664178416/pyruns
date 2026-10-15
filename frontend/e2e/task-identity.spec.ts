import { expect, test } from '@playwright/test'

for (const field of ['notes', 'env'] as const) {
  test(`a ${field} draft cannot overwrite a replacement task with the same name`, async ({ page }) => {
    let identity = 'original-task'
    let notes = ''
    let env: Record<string, string> = {}
    const task = () => ({
      name: 'alpha', status: 'pending', task_kind: 'shell', dir: '/tmp/alpha',
      task_identity: identity, config_file: '/tmp/alpha/config.sh',
      config_text: 'echo alpha', preview_text: 'echo alpha',
      created_at: '2026-10-15_12-00-00', run_index: 0, pinned: false, notes, env,
    })
    await page.route('**/api/tasks?*', route => route.fulfill({ json: {
      items: [task()], total: 1, offset: 0, limit: 50, has_more: false,
    } }))
    await page.route('**/api/tasks/alpha?*', route => route.fulfill({ json: task() }))
    const writes: string[] = []
    await page.route(`**/api/tasks/alpha/${field}?*`, route => {
      const payload = route.request().postDataJSON()
      writes.push(payload.expected_task_identity)
      if (payload.expected_task_identity !== identity) {
        return route.fulfill({ status: 409, json: { detail: 'Task identity changed.' } })
      }
      if (field === 'notes') notes = payload.notes
      else env = payload.env
      return route.fulfill({ json: { ok: true, task: task() } })
    })

    await page.goto('/manager?token=pyruns-e2e-access-token')
    const open = page.getByRole('button', { name: 'Open details for alpha' })
    await open.click()
    await page.getByRole('tab', { name: field === 'notes' ? 'Notes' : 'Env', exact: true }).click()
    const draft = field === 'notes'
      ? page.getByRole('textbox', { name: 'Task notes' })
      : page.getByRole('textbox', { name: 'Environment variable value' })
    if (field === 'env') {
      await page.getByRole('button', { name: 'Add environment variable' }).click()
      await page.getByRole('textbox', { name: 'Environment variable key' }).fill('LOCAL')
    }
    await draft.fill('original draft')
    identity = 'replacement-task'
    const save = page.getByRole('button', { name: field === 'notes' ? 'Save Notes' : 'Save', exact: true })
    await save.click()
    await expect(page.getByText('This task was replaced. Your draft is safe. Close and reopen task details before editing the new task.')).toBeVisible()
    await expect(draft).toHaveValue('original draft')
    await expect(page.getByRole('button', { name: field === 'notes' ? 'Replace Notes' : 'Replace Env' })).toBeHidden()
    // Retrying must retain the original identity instead of rebasing onto the replacement.
    await save.click()
    await expect.poll(() => writes.length).toBe(2)
    expect(writes).toEqual(['original-task', 'original-task'])
    expect(notes).toBe('')
    expect(env).toEqual({})

    await page.getByRole('button', { name: 'Close task details' }).click()
    await page.getByRole('dialog', { name: 'Discard changes?' }).getByRole('button', { name: 'Discard', exact: true }).click()
    await open.click()
    await page.getByRole('tab', { name: field === 'notes' ? 'Notes' : 'Env', exact: true }).click()
    if (field === 'env') {
      await page.getByRole('button', { name: 'Add environment variable' }).click()
      await page.getByRole('textbox', { name: 'Environment variable key' }).fill('NEW')
    }
    await draft.fill('replacement draft')
    await save.click()
    await expect.poll(() => writes.length).toBe(3)
    expect(writes[2]).toBe('replacement-task')
    await expect(page.getByRole('button', { name: field === 'notes' ? 'Save Notes' : 'Saved', exact: true })).toBeDisabled()
    if (field === 'notes') expect(notes).toBe('replacement draft')
    else expect(env).toEqual({ NEW: 'replacement draft' })
  })
}
