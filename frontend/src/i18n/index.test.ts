import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n, { LANGUAGE_STORAGE_KEY, resolveLanguage, setLanguage, t, translateMessage } from './index'

afterEach(async () => {
  vi.unstubAllGlobals()
  await setLanguage('en')
})

describe('interface language', () => {
  it('uses the saved supported choice before the browser language', () => {
    expect(resolveLanguage('en', ['zh-CN'])).toBe('en')
    expect(resolveLanguage('zh-CN', ['en-US'])).toBe('zh-CN')
    expect(resolveLanguage(null, ['zh-TW', 'en'])).toBe('zh-CN')
    expect(resolveLanguage('invalid', ['en-US', 'zh-CN'])).toBe('en')
    expect(resolveLanguage(null, [])).toBe('en')
  })

  it('changes language and preserves interpolation data literally', async () => {
    await setLanguage('zh-CN')
    expect(t('Preferences')).toBe('偏好设置')
    expect(t('Matches in {{name}}', { name: '<task.name>: run' })).toBe('<task.name>: run 中的匹配')
    expect(t('Something not translated: details.')).toBe('Something not translated: details.')
    await setLanguage('en')
    expect(t('Preferences')).toBe('Preferences')
    expect(t('Matches in {{name}}', { name: 'train.py' })).toBe('Matches in train.py')
  })

  it('updates the document language and saves the selection', async () => {
    const setItem = vi.fn()
    vi.stubGlobal('window', { localStorage: { setItem } })
    vi.stubGlobal('document', { documentElement: { lang: 'en' } })
    await setLanguage('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(setItem).toHaveBeenCalledWith(LANGUAGE_STORAGE_KEY, 'zh-CN')
  })

  it('works when browser storage is blocked', async () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('Storage blocked') } })
    await expect(setLanguage('zh-CN')).resolves.toBeDefined()
    expect(i18n.resolvedLanguage).toBe('zh-CN')
  })

  it('preserves unknown diagnostic text containing translation syntax', async () => {
    await setLanguage('zh-CN')
    expect(translateMessage('Something went wrong.')).toBe('发生错误。')
    expect(translateMessage('Cannot open $t(Save).py')).toBe('Cannot open $t(Save).py')
  })

  it('keeps every named interpolation value in the Chinese resources', () => {
    const placeholders = (text: string) => [...new Set(Array.from(text.matchAll(/\{\{\s*([^},\s]+)[^}]*\}\}/g), match => match[1]))].sort()
    const resources = i18n.getResourceBundle('zh-CN', 'translation') as Record<string, string>
    for (const [source, translation] of Object.entries(resources)) {
      expect(placeholders(translation), source).toEqual(placeholders(source))
    }
  })
})
