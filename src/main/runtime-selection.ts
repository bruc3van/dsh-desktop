/** Shared by the injected panel and the standalone settings script.
 * Keep this function self-contained: the standalone page serializes it.
 */
export function installRuntimeSelection(options: {
  root: HTMLElement
  selectedClass: string
  chinese: boolean
  protectWindow?: boolean
  save: (ids: Array<'probe' | 'installed' | 'npx' | 'bundled'>) => Promise<{
    saved: boolean
    smartRuntimes: Array<'probe' | 'installed' | 'npx' | 'bundled'>
    error?: string
  }>
}) {
  type Id = 'probe' | 'installed' | 'npx' | 'bundled'
  const { root, selectedClass, save } = options
  const t = (zh: string, en: string): string => options.chinese ? zh : en
  const all: Id[] = ['bundled', 'probe', 'installed', 'npx']
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-smart-runtime]')]
  const apply = root.querySelector('[data-runtime-apply]') as HTMLButtonElement
  const undo = root.querySelector('[data-runtime-undo]') as HTMLButtonElement
  const status = root.querySelector('[data-runtime-status]') as HTMLElement
  let baseline: Id[] = []
  let draft: Id[] = []
  let ready = false
  let busy = false
  let isolated = false
  const dirty = (): boolean => all.some(id => baseline.includes(id) !== draft.includes(id))
  const paint = (): void => {
    for (const button of buttons) {
      const id = button.dataset.smartRuntime as Id
      button.classList.toggle(selectedClass, draft.includes(id))
      button.setAttribute('aria-pressed', String(draft.includes(id)))
      button.disabled = !ready || busy || (isolated && id === 'probe')
    }
    apply.disabled = !ready || busy || !dirty() || draft.length === 0
    undo.disabled = !ready || busy || !dirty()
    apply.textContent = busy ? t('正在重新连接…', 'Reconnecting…') : t('应用并重新连接', 'Apply and reconnect')
    root.setAttribute('aria-busy', String(busy))
  }
  const pending = (): void => {
    status.textContent = draft.length === 0 ? t('至少保留一种来源', 'Keep at least one source')
      : dirty() ? t('有未应用的更改', 'Unapplied changes') : ''
  }
  for (const button of buttons) button.addEventListener('click', () => {
    if (button.disabled) return
    const id = button.dataset.smartRuntime as Id
    draft = all.filter(entry => entry === id ? !draft.includes(entry) : draft.includes(entry))
    pending()
    paint()
  })
  undo.addEventListener('click', () => {
    if (busy) return
    draft = [...baseline]
    pending()
    paint()
  })
  apply.addEventListener('click', async () => {
    if (apply.disabled || busy) return
    busy = true
    paint()
    status.textContent = t('正在保存并重新连接…', 'Saving and reconnecting…')
    try {
      const result = await save([...draft])
      if (!result.saved) throw new Error(result.error || t('保存失败', 'Save failed'))
      baseline = [...result.smartRuntimes]
      draft = [...baseline]
      status.textContent = t('已应用来源设置', 'Source settings applied')
    } catch (error) {
      status.textContent = t('应用失败：', 'Apply failed: ') + (error instanceof Error ? error.message : String(error))
    } finally {
      busy = false
      paint()
    }
  })

  // Protect settings dismissal (X, Escape, backdrop) and navigation to other
  // settings. A native HTML dialog also works in Electron, unlike confirm().
  let prompt: HTMLDialogElement | undefined
  const guard = (event: Event): void => {
    if (prompt !== undefined) {
      if (event instanceof KeyboardEvent && event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        prompt.remove()
        prompt = undefined
        apply.focus()
      }
      return
    }
    if (!root.isConnected || (!dirty() && !busy)) return
    const target = event.target
    if (!(target instanceof Element)) return
    const keyboard = event instanceof KeyboardEvent
    if (keyboard && event.key !== 'Escape') return
    if (!keyboard && root.contains(target)) return
    const host = root.closest('[role="dialog"]')
    if (!keyboard && !target.closest('button,a,[role="tab"],[class*="navItem"]') && (host === null || host.contains(target))) return
    event.preventDefault()
    event.stopImmediatePropagation()
    prompt = document.createElement('dialog')
    prompt.setAttribute('aria-label', t('未应用的来源更改', 'Unapplied source changes'))
    prompt.style.cssText = 'margin:auto;padding:24px;border:0;border-radius:var(--dsw-radius-panel,28px);max-width:380px;width:calc(100vw - 32px);background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font:400 14px/22px var(--dsw-font-family,system-ui);box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px rgba(0,0,0,.16),0 3px 8px rgba(0,0,0,.04),0 0 20px rgba(0,0,0,.05))'
    const text = document.createElement('p')
    text.style.cssText = 'margin:0'
    text.textContent = busy ? t('正在应用来源设置，请稍候。', 'Applying source settings. Please wait.')
      : t('来源更改尚未应用。要放弃更改吗？', 'Source changes have not been applied. Discard them?')
    prompt.appendChild(text)
    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:20px'
    prompt.appendChild(actions)
    const dismiss = (): void => { prompt?.remove(); prompt = undefined; apply.focus() }
    const makeButton = (label: string, action: () => void, primary = false): HTMLButtonElement => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.style.cssText = primary
        ? 'display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-button-primary-fill,rgb(15,17,21));color:var(--dsw-alias-label-primary-foreground,#fff);cursor:pointer;font-family:inherit;font-size:14px;line-height:22px;font-weight:500'
        : 'display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border:0;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,12px);background:transparent;color:inherit;cursor:pointer;font-family:inherit;font-size:14px;line-height:22px;font-weight:400'
      button.addEventListener('click', action)
      actions.appendChild(button)
      return button
    }
    const keep = makeButton(t('继续编辑', 'Continue editing'), dismiss, true)
    if (!busy) makeButton(t('放弃更改', 'Discard changes'), () => {
      draft = [...baseline]
      pending()
      paint()
      dismiss()
      if (keyboard) target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
      else {
        const action = target.closest('button,a,[role="tab"],[class*="navItem"]') ?? target
        if (action instanceof HTMLElement) action.click()
      }
    })
    prompt.addEventListener('cancel', event => { event.preventDefault(); dismiss() })
    document.body.appendChild(prompt)
    prompt.showModal()
    keep.focus()
  }
  // Window capture precedes the official React dialog's document listeners.
  window.addEventListener('click', guard, true)
  window.addEventListener('keydown', guard, true)
  const beforeUnload = (event: BeforeUnloadEvent): void => {
    if (options.protectWindow && dirty() && !busy) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  window.addEventListener('beforeunload', beforeUnload)
  const observer = new MutationObserver(() => {
    if (root.isConnected) return
    window.removeEventListener('click', guard, true)
    window.removeEventListener('keydown', guard, true)
    window.removeEventListener('beforeunload', beforeUnload)
    prompt?.remove()
    observer.disconnect()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  paint()
  return {
    load(ids: Id[] | undefined, isIsolated = false): void {
      isolated = isIsolated
      if (!busy && (!ready || !dirty())) {
        baseline = ids?.length ? [...ids] : [...all]
        draft = [...baseline]
        ready = true
      }
      paint()
    },
  }
}
