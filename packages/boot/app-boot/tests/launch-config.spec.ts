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

it('applies the active preset while preserving caller-supplied environment values', async () => {
  const checkout = await fixture({
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
  const applied = applyLaunchConfig({ environment, cwd: checkout, moduleDirectory: checkout })
  expect(applied).toStrictEqual({
    path: join(checkout, LAUNCH_CONFIG_FILE),
    profile: 'intranet',
    names: ['DSH_ACCOUNT_INSECURE', 'DEEPSEEK_BASE_URL'],
  })
  expect(environment).toStrictEqual({
    DSH_ACCOUNT_ORIGIN: 'https://platform.deepseek.com',
    DSH_ACCOUNT_INSECURE: '1',
    DEEPSEEK_BASE_URL: 'http://10.1.2.3:3000',
  })
})

it('does not load yun.config.json from an untrusted working directory', async () => {
  const untrustedCwd = await fixture({
    active: 'evil',
    profiles: { evil: { DSH_ACCOUNT_ORIGIN: 'https://attacker.invalid' } },
  })
  const empty = await mkdtemp(join(tmpdir(), 'desktop-launch-clean-'))
  directories.push(empty)
  const environment: NodeJS.ProcessEnv = {}
  expect(applyLaunchConfig({ environment, cwd: untrustedCwd, moduleDirectory: empty, dshHome: empty })).toBeUndefined()
  expect(environment).toStrictEqual({})
})

it('rejects non-allowlisted keys, null/object values, and prototype preset names', async () => {
  const checkout = await fixture({
    active: 'local',
    profiles: {
      local: {
        DSH_ACCOUNT_ORIGIN: 'http://127.0.0.1:3000',
        NODE_OPTIONS: '--require /tmp/pwn.js',
        PATH: '/tmp/evil',
        DSH_INFERENCE_ORIGIN: null,
        DSH_DEFAULT_MODEL: { nested: true },
      },
    },
  })
  const warn = vi.fn()
  const environment: NodeJS.ProcessEnv = {}
  const applied = applyLaunchConfig({ environment, cwd: checkout, moduleDirectory: checkout, warn })
  expect(applied?.names).toStrictEqual(['DSH_ACCOUNT_ORIGIN'])
  expect(environment).toStrictEqual({ DSH_ACCOUNT_ORIGIN: 'http://127.0.0.1:3000' })
  expect(warn).toHaveBeenCalledTimes(4)

  const protoWarn = vi.fn()
  const protoEnv: NodeJS.ProcessEnv = { YUN_PROFILE: '__proto__' }
  expect(applyLaunchConfig({ environment: protoEnv, cwd: checkout, moduleDirectory: checkout, warn: protoWarn })).toBeUndefined()
  expect(protoWarn).toHaveBeenCalledOnce()
})

it('lets YUN_PROFILE select another preset without editing the document', async () => {
  const checkout = await fixture({
    active: 'intranet',
    profiles: {
      intranet: { DSH_ACCOUNT_ORIGIN: 'http://10.1.2.3:3000' },
      local: { DSH_ACCOUNT_ORIGIN: 'http://127.0.0.1:3000' },
    },
  })
  const environment: NodeJS.ProcessEnv = { YUN_PROFILE: 'local' }
  expect(applyLaunchConfig({ environment, cwd: checkout, moduleDirectory: checkout })?.profile).toBe('local')
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

it('loads yun.config.json from dshHome when no checkout file exists', async () => {
  const home = await fixture({ active: 'local', profiles: { local: { DSH_ACCOUNT_ORIGIN: 'http://127.0.0.1:3000' } } })
  const empty = await mkdtemp(join(tmpdir(), 'desktop-launch-empty-mod-'))
  directories.push(empty)
  const environment: NodeJS.ProcessEnv = {}
  const applied = applyLaunchConfig({ environment, cwd: empty, moduleDirectory: empty, dshHome: home })
  expect(applied).toStrictEqual({
    path: join(home, LAUNCH_CONFIG_FILE),
    profile: 'local',
    names: ['DSH_ACCOUNT_ORIGIN'],
  })
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
