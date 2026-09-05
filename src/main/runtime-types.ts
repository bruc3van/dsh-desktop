/**
 * Resolve the `dsh` command the client spawns for local mode. Order: the
 * explicit DSH_DESKTOP_DSH override, a verified user-installed dsh, the
 * app-bundled npm package, conventional sibling checkouts (dev convenience),
 * and finally `dsh` on PATH.
 */
export interface DshCommand {
  command: string
  args: string[]
  /** The official CLI entry `runtimeLauncher()` imports, when args boot it. */
  entry?: string
  binPath?: string
  /** Spawn through the platform shell (a Windows `.cmd`/`.bat` wrapper). */
  shell?: boolean
  label: string
  source: 'override' | 'installed' | 'npx' | 'bundled' | 'checkout' | 'path'
  /**
   * The runtime's own dsh version, when this client could read one. It gates
   * the bundled-plugin seat: the plugin is built against the runtime we ship,
   * and an older one may not export what it imports.
   */
  version?: string
}

export class BundledRuntimeMissingError extends Error {
  constructor() {
    super('安装包中缺少内置 dsh 运行时。请重新从项目的 GitHub Releases 下载并安装完整客户端。')
    this.name = 'BundledRuntimeMissingError'
  }
}

export class NoEnabledSmartRuntimeError extends Error {
  constructor(chinese: boolean) {
    super(chinese
      ? '没有启用可启动的运行时。请在连接设置中至少勾选一种智能连接来源。'
      : 'No enabled Smart-mode runtime. Select at least one source in Connection settings.')
    this.name = 'NoEnabledSmartRuntimeError'
  }
}
