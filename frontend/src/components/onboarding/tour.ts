import { driver, type DriveStep } from 'driver.js'
import type { NavigateFunction } from 'react-router-dom'
import i18n, { t } from '@/i18n'
import 'driver.js/dist/driver.css'
import './tour.css'

type Panel = 'workspace' | 'runtime'

interface TourStep {
  target: string
  title: string
  description: string
  route?: string
  panel?: Panel
  next?: string
  click?: 'next' | 'finish'
  interactive?: boolean
}

const steps: TourStep[] = [
  {
    target: 'home', route: '/', click: 'next',
    title: 'Your overview',
    description: 'Home shows task counts, system resources, and GPU activity. Return here whenever you need an overview.',
  },
  {
    target: 'workspace', route: '/', click: 'next', next: 'Open workspace picker',
    title: 'Choose where you work',
    description: 'This button opens the workspace picker. A workspace keeps related tasks, configuration, and logs together.',
  },
  {
    target: 'workspace-picker', route: '/', panel: 'workspace',
    title: 'Python or Shell',
    description: 'Choose Python for a script and its parameters, or Shell for terminal commands. After the tour, select a real script or folder here.',
  },
  {
    target: 'generator', route: '/', click: 'next', next: 'Open Generator',
    title: 'Build a task',
    description: 'Click Generator to open the task editor. You can also use the button below to continue.',
  },
  {
    target: 'generator-controls', route: '/generator',
    title: 'Edit the task input',
    description: 'Load a saved task or template, then edit its Shell command or Python parameters. The view controls change how parameters are displayed.',
  },
  {
    target: 'generator-create', route: '/generator',
    title: 'Create first, run later',
    description: 'Set a task name and create the task here. Batch parameters can be previewed before creation. Creating a task does not start it.',
  },
  {
    target: 'manager', route: '/generator', click: 'next', next: 'Open Manager',
    title: 'Organize and run',
    description: 'Click Manager to find the tasks you created and choose what to run.',
  },
  {
    target: 'manager-controls', route: '/manager',
    title: 'Find and manage tasks',
    description: 'Search or filter tasks here. Task cards provide run, stop, pin, and detail actions; selecting multiple tasks enables batch actions.',
  },
  {
    target: 'monitor', route: '/manager', click: 'next', next: 'Open Monitor',
    title: 'Follow a run',
    description: 'Click Monitor to follow task output without leaving the interface.',
  },
  {
    target: 'monitor-controls', route: '/monitor',
    title: 'Select a task, read its logs',
    description: 'Find a task in this list to open its terminal output. Running tasks stream new output; completed tasks keep their logs for inspection and search.',
  },
  {
    target: 'runtime', route: '/monitor', click: 'next', next: 'View runtime settings',
    title: 'Check the runtime',
    description: 'Runtime opens Python, environment-variable, and GPU-wait settings for this workspace.',
  },
  {
    target: 'runtime-controls', route: '/monitor', panel: 'runtime',
    title: 'Settings for the next run',
    description: 'These tabs separate Python, environment variables, and GPU settings. Review them before running tasks; this tour does not save any changes.',
  },
  {
    target: 'language', route: '/monitor', interactive: true,
    title: 'Choose your language',
    description: 'Try this button to switch between Chinese and English. Your tasks, commands, and logs keep their original text.',
  },
  {
    target: 'theme', route: '/monitor', interactive: true,
    title: 'Make it comfortable',
    description: 'Try this button to switch between light and dark mode. Your choice is remembered in this browser.',
  },
  {
    target: 'guide', route: '/monitor',
    title: 'Replay the guide from Preferences',
    description: 'Open Preferences to replay this guide whenever you want to review the workflow.',
  },
  {
    target: 'preferences', route: '/monitor', click: 'finish',
    title: 'You are ready',
    description: 'Preferences contains language, appearance, and search options. Click it to explore, or finish the tour and choose a workspace to create your first task.',
  },
]

function waitForTarget(selector: string, signal: AbortSignal): Promise<HTMLElement | null> {
  return new Promise(resolve => {
    let timer: number
    const deadline = Date.now() + 5000
    const finish = (element: HTMLElement | null) => {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolve(element)
    }
    const abort = () => finish(null)
    const check = () => {
      if (signal.aborted) return finish(null)
      const element = document.querySelector<HTMLElement>(selector)
      if (element && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0) {
        finish(element)
      } else if (Date.now() >= deadline) {
        finish(null)
      } else {
        timer = window.setTimeout(check, 50)
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    check()
  })
}

function waitForPath(pathname: string, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    let timer: number
    const deadline = Date.now() + 5000
    const finish = (matched: boolean) => {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolve(matched)
    }
    const abort = () => finish(false)
    const check = () => {
      if (signal.aborted) return finish(false)
      if (window.location.pathname === pathname) return finish(true)
      if (Date.now() >= deadline) return finish(false)
      timer = window.setTimeout(check, 50)
    }
    signal.addEventListener('abort', abort, { once: true })
    check()
  })
}

