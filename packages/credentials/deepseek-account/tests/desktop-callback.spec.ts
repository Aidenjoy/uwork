import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { DeepSeekAccount } from '../src/index.ts'
import { DESKTOP_CALLBACK_PATH } from '../src/protocol.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** utoken's desktop token response: a 10-minute access token plus the long-lived model key. */
const ACCESS_TOKEN = 'A'.repeat(43)

/**
 * Boot the production stack a Web profile mounts: the WebServer, the browser-trust fence, the
 * authorization registry, the private credential store, and the account service, with a stand-in
 * for utoken's desktop authorization endpoints.
 */
async function fixture(user?: Record<string, unknown>, config: Record<string, unknown> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-callback-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const exchanges: string[] = []
  const platform = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => {
      if (req.url !== '/api/desktop-auth/token' || req.method !== 'POST') {
        res.writeHead(404).end()
        return
      }
      exchanges.push(body)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 600, language_api_key: 'sk-test-language-key',
        ...(user === undefined ? {} : { user }),
      }))
    })
  })
  await new Promise<void>(resolve => platform.listen(0, '127.0.0.1', resolve))
  const platformAddress = platform.address()
  if (platformAddress === null || typeof platformAddress === 'string') throw new Error('missing listener')
  const platformOrigin = `http://127.0.0.1:${platformAddress.port}`
  cleanups.push(async () => {
    await new Promise<void>((resolve) => { platform.close(() => { resolve() }); platform.closeAllConnections() })
  })

  // A notification service that never minted this grant: it answers the Platform envelope's
  // unauthorized business code for every token, which the account service must not read as expiry.
  let harnessHits = 0
  const harness = createServer((_req: IncomingMessage, res: ServerResponse) => {
    harnessHits++
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ code: 40003, msg: 'Authorization Failed (invalid token)', data: null }))
  })
  await new Promise<void>(resolve => harness.listen(0, '127.0.0.1', resolve))
  const harnessAddress = harness.address()
  if (harnessAddress === null || typeof harnessAddress === 'string') throw new Error('missing listener')
  const harnessOrigin = `http://127.0.0.1:${harnessAddress.port}`
  cleanups.push(async () => {
    await new Promise<void>((resolve) => { harness.close(() => { resolve() }); harness.closeAllConnections() })
  })

  const ctx = new Context()
  const web = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await web
  cleanups.push(() => web.dispose())
  const connection = ctx.plugin(Connection)
  await connection.await()
  cleanups.push(() => connection.dispose())
  const credentials = ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await credentials
  cleanups.push(() => credentials.dispose())
  const authorization = ctx.plugin(AuthorizationService)
  await authorization
  cleanups.push(() => authorization.dispose())
  const provider = ctx.plugin(DeepSeekAccount, {
    platformOrigin, harnessOrigin, inferenceOrigin: platformOrigin, allowLoopbackHttp: true, embeddedPageDist: '',
    ...config,
  })
  await provider
  cleanups.push(() => provider.dispose())

  const account = ctx.deepseekAccount
  const callbackOrigin = `http://127.0.0.1:${ctx.webServer.port}`
  const states = new AbortController()
  cleanups.push(async () => { states.abort() })
  async function wait(phase: string) {
    for await (const { state } of account.watch(states.signal)) {
      if (state.attempt?.phase === phase) return state
    }
    throw new Error(`missing phase ${phase}`)
  }
  const callback = (state: string, extra = '&code=test-code') => `${callbackOrigin}${DESKTOP_CALLBACK_PATH}?state=${state}${extra}`
  /** Markers Chrome attaches to a return navigation arriving from the authorization server. */
  const crossSite = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  return { ctx, account, callbackOrigin, callback, crossSite, wait, exchanges, harnessHits: () => harnessHits }
}

it('consumes a cross-site desktop callback the browser-trust fence refuses for other routes', async () => {
  const f = await fixture()
  const stop = f.ctx.webServer.register({ kind: 'exact', path: '/public', auth: 'anonymous', handler: (_req, res) => { res.end('public') } })
  cleanups.push(async () => { stop() })
  await f.account.startSignIn({ version: '1.2.3', locale: 'zh', timezoneOffsetSeconds: 28_800 }, f.callbackOrigin, 'web')
  const state = await f.wait('waiting-browser')
  const authorizeUrl = new URL(state.attempt?.authorizeUrl ?? '')
  expect(authorizeUrl.pathname).toBe('/api/desktop-auth/authorize')
  expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`${f.callbackOrigin}${DESKTOP_CALLBACK_PATH}`)
  // The same markers on an ordinary route stay refused; only the callback route answers.
  expect((await fetch(`${f.callbackOrigin}/public`, { headers: f.crossSite })).status).toBe(403)
  const response = await fetch(f.callback(authorizeUrl.searchParams.get('state') ?? ''), { headers: f.crossSite })
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('登录成功')
  expect(f.exchanges).toHaveLength(1)
  expect((await f.account.getState()).status).toBe('credential-stored')
  expect(await f.account.resolveLanguageKey()).toBe('sk-test-language-key')
})

