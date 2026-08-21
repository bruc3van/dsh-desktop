/**
 * Verify the client-owned Win32 directory-picker compatibility patch.
 *
 * The official picker reads a COM-owned UTF-16 pointer through koffi.view().
 * That works under ordinary Node but aborts Electron's embedded Node inside
 * N-API. The release keeps the official package version pinned and patches
 * only its built worker to copy the exact string through Win32 instead.
 *
 * This check first proves the deployed closure contains that exact patch. On
 * Windows it then independently runs the same pointer conversion under
 * Electron's own Node, against a real Unicode filesystem path, without opening
 * a dialog. The published worker does not export this helper, so the marker
 * check binds the deployed code while the probe proves its native technique;
 * keep both halves synchronized when the patch changes.
 * @module desktop/scripts/check-win32-picker
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const RUNTIME_DIR = join(APP_DIR, '.runtime', 'node_modules')
const PICKER_DIR = join(RUNTIME_DIR, '@deepseek-ai', 'dsh-host-directory-picker-native')
const PICKER_PACKAGE_FILE = join(PICKER_DIR, 'package.json')
const WORKER_FILE = join(PICKER_DIR, 'lib', 'worker.cjs')
const KOFFI_NATIVE_FILE = join(RUNTIME_DIR, '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node')
const EXPECTED_VERSION = '0.1.1-rc.2'

if (!existsSync(PICKER_PACKAGE_FILE) || !existsSync(WORKER_FILE)) {
  throw new Error('deployed dsh runtime is missing; run `pnpm run prepare:runtime` before `pnpm run check:picker`')
}

const pickerPackage = JSON.parse(await readFile(PICKER_PACKAGE_FILE, 'utf8'))
if (pickerPackage.version !== EXPECTED_VERSION) {
  throw new Error('Win32 picker version mismatch: expected '
    + EXPECTED_VERSION + ', deployed ' + String(pickerPackage.version))
}

const workerSource = await readFile(WORKER_FILE, 'utf8')
for (const marker of ['lstrlenW', 'RtlMoveMemory', 'copyMemory(bytes, address, byteLength)']) {
  if (!workerSource.includes(marker)) throw new Error('deployed picker worker is missing patch marker: ' + marker)
}
if (workerSource.includes('Buffer.from(koffi.view(address, 32768))')) {
  throw new Error('deployed picker worker still contains the Electron-crashing koffi.view path')
}
console.log('✓ deployed Win32 picker worker contains the Electron compatibility patch')

if (process.platform !== 'win32') process.exit(0)

/** Map one PE relative virtual address into the file that carries it. */
function peOffset(sections, rva) {
  const section = sections.find(item => rva >= item.virtualAddress
    && rva < item.virtualAddress + Math.max(item.virtualSize, item.rawSize))
  if (section === undefined) throw new Error('invalid PE RVA 0x' + rva.toString(16))
  return section.rawOffset + rva - section.virtualAddress
}

