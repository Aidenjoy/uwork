/** Compile the fixed npm DevTools sources locally and publish the complete static frontend. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFrontend } from './devtools/vite.ts'
import { DEVTOOLS_NPM_VERSION, DEVTOOLS_SOURCE_REVISION } from './devtools/source.ts'

let pending: Promise<{ files: number; bytes: number }> | undefined

/**
 * Build lib/devtools without network access, retaining relative Worker and asset URLs.
 * @returns Published file count and bytes, excluding the distribution manifest.
 */
export function buildDevtools(): Promise<{ files: number; bytes: number }> {
  pending ??= compile().finally(() => { pending = undefined })
  return pending
}

async function compile(): Promise<{ files: number; bytes: number }> {
  const lib = fileURLToPath(new URL('../lib/', import.meta.url))
  await mkdir(lib, { recursive: true })
  const temporary = await mkdtemp(join(lib, 'devtools.build-'))
  try {
    await buildFrontend(temporary)
    const files: Array<{ path: string; bytes: number; sha256: string }> = []
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(join(temporary, directory), { withFileTypes: true })) {
        const path = directory ? `${directory}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(path)
        else {
          const bytes = await readFile(join(temporary, path))
          files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
        }
      }
    }
    await walk('')
    const bytes = files.reduce((total, file) => total + file.bytes, 0)
    const output = join(lib, 'devtools')
    await writeFile(join(temporary, 'resource-manifest.json'), `${JSON.stringify({
      source: 'chrome-devtools-frontend', version: DEVTOOLS_NPM_VERSION, revision: DEVTOOLS_SOURCE_REVISION,
      builder: 'vite',
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
    }, null, 2)}\n`)
    // Republishing an identical tree would still delete and recreate `lib/devtools`, and a
    // concurrent `pnpm pack` walking it can observe a missing path even across two renames.
    // The manifest pins every file's path, size, and digest, so an exact match is proof that
    // the published tree is current and the swap can be skipped entirely.
    const manifest = await readFile(join(temporary, 'resource-manifest.json'), 'utf8')
    const published = await readFile(join(output, 'resource-manifest.json'), 'utf8').catch(() => undefined)
    if (published === manifest) {
      console.log(`DevTools npm ${DEVTOOLS_NPM_VERSION}: ${files.length} files unchanged`)
      return { files: files.length, bytes }
    }
    // Swap the published tree without ever leaving `lib/devtools` absent: a concurrent
    // `pnpm pack` enumerating `lib/devtools/**` must not observe a missing directory, and the
    // slow recursive delete of the previous tree happens only after the new one is in place.
    const retired = join(lib, `devtools.retire-${randomUUID()}`)
    const hadPrevious = await rename(output, retired).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    try {
      await rename(temporary, output)
    } catch (error) {
      // Restore the previous tree so a failed publish cannot leave the package without DevTools.
      if (hadPrevious) await rename(retired, output).catch(() => {})
      throw error
    }
    if (hadPrevious) await rm(retired, { recursive: true, force: true })
    console.log(`DevTools npm ${DEVTOOLS_NPM_VERSION}: ${files.length} files, ${bytes} bytes`)
    return { files: files.length, bytes }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildDevtools()