export function startOnboardingTour({ navigate, onFinish, onError }: {
  navigate: NavigateFunction
  onFinish: (completed: boolean) => void
  onError: () => void
}) {
  let disposed = false
  let completed = false
  let pending: AbortController | undefined
  let removeTargetClick: (() => void) | undefined
  let restoreInteraction: (() => void) | undefined
  const openedPanels = new Set<Panel>()

  function closePanels(except?: Panel) {
    for (const panel of openedPanels) {
      if (panel === except) continue
      document.querySelector<HTMLButtonElement>(`[data-tour-close="${panel}"]`)?.click()
      openedPanels.delete(panel)
    }
  }

  function cleanup() {
    disposed = true
    pending?.abort()
    removeTargetClick?.()
    restoreInteraction?.()
    i18n.off('languageChanged', translateTour)
    closePanels()
  }

  function finish() {
    completed = true
    tour.destroy()
  }

  function localizedSteps(): DriveStep[] {
    return steps.map((step, index) => ({
      element: `[data-tour="${step.target}"]`,
      disableActiveInteraction: !step.click && !step.interactive,
      popover: {
        title: t(step.title),
        description: t(step.description),
        side: 'right',
        align: 'start',
        nextBtnText: t(index === steps.length - 1 ? 'Finish tour' : step.next || 'Next step'),
        prevBtnText: t('Previous step'),
        doneBtnText: t('Finish tour'),
        progressText: t('Step {{current}} of {{total}}', { current: '{{current}}', total: '{{total}}' }),
        onNextClick: () => { void goTo(index + 1) },
        onPrevClick: () => { void goTo(index - 1) },
        onDoneClick: finish,
      },
    }))
  }

  const tour = driver({
    steps: localizedSteps(),
    animate: false,
    smoothScroll: false,
    overlayOpacity: 0.48,
    overlayClickBehavior: 'none',
    stagePadding: 6,
    stageRadius: 8,
    popoverOffset: 12,
    popoverClass: 'pyruns-tour',
    showProgress: true,
    closeBtnLabel: t('Skip tour'),
    onPopoverRender(popover, { index }) {
      popover.wrapper.dataset.tourStep = steps[index ?? 0].target
      popover.closeButton.textContent = t('Skip')
      popover.closeButton.setAttribute('aria-label', t('Skip tour'))
      popover.closeButton.title = t('Skip tour')
    },
    onDestroyed() {
      if (disposed) return
      cleanup()
      onFinish(completed)
    },
  })

  async function goTo(index: number) {
    if (disposed) return
    if (index >= steps.length) return finish()
    if (index < 0) return
    pending?.abort()
    const controller = new AbortController()
    pending = controller
    removeTargetClick?.()
    removeTargetClick = undefined
    restoreInteraction?.()
    restoreInteraction = undefined
    const step = steps[index]
    closePanels(step.panel)
    if (step.route && (window.location.pathname !== step.route
      || (!step.panel && new URLSearchParams(window.location.search).has('launcher')))) {
      navigate(step.route)
      if (!(await waitForPath(step.route, controller.signal))) return
    }
    if (step.panel) {
      openedPanels.add(step.panel)
      if (!document.querySelector(`[data-tour-panel="${step.panel}"]`)) {
        document.querySelector<HTMLButtonElement>(`[data-tour="${step.panel}"]`)?.click()
      }
    }
    const element = await waitForTarget(`[data-tour="${step.target}"]`, controller.signal)
    if (disposed || controller.signal.aborted) return
    if (!element) {
      cleanup()
      tour.destroy()
      onError()
      return
    }
    if (!step.click && !step.interactive) {
      const wasInert = element.inert
      element.inert = true
      restoreInteraction = () => { element.inert = wasInert }
    }
    // Preserve Driver's active popover and listeners while updating translated steps.
    tour.setConfig({ ...tour.getConfig(), steps: localizedSteps() })
    tour.drive(index)
    if (step.click) {
      const handleClick = () => {
        // Wait until the event has bubbled through React before following its navigation.
        window.setTimeout(() => {
          if (disposed || controller.signal.aborted) return
          if (step.click === 'finish') finish()
          else void goTo(index + 1)
        }, 0)
      }
      element.addEventListener('click', handleClick)
      removeTargetClick = () => element.removeEventListener('click', handleClick)
    }
  }

  function translateTour() {
    const index = tour.getActiveIndex()
    if (index != null) void goTo(index)
  }

  i18n.on('languageChanged', translateTour)
  void goTo(0)

  return {
    destroy() {
      if (disposed) return
      cleanup()
      tour.destroy()
    },
  }
}
