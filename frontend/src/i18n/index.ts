import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import common from './locales/common'
import tasks from './locales/tasks'
import creation from './locales/creation'
import runtime from './locales/runtime'
import onboarding from './locales/onboarding'

export { useTranslation } from 'react-i18next'
export type Language = 'en' | 'zh-CN'
export const LANGUAGE_STORAGE_KEY = 'pyruns_language'

export function resolveLanguage(stored: string | null, browserLanguages: readonly string[]): Language {
  if (stored === 'en' || stored === 'zh-CN') return stored
  return browserLanguages[0]?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

function initialLanguage(): Language {
  if (typeof window === 'undefined') return 'en'
  let stored: string | null = null
  try {
    stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
  } catch {
    // The browser preference still works when storage is unavailable.
  }
  return resolveLanguage(stored, typeof navigator === 'undefined' ? [] : navigator.languages)
}

const chinese = { ...tasks, ...creation, ...runtime, ...common, ...onboarding }
const english = Object.fromEntries(Object.keys(chinese).map(key => [key, key]))

void i18n.use(initReactI18next).init({
  resources: { en: { translation: english }, 'zh-CN': { translation: chinese } },
  lng: initialLanguage(),
  fallbackLng: 'en',
  supportedLngs: ['en', 'zh-CN'],
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnEmptyString: false,
})

function applyLanguage(language: string) {
  if (typeof document !== 'undefined') document.documentElement.lang = language
}

applyLanguage(i18n.language)
i18n.on('languageChanged', language => {
  applyLanguage(language)
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    // Keep the current language for this session.
  }
})

export function setLanguage(language: Language) {
  return i18n.changeLanguage(language)
}

export function translateMessage(message: string): string {
  return i18n.exists(message) ? i18n.t(message) : message
}

export const t: typeof i18n.t = i18n.t.bind(i18n)
export default i18n
