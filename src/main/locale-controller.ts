import { app } from 'electron'
import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

interface Options {
  childHome: () => string
  installMenu: () => void
  refreshTrayMenu: () => void
}

export function createLocaleController(options: Options) {
  const { childHome, installMenu, refreshTrayMenu } = options


  /**
   * The Web UI's own language setting, as the official client persists it in
   * `$DSH_HOME/settings.yaml`:
   *
   * ```yaml
   * locale:
   *   preference: zh
   * ```
   *
   * Read with a two-line scan rather than a YAML dependency: one scalar under
   * one top-level key is not worth a parser, and an unreadable or unexpected
   * document must degrade to "unknown" (the system locale then decides) instead
   * of throwing inside a menu build. Only the local child's home is consulted —
   * in Connect mode the page's language lives on the remote machine, where this
   * process cannot see it.
   */
  function dshLocalePreference(): string | undefined {
    let text: string
    try {
      text = readFileSync(join(childHome(), 'settings.yaml'), 'utf8')
    } catch {
      return undefined
    }
    let inLocaleBlock = false
    for (const line of text.split(/\r?\n/)) {
      // A non-indented line starts a new top-level key: the locale block ends
      // there, and only a `locale:` line reopens it.
      if (/^\S/.test(line)) {
        inLocaleBlock = /^locale:\s*(?:#.*)?$/.test(line)
        continue
      }
      if (!inLocaleBlock) continue
      const match = /^\s+preference:\s*["']?([A-Za-z][\w-]*)["']?\s*(?:#.*)?$/.exec(line)
      if (match !== null) return match[1]
    }
    return undefined
  }


  // Cached: localeChinese runs per rendered string. Kept fresh by
  // watchLocalePreference rather than by a TTL in the hot path.
  let cachedLocalePreference: string | undefined

  let localePreferenceLoaded = false


  /**
   * The language every native surface follows. The Web UI's setting wins: the
   * menu bar, tray, and dialogs sit around a page the user has already told
   * which language to speak, and a native frame in the other language is the
   * mixed-language menu bar this replaced. The system locale is the fallback
   * for before that setting exists (or when a remote page owns it).
   */
  function localeChinese(): boolean {
    if (!localePreferenceLoaded) {
      cachedLocalePreference = dshLocalePreference()
      localePreferenceLoaded = true
    }
    const preference = cachedLocalePreference
    if (preference !== undefined) return preference.toLowerCase().startsWith('zh')
    return app.getLocale().toLowerCase().startsWith('zh')
  }


  /**
   * Follow the Web UI's language switch while the client is running. The
   * official client rewrites settings.yaml atomically (write + rename), which a
   * watch on the file itself would stop seeing after the first switch, so the
   * home directory is watched instead and filtered by name. The interval is the
   * backstop for filesystems where directory watching reports nothing at all
   * (network mounts, some container layers), and it is also what re-attaches the
   * watcher: on a first launch the home does not exist yet — the child spawn
   * creates it, later than this runs — so the first attach fails and only a
   * retry ever gets a watcher at all.
   */
  function watchLocalePreference(): void {
    const apply = (): void => {
      const next = dshLocalePreference()
      localePreferenceLoaded = true
      if (next === cachedLocalePreference) return
      cachedLocalePreference = next
      // Both menus bake their labels in at build time, so a language change is
      // only visible once they are rebuilt.
      installMenu()
      refreshTrayMenu()
    }
    let watcher: FSWatcher | undefined
    const attach = (): void => {
      if (watcher !== undefined) return
      let opened: FSWatcher
      try {
        opened = watch(childHome(), (_event, filename) => {
          if (filename === null || filename === 'settings.yaml') apply()
        })
      } catch {
        return // No home yet, or an unwatchable path: the poll retries and covers it.
      }
      // An FSWatcher is an EventEmitter, so an 'error' with no listener of its
      // own is an uncaught exception — the home's volume going away would take
      // the main process down over a menu label. Dropping the watcher instead
      // lets the poll rebuild it if the path becomes watchable again.
      opened.on('error', () => {
        try { opened.close() } catch { /* already torn down by the error */ }
        if (watcher === opened) watcher = undefined
      })
      opened.unref()
      watcher = opened
    }
    attach()
    const timer = setInterval(() => { attach(); apply() }, 5_000)
    timer.unref()
    apply()
  }
  return { localeChinese, watchLocalePreference }
}
