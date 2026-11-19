/** Prepare Desktop resources and publish their versions after every preparation stage succeeds. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, createReadStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { downloadArtifact } from '@electron/get'
import extractZip from 'extract-zip'
import { readPrimaryRuntime } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { desktopTargetPlatform, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { packagingStep } from './packaging-step.mjs'
import { preparePrimaryRuntime } from './prepare-primary-runtime.ts'
import { prepareDesktopCli } from './prepare-cli.ts'
import { prepareCommandLink } from './prepare-command-link.ts'

const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const RUNTIME_ROOT = BUILD_PATHS.runtime
/** Public Electron mirror used when an official GitHub download cannot complete. */
const ELECTRON_MIRROR_FALLBACK = 'https://npmmirror.com/mirrors/electron/'

type DesktopTarget = ReturnType<typeof desktopTargetPlatform>

/** Report an unobtainable Electron archive together with the operator's offline and mirror options. */
function unavailableElectron(fileName: string, cause: unknown): Error {
  return new Error(
    `desktop runtime: cannot obtain ${fileName}; place the archive under ${BUILD_PATHS.downloads},`
    + ' point DSH_ELECTRON_ARCHIVE at a local copy, or set ELECTRON_MIRROR to a reachable mirror.',
    { cause })
}

/** Hash a local artifact so an operator-supplied digest can be checked without network access. */
async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Locate an Electron distribution zip that an earlier run already downloaded.
 * Restoring the network round trip is what makes repeat and offline builds fail on a blocked
 * GitHub, because @electron/get refreshes SHASUMS256.txt even when the archive is cached.
 * @param fileName Expected archive file name for the selected Electron version and target.
 * @returns Absolute path of a reusable archive, or undefined when none exists.
 */
function findElectronArchive(fileName: string): string | undefined {
  const override = process.env.DSH_ELECTRON_ARCHIVE
  if (override !== undefined && override !== '') {
    if (!existsSync(override)) {
      throw new Error(`desktop runtime: DSH_ELECTRON_ARCHIVE does not exist: ${override}`)
    }
    return override
  }
  if (!existsSync(BUILD_PATHS.downloads)) return undefined
  // @electron/get stores each download under <sha256-of-url>/<fileName>, so match on the file name.
  for (const entry of readdirSync(BUILD_PATHS.downloads, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(BUILD_PATHS.downloads, entry.name, fileName)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Extract the target Electron distribution and return its embedded Node version. */
async function prepareElectron({ platform, arch }: DesktopTarget): Promise<string> {
  const require = createRequire(import.meta.url)
  const { version } = require('electron/package.json') as { version: string }
  const fileName = `electron-v${version}-${platform}-${arch}.zip`
  const archive = await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'download:electron',
    async () => {
      // In isolated/offline builds the checksum file cannot be re-fetched. An operator can supply the
      // official sha256 for a pre-seeded artifact so @electron/get validates against a local manifest.
      const shasum = process.env.DSH_ELECTRON_SHASUM
      const artifactName = 'electron'
      const local = findElectronArchive(fileName)
      if (local !== undefined) {
        if (shasum !== undefined && shasum !== '') {
          const actual = await digestFile(local)
          if (actual !== shasum.toLowerCase()) {
            throw new Error(`desktop runtime: ${local} sha256 ${actual} does not match DSH_ELECTRON_SHASUM`)
          }
        }
        process.stdout.write(`desktop runtime: reusing prepared Electron archive ${local}\n`)
        return local
      }
      const request = {
        version, platform, arch, artifactName, cacheRoot: BUILD_PATHS.downloads,
        ...(shasum === undefined || shasum === '' ? {} : { checksums: { [fileName]: shasum } }),
      }
      try {
        return await downloadArtifact(request)
      } catch (officialError) {
        // GitHub releases are frequently unreachable from mainland networks. Retry a public mirror
        // unless the operator already pinned one, so a first build does not depend on GitHub alone.
        const pinnedMirror = process.env.ELECTRON_MIRROR
        if (pinnedMirror !== undefined && pinnedMirror !== '') {
          throw unavailableElectron(fileName, officialError)
        }
        process.stdout.write(`desktop runtime: official Electron download failed; retrying ${ELECTRON_MIRROR_FALLBACK}\n`)
        try {
          return await downloadArtifact({ ...request, mirrorOptions: { mirror: ELECTRON_MIRROR_FALLBACK } })
        } catch (mirrorError) {
          throw unavailableElectron(fileName, mirrorError)
        }
      }
    })
  rmSync(BUILD_PATHS.electron, { recursive: true, force: true })
  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'extract:electron', () => extractZip(archive, { dir: BUILD_PATHS.electron }))
  const executable = join(BUILD_PATHS.electron, platform === 'win32' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron')
  return execFileSync(executable, ['-p', 'process.versions.node'], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).trim()
}

function prepareCli({ platform, arch }: DesktopTarget): void {
  cpSync(join(import.meta.dirname, 'node-bin'), join(RUNTIME_ROOT, 'bin'), { recursive: true })
  chmodSync(join(RUNTIME_ROOT, 'bin', 'node'), 0o755)
  const cli = join(RUNTIME_ROOT, 'cli')
  prepareDesktopCli(cli, platform)
  if (platform === 'darwin') {
    const minimumVersion = execFileSync('/usr/libexec/PlistBuddy', [
      '-c', 'Print LSMinimumSystemVersion', join(BUILD_PATHS.electron, 'Electron.app', 'Contents', 'Info.plist'),
    ], { encoding: 'utf8' }).trim()
    prepareCommandLink(cli, arch, minimumVersion)
  }
  cpSync(join(import.meta.dirname, '..', 'lib', 'command-manager-entry.js'), join(cli, 'command-manager.js'))
  cpSync(join(import.meta.dirname, 'command-path.ps1'), join(cli, 'command-path.ps1'))
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'defer-primary-runtime-smoke': { type: 'boolean', default: false } } })
  const target = desktopTargetPlatform(resolveDesktopBuildTarget())
  rmSync(RUNTIME_ROOT, { recursive: true, force: true })
  mkdirSync(RUNTIME_ROOT, { recursive: true })
  const preparePrimary = () => packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:primary-runtime',
    () => preparePrimaryRuntime({ deferSmoke: values['defer-primary-runtime-smoke'] }))
  let nodeVersion: string
  if (target.platform === 'win32') {
    const [electron, primary] = await Promise.allSettled([prepareElectron(target), preparePrimary()])
    if (electron.status === 'rejected') throw electron.reason
    if (primary.status === 'rejected') throw primary.reason
    nodeVersion = electron.value
  } else {
    nodeVersion = await prepareElectron(target)
    await preparePrimary()
  }
  const { pnpm } = await readPrimaryRuntime(join(RUNTIME_ROOT, 'primary-runtime'))
  if (pnpm === undefined) throw new Error('desktop runtime: primary-runtime manifest has no pnpm version')
  await packagingStep(process.env.DSH_DESKTOP_PACKAGING_RUN_DIR, 'prepare:cli', async () => { prepareCli(target) })
  writeFileSync(join(RUNTIME_ROOT, 'versions.json'), `${JSON.stringify({
    schemaVersion: 1,
    node: nodeVersion,
    pnpm,
  }, undefined, 2)}\n`)
}

await main()
