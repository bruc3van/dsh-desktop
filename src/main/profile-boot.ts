/**
 * Shared by the launcher steps that edit the web profile before DSH reads it:
 * prove the selected CLI is an official DSH installation, then let that
 * version's own `initProfile()` create the profile when it does not exist yet.
 * @module dsh-desktop/profile-boot
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WEB_PROFILE } from './web-profile.ts'

interface ProfileTemplates { web: { bundles: string[]; patchReload?: string } }

/** Whether the selected installation can resolve a package, without assuming exported subpaths. */
export function installationProvides(anchor: string, name: string): boolean {
  return (createRequire(anchor).resolve.paths(name) ?? [])
    .some(base => existsSync(join(base, name, 'package.json')))
}

/** @returns the installation's package.json, used as the resolution anchor. */
export async function initWebProfile(entry: string, home: string): Promise<string> {
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
  appBoot.initProfile(join(home, 'profiles', WEB_PROFILE), templates.web.bundles, templates.web.patchReload)
  return anchor
}
