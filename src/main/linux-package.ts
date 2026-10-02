import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The marker is a dpkg-owned file added only to the DEB payload by FPM. */
export function linuxPackageType(resourcesPath: string): 'appimage' | 'deb' {
  try {
    return readFileSync(join(resourcesPath, 'package-type'), 'utf8').trim() === 'deb' ? 'deb' : 'appimage'
  } catch {
    return 'appimage'
  }
}
