/** Offer the preset subscription inside a managed CLI child, before DSH reads its profile. */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { offerPresetSubscription, PLUGIN_MARKET_BUNDLE } from './preset-subscription.ts'
import { WEB_PROFILE } from './web-profile.ts'

export const PRESET_SUBSCRIPTION_VARIABLE = 'DSH_DESKTOP_PRESET_SUBSCRIPTION'

export interface PresetSubscriptionRequest {
  home: string
}

interface ProfileTemplates { web: { bundles: string[]; patchReload?: string } }

/** Whether the selected installation can resolve a package, without assuming exported subpaths. */
function installationProvides(anchor: string, name: string): boolean {
  return (createRequire(anchor).resolve.paths(name) ?? [])
    .some(base => existsSync(join(base, name, 'package.json')))
}

export async function preparePresetSubscription(entry: string, request: PresetSubscriptionRequest): Promise<void> {
  const { home } = request
  try {
    const anchor = join(dirname(dirname(entry)), 'package.json')
    const runtime = JSON.parse(readFileSync(anchor, 'utf8')) as { name?: string }
    if (runtime.name !== '@deepseek-ai/dsh') throw new Error('the selected CLI is not a verifiable DSH installation')
    const appBoot = await import(pathToFileURL(createRequire(anchor).resolve('@deepseek-ai/dsh-app-boot')).href) as {
      initProfile(dir: string, bundles: string[], patchReload?: string): void
      PROFILE_TEMPLATES?: ProfileTemplates
    }
    // 0.2.2 moved templates out of app-boot; older installed runtimes still
    // expose them there. Resolve both from the selected CLI installation.
    const templates = appBoot.PROFILE_TEMPLATES ?? (await import(pathToFileURL(
      createRequire(anchor).resolve('@deepseek-ai/dsh-official-bundles'),
    ).href) as { PROFILE_TEMPLATES: ProfileTemplates }).PROFILE_TEMPLATES
    // The selected version owns defaults and pnpm settings; never copy templates.
    // A first-ever home has no profile until this call, which is what lets the
    // very first launch already open with the subscription.
    appBoot.initProfile(join(home, 'profiles', WEB_PROFILE), templates.web.bundles, templates.web.patchReload)
    const outcome = offerPresetSubscription(home, installationProvides(anchor, PLUGIN_MARKET_BUNDLE))
    console.log('[desktop] preset plugin index: ' + outcome)
  } catch (error) {
    // An offer that cannot be made is never a reason to stop the runtime.
    console.warn('[desktop] preset plugin index not offered: ' + (error instanceof Error ? error.message : String(error)))
  }
}