it('answers a callback that outlives its attempt with a readable page instead of an admission refusal', async () => {
  const f = await fixture()
  await f.account.startSignIn({ version: '1.2.3', locale: 'zh', timezoneOffsetSeconds: 28_800 }, f.callbackOrigin, 'web')
  const state = await f.wait('waiting-browser')
  const authorizeUrl = new URL(state.attempt?.authorizeUrl ?? '')
  await f.account.cancelSignIn(state.attempt!.id)
  const response = await fetch(f.callback(authorizeUrl.searchParams.get('state') ?? ''), { headers: f.crossSite })
  expect(response.status).toBe(400)
  const body = await response.text()
  expect(body).toContain('登录会话已失效')
  expect(body).not.toContain('forbidden')
})

it('rejects a callback whose state belongs to no attempt without touching the authorization server', async () => {
  const f = await fixture()
  const response = await fetch(f.callback('not-a-state'), { headers: f.crossSite })
  expect(response.status).toBe(400)
  expect(await response.text()).toContain('登录会话已失效')
  expect(f.exchanges).toHaveLength(0)
})

it('does not let a notification service that never minted the grant revoke it', async () => {
  const f = await fixture()
  await f.account.startSignIn({ version: '1.2.3', locale: 'zh', timezoneOffsetSeconds: 28_800 }, f.callbackOrigin, 'web')
  const state = await f.wait('waiting-browser')
  const authorizeUrl = new URL(state.attempt?.authorizeUrl ?? '')
  const response = await fetch(f.callback(authorizeUrl.searchParams.get('state') ?? ''), { headers: f.crossSite })
  expect(response.status).toBe(200)
  expect((await f.account.getState()).status).toBe('credential-stored')
  // utoken issued this grant; DeepSeek's harness answers every foreign token with 40003. Reading
  // notifications there must neither reach it nor clear the login.
  expect(await f.account.getNotifications({ version: '1.2.3', locale: 'zh', timezoneOffsetSeconds: 28_800 })).toBeNull()
  expect(f.harnessHits()).toBe(0)
  expect((await f.account.getState()).status).toBe('credential-stored')
  expect(await f.account.resolveLanguageKey()).toBe('sk-test-language-key')
})

it('stores the utoken account snapshot and serves it as the gateway profile', async () => {
  const user = { id: 1, username: 'xinyang', display_name: '欧阳', role: 1, group: 'default' }
  const f = await fixture(user, { platformAccountApis: false })
  await f.account.startSignIn({ version: '1.2.3', locale: 'zh', timezoneOffsetSeconds: 28_800 }, f.callbackOrigin, 'web')
  const state = await f.wait('waiting-browser')
  const authorizeUrl = new URL(state.attempt?.authorizeUrl ?? '')
  const response = await fetch(f.callback(authorizeUrl.searchParams.get('state') ?? ''), { headers: f.crossSite })
  expect(response.status).toBe(200)
  // The gateway has no DeepSeek profile endpoint; the exchange snapshot answers instead of a request.
  expect(await f.account.getProfile({ version: '1.2.3', locale: 'zh', timezoneOffsetSeconds: 28_800 })).toEqual({
    status: 'ready',
    value: { id: '1', name: '欧阳', contact: null, username: 'xinyang', role: 1, group: 'default' },
  })
  // An empty display_name falls back to the login account.
  expect((await f.account.getProfile({ version: '1.2.3', locale: 'zh', timezoneOffsetSeconds: 28_800 }))).toBeDefined()
})

it('falls back to username when the utoken display name is empty', async () => {
  const user = { id: 7, username: 'fallback', display_name: '', role: 10, group: 'vip' }
  const f = await fixture(user, { platformAccountApis: false })
  await f.account.startSignIn({ version: '1.2.3', locale: 'zh', timezoneOffsetSeconds: 28_800 }, f.callbackOrigin, 'web')
  const state = await f.wait('waiting-browser')
  const authorizeUrl = new URL(state.attempt?.authorizeUrl ?? '')
  await fetch(f.callback(authorizeUrl.searchParams.get('state') ?? ''), { headers: f.crossSite })
  const profile = await f.account.getProfile({ version: '1.2.3', locale: 'zh', timezoneOffsetSeconds: 28_800 })
  expect(profile).toMatchObject({ status: 'ready', value: { name: 'fallback', username: 'fallback', role: 10, group: 'vip' } })
})

it('still signs in when the account snapshot shape drifts', async () => {
  // A display-only field must never block sign-in; the profile degrades to "failed".
  const f = await fixture({ id: 'not-an-int' }, { platformAccountApis: false })
  await f.account.startSignIn({ version: '1.2.3', locale: 'zh', timezoneOffsetSeconds: 28_800 }, f.callbackOrigin, 'web')
  const state = await f.wait('waiting-browser')
  const authorizeUrl = new URL(state.attempt?.authorizeUrl ?? '')
  const response = await fetch(f.callback(authorizeUrl.searchParams.get('state') ?? ''), { headers: f.crossSite })
  expect(response.status).toBe(200)
  expect((await f.account.getState()).status).toBe('credential-stored')
  expect(await f.account.resolveLanguageKey()).toBe('sk-test-language-key')
  expect(await f.account.getProfile({ version: '1.2.3', locale: 'zh', timezoneOffsetSeconds: 28_800 }))
    .toEqual({ status: 'failed' })
})
