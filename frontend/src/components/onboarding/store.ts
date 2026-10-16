import { create } from 'zustand'

export const ONBOARDING_STORAGE_KEY = 'pyruns.onboarding.v1'

type Phase = 'idle' | 'welcome' | 'tour'
type Outcome = 'seen' | 'dismissed' | 'completed'

function hasSeenTour() {
  try {
    return ['seen', 'dismissed', 'completed'].includes(window.localStorage.getItem(ONBOARDING_STORAGE_KEY) || '')
  } catch {
    return false
  }
}

function remember(outcome: Outcome) {
  try {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, outcome)
  } catch {
    // The in-memory flag still prevents repeated prompts in this session.
  }
}

interface OnboardingState {
  phase: Phase
  hasSeen: boolean
  returnFocus: HTMLElement | null
  open: (returnFocus?: HTMLElement | null) => void
  start: () => void
  finish: (completed?: boolean) => void
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  phase: 'idle',
  hasSeen: hasSeenTour(),
  returnFocus: null,
  open(returnFocus) {
    if (get().phase !== 'idle') return
    remember('seen')
    set({
      phase: 'welcome',
      hasSeen: true,
      returnFocus: returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null),
    })
  },
  start: () => set({ phase: 'tour' }),
  finish(completed = false) {
    const target = get().returnFocus
    remember(completed ? 'completed' : 'dismissed')
    set({ phase: 'idle', hasSeen: true, returnFocus: null })
    window.requestAnimationFrame(() => {
      if (get().phase === 'idle' && !document.querySelector('dialog[open]')) {
        const fallback = document.querySelector<HTMLElement>('[data-tour="preferences"]')
        ;(target?.isConnected ? target : fallback)?.focus({ preventScroll: true })
      }
    })
  },
}))
