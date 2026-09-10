/** Prepare the market inside a managed CLI child, before DSH reads its profile. */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import satisfies from 'semver/functions/satisfies.js'
import { abandonBundledPlugin, BUNDLED_PLUGIN_NAME, seatBundledPlugin, withdrawBundledPlugin } from './bundled-plugin.ts'

export const MARKET_BOOT_VARIABLE = 'DSH_DESKTOP_BUNDLED_MARKET'
export interface MarketBootRequest {
  home: string
  pluginDir?: string
  mode: 'offer' | 'disabled' | 'suppressed'
}
interface PackageManifest {
  name: string
  installationPath?: string
  version: string
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

/** Node package lookup without assuming that package.json is an exported subpath. */
function packageManifest(anchor: string, name: string): PackageManifest | undefined {
  for (const base of createRequire(anchor).resolve.paths(name) ?? []) {
    const file = join(base, name, 'package.json')
    if (existsSync(file)) return { ...JSON.parse(readFileSync(file, 'utf8')) as PackageManifest, installationPath: realpathSync(file) }
  }
  return undefined
}

export async function prepareBundledMarket(entry: string, request: MarketBootRequest): Promise<void> {
  const { home, pluginDir, mode } = request
  try {
    if (mode === 'disabled') { abandonBundledPlugin(home, pluginDir); return }
    if (mode === 'suppressed') { withdrawBundledPlugin(home, pluginDir); return }
    if (pluginDir === undefined) { abandonBundledPlugin(home); return }
    const anchor = join(dirname(dirname(entry)), 'package.json')
    const runtime = JSON.parse(readFileSync(anchor, 'utf8')) as PackageManifest
    if (runtime.name !== '@deepseek-ai/dsh') throw new Error('the selected CLI is not a verifiable DSH installation')
    const market = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')) as PackageManifest
    if (market.name !== BUNDLED_PLUGIN_NAME) throw new Error('invalid bundled market package')
    const peers = Object.entries(market.peerDependencies ?? {})
    for (const [name, range] of peers) {
      const dependency = packageManifest(anchor, name)
      if (dependency === undefined && market.peerDependenciesMeta?.[name]?.optional === true) continue
      if (dependency === undefined || !satisfies(dependency.version, range)) {
        throw new Error('the selected runtime does not provide compatible peer ' + name + '@' + range)
      }
    }
    // An installation-owned market would take precedence over profile patches.
    // Refuse to add our copy instead of modifying an external installation.
    if (packageManifest(anchor, BUNDLED_PLUGIN_NAME) !== undefined) {
      throw new Error('the selected DSH installation already owns a market bundle')
    }
    const appBootPath = createRequire(anchor).resolve('@deepseek-ai/dsh-app-boot')
    const appBoot = await import(pathToFileURL(appBootPath).href) as {
      initProfile(dir: string, bundles: string[], patchReload: string): void
      loadProfileDirectory(bin: string, dir: string, anchor: string): unknown
      healProfilesModuleFallback(options: { installAnchor: string; profile: unknown; home: string }): Promise<void>
      PROFILE_TEMPLATES: { web: { bundles: string[]; patchReload: string } }
    }
    const template = appBoot.PROFILE_TEMPLATES.web
    // The selected version owns defaults and pnpm settings; never copy templates.
    appBoot.initProfile(join(home, 'profiles', 'web'), template.bundles, template.patchReload)
    const result = seatBundledPlugin(pluginDir, home, { version: runtime.version, peersVerified: true })
    if (result.error !== undefined) throw new Error(result.error)
    const profile = appBoot.loadProfileDirectory('dsh', join(home, 'profiles', 'web'), anchor)
    await appBoot.healProfilesModuleFallback({ installAnchor: anchor, profile, home })
    const issues = marketPeerIssues(home)
    for (const issue of issues) console.warn('[desktop] market dependency drift: ' + issue)
    if (issues.length > 0 && result.owned) throw new Error('client-owned market has incompatible profile dependencies; repair the profile dependencies before enabling it')
    console.log('[desktop] bundled market prepared: ' + (result.owned ? 'client-owned' : 'user-managed'))
  } catch (error) {
    withdrawBundledPlugin(home, pluginDir)
    console.warn('[desktop] bundled market not offered: ' + (error instanceof Error ? error.message : String(error)))
  }
}

/** Diagnose from the installed market's real location, including pnpm links. */
export function marketPeerIssues(home: string): string[] {
  const file = join(home, 'profiles', 'web', 'node_modules', BUNDLED_PLUGIN_NAME, 'package.json')
  if (!existsSync(file)) return []
  const anchor = realpathSync(file)
  const market = JSON.parse(readFileSync(anchor, 'utf8')) as PackageManifest
  const issues: string[] = []
  for (const [name, range] of Object.entries(market.peerDependencies ?? {})) {
    const dependency = packageManifest(anchor, name)
    if (dependency === undefined && market.peerDependenciesMeta?.[name]?.optional === true) continue
    if (dependency === undefined || !satisfies(dependency.version, range)) {
      issues.push(name + ': resolved ' + (dependency?.version ?? 'missing') + (dependency?.installationPath === undefined ? '' : ' at ' + dependency.installationPath) + ', expected ' + range + ' (from ' + anchor + '); user packages were preserved')
    }
  }
  return issues
}