/** Read the ordinary import directory from a 32/64-bit PE image. */
function peImports(image) {
  const pe = image.readUInt32LE(0x3c)
  if (image.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('Koffi native module is not a PE image')
  const coff = pe + 4
  const optional = coff + 20
  const optionalSize = image.readUInt16LE(coff + 16)
  const dataDirectories = optional + (image.readUInt16LE(optional) === 0x20b ? 112 : 96)
  const sectionTable = optional + optionalSize
  const sections = Array.from({ length: image.readUInt16LE(coff + 2) }, (_, index) => {
    const offset = sectionTable + index * 40
    return {
      virtualSize: image.readUInt32LE(offset + 8),
      virtualAddress: image.readUInt32LE(offset + 12),
      rawSize: image.readUInt32LE(offset + 16),
      rawOffset: image.readUInt32LE(offset + 20),
    }
  })
  const importRva = image.readUInt32LE(dataDirectories + 8)
  if (importRva === 0) return []
  const imports = []
  for (let descriptor = peOffset(sections, importRva);;) {
    const nameRva = image.readUInt32LE(descriptor + 12)
    if (image.readUInt32LE(descriptor) === 0 && nameRva === 0 && image.readUInt32LE(descriptor + 16) === 0) break
    const nameOffset = peOffset(sections, nameRva)
    const nameEnd = image.indexOf(0, nameOffset)
    imports.push(image.toString('ascii', nameOffset, nameEnd))
    descriptor += 20
  }
  return imports
}

if (!existsSync(KOFFI_NATIVE_FILE)) throw new Error('deployed runtime is missing ' + KOFFI_NATIVE_FILE)
const koffiImports = peImports(await readFile(KOFFI_NATIVE_FILE))
const externalMsvcRuntime = koffiImports.filter(name => /^(?:msvcp|vcruntime)\d.*\.dll$/i.test(name))
if (externalMsvcRuntime.length > 0) {
  throw new Error('deployed Koffi requires a Visual C++ Redistributable that clean Windows may not have: '
    + externalMsvcRuntime.join(', '))
}
console.log('✓ deployed Koffi has no external Visual C++ runtime dependency')

const probeHome = await mkdtemp(join(tmpdir(), 'dsh-picker-electron-smoke-'))
const expectedPath = join(probeHome, '工作区-é')
await mkdir(expectedPath)

const requireFromHere = createRequire(import.meta.url)
const electronExecutable = requireFromHere('electron')
const runtimePackage = join(APP_DIR, '.runtime', 'package.json')
const probeSource = String.raw`
const { createRequire } = require('node:module')
const koffi = createRequire(process.argv[1])('koffi')

function guidBytes(text) {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(text)
  const bytes = Buffer.alloc(16)
  bytes.writeUInt32LE(parseInt(match[1], 16), 0)
  bytes.writeUInt16LE(parseInt(match[2], 16), 4)
  bytes.writeUInt16LE(parseInt(match[3], 16), 6)
  Buffer.from(match[4] + match[5], 'hex').copy(bytes, 8)
  return bytes
}

const ole32 = koffi.load('ole32.dll')
const shell32 = koffi.load('shell32.dll')
const kernel32 = koffi.load('kernel32.dll')
const coInitializeEx = ole32.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32'])
const coUninitialize = ole32.func('__stdcall', 'CoUninitialize', 'void', [])
const coTaskMemFree = ole32.func('__stdcall', 'CoTaskMemFree', 'void', ['void *'])
const createItem = shell32.func('__stdcall', 'SHCreateItemFromParsingName', 'int32', ['str16', 'void *', 'void *', 'void *'])
const lstrlenW = kernel32.func('__stdcall', 'lstrlenW', 'int', ['void *'])
const copyMemory = kernel32.func('__stdcall', 'RtlMoveMemory', 'void', ['void *', 'void *', 'uintptr'])
const pointerSize = koffi.sizeof('void *')
const itemOut = Buffer.alloc(pointerSize)
const initialized = coInitializeEx(null, 2)
if (initialized < 0) throw new Error('CoInitializeEx failed: ' + initialized)

try {
  const created = createItem(process.argv[2], null, guidBytes('43826d1e-e718-42ee-bc55-a1e261c37bfe'), itemOut)
  if (created < 0) throw new Error('SHCreateItemFromParsingName failed: ' + created)
  const item = koffi.decode(itemOut, 'void *')
  const vtable = koffi.decode(item, 'void *')
  const getNamePointer = koffi.decode(vtable, 5 * pointerSize, 'void *')
  const releasePointer = koffi.decode(vtable, 2 * pointerSize, 'void *')
  const getName = koffi.proto('int32 __stdcall DshProbeGetDisplayName(void *self, int32 form, _Out_ void **name)')
  const release = koffi.proto('uint32 __stdcall DshProbeRelease(void *self)')
  const nameOut = [null]
  try {
    const gotName = koffi.call(getNamePointer, getName, item, 0x80058000 | 0, nameOut)
    if (gotName < 0) throw new Error('IShellItem::GetDisplayName failed: ' + gotName)
    try {
      const byteLength = lstrlenW(nameOut[0]) * 2
      const bytes = Buffer.alloc(byteLength)
      if (byteLength > 0) copyMemory(bytes, nameOut[0], byteLength)
      console.log(JSON.stringify({ path: bytes.toString('utf16le') }))
    } finally {
      coTaskMemFree(nameOut[0])
    }
  } finally {
    koffi.call(releasePointer, release, item)
  }
} finally {
  coUninitialize()
}
`

const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
const child = spawn(electronExecutable, ['-e', probeSource, runtimePackage, expectedPath], {
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', chunk => { stdout += chunk })
child.stderr.on('data', chunk => { stderr += chunk })

try {
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill()
      rejectExit(new Error('Electron Win32 picker probe timed out'))
    }, 15_000)
    child.once('error', error => {
      clearTimeout(timeout)
      rejectExit(error)
    })
    child.once('exit', code => {
      clearTimeout(timeout)
      resolveExit(code)
    })
  })
  if (exitCode !== 0) {
    throw new Error('Electron Win32 picker probe exited with code ' + String(exitCode)
      + '\nstdout:\n' + stdout + '\nstderr:\n' + stderr)
  }
  const resultLine = stdout.trim().split(/\r?\n/).at(-1)
  const result = JSON.parse(resultLine ?? '{}')
  // Hosted Windows runners can expose TEMP through an 8.3 alias such as
  // RUNNER~1 while the Shell COM API returns the equivalent long path. Resolve
  // both existing paths before comparison; casing is also non-semantic here.
  const [actualCanonical, expectedCanonical] = await Promise.all([
    realpath(result.path),
    realpath(expectedPath),
  ])
  if (actualCanonical.toLowerCase() !== expectedCanonical.toLowerCase()) {
    throw new Error('Electron Win32 picker probe returned ' + JSON.stringify(result.path)
      + ', expected ' + JSON.stringify(expectedPath)
      + ' (canonical paths: ' + JSON.stringify(actualCanonical) + ' / ' + JSON.stringify(expectedCanonical) + ')')
  }
  console.log('✓ Electron Node read the Unicode Win32 path without koffi.view')
} finally {
  if (child.exitCode === null) child.kill()
  await rm(probeHome, { recursive: true, force: true })
}
