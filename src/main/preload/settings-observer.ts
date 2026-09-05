import { ipcRenderer } from 'electron'
import { inspectSettingsHost } from '../settings-adapter.ts'
import type { SettingsIntegrationStatus } from '../settings-integration.ts'
import type { UpdateState } from './bridge.ts'
import { DESKTOP_TAB_ID, DESKTOP_PANEL_ID } from './constants.ts'
import { removeSettingsIntegration, reconcileSettingsNavigation } from './settings-navigation.ts'
import { paintUpdateCard } from './update-card.ts'
import { injectKeyHelp } from './key-help.ts'
import { currentEnglish } from './language.ts'

let watching = false
let lastIntegrationStatus = ''
const reportedIntegrationFailures = new Set<string>()

function reportSettingsIntegration(status: SettingsIntegrationStatus): void {
  const signature = JSON.stringify(status)
  if (lastIntegrationStatus === signature) return
  lastIntegrationStatus = signature
  ipcRenderer.send('desktop:settings-integration', status)
  if (status.state === 'unsupported' && !reportedIntegrationFailures.has(status.reason)) {
    reportedIntegrationFailures.add(status.reason)
    console.warn('[desktop] settings integration unavailable:', status.reason,
      '— open Desktop settings from the application menu or tray.')
  }
}

/** Watch for the official settings dialog and keep the card injected. */
export function watchSettingsDialog(): () => void {
  if (watching) return () => {}
  watching = true
  let observedDialog: Element | null = null
  // Watch class/visibility changes only inside the recognized settings dialog.
  // Our own navigation styling must not create an observer feedback loop.
  const attributes = new MutationObserver(records => {
    if (records.some(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement
      return target !== null && target.closest('#' + DESKTOP_TAB_ID + ', #' + DESKTOP_PANEL_ID) === null
    })) scheduleProbe()
  })
  const probe = (): void => {
    injectKeyHelp()
    try {
      const host = inspectSettingsHost()
      if (host.state !== 'absent' && observedDialog !== host.dialog) {
        attributes.disconnect()
        observedDialog = host.dialog
        attributes.observe(host.dialog, {
          subtree: true, attributes: true, attributeFilter: ['class', 'role', 'hidden', 'style'], characterData: true,
        })
      } else if (host.state === 'absent' && observedDialog !== null && !observedDialog.isConnected) {
        attributes.disconnect()
        observedDialog = null
      }
      if (host.state !== 'matched') {
        removeSettingsIntegration()
        reportSettingsIntegration(host.state === 'absent' ? { state: 'absent' } : { state: 'unsupported', reason: host.reason })
        return
      }
      if (!reconcileSettingsNavigation(host.navList, host.options)) {
        removeSettingsIntegration()
        reportSettingsIntegration({ state: 'unsupported', reason: 'mount-failed' })
        return
      }
      reportSettingsIntegration({ state: 'mounted' })
    } catch {
      removeSettingsIntegration()
      reportSettingsIntegration({ state: 'unsupported', reason: 'mount-failed' })
    }
  }
  // The observer sees every mutation of a streaming chat surface, and a probe
  // measures element boxes. Running one per animation frame both collapses
  // bursts and moves the reads to a point where layout is already clean,
  // instead of forcing a synchronous relayout inside the observer callback.
  let scheduled = false
  let frame = 0
  const scheduleProbe = (): void => {
    if (scheduled) return
    scheduled = true
    frame = requestAnimationFrame(() => {
      scheduled = false
      probe()
    })
  }
  const observer = new MutationObserver(scheduleProbe)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  const onUpdate = (_event: Electron.IpcRendererEvent, state: UpdateState): void => {
    paintUpdateCard(state, currentEnglish())
  }
  ipcRenderer.on('desktop:update:changed', onUpdate)
  probe()
  return () => {
    watching = false
    lastIntegrationStatus = ''
    cancelAnimationFrame(frame)
    observer.disconnect()
    attributes.disconnect()
    ipcRenderer.removeListener('desktop:update:changed', onUpdate)
    removeSettingsIntegration()
  }
}
