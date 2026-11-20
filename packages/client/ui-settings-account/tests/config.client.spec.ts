/** Public questionnaire options are emitted in the page bootstrap. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, Config } from '../src/index.ts'
import { CONTACT_CONFIG_GLOBAL } from '../src/contact-config.ts'
import { PLATFORM_PAGES_GLOBAL } from '../src/platform-pages-config.ts'
import { ONBOARDING_CONFIG_GLOBAL } from '../src/onboarding-config.ts'

/** The Peer an index render speaks for; this listener reads no field of it. */
const PAGE_PEER = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]

it('injects configured contact options with an empty default URL and removes the listener on disposal', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const config: Config = Config({ contactSource: 'harness' })
  expect(config.contactFormUrl).toBe('')
  await ctx.plugin({ Config, apply }, { contactSource: 'harness', contactFormUrl: 'https://support.example.test/form/' })
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table, PAGE_PEER)
  expect(table).toEqual([{ kind: 'global', name: CONTACT_CONFIG_GLOBAL, value: {
    contactFormUrl: 'https://support.example.test/form/', contactSource: config.contactSource,
  } }, { kind: 'global', name: PLATFORM_PAGES_GLOBAL, value: { embeddedPlatformPages: true } },
  { kind: 'global', name: ONBOARDING_CONFIG_GLOBAL, value: { desktopOnboarding: true } }])
  await ctx.fiber.dispose()
  table.length = 0
  ctx.emit('webserver/index-inject', table, PAGE_PEER)
  expect(table).toEqual([])
})

it('publishes the deployment choice to open Platform pages in the system browser', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin({ Config, apply }, { embeddedPlatformPages: false })
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table, PAGE_PEER)
  expect(table).toContainEqual({ kind: 'global', name: PLATFORM_PAGES_GLOBAL, value: { embeddedPlatformPages: false } })
})

it('publishes the choice to skip the first-run overlay to the page bootstrap', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin({ Config, apply }, { desktopOnboarding: false })
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table, PAGE_PEER)
  expect(table).toContainEqual({ kind: 'global', name: ONBOARDING_CONFIG_GLOBAL, value: { desktopOnboarding: false } })
})

it('hides the generated account form and releases its policy on disposal', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const release = vi.fn()
  const configure = vi.fn(() => release)
  ctx.provide('settings', { configure } as never)
  const fiber = await ctx.plugin({ Config, apply })
  await ctx.fiber.await()
  expect(configure).toHaveBeenCalledWith({ auto: false }, fiber)
  await fiber.dispose()
  expect(release).toHaveBeenCalledOnce()
})
