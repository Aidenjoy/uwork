import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { applyLaunchConfig, LAUNCH_CONFIG_FILE } from '../src/launch-config.ts'

const directories: string[] = []

afterEach(async () => {
  while (directories.length > 0) await rm(directories.pop() as string, { recursive: true, force: true })
})

/** Create a scratch directory holding one JSON document. */
async function fixture(document: unknown, name = LAUNCH_CONFIG_FILE): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-launch-config-'))
  directories.push(directory)
  await writeFile(join(directory, name), JSON.stringify(document))
  return directory
}

it('applies the active preset and replaces an inherited value', async () => {
  const cwd = await fixture({
    active: 'intranet',
    profiles: {
      intranet: {
        DSH_ACCOUNT_ORIGIN: 'http://10.1.2.3:3000',
        DSH_ACCOUNT_INSECURE: '1',
        DEEPSEEK_BASE_URL: 'http://10.1.2.3:3000',
      },
      official: {},
    },
  })
  const environment: NodeJS.ProcessEnv = { DSH_ACCOUNT_ORIGIN: 'https://platform.deepseek.com' }
  const applied = applyLaunchConfig({ environment, cwd, moduleDirectory: cwd })
  expect(applied).toStrictEqual({
    path: join(cwd, LAUNCH_CONFIG_FILE),
    profile: 'intranet',
    names: ['DSH_ACCOUNT_ORIGIN', 'DSH_ACCOUNT_INSECURE', 'DEEPSEEK_BASE_URL'],
  })
  expect(environment).toStrictEqual({
    DSH_ACCOUNT_ORIGIN: 'http://10.1.2.3:3000',
    DSH_ACCOUNT_INSECURE: '1',
    DEEPSEEK_BASE_URL: 'http://10.1.2.3:3000',
  })
})

it('lets YUN_PROFILE select another preset without editing the document', async () => {
  const cwd = await fixture({
    active: 'intranet',
    profiles: {
      intranet: { DSH_ACCOUNT_ORIGIN: 'http://10.1.2.3:3000' },
      local: { DSH_ACCOUNT_ORIGIN: 'http://127.0.0.1:3000' },
    },
  })
  const environment: NodeJS.ProcessEnv = { YUN_PROFILE: 'local' }
  expect(applyLaunchConfig({ environment, cwd, moduleDirectory: cwd })?.profile).toBe('local')
  expect(environment.DSH_ACCOUNT_ORIGIN).toBe('http://127.0.0.1:3000')
})

it('finds the checkout beside the entry when the working directory has no file', async () => {
  const checkout = await fixture({ active: 'local', profiles: { local: { DSH_ACCOUNT_ORIGIN: 'http://127.0.0.1:3000' } } })
  const elsewhere = await mkdtemp(join(tmpdir(), 'desktop-launch-cwd-'))
  directories.push(elsewhere)
  const environment: NodeJS.ProcessEnv = {}
  const applied = applyLaunchConfig({ environment, cwd: elsewhere, moduleDirectory: join(checkout, 'apps', 'desktop-host') })
  expect(applied?.profile).toBe('local')
  expect(environment.DSH_ACCOUNT_ORIGIN).toBe('http://127.0.0.1:3000')
})

it('keeps startup safe for a broken document', async () => {
  const cwd = await fixture({ profiles: { local: { DSH_ACCOUNT_ORIGIN: 'http://127.0.0.1:3000' } } })
  const warn = vi.fn()
  const environment: NodeJS.ProcessEnv = {}
  expect(applyLaunchConfig({ environment, cwd, moduleDirectory: cwd, warn })).toBeUndefined()
  expect(environment).toStrictEqual({})
  expect(warn).toHaveBeenCalledOnce()
})

it('keeps startup safe for an unknown preset and a missing explicit path', async () => {
  const cwd = await fixture({ active: 'absent', profiles: { local: {} } })
  const warn = vi.fn()
  expect(applyLaunchConfig({ environment: {}, cwd, moduleDirectory: cwd, warn })).toBeUndefined()
  const missing = join(cwd, 'nowhere.json')
  expect(applyLaunchConfig({ environment: { YUN_CONFIG: missing }, cwd, moduleDirectory: cwd, warn })).toBeUndefined()
  expect(warn).toHaveBeenCalledTimes(2)
})

it('does nothing when no candidate exists', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'desktop-launch-empty-'))
  directories.push(cwd)
  const applied = applyLaunchConfig({ environment: {}, cwd, moduleDirectory: cwd, dshHome: cwd })
  expect(applied).toBeUndefined()
})
