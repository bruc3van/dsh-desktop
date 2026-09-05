import type { UpdateState } from './updater.ts'

interface MenuActions {
  openSettings: () => void
  showWindow: () => void
  checkUpdates: () => void
  restart: () => void
  quit: () => void
}
interface TrayMenuOptions {
  chinese: boolean
  state: UpdateState | undefined
  actions: MenuActions
}
interface ApplicationMenuOptions {
  chinese: boolean
  name: string
  development: boolean
  actions: MenuActions
}

export function buildTrayMenu({ chinese, state, actions }: TrayMenuOptions): Electron.MenuItemConstructorOptions[] {
  const updateLabel = state?.phase === 'available' && state.info !== null && !state.dismissed
    ? (chinese ? '更新到 v' : 'Update to v') + state.info.availableVersion
    : (chinese ? '检查更新…' : 'Check for Updates…')
  return [
    { label: chinese ? '显示主窗口' : 'Show Window', click: actions.showWindow },
    { id: 'desktop-settings', label: chinese ? '桌面设置…' : 'Desktop settings…', click: actions.openSettings },
    { label: updateLabel, click: actions.checkUpdates },
    { type: 'separator' },
    { label: chinese ? '重启客户端' : 'Restart', click: actions.restart },
    { label: chinese ? '退出' : 'Quit', click: actions.quit },
  ]
}


export function buildApplicationMenu({ chinese, name, development, actions }: ApplicationMenuOptions): Electron.MenuItemConstructorOptions[] {
  return [
    {
      label: name,
      submenu: [
        { role: 'about', label: (chinese ? '关于 ' : 'About ') + name },
        {
          id: 'desktop-settings',
          label: chinese ? '桌面设置…' : 'Desktop settings…',
          accelerator: 'CommandOrControl+,',
          click: actions.openSettings,
        },
        {
          label: chinese ? '检查更新…' : 'Check for Updates…',
          click: actions.checkUpdates,
        },
        // Same gesture (and same wording) as the tray's item: a plugin that
        // only takes effect on a fresh runtime needs the harness replaced, and
        // the menu bar is where a macOS user looks for it when the window —
        // not the tray — is what they have in front of them.
        { label: chinese ? '重启客户端' : 'Restart', click: actions.restart },
        { type: 'separator' },
        { role: 'services', label: chinese ? '服务' : 'Services' },
        { type: 'separator' },
        { role: 'hide', label: (chinese ? '隐藏 ' : 'Hide ') + name },
        { role: 'hideOthers', label: chinese ? '隐藏其他' : 'Hide Others' },
        { role: 'unhide', label: chinese ? '全部显示' : 'Show All' },
        { type: 'separator' },
        { role: 'quit', label: (chinese ? '退出 ' : 'Quit ') + name },
      ],
    },
    {
      label: chinese ? '编辑' : 'Edit',
      submenu: [
        { role: 'undo', label: chinese ? '撤销' : 'Undo' },
        { role: 'redo', label: chinese ? '重做' : 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: chinese ? '剪切' : 'Cut' },
        { role: 'copy', label: chinese ? '拷贝' : 'Copy' },
        { role: 'paste', label: chinese ? '粘贴' : 'Paste' },
        { role: 'pasteAndMatchStyle', label: chinese ? '粘贴并匹配样式' : 'Paste and Match Style' },
        { role: 'delete', label: chinese ? '删除' : 'Delete' },
        { role: 'selectAll', label: chinese ? '全选' : 'Select All' },
        { type: 'separator' },
        {
          label: chinese ? '语音' : 'Speech',
          submenu: [
            { role: 'startSpeaking', label: chinese ? '开始朗读' : 'Start Speaking' },
            { role: 'stopSpeaking', label: chinese ? '停止朗读' : 'Stop Speaking' },
          ],
        },
      ],
    },
    {
      label: chinese ? '显示' : 'View',
      submenu: [
        { role: 'reload', label: chinese ? '重新载入' : 'Reload' },
        { role: 'forceReload', label: chinese ? '强制重新载入' : 'Force Reload' },
        // The shipped app keeps Reload (a Web UI client still benefits from
        // rebuilding its renderer) but not DevTools: a packaged install has
        // no debugging surface to expose, and the window may be showing a
        // remote page whose runtime internals are none of the user's concern.
        ...(development
          ? [{ role: 'toggleDevTools' as const, label: chinese ? '切换开发者工具' : 'Toggle Developer Tools' }]
          : []),
        { type: 'separator' },
        { role: 'resetZoom', label: chinese ? '实际大小' : 'Actual Size' },
        { role: 'zoomIn', label: chinese ? '放大' : 'Zoom In' },
        { role: 'zoomOut', label: chinese ? '缩小' : 'Zoom Out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: chinese ? '进入全屏幕' : 'Toggle Full Screen' },
      ],
    },
    {
      label: chinese ? '窗口' : 'Window',
      submenu: [
        { role: 'minimize', label: chinese ? '最小化' : 'Minimize' },
        { role: 'zoom', label: chinese ? '缩放' : 'Zoom' },
        { type: 'separator' },
        { role: 'front', label: chinese ? '前置全部窗口' : 'Bring All to Front' },
        { type: 'separator' },
        { role: 'close', label: chinese ? '关闭窗口' : 'Close Window' },
      ],
    },
  ]
}
