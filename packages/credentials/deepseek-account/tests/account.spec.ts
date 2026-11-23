import { afterEach, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer as createTcpServer, connect, Socket } from 'node:net'
import { join } from 'node:path'
import { createServer, request as httpRequest, IncomingMessage, ServerResponse } from 'node:http'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AccountClientMetadata } from '@deepseek-ai/dsh-deepseek-account'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { DeepSeekAccount } from '../src/index.ts'
import { DESKTOP_CALLBACK_PATH, desktopRedirectUri, isPrivateHttpHost, platformHeaders, platformOrigin, loginOrigin } from '../src/protocol.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.useRealTimers()
  while (cleanups.length) await cleanups.pop()!()
})

/** Client identity supplied with each account operation; the Host derives the Platform headers from it. */
const clientMetadata = (locale = 'en'): AccountClientMetadata => ({ version: '1.2.3', locale, timezoneOffsetSeconds: 28_800 })

async function fixture(
  contact: { email: string; mobile?: string; mobile_number?: string; id?: string | null } = {
    email: 't***@example.invalid', mobile: '138****5678',
  },
  requestHeaders: Record<string, string> = {},
  accountRequestHeaders: Record<string, string> = {},
  inferenceOrigin = 'https://api.deepseek.com',
  beforeAccount?: (ctx: Context, origin: string) => Promise<void>,
  embeddedPageDist = '',
  desktopPlatform: 'darwin' | 'win32' | null = null,
  balanceTimeoutMs = 30_000,
  pagePaths: { usagePath?: string; topUpPath?: string } = {},
  extraConfig: Record<string, unknown> = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-account-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  let init: Record<string, string> = {}
  const cancellations: Array<Record<string, string>> = []
  const cancellationReceived = Promise.withResolvers<undefined>()
  let holdCancel = false
  const exchanged = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let redirect = false
  let hold = false
  let count = 0
  let businessCode = 0
  let initOverride: Record<string, unknown> = {}
  let onInit = () => {}
  let origin = ''
  let detailsHold = false
  let balanceHold = false
  let detailCode = 0
  let detailStatus = 200
  let profileFailed = false
  /** utoken desktop exchange: 43-character access token, long-lived language key, optional snapshot. */
  let accessToken = 'A'.repeat(43)
  let desktopUser: Record<string, unknown> | undefined
  let tokenOverride: Record<string, unknown> = {}
  const tokenRequests: string[] = []

  let summaryFailed = false
  let logoutFailed = false
  let logoutHold = false
  let logoutCount = 0
  const logoutHeaders: Array<string | undefined> = []
  let desktopRevokeCount = 0
  const desktopRevokeHeaders: Array<string | undefined> = []
  let desktopBalanceStatus = 200
  let desktopBalanceRaw: string | undefined
  let desktopBalancePayload: unknown = {
    success: true,
    data: {
      user_id: 329,
      wallet_balance: 30,
      wallet_quota: 15_000_000,
      quota_display_type: 'USD',
      subscriptions: [{
        subscription_id: 8,
        plan_id: 1,
        total_points: 40,
        used_points: 1,
        remaining_points: 39,
        unlimited: false,
        end_time: 1_798_000_000,
      }],
    },
  }
  const desktopBalanceRequests: Array<string | undefined> = []
  let desktopUsageLogsStatus = 200
  let desktopUsageLogsRaw: string | undefined
  let desktopUsageLogsPayload: unknown = {
    success: true,
    message: '',
    data: {
      page: 1,
      page_size: 20,
      total: 1,
      items: [{
        id: 4101,
        created_at: 1_700_000_000,
        model_name: 'example-model',
        type: 2,
        prompt_tokens: 11,
        completion_tokens: 7,
        quota: 5,
        subscription_quota: 9,
        token_name: 'example-key-name',
        request_id: 'example-request-id',
        http_status: 200,
        use_time: 2,
        is_stream: true,
        cache_hit: false,
        task_settle: false,
      }],
    },
  }
  const desktopUsageLogsRequests: Array<{ url: string; authorization: string | undefined }> = []
  let desktopConversationsStatus = 200
  let desktopConversationsPayload: unknown = {
    success: true,
    message: '',
    data: {
      items: [{
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: '测试会话',
        revision: 3,
        create_time: '2026-11-23T08:00:00Z',
        update_time: '2026-11-23T08:05:00Z',
      }],
      has_more: false,
    },
  }
  const desktopConversationMessagesPayload: unknown = {
    success: true,
    message: '',
    data: {
      revision: 3,
      items: [{
        id: 'msg-user-1',
        sequence: 51,
        payload: { key: 'msg-user-1', from: 'user', versions: [{ id: 'v1', content: '你好' }], status: 'complete' },
      }],
      has_more: true,
    },
  }
  let desktopConversationPatchStatus = 200
  const desktopConversationPatchPayload: unknown = {
    success: true,
    message: '',
    data: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      title: '测试会话',
      revision: 4,
      create_time: '2026-11-23T08:00:00Z',
      update_time: '2026-11-23T08:06:00Z',
    },
  }
  const desktopConversationRequests: Array<{ method: string; url: string; authorization: string | undefined }> = []
  let normalWallets: unknown = [{ currency: 'CNY', balance: '123.45', token_estimation: '0' },
    { currency: 'USD', balance: '6.78', token_estimation: '0' }]
  let bonusWallets: unknown = [{ currency: 'CNY', balance: '10.00' }]
  const detailsStarted = Promise.withResolvers<undefined>()
  const detailRequests: Array<{ path: string; authorization: string | undefined }> = []
  const receivedHeaders: Array<{
    clientPlatform: string | undefined
    bundleId: string | undefined
    version: string | undefined
    locale: string | undefined
    timezoneOffset: string | undefined
    path: string | undefined
    cookie: string | undefined
    authorization: string | undefined
  }> = []
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const reqPath = req.url?.split('?')[0]
    if (reqPath !== '/api/desktop-auth/revoke' && reqPath !== '/api/desktop-auth/balance'
      && reqPath !== '/api/desktop/usage-logs' && !reqPath?.startsWith('/api/conversations')) {
      expect(req.headers.authorization).toBeUndefined()
    }
    receivedHeaders.push({ clientPlatform: req.headers['x-client-platform'] as string | undefined,
      bundleId: req.headers['x-client-bundle-id'] as string | undefined,
      version: req.headers['x-client-version'] as string | undefined,
      locale: req.headers['x-client-locale'] as string | undefined,
      timezoneOffset: req.headers['x-client-timezone-offset'] as string | undefined,
      path: req.url, cookie: req.headers.cookie, authorization: req.headers['x-dsh-auth-token'] as string | undefined })
    if (redirect) { res.writeHead(302, { location: `${origin}/redirect-target` }).end(); return }
    if (req.url === '/api/desktop-auth/balance' && req.method === 'GET') {
      desktopBalanceRequests.push(req.headers.authorization)
      if (detailsHold || balanceHold) await release.promise
      if (desktopBalanceStatus !== 200) { res.writeHead(desktopBalanceStatus).end(); return }
      res.setHeader('content-type', 'application/json')
      res.end(desktopBalanceRaw ?? JSON.stringify(desktopBalancePayload))
      return
    }
    if (reqPath === '/api/desktop/usage-logs' && req.method === 'GET') {
      desktopUsageLogsRequests.push({ url: req.url ?? '', authorization: req.headers.authorization })
      if (desktopUsageLogsStatus !== 200) { res.writeHead(desktopUsageLogsStatus).end(); return }
      res.setHeader('content-type', 'application/json')
      res.end(desktopUsageLogsRaw ?? JSON.stringify(desktopUsageLogsPayload))
      return
    }
    if (reqPath === '/api/conversations' && req.method === 'GET') {
      desktopConversationRequests.push({ method: 'GET', url: req.url ?? '', authorization: req.headers.authorization })
      if (desktopConversationsStatus !== 200) { res.writeHead(desktopConversationsStatus).end(); return }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(desktopConversationsPayload))
      return
    }
    if (reqPath?.startsWith('/api/conversations/') && reqPath.endsWith('/messages') && req.method === 'GET') {
      desktopConversationRequests.push({ method: 'GET', url: req.url ?? '', authorization: req.headers.authorization })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(desktopConversationMessagesPayload))
      return
    }
    if (reqPath?.startsWith('/api/conversations/') && req.method === 'PATCH') {
      desktopConversationRequests.push({ method: 'PATCH', url: req.url ?? '', authorization: req.headers.authorization })
      if (desktopConversationPatchStatus !== 200) { res.writeHead(desktopConversationPatchStatus).end(); return }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(desktopConversationPatchPayload))
      return
    }
    if (req.url === '/api/desktop-auth/revoke') {
      desktopRevokeCount++
      desktopRevokeHeaders.push(req.headers.authorization)
      if (logoutHold) await release.promise
      res.writeHead(logoutFailed ? 500 : 204).end()
      return
    }
    if (req.url === '/auth-api/v0/users/logout') {
      logoutCount++
      logoutHeaders.push(req.headers['x-dsh-auth-token'] as string | undefined)
      if (logoutHold) await release.promise
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ code: logoutFailed ? 50000 : 0, data: { biz_code: 0, biz_data: null } }))
      return
    }
    if (req.method === 'GET') {
      detailRequests.push({ path: req.url!, authorization: req.headers['x-dsh-auth-token'] as string | undefined })
      const status = detailStatus
      detailsStarted.resolve(undefined)
      if (detailsHold || (balanceHold && req.url === '/api/v0/users/get_user_summary')) await release.promise
      if (status !== 200) { res.writeHead(status).end(); return }
      if (detailCode !== 0) { res.end(JSON.stringify({ code: detailCode, data: null })); return }
      const value = req.url === '/auth-api/v0/users/current'
        ? { id: 'test-user', token: 'never-copy-response-token', ...contact,
          id_profile: { name: 'Test Account', picture: null } }
        : { normal_wallets: normalWallets, bonus_wallets: bonusWallets }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ code: 0, data: {
        biz_code: (profileFailed && req.url === '/auth-api/v0/users/current')
          || (summaryFailed && req.url === '/api/v0/users/get_user_summary') ? 17 : 0, biz_data: value,
      } }))
      return
    }
    // utoken answers the desktop code exchange with plain JSON, not the platform envelope.
    if (req.url === '/api/desktop-auth/token') {
      let form = ''
      for await (const chunk of req) form += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      tokenRequests.push(form)
      count++
      exchanged.resolve(undefined)
      if (hold) await release.promise
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 600,
        language_api_key: 'sk-test-language-key',
        ...(desktopUser === undefined ? {} : { user: desktopUser }),
        ...tokenOverride,
      }))
      return
    }
    req.setEncoding('utf8')
    let text = ''
    for await (const chunk of req) {
      if (typeof chunk !== 'string') throw new Error('expected UTF-8 chunk')
      text += chunk
    }
    const body = JSON.parse(text) as Record<string, string>
    let value: unknown
    if (req.url?.endsWith('auth_cancel')) {
      cancellations.push(body)
      cancellationReceived.resolve(undefined)
      if (holdCancel) await release.promise
      value = null
    } else if (req.url?.endsWith('auth_init')) {
      init = body
      onInit()
      value = { authorize_url: `${origin}/dsh/authorize?authorize_id=test`, expires_in: 600, authorize_id: 'test', ...initOverride }
    } else {
      count++
      exchanged.resolve(undefined)
      if (hold) await release.promise
      value = { user: null, token: 'dsh_mock_test', authorized_url: `${origin}/dsh/authorized?result=test&locale=zh_CN` }
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ code: 0, data: { biz_code: businessCode, biz_msg: 'sensitive diagnostic', biz_data: value } }))
  }
  const server = createServer((req, res) => { void handle(req, res).catch(() => { res.writeHead(500).end() }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing listener')
  origin = `http://127.0.0.1:${address.port}`
  cleanups.push(async () => {
    release.resolve(undefined)
    await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
  })
  const ctx = new Context()
  const web = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await web
  const callbackOrigin = `http://127.0.0.1:${ctx.webServer.port}`
  const credentials = ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.yaml'), watch: false })
  await credentials
  const authorization = ctx.plugin(AuthorizationService)
  await authorization
  await beforeAccount?.(ctx, origin)
  const provider = ctx.plugin(DeepSeekAccount, {
    platformOrigin: origin, inferenceOrigin, embeddedPageDist, desktopPlatform,
    allowLoopbackHttp: true, requestHeaders, accountRequestHeaders,
    logoutRetryDelayMs: 1, balanceTimeoutMs,
    ...pagePaths,
    ...extraConfig,
  })
  await provider
  cleanups.push(async () => { await provider.dispose(); await authorization.dispose(); await credentials.dispose(); await web.dispose() })
  const account = ctx.deepseekAccount
  const states = new AbortController()
  cleanups.push(async () => { states.abort() })
  /** CSRF state of the current attempt; the callback route matches on it instead of the Host header. */
  let currentState: string | undefined
  async function wait(phase: string) {
    for await (const { state } of account.watch(states.signal)) {
      const authorizeUrl = state.attempt?.authorizeUrl
      if (authorizeUrl !== undefined) {
        try {
          currentState = new URL(authorizeUrl).searchParams.get('state') ?? currentState
        } catch {
          // A malformed authorize URL is the subject of its own assertion.
        }
      }
      if (state.attempt?.phase === phase) return state
    }
    throw new Error(`missing phase ${phase}`)
  }
  return { cancellations, cancellationReceived, holdCancel: () => { holdCancel = true },
    ctx, account, home, origin, callbackOrigin, wait, receivedHeaders, logoutHeaders, logoutCount: () => logoutCount,
    desktopRevokeHeaders, desktopRevokeCount: () => desktopRevokeCount,
    desktopBalanceRequests,
    setDesktopBalanceStatus: (status: number) => { desktopBalanceStatus = status },
    setDesktopBalancePayload: (value: unknown) => { desktopBalancePayload = value },
    desktopUsageLogsRequests,
    setDesktopUsageLogsStatus: (value: number) => { desktopUsageLogsStatus = value },
    setDesktopUsageLogsPayload: (value: unknown) => { desktopUsageLogsPayload = value },
    setDesktopUsageLogsRaw: (value: string | undefined) => { desktopUsageLogsRaw = value },
    desktopConversationRequests,
    setDesktopConversationsStatus: (value: number) => { desktopConversationsStatus = value },
    setDesktopConversationsPayload: (value: unknown) => { desktopConversationsPayload = value },
    setDesktopConversationPatchStatus: (value: number) => { desktopConversationPatchStatus = value },
    setDesktopBalanceRaw: (value: string | undefined) => { desktopBalanceRaw = value },
    holdLogout: () => { logoutHold = true },
    failLogout: (failed: boolean) => { logoutFailed = failed }, detailRequests, detailsStarted,
    detailCode: (code: number) => { detailCode = code },
    detailStatus: (status: number) => { detailStatus = status },
    failProfile: (failed: boolean) => { profileFailed = failed },
    holdBalance: () => { balanceHold = true },
    setBalance: (value: string) => { normalWallets = [{ currency: 'CNY', balance: value }, { currency: 'USD', balance: '6.78' }] },
    holdDetails: () => { detailsHold = true }, failSummary: () => { summaryFailed = true },
    invalidateSummary: () => { normalWallets = [{ currency: 'CNY', balance: 'not-a-decimal' }] },
    normalWallets: (value: unknown) => { normalWallets = value },
    dispose: () => provider.dispose(), exchanged, release,
    redirect: () => { redirect = true },
    hold: () => { hold = true },
    initResponse: (value: Record<string, unknown>) => { initOverride = value },
    onInit: (callback: () => void) => { onInit = callback },
    bonusWallets: (value: unknown) => { bonusWallets = value },
    /** Override the desktop token payload; `null` makes the exchange answer a protocol violation. */
    exchangeResponse: (value: Record<string, unknown> | null) => { tokenOverride = value === null ? { access_token: 'short' } : value },
    setAccessToken: (value: string) => { accessToken = value },
    setDesktopUser: (value: Record<string, unknown> | undefined) => { desktopUser = value },
    tokenRequests: () => tokenRequests,
    fail: (value: number) => { businessCode = value },
    init: () => init, count: () => count,
    callback: (state: string | undefined = currentState) => `${callbackOrigin}${DESKTOP_CALLBACK_PATH}?code=test&state=${state ?? ''}` }
}

it('accepts the cross-site OAuth return without relaxing other anonymous routes', async () => {
  const f = await fixture()
  const connection = f.ctx.plugin(Connection)
  await connection.await()
  cleanups.push(async () => { await connection.dispose() })
  const stop = f.ctx.webServer.register({ kind: 'exact', path: '/public', auth: 'anonymous', handler: (_req, res) => { res.end('public') } })
  cleanups.push(async () => { stop() })
  const headers = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
  await f.wait('waiting-browser')
  expect((await fetch(`${f.callbackOrigin}/public`, { headers })).status).toBe(403)
  expect((await fetch(f.callback('wrong'), { headers })).status).toBe(400)
  expect(f.count()).toBe(0)
  const response = await fetch(f.callback(), { headers, redirect: 'manual' })
  // The return tab is answered in place: the desktop exchange has no post-authorization page.
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('Signed in')
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(f.count()).toBe(1)
  expect((await f.account.getState()).status).toBe('credential-stored')
})

it('consumes the callback by CSRF state rather than the Host header', async () => {
  const f = await fixture()
  const connection = f.ctx.plugin(Connection)
  await connection.await()
  cleanups.push(async () => { await connection.dispose() })
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
  await f.wait('waiting-browser')
  const callback = new URL(f.callback())
  const crossSite = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  const requestStatus = (url: URL, headers: Record<string, string>): Promise<number | undefined> => new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.on('error', reject)
      response.once('end', () => { resolve(response.statusCode) })
      response.resume()
    })
    request.on('error', reject)
    request.end()
  })
  // A port forward or a loopback host spelling must not detach a login...
  expect(await requestStatus(callback, { ...crossSite, host: `localhost:${callback.port}` })).toBe(200)
  expect(f.count()).toBe(1)
  expect((await f.account.getState()).status).toBe('credential-stored')
  // ...while a state that does not belong to the attempt is refused without touching the exchange.
  await f.account.signOut(clientMetadata())
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
  await f.wait('waiting-browser')
  expect(await requestStatus(new URL(f.callback('wrong')), crossSite)).toBe(400)
  expect(f.count()).toBe(1)
  await f.account.cancelSignIn((await f.account.getState()).attempt!.id)
})

// The desktop authorization server signs the URL locally: there is no `auth_init` round-trip, so the
// former server-TTL and initialization-deadline cases no longer describe this flow. The attempt
// deadline itself is covered by the exchange-arrives-late case below.

it('does not store an exchange result received after the sign-in deadline', async () => {
  const f = await fixture()
  const startedAt = 1_000_000
  f.hold()
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(startedAt)
    await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
    await f.wait('waiting-browser')
    const callback = fetch(f.callback(), { redirect: 'manual' })
    await f.exchanged.promise
    vi.setSystemTime(startedAt + 600_000)
    f.release.resolve(undefined)
    await callback
    const state = await f.wait('expired')
    expect(state.status).toBe('signed-out')
    expect(await f.account.getPlatformSession()).toBeNull()
  } finally { vi.useRealTimers() }
})

it('stores both credentials before answering, restores account presence, and clears them on sign-out', async () => {
  const f = await fixture()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  expect((await fetch(f.callback('wrong'))).status).toBe(400)
  const response = await fetch(f.callback(), { redirect: 'manual' })
  expect(response.status).toBe(200)
  expect((await f.account.getState()).status).toBe('credential-stored')
  const stored = await readFile(join(f.home, 'credentials.yaml'), 'utf8')
  expect(stored).toContain('A'.repeat(43))
  // The Host publishes identity from a separate profile read; the snapshot only reuses it.
  await f.account.getProfile(clientMetadata())
  expect(await f.account.getPlatformSession()).toEqual({ origin: f.origin, userId: 'test-user', token: 'A'.repeat(43),
    usagePath: '/usage', topUpPath: '/top_up', requestHeaders: {} })
  expect(await f.account.resolveToken('https://api.deepseek.com')).toBeUndefined()
  // The language key is the model credential, kept apart from the 10-minute access token, and it is
  // bound to the configured inference origin rather than to the authorization origin.
  expect(await f.account.resolveLanguageKey()).toBe('sk-test-language-key')
  expect(await f.account.resolveLanguageKey('https://api.deepseek.com/v1')).toBe('sk-test-language-key')
  expect(await f.account.resolveLanguageKey(f.origin)).toBeUndefined()
  await f.account.signOut(clientMetadata())
  expect((await f.account.getState()).status).toBe('signed-out')
  expect(await f.account.getPlatformSession()).toBeNull()
  expect(await f.account.resolveLanguageKey()).toBeUndefined()
  for (const name of ['default', 'speech', 'profile']) {
    expect((await f.ctx.credentials.describeRecord(credentialKey('deepseek-account-platform', name))).configured).toBe(false)
  }
})

it('does not persist a delayed exchange after cancellation or replace the next attempt', async () => {
  const f = await fixture()
  f.exchangeResponse({ user: { email: 'c***@example.invalid', id_profile: { name: 'Cancelled User' } } })
  f.hold()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  const waiting = await f.wait('waiting-browser')
  const callback = fetch(f.callback(), { redirect: 'manual' }).catch(() => undefined)
  await f.exchanged.promise
  const cancelled = await f.account.cancelSignIn(waiting.attempt!.id)
  expect(cancelled.attempt?.phase).toBe('cancelled')
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  const next = await f.wait('waiting-browser')
  f.release.resolve(undefined)
  await callback
  expect((await f.account.getState()).attempt?.id).toBe(next.attempt?.id)
  expect((await f.account.getState()).status).toBe('signed-out')
  expect(f.count()).toBe(1)
  expect(await f.account.getProfile(clientMetadata())).toBeNull()
  await f.account.cancelSignIn(next.attempt!.id)
})

it('allows real account credentials only on the exact official HTTPS origin', async () => {
  const f = await fixture()
  await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, issuer: 'https://platform.deepseek.com', token: 'test-account-token' },
  }))
  expect(await f.account.resolveToken('https://api.deepseek.com/v1')).toBe('test-account-token')
  for (const url of ['http://api.deepseek.com', 'https://api.deepseek.com.evil.test', 'https://api.deepseek.com:8443', 'https://user@api.deepseek.com']) {
    expect(await f.account.resolveToken(url)).toBeUndefined()
  }
})

it('restricts platform destinations to the configured origin and route', () => {
  expect(() => platformOrigin('http://localhost:8081', false, 'platformOrigin')).toThrow()
  expect(platformOrigin('http://localhost:8081', true, 'platformOrigin')).toBe('http://localhost:8081')
  expect(() => platformOrigin('http://example.com', true, 'platformOrigin')).toThrow()
  expect(platformOrigin('http://10.1.2.3:3000', true, 'platformOrigin')).toBe('http://10.1.2.3:3000')
  // A public host that merely starts with a private prefix is not an intranet address.
  for (const host of ['http://10.1.2.3.example.com', 'http://10.0.0.1.example.com', 'http://172.16.0.9.example.com']) {
    expect(() => platformOrigin(host, true, 'platformOrigin')).toThrow('platformOrigin')
  }
  expect(isPrivateHttpHost('192.168.1.1')).toBe(true)
  expect(isPrivateHttpHost('172.31.255.255')).toBe(true)
  expect(isPrivateHttpHost('172.32.0.1')).toBe(false)
  expect(isPrivateHttpHost('8.8.8.8')).toBe(false)
})

// The desktop authorization server answers the return tab in place and has no `authorized_url`
// completion page, so the former completion-URL, `login_source` and `client_type` cases no longer
// describe this flow.

it('answers a malformed token payload as a protocol failure without exposing backend text', async () => {
  const f = await fixture()
  // A 15-character access token fails the response schema after a successful HTTP round trip.
  f.exchangeResponse(null)
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  expect((await fetch(f.callback(), { redirect: 'manual' })).status).toBe(204)
  const state = await f.wait('failed')
  expect(state).toMatchObject({ status: 'signed-out', attempt: { phase: 'failed', errorCode: 'protocol' } })
  expect(JSON.stringify(state)).not.toContain('sensitive diagnostic')
  expect((await f.ctx.credentials.describeRecord(credentialKey('deepseek-account-platform', 'default'))).configured).toBe(false)
})


it('removes its callback route without closing the shared server on disposal', async () => {
  const f = await fixture()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  const callback = f.callback()
  await f.dispose()
  expect((await fetch(callback)).status).toBe(404)
  await expect(f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')).rejects.toThrow()
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'default'))).toBeUndefined()
})


it('derives every portal link and the authorization URL from the private platform origin', async () => {
  const f = await fixture()
  expect((await f.account.getState()).links).toEqual({ usageUrl: `${f.origin}/usage`, topUpUrl: `${f.origin}/top_up` })
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  const authorizeUrl = new URL((await f.wait('waiting-browser')).attempt!.authorizeUrl!)
  expect(authorizeUrl.origin).toBe(f.origin)
  expect(authorizeUrl.pathname).toBe('/api/desktop-auth/authorize')
  expect(Object.fromEntries(authorizeUrl.searchParams)).toMatchObject({
    response_type: 'code', client_id: 'yun-token-desktop',
    redirect_uri: `${f.callbackOrigin}${DESKTOP_CALLBACK_PATH}`, code_challenge_method: 'S256',
  })
  expect(authorizeUrl.searchParams.get('state')).toMatch(/^[\w-]{43}$/u)
  expect(authorizeUrl.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/u)
  await f.account.cancelSignIn((await f.account.getState()).attempt!.id)
})

it('points the usage and top-up entries at the deployment console routes', async () => {
  // A gateway such as utoken serves neither official path, so both links and the private session
  // the Desktop embedded view loads come from configuration.
  const f = await fixture(undefined, {}, {}, undefined, undefined, '', null, 30_000,
    { usagePath: '/usage-logs', topUpPath: '/wallet' })
  expect((await f.account.getState()).links).toEqual({
    usageUrl: `${f.origin}/usage-logs`, topUpUrl: `${f.origin}/wallet` })
  await storeAccount(f)
  expect(await f.account.getPlatformSession()).toMatchObject({ usagePath: '/usage-logs', topUpPath: '/wallet' })
})

it('refuses a page destination that leaves the platform origin', async () => {
  await expect(fixture(undefined, {}, {}, undefined, undefined, '', null, 30_000,
    { usagePath: 'https://elsewhere.invalid/usage' })).rejects.toThrow('account: usagePath')
  await expect(fixture(undefined, {}, {}, undefined, undefined, '', null, 30_000,
    { topUpPath: '//elsewhere.invalid/wallet' })).rejects.toThrow('account: topUpPath')
})

async function storeAccount(f: Awaited<ReturnType<typeof fixture>>) {
  await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, issuer: f.origin, token: 'test-platform-grant' },
  }))
}

it('queries Platform Web endpoints with the stored grant and projects only masked profile and separate recharge and bonus balances', async () => {
  const f = await fixture()
  expect(await readDetails(f.account)).toBeNull()
  await storeAccount(f)
  expect(await readDetails(f.account)).toEqual({
    profile: { status: 'ready', value: { id: 'test-user', name: 'Test Account', avatarUrl: null, contact: '138****5678' } },
    balance: { status: 'ready', bonusWallets: [{ currency: 'CNY', balance: '10.00' }], value: [{ currency: 'CNY', balance: '123.45' }, { currency: 'USD', balance: '6.78' }] },
  })
  expect(f.detailRequests).toEqual(expect.arrayContaining([
    { path: '/auth-api/v0/users/current', authorization: 'test-platform-grant' },
    { path: '/api/v0/users/get_user_summary', authorization: 'test-platform-grant' },
  ]))
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'default'))).toMatchObject({
    payload: { token: 'test-platform-grant' },
  })
})

it('retains profile data when balance fails instead of reporting a zero balance', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.failSummary()
  expect(await readDetails(f.account)).toMatchObject({ profile: { status: 'ready' }, balance: { status: 'failed' } })
})

it('publishes sign-out only after local grant removal and refuses token resolution while removing', async () => {
  const f = await fixture()
  await storeAccount(f)
  const observed: string[] = []
  f.ctx.on('deepseek-account/signed-out', () => { observed.push('signed-out') })
  const pending = f.account.signOut(clientMetadata())
  expect(await f.account.resolveToken('https://api.deepseek.com')).toBeUndefined()
  await pending
  expect(observed).toEqual(['signed-out'])
  expect((await f.account.getState()).status).toBe('signed-out')
})

it('discards account details when sign-out races the Platform response', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.holdDetails()
  const pending = readDetails(f.account)
  await f.detailsStarted.promise
  await f.account.signOut(clientMetadata())
  expect(await pending).toBeNull()
  f.release.resolve(undefined)
  expect(await readDetails(f.account)).toBeNull()
})

it('does not send an account grant to a different configured Platform environment', async () => {
  const f = await fixture()
  await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, issuer: 'https://platform.deepseek.com', token: 'test-platform-grant' },
  }))
  await expect(readDetails(f.account)).rejects.toThrow('account: protocol')
  expect(f.detailRequests).toEqual([])
})

it('accepts Platform exponent and full-precision balances that big.js parses', async () => {
  const f = await fixture()
  await storeAccount(f)
  // The reported production value: a zero recharge wallet in exponent form beside a bonus wallet
  // carrying more fractional digits than the old provider regex allowed.
  f.normalWallets([{ currency: 'CNY', balance: '0E-16' }])
  f.bonusWallets([{ currency: 'CNY', balance: '5.0000000000000000' }])
  expect(await readDetails(f.account)).toMatchObject({
    balance: {
      status: 'ready',
      value: [{ currency: 'CNY', balance: '0E-16' }],
      bonusWallets: [{ currency: 'CNY', balance: '5.0000000000000000' }],
    },
  })
})

it.each([
  ['1e+3', '1e+3'],
  ['1E-3', '1E-3'],
  ['.5', '.5'],
  ['1.', '1.'],
  ['-0.00', '-0.00'],
])('keeps the original balance string %s readable when big.js accepts it', async (balance, preserved) => {
  const f = await fixture()
  await storeAccount(f)
  f.normalWallets([{ currency: 'CNY', balance }])
  expect(await readDetails(f.account)).toMatchObject({
    balance: { status: 'ready', value: [{ currency: 'CNY', balance: preserved }] },
  })
})

it.each(['NaN', 'Infinity', '-Infinity', '1e', 'e5', '1.2.3', '', ' 1', '+1', '0x10', '1,5'])(
  'still rejects the malformed balance %s', async (balance) => {
    const f = await fixture()
    await storeAccount(f)
    f.normalWallets([{ currency: 'CNY', balance }])
    expect(await readDetails(f.account)).toMatchObject({ profile: { status: 'ready' }, balance: { status: 'failed' } })
  },
)

it('rejects malformed wallet data independently of the profile response', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.invalidateSummary()
  expect(await readDetails(f.account)).toMatchObject({ profile: { status: 'ready' }, balance: { status: 'failed' } })
})

it.each([
  { input: { email: '', mobile: '138***78' }, expected: '138***78' },
  { input: { email: '', mobile_number: '+86 138••••5678' }, expected: '+86 138••••5678' },
  { input: { email: 'te***@example.invalid' }, expected: 'te***@example.invalid' },
])('preserves Platform contact masking without rewriting it: $expected', async ({ input, expected }) => {
  const f = await fixture(input)
  await storeAccount(f)
  expect((await readDetails(f.account))?.profile).toEqual({
    status: 'ready', value: { id: 'test-user', name: 'Test Account', avatarUrl: null, contact: expected },
  })
})

it('removes the local grant while a shared concurrent logout request is still pending', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.holdLogout()
  await Promise.all([f.account.signOut(clientMetadata()), f.account.signOut(clientMetadata())])
  await expect.poll(f.logoutCount).toBe(1)
  expect(f.logoutHeaders).toEqual(['test-platform-grant'])
  expect((await f.account.getState()).status).toBe('signed-out')
  await f.account.signOut(clientMetadata())
  expect(f.logoutCount()).toBe(1)
})

it('bounds failed logout retries without restoring the grant or deleting a new login', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.failLogout(true)
  await expect(f.account.signOut(clientMetadata())).resolves.toMatchObject({ status: 'signed-out' })
  expect(await readDetails(f.account)).toBeNull()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  f.setAccessToken('N'.repeat(43))
  await fetch(f.callback(), { redirect: 'manual' })
  await expect.poll(f.logoutCount).toBe(6)
  expect(f.logoutHeaders).toEqual(Array<string>(6).fill('test-platform-grant'))
  expect((await f.account.getState()).status).toBe('credential-stored')
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'default')))
    .toMatchObject({ kind: 'grant', payload: { token: 'N'.repeat(43) } })
})

it.each([['en', 'en', 'Signed in'], ['zh-CN', 'zh-CN', '登录成功']])(
  'carries %s into the return page and keeps the language of the attempt it joined', async (locale, lang, copy) => {
    const f = await fixture()
    await f.account.startSignIn(clientMetadata(locale), f.callbackOrigin, 'desktop')
    const first = await f.wait('waiting-browser')
    expect((await f.account.startSignIn(clientMetadata('zh'), f.callbackOrigin, 'desktop')).attempt?.id).toBe(first.attempt?.id)
    const page = await (await fetch(f.callback(), { redirect: 'manual' })).text()
    expect(page).toContain(`lang="${lang}"`)
    expect(page).toContain(copy)
    // A fresh attempt after sign-out takes the language of that call instead.
    await f.account.signOut(clientMetadata())
    await f.account.startSignIn(clientMetadata('zh'), f.callbackOrigin, 'desktop')
    await f.wait('waiting-browser')
    expect(await (await fetch(f.callback(), { redirect: 'manual' })).text()).toContain('lang="zh-CN"')
  })

it('adds private deployment cookies to every Platform request without exposing them in account state', async () => {
  const f = await fixture(undefined, { Cookie: 'test_gate=synthetic' })
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  await readDetails(f.account)
  expect(JSON.stringify(await f.account.getState())).not.toContain('test_gate')
  await f.account.signOut(clientMetadata())
  await expect.poll(f.logoutCount).toBe(1)
  const headers = f.receivedHeaders
  const paths = headers.map(item => item.path)
  // The desktop exchange comes first; the profile and wallet queries then arrive in scheduler order.
  expect(paths.slice(0, 1)).toEqual(['/api/desktop-auth/token'])
  expect(paths.slice(1, -1).sort()).toEqual(['/api/v0/users/get_user_summary', '/auth-api/v0/users/current'])
  expect(paths.at(-1)).toBe('/auth-api/v0/users/logout')
  expect(headers.every(item => item.cookie === 'test_gate=synthetic')).toBe(true)
  const grantedPaths = new Set(['/auth-api/v0/users/current', '/api/v0/users/get_user_summary', '/auth-api/v0/users/logout'])
  expect(headers.filter(item => grantedPaths.has(item.path ?? '')).every(item => item.authorization === 'A'.repeat(43))).toBe(true)
  expect(headers.filter(item => !grantedPaths.has(item.path ?? '')).every(item => item.authorization === undefined)).toBe(true)
})

it('rejects reserved, duplicate and malformed deployment headers without disclosing values', () => {
  for (const headers of [
    { Authorization: 'secret-value' }, { 'X-DSH-Auth-Token': 'secret-value' }, { HOST: 'secret-value' }, { 'Content-Length': '5' },
    { Cookie: 'secret-value', cookie: 'other' }, { 'bad name': 'secret-value' },
    { Cookie: 'secret-value\r\ninjected: x' },
  ]) {
    expect(() => platformHeaders(headers)).toThrow(/^account: requestHeaders/)
  }
  expect(platformHeaders({ Cookie: 'test_gate=synthetic' })).toEqual({ cookie: 'test_gate=synthetic' })
})

it('does not forward deployment cookies through a Platform redirect', async () => {
  const f = await fixture(undefined, { Cookie: 'test_gate=synthetic' })
  f.redirect()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  await f.wait('failed')
  expect(f.receivedHeaders.map(item => item.path)).toEqual(['/api/desktop-auth/token'])
})

it('closes the failed Web authorization tab without redirecting and keeps the shared HTTP server alive', async () => {
  const f = await fixture()
  const dispose = f.ctx.webServer.register({ kind: 'exact', path: '/health', auth: 'anonymous', handler: (_req, res) => { res.end('alive') } })
  cleanups.push(async () => { dispose() })
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
  await f.wait('waiting-browser')
  // A token response that fails the schema is a protocol failure, answered by the failure page.
  f.exchangeResponse(null)
  const response = await fetch(f.callback(), { redirect: 'manual' })
  expect(response.status).toBe(200)
  expect(response.headers.get('location')).toBeNull()
  const page = await response.text()
  expect(page).toContain('window.close()')
  const nonce = /nonce="([^"]+)"/.exec(page)![1]
  expect(response.headers.get('content-security-policy')).toContain(`script-src 'nonce-${nonce}'`)
  await expect(`${page.match(/<p>(.*?)<\/p>/)![1]}\n`)
    .toMatchFileSnapshot('./expected/web-exchange-failure.txt')
  expect(await f.wait('failed')).toMatchObject({ status: 'signed-out', attempt: { errorCode: 'protocol' } })
  expect(f.count()).toBe(1)
  expect(await (await fetch(`${f.callbackOrigin}/health`)).text()).toBe('alive')
  f.exchangeResponse({})
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
  await f.wait('waiting-browser')
  const success = await fetch(f.callback(), { redirect: 'manual' })
  expect(success.status).toBe(200)
  expect(f.count()).toBe(2)
})

it('completes login through a local TCP forward using the browser port rather than the Host port', async () => {
  const f = await fixture()
  const hostPort = f.ctx.webServer.port
  if (hostPort === undefined) throw new Error('account test: the Host listener has not bound a port')
  const sockets = new Set<Socket>()
  const forward = createTcpServer((socket) => {
    const upstream = connect(hostPort, '127.0.0.1')
    for (const connection of [socket, upstream]) {
      sockets.add(connection)
      connection.on('close', () => { sockets.delete(connection) })
      connection.on('error', () => { socket.destroy(); upstream.destroy() })
    }
    socket.pipe(upstream).pipe(socket)
  })
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => forward.close(() => { resolve() }))
  })
  await new Promise<void>(resolve => forward.listen(0, '127.0.0.1', resolve))
  const address = forward.address()
  if (address === null || typeof address === 'string') throw new Error('missing forward listener')
  const forwardedOrigin = `http://127.0.0.1:${address.port}`
  expect(forwardedOrigin).not.toBe(f.callbackOrigin)
  await f.account.startSignIn(clientMetadata(), forwardedOrigin, 'web')
  const state = await f.wait('waiting-browser')
  const authorizeUrl = new URL(state.attempt!.authorizeUrl!)
  expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(`${forwardedOrigin}${DESKTOP_CALLBACK_PATH}`)
  // The return arrives through the forwarded origin; the state, not the Host header, decides.
  const response = await fetch(`${forwardedOrigin}${DESKTOP_CALLBACK_PATH}?code=test&state=${authorizeUrl.searchParams.get('state')}`,
    { redirect: 'manual' })
  expect(response.status).toBe(200)
  expect((await f.account.getState()).status).toBe('credential-stored')
})

it('keeps cancellation authoritative without reopening WebUI after a delayed exchange', async () => {
  const f = await fixture()
  f.hold()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
  const state = await f.wait('waiting-browser')
  const response = fetch(f.callback(), { redirect: 'manual' })
  await f.exchanged.promise
  await f.account.cancelSignIn(state.attempt!.id)
  // A cancelled attempt closes its return tab without a page of its own.
  expect((await response).status).toBe(204)
  f.release.resolve(undefined)
  expect(await f.account.getState()).toMatchObject({ status: 'signed-out', attempt: { phase: 'cancelled' } })
})

it.each(['https://example.com', 'http://example.com', 'http://127.0.0.1.evil.test',
  'http://localhost', 'http://127.0.0.1', 'http://[::1]', 'http://localhost:0', 'http://localhost:65536',
  'http://user@localhost', 'http://localhost/path', 'http://localhost/?x=1', 'http://localhost/#x', 'invalid'])
('rejects unsupported callback origin %s before starting authorization', async (origin) => {
  const f = await fixture()
  await expect(f.account.startSignIn(clientMetadata(), origin, 'web')).rejects.toThrow('account: protocol')
  expect((await f.account.getState()).attempt).toBeNull()
  expect(f.count()).toBe(0)
})

it('normalizes supported loopback callback origins', () => {
  expect(loginOrigin('http://localhost:8080/')).toBe('http://localhost:8080')
  expect(loginOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  expect(loginOrigin('http://[::1]:8080/')).toBe('http://[::1]:8080')
  expect(loginOrigin('http://localhost:80')).toBe('http://localhost:80')
  expect(desktopRedirectUri('http://localhost:8080')).toBe(`http://127.0.0.1:8080${DESKTOP_CALLBACK_PATH}`)
  expect(desktopRedirectUri('http://localhost:80')).toBe(`http://127.0.0.1:80${DESKTOP_CALLBACK_PATH}`)
  expect(desktopRedirectUri('http://127.0.0.1:51234')).toBe(`http://127.0.0.1:51234${DESKTOP_CALLBACK_PATH}`)
  expect(desktopRedirectUri('http://[::1]:8080')).toBe(`http://[::1]:8080${DESKTOP_CALLBACK_PATH}`)
})

it('normalizes localhost callback origins to 127.0.0.1 in utoken authorize and token requests', async () => {
  const f = await fixture()
  const port = new URL(f.callbackOrigin).port
  const localhostOrigin = `http://localhost:${port}`
  await f.account.startSignIn(clientMetadata(), localhostOrigin, 'web')
  const state = await f.wait('waiting-browser')
  const authorizeUrl = new URL(state.attempt!.authorizeUrl!)
  const expectedRedirectUri = `http://127.0.0.1:${port}${DESKTOP_CALLBACK_PATH}`
  expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(expectedRedirectUri)
  const response = await fetch(
    `${localhostOrigin}${DESKTOP_CALLBACK_PATH}?code=test&state=${authorizeUrl.searchParams.get('state')}`,
    { redirect: 'manual' },
  )
  expect(response.status).toBe(200)
  expect((await f.account.getState()).status).toBe('credential-stored')
  const tokenParams = new URLSearchParams(f.tokenRequests().at(-1))
  expect(tokenParams.get('redirect_uri')).toBe(expectedRedirectUri)
})

// The desktop flow never calls `auth_init`, so there is no `authorize_id` to validate, no remote
// `auth_cancel`, and no initialization-time redirect URI to echo back. Those cases were removed with
// the protocol they covered; the CSRF state and the state-matched route replace them.

it('never exports an embedded Platform token to a different configured issuer', async () => {
  const f = await fixture()
  await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, token: 'fixture-secret', issuer: 'https://platform.deepseek.com' },
  }))
  await expect(f.account.getPlatformSession()).rejects.toThrow()
})

async function readDetails(account: Pick<DeepSeekAccount, 'getProfile' | 'getBalance'>) {
  const [profile, balance] = await Promise.all([account.getProfile(clientMetadata()), account.getBalance(clientMetadata())])
  return profile === null || balance === null ? null : { profile, balance }
}

it('fails a balance query after its configured deadline while profile queries remain available', async () => {
  const f = await fixture(undefined, {}, {}, undefined, undefined, '', null, 50)
  await storeAccount(f)
  f.holdBalance()
  try {
    expect(await f.account.getBalance(clientMetadata())).toEqual({ status: 'failed' })
    expect(await f.account.getProfile(clientMetadata())).toMatchObject({ status: 'ready' })
  } finally { f.release.resolve(undefined) }
})

it('returns the profile while the balance request is still pending', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.holdBalance()
  let balanceSettled = false
  const balance = f.account.getBalance(clientMetadata()).then((value) => { balanceSettled = true; return value })
  try {
    await f.detailsStarted.promise
    expect(await f.account.getProfile(clientMetadata())).toMatchObject({ status: 'ready', value: { name: 'Test Account' } })
    expect(balanceSettled).toBe(false)
  } finally { f.release.resolve(undefined) }
  expect(await balance).toMatchObject({ status: 'ready' })
})


it('serves the sign-in snapshot and desktop balance when the deployment has no DeepSeek account APIs', async () => {
  // utoken serves desktop profile from the exchange snapshot and balances from GET /api/desktop-auth/balance,
  // avoiding DeepSeek-only endpoints (/auth-api/v0/users/current, /api/v0/users/get_user_summary).
  const f = await fixture(undefined, {}, {}, undefined, undefined, '', null, 30_000, {},
    { platformAccountApis: false })
  f.setDesktopUser({ id: 7, username: 'alice', display_name: '', role: 1, group: 'default' })
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  expect(await f.account.getProfile(clientMetadata())).toEqual({
    status: 'ready', value: { id: '7', name: 'alice', contact: null, username: 'alice', role: 1, group: 'default' },
  })
  expect(await f.account.getBalance(clientMetadata())).toEqual({
    status: 'ready',
    value: [{ currency: 'CNY', balance: '30' }],
    bonusWallets: [],
    subscriptions: [{
      subscriptionId: 8,
      planId: 1,
      totalPoints: '40',
      usedPoints: '1',
      remainingPoints: '39',
      unlimited: false,
      endTime: 1_798_000_000,
    }],
  })
  expect(f.desktopBalanceRequests).toEqual([`Bearer ${'A'.repeat(43)}`])
  expect(f.detailRequests).toEqual([])
  // A gateway deployment skips DeepSeek's logout endpoint and revokes its own desktop session instead.
  await f.account.signOut(clientMetadata())
  expect(f.logoutCount()).toBe(0)
  await expect.poll(f.desktopRevokeCount).toBe(1)
  expect(f.desktopRevokeHeaders).toEqual([`Bearer ${'A'.repeat(43)}`])
  // The snapshot is bound to the origin that issued it and disappears with the grant.
  expect(await f.account.getProfile(clientMetadata())).toBeNull()
  expect(await f.account.getBalance(clientMetadata())).toBeNull()
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'profile'))).toBeUndefined()
})

it('parses CNY desktop balances, unlimited or null subscriptions, and optional plan titles', async () => {
  const f = await fixture(undefined, {}, {}, undefined, undefined, '', null, 30_000, {},
    { platformAccountApis: false })
  f.setDesktopUser({ id: 7, username: 'alice', display_name: 'Alice', role: 1, group: 'vip' })
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  f.setDesktopBalancePayload({
    success: true,
    data: {
      user_id: 7,
      wallet_balance: '1894.37',
      quota_display_type: 'CNY',
      subscriptions: [{
        subscription_id: 9, plan_id: 2, plan_title: '体验版',
        total_points: '0', used_points: '12.5', remaining_points: '0', unlimited: true, end_time: 1_798_000_000,
      }],
    },
  })
  expect(await f.account.getBalance(clientMetadata())).toEqual({
    status: 'ready',
    value: [{ currency: 'CNY', balance: '1894.37' }],
    bonusWallets: [],
    subscriptions: [{
      subscriptionId: 9, planId: 2, planTitle: '体验版',
      totalPoints: '0', usedPoints: '12.5', remainingPoints: '0', unlimited: true, endTime: 1_798_000_000,
    }],
  })
  f.setDesktopBalancePayload({
    success: true,
    data: { wallet_balance: 0, quota_display_type: 'TOKENS', subscriptions: null },
  })
  expect(await f.account.getBalance(clientMetadata())).toEqual({
    status: 'ready', value: [{ currency: 'CNY', balance: '0' }], bonusWallets: [], subscriptions: [],
  })
})

it('degrades desktop balance errors and 401 without signing out', async () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const f = await fixture(undefined, {}, {}, undefined, undefined, '', null, 30_000, {},
      { platformAccountApis: false })
    expect(await f.account.getBalance(clientMetadata())).toBeNull()
    expect(f.desktopBalanceRequests).toEqual([])
    await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
    await f.wait('waiting-browser')
    await fetch(f.callback(), { redirect: 'manual' })
    for (const setup of [
      () => { f.setDesktopBalanceStatus(401) },
      () => { f.setDesktopBalanceStatus(500) },
      () => { f.setDesktopBalanceStatus(200); f.setDesktopBalancePayload({ success: false, data: null }) },
      () => { f.setDesktopBalanceStatus(200); f.setDesktopBalancePayload(null); f.setDesktopBalanceRaw('{bad') },
    ]) {
      setup()
      expect(await f.account.getBalance(clientMetadata())).toEqual({ status: 'failed' })
      expect(await f.account.getState()).toMatchObject({ status: 'credential-stored' })
    }
  } finally {
    output.mockRestore()
  }
})

it('queries utoken desktop usage logs, clamps offset, and degrades errors without signing out', async () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const platform = await fixture()
    await storeAccount(platform)
    expect(await platform.account.getUsageLogs(clientMetadata())).toBeNull()

    const f = await fixture(undefined, {}, {}, undefined, undefined, '', null, 30_000, {},
      { platformAccountApis: false })
    expect(await f.account.getUsageLogs(clientMetadata())).toBeNull()
    await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
    await f.wait('waiting-browser')
    await fetch(f.callback(), { redirect: 'manual' })

    expect(await f.account.getUsageLogs(clientMetadata(), { page: 999, pageSize: 20 })).toEqual({
      status: 'ready',
      value: {
        page: 1,
        pageSize: 20,
        total: 1,
        items: [{
          id: 4101,
          createdAt: 1_700_000_000,
          modelName: 'example-model',
          type: 2,
          promptTokens: 11,
          completionTokens: 7,
          quota: 5,
          subscriptionQuota: 9,
          tokenName: 'example-key-name',
          requestId: 'example-request-id',
          httpStatus: 200,
          useTime: 2,
          isStream: true,
          cacheHit: false,
          taskSettle: false,
        }],
      },
    })
    expect(f.desktopUsageLogsRequests).toEqual([
      { url: '/api/desktop/usage-logs?p=500&page_size=20', authorization: `Bearer ${'A'.repeat(43)}` },
    ])

    for (const setup of [
      () => { f.setDesktopUsageLogsStatus(401) },
      () => { f.setDesktopUsageLogsStatus(400) },
      () => { f.setDesktopUsageLogsStatus(500) },
      () => { f.setDesktopUsageLogsStatus(200); f.setDesktopUsageLogsPayload({ success: false, message: 'err', data: null }) },
      () => { f.setDesktopUsageLogsStatus(200); f.setDesktopUsageLogsPayload(null); f.setDesktopUsageLogsRaw('{bad') },
    ]) {
      setup()
      expect(await f.account.getUsageLogs(clientMetadata())).toEqual({ status: 'failed' })
      expect(await f.account.getState()).toMatchObject({ status: 'credential-stored' })
    }
  } finally {
    output.mockRestore()
  }
})

it('lists, reads, and patches utoken cloud conversations, handling 409 conflicts and 401 without signing out', async () => {
  const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const platform = await fixture()
    await storeAccount(platform)
    expect(await platform.account.listConversations(clientMetadata())).toBeNull()

    const f = await fixture(undefined, {}, {}, undefined, undefined, '', null, 30_000, {},
      { platformAccountApis: false })
    expect(await f.account.listConversations(clientMetadata())).toBeNull()
    await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
    await f.wait('waiting-browser')
    await fetch(f.callback(), { redirect: 'manual' })

    expect(await f.account.listConversations(clientMetadata(), { offset: 0, limit: 30 })).toEqual({
      status: 'ready',
      value: {
        items: [{
          id: '550e8400-e29b-41d4-a716-446655440000',
          title: '测试会话',
          revision: 3,
          createTime: '2026-11-23T08:00:00Z',
          updateTime: '2026-11-23T08:05:00Z',
        }],
        hasMore: false,
      },
    })

    expect(await f.account.getConversationMessages(clientMetadata(), '550e8400-e29b-41d4-a716-446655440000', {
      limit: 50, before: 51, revision: 3,
    })).toEqual({
      status: 'ready',
      value: {
        revision: 3,
        items: [{
          id: 'msg-user-1',
          sequence: 51,
          payload: { key: 'msg-user-1', from: 'user', versions: [{ id: 'v1', content: '你好' }], status: 'complete' },
        }],
        hasMore: true,
      },
    })

    expect(await f.account.patchConversation(clientMetadata(), '550e8400-e29b-41d4-a716-446655440000', {
      revision: 3, mutationId: 'mut-1', title: '测试会话', messages: [], deletedIds: [],
    })).toEqual({
      status: 'ready',
      value: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: '测试会话',
        revision: 4,
        createTime: '2026-11-23T08:00:00Z',
        updateTime: '2026-11-23T08:06:00Z',
      },
    })

    f.setDesktopConversationPatchStatus(409)
    expect(await f.account.patchConversation(clientMetadata(), '550e8400-e29b-41d4-a716-446655440000', {
      revision: 3, mutationId: 'mut-2', title: '测试会话', messages: [], deletedIds: [],
    })).toEqual({ status: 'conflict' })

    f.setDesktopConversationsStatus(401)
    expect(await f.account.listConversations(clientMetadata())).toEqual({ status: 'failed' })
    expect(await f.account.getState()).toMatchObject({ status: 'credential-stored' })
  } finally {
    output.mockRestore()
  }
})

it('keeps a valid grant when the exchange omits the account snapshot', async () => {
  const f = await fixture()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  expect((await f.account.getState()).status).toBe('credential-stored')
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'speech')))
    .toMatchObject({ kind: 'grant', payload: { key: 'sk-test-language-key' } })
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'profile'))).toBeUndefined()
})

it.each([undefined, null, { email: 123 }])('fetches current when exchange user is unavailable: %j', async (user) => {
  const f = await fixture()
  f.exchangeResponse({ user })
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  expect(await f.account.getProfile(clientMetadata())).toMatchObject({ status: 'ready', value: { name: 'Test Account' } })
  expect(f.detailRequests).toHaveLength(1)
})


// The desktop flow has no initialization payload, so its `authorize_id` validation cases were removed
// with the protocol they covered.


it('overlays account cookies without changing authorization or logout routing', async () => {
  const f = await fixture(undefined, { Cookie: 'gate=private; route=auth', 'x-private': 'keep' }, { Cookie: 'route=account' })
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  await readDetails(f.account)
  expect(await f.account.getPlatformSession()).toMatchObject({ requestHeaders: { cookie: 'gate=private; route=account', 'x-private': 'keep' } })
  await f.account.signOut(clientMetadata())
  await expect.poll(f.logoutCount).toBe(1)
  for (const row of f.receivedHeaders) {
    const detail = ['/auth-api/v0/users/current', '/api/v0/users/get_user_summary'].includes(row.path ?? '')
    expect(row.cookie).toBe(detail ? 'gate=private; route=account' : 'gate=private; route=auth')
  }
  expect(JSON.stringify(await f.account.getState())).not.toContain('private')
})


it('sends a development grant and its language key only to the configured inference origin', async () => {
  const grant = 'T'.repeat(43)
  const f = await fixture(undefined, {}, {}, 'http://inference.example.test:8094')
  f.setAccessToken(grant)
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  await f.wait('succeeded')
  expect(await f.account.resolveToken('http://inference.example.test:8094/api')).toBe(grant)
  expect(await f.account.resolveLanguageKey('http://inference.example.test:8094/api')).toBe('sk-test-language-key')
  for (const url of ['https://api.deepseek.com', 'http://inference.example.test:8095/api',
    'https://inference.example.test:8094/api', 'http://user@inference.example.test:8094/api']) {
    expect(await f.account.resolveToken(url)).toBeUndefined()
    // A profile that names another Messages base URL must not receive the gateway key either.
    expect(await f.account.resolveLanguageKey(url)).toBeUndefined()
  }
})


it('starts signed out after discarding another Platform issuer without remote logout or unrelated credential loss', async () => {
  const accountKey = credentialKey('deepseek-account-platform', 'default')
  const deviceKey = credentialKey('deepseek-account-platform', 'device')
  const apiKey = credentialRef('TEST_PLATFORM_SWITCH_API_KEY')
  const f = await fixture(undefined, {}, {}, undefined, async (ctx) => {
    await ctx.credentials.modifyRecord(accountKey, () => Promise.resolve({
      kind: 'grant', payload: { version: 1, issuer: 'https://old-platform.example.test', token: 'old-token' },
    }))
    await ctx.credentials.modifyRecord(deviceKey, () => Promise.resolve({ kind: 'grant', payload: { id: 'stable-device' } }))
    await ctx.credentials.set(apiKey, 'retained-api-key')
  })
  expect((await f.account.getState()).status).toBe('signed-out')
  expect(await f.account.getPlatformSession()).toBeNull()
  expect(await f.account.getProfile(clientMetadata())).toBeNull()
  expect(await f.account.getBalance(clientMetadata())).toBeNull()
  expect(await f.ctx.credentials.readRecord(accountKey)).toBeUndefined()
  expect(await f.ctx.credentials.readRecord(deviceKey)).toEqual({ kind: 'grant', payload: { id: 'stable-device' } })
  expect((await f.ctx.credentials.resolve(apiKey))?.value).toBe('retained-api-key')
  expect(f.receivedHeaders).toEqual([])
})

it('preserves a matching issuer and its grant when a balance request fails', async () => {
  const accountKey = credentialKey('deepseek-account-platform', 'default')
  const f = await fixture(undefined, {}, {}, undefined, async (ctx, issuer) => {
    await ctx.credentials.modifyRecord(accountKey, () => Promise.resolve({
      kind: 'grant', payload: { version: 1, issuer, token: 'retained-token' },
    }))
  })
  f.failSummary()
  expect(await f.account.getBalance(clientMetadata())).toEqual({ status: 'failed' })
  expect((await f.account.getState()).status).toBe('credential-stored')
  expect(await f.ctx.credentials.readRecord(accountKey)).toMatchObject({ kind: 'grant', payload: { token: 'retained-token' } })
  expect(f.logoutCount()).toBe(0)
})

it('carries the configured embedded frontend selector in the private Platform session', async () => {
  const f = await fixture(undefined, {}, {}, undefined, undefined, 'feat/test')
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  await f.account.getProfile(clientMetadata())
  expect(await f.account.getPlatformSession()).toEqual({ origin: f.origin, userId: 'test-user', token: 'A'.repeat(43), embeddedPageDist: 'feat/test',
    usagePath: '/usage', topUpPath: '/top_up', requestHeaders: {} })
})

it.each([
  ['darwin', 'desktop-mac'], ['win32', 'desktop-win'], [null, 'web'],
] as const)('identifies %s Host API requests over deployment header overrides', async (desktopPlatform, expected) => {
  // Deployment configuration may name the client identity headers, but the caller's metadata always
  // wins for every Host API request. The embedded session keeps the deployment values, and its
  // consuming client composes the same five headers on top.
  const overrides = { 'x-client-bundle-id': 'deployment', 'x-client-platform': 'deployment',
    'x-client-version': 'deployment', 'x-client-locale': 'deployment', 'x-client-timezone-offset': 'deployment' }
  const f = await fixture(undefined, { Cookie: 'test_gate=synthetic', ...overrides }, overrides,
    undefined, undefined, '', desktopPlatform)
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  await readDetails(f.account)
  expect(await f.account.getPlatformSession()).toEqual({ origin: f.origin, userId: 'test-user', token: 'A'.repeat(43),
    usagePath: '/usage', topUpPath: '/top_up', requestHeaders: { cookie: 'test_gate=synthetic', ...overrides } })
  await f.account.signOut(clientMetadata())
  await expect.poll(f.logoutCount).toBe(1)
  const paths = f.receivedHeaders.map(item => item.path)
  expect(paths.slice(0, 1)).toEqual(['/api/desktop-auth/token'])
  // Profile and balance requests run concurrently.
  expect(paths.slice(1, -1).sort()).toEqual(['/api/v0/users/get_user_summary', '/auth-api/v0/users/current'])
  expect(paths.slice(-1)).toEqual(['/auth-api/v0/users/logout'])
  expect(f.receivedHeaders.map(item => item.clientPlatform)).toEqual(f.receivedHeaders.map(() => expected))
  for (const header of f.receivedHeaders) {
    expect(header).toMatchObject({ bundleId: '', version: '1.2.3', locale: 'en_US', timezoneOffset: '28800' })
  }
})

const ZH_CLIENT = { version: '1.0.0', locale: 'zh-CN', timezoneOffsetSeconds: 28_800 }
const EN_CLIENT = { version: '9.9.9', locale: 'en-US', timezoneOffsetSeconds: -18_000 }

it('keeps one login attempt on the identity captured by its own initiating call', async () => {
  const f = await fixture()
  await f.account.startSignIn(ZH_CLIENT, f.callbackOrigin, 'desktop')
  const waiting = await f.wait('waiting-browser')
  // A joining call supplies other metadata; the attempt keeps the identity it captured.
  expect((await f.account.startSignIn(EN_CLIENT, f.callbackOrigin, 'desktop')).attempt?.id).toBe(waiting.attempt?.id)
  await fetch(f.callback(), { redirect: 'manual' })
  expect(f.receivedHeaders.map(header => [
    header.path, header.bundleId, header.clientPlatform, header.version, header.locale, header.timezoneOffset,
  ])).toEqual([['/api/desktop-auth/token', '', 'web', '1.0.0', 'zh_CN', '28800']])
  // The next attempt starts from the metadata of the call that opens it.
  await f.account.signOut(clientMetadata())
  await f.account.startSignIn(EN_CLIENT, f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  expect(f.receivedHeaders.at(-1)).toMatchObject({ version: '9.9.9', locale: 'en_US', timezoneOffset: '-18000' })
})

it('derives the client headers independently for profile, balance, and logout calls', async () => {
  const f = await fixture()
  await storeAccount(f)
  await f.account.getProfile(EN_CLIENT)
  await f.account.getBalance(ZH_CLIENT)
  await f.account.signOut({ version: '2.0.0', locale: 'fr', timezoneOffsetSeconds: 3_600 })
  await expect.poll(f.logoutCount).toBe(1)
  expect(f.receivedHeaders.map(header => [
    header.path, header.bundleId, header.clientPlatform, header.version, header.locale, header.timezoneOffset,
  ])).toEqual([
    ['/auth-api/v0/users/current', '', 'web', '9.9.9', 'en_US', '-18000'],
    ['/api/v0/users/get_user_summary', '', 'web', '1.0.0', 'zh_CN', '28800'],
    ['/auth-api/v0/users/logout', '', 'web', '2.0.0', 'en_US', '3600'],
  ])
})

it('rejects unsupported native desktop platforms in configuration', () => {
  // @ts-expect-error Configuration files can name unsupported operating systems.
  expect(() => DeepSeekAccount.Config({ desktopPlatform: 'linux' })).toThrow()
})

it('retains successful profile data on current failure only for the same credential', async () => {
  const f = await fixture()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  const initial = await f.account.getProfile(clientMetadata())
  expect(initial).toMatchObject({ status: 'ready', value: { name: 'Test Account' } })
  f.failProfile(true)
  expect(await f.account.getProfile(clientMetadata())).toEqual(initial)
  f.failProfile(false)
  const refreshed = await f.account.getProfile(clientMetadata())
  expect(refreshed).toMatchObject({ status: 'ready', value: { name: 'Test Account' } })
  f.failProfile(true)
  expect(await f.account.getProfile(clientMetadata())).toEqual(refreshed)
  const key = credentialKey('deepseek-account-platform', 'default')
  await f.ctx.credentials.modifyRecord(key, () => Promise.resolve({
    kind: 'grant', payload: { version: 1, issuer: f.origin, token: 'replacement-token' },
  }))
  expect(await f.account.getProfile(clientMetadata())).toEqual({ status: 'failed' })
  await f.account.signOut(clientMetadata())
  expect(await f.account.getProfile(clientMetadata())).toBeNull()
})

it.each([[], [{ currency: 'CNY', balance: '0.00' }]].map(wallets => ({ wallets })))('preserves empty or zero bonus wallets', async ({ wallets }) => {
  const f = await fixture()
  await storeAccount(f)
  f.bonusWallets(wallets)
  expect(await f.account.getBalance(clientMetadata())).toMatchObject({ status: 'ready', bonusWallets: wallets })
})

it.each([undefined, [{ currency: 'EUR', balance: '1' }], [{ currency: 'CNY', balance: 'invalid' }]].map(wallets => ({ wallets })))(
  'rejects malformed bonus wallets without reporting zero credit', async ({ wallets }) => {
    const f = await fixture()
    await storeAccount(f)
    f.bonusWallets(wallets)
    expect(await f.account.getBalance(clientMetadata())).toEqual({ status: 'failed' })
  },
)

it.each(['profile', 'balance'] as const)('clears the rejected account grant after a %s HTTP 401', async (field) => {
  const f = await fixture()
  await storeAccount(f)
  let signedOut = 0
  f.ctx.on('deepseek-account/signed-out', () => { signedOut++ })
  const expired = vi.fn()
  f.ctx.on('deepseek-account/session-expired', expired)
  f.detailStatus(401)
  expect(await (field === 'profile' ? f.account.getProfile(clientMetadata()) : f.account.getBalance(clientMetadata()))).toBeNull()
  expect(await f.account.getState()).toMatchObject({ status: 'signed-out', attempt: null })
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'default'))).toBeUndefined()
  expect(signedOut).toBe(1)
  expect(expired).toHaveBeenCalledOnce()
})

it.each(['profile', 'balance'] as const)('clears the rejected account grant after a %s HTTP 200 with code 40003', async (field) => {
  const f = await fixture()
  await storeAccount(f)
  let signedOut = 0
  f.ctx.on('deepseek-account/signed-out', () => { signedOut++ })
  const expired = vi.fn()
  f.ctx.on('deepseek-account/session-expired', expired)
  f.detailCode(40003)
  expect(await (field === 'profile' ? f.account.getProfile(clientMetadata()) : f.account.getBalance(clientMetadata()))).toBeNull()
  expect(await f.account.getState()).toMatchObject({ status: 'signed-out', attempt: null })
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'default'))).toBeUndefined()
  expect(signedOut).toBe(1)
  expect(expired).toHaveBeenCalledOnce()
})

it('coalesces simultaneous unauthorized profile and balance responses', async () => {
  const f = await fixture()
  await storeAccount(f)
  let signedOut = 0
  f.ctx.on('deepseek-account/signed-out', () => { signedOut++ })
  const expired = vi.fn()
  f.ctx.on('deepseek-account/session-expired', expired)
  f.detailStatus(401)
  await Promise.all([f.account.getProfile(clientMetadata()), f.account.getBalance(clientMetadata())])
  expect(signedOut).toBe(1)
  expect(expired).toHaveBeenCalledOnce()
  expect(await f.account.getState()).toMatchObject({ status: 'signed-out' })
})

it.each([403, 500])('retains the account grant after HTTP %s', async (status) => {
  const f = await fixture()
  await storeAccount(f)
  f.detailStatus(status)
  expect(await f.account.getBalance(clientMetadata())).toEqual({ status: 'failed' })
  expect(await f.account.getState()).toMatchObject({ status: 'credential-stored' })
})

it('does not remove a replacement grant when an older request is rejected', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.detailStatus(401)
  f.holdDetails()
  const pending = f.account.getBalance(clientMetadata())
  try {
    await f.detailsStarted.promise
    await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
      kind: 'grant', payload: { version: 1, issuer: f.origin, token: 'replacement-grant' },
    }))
  } finally {
    f.release.resolve(undefined)
  }
  expect(await pending).toBeNull()
  expect(await f.account.getState()).toMatchObject({ status: 'credential-stored' })
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'default')))
    .toMatchObject({ kind: 'grant', payload: { token: 'replacement-grant' } })
})

it.each(['0E-16', '1.25e+2', '-3E-4'])('preserves scientific-notation wallet balance %s', async (balance) => {
  const f = await fixture()
  await storeAccount(f)
  f.setBalance(balance)
  expect(await f.account.getBalance(clientMetadata())).toMatchObject({ status: 'ready', value: [{ currency: 'CNY', balance }, { currency: 'USD', balance: '6.78' }] })
})

it.each([{ kind: 'api-key' as const, key: 'wrong-kind' }, { kind: 'grant' as const, payload: { version: 0 } }])(
  'rejects invalid stored account records across account consumers: $kind', async (record) => {
    const f = await fixture()
    const key = credentialKey('deepseek-account-platform', 'default')
    await f.ctx.credentials.modifyRecord(key, () => Promise.resolve(record))
    await expect(f.account.getState()).rejects.toThrow('account: storage')
    await expect(f.account.getProfile(clientMetadata())).rejects.toThrow('account: storage')
    await expect(f.account.getPlatformSession()).rejects.toThrow('account: storage')
    await expect(f.account.resolveToken('https://api.deepseek.com')).rejects.toThrow('account: storage')
    await expect(f.account.signOut(clientMetadata())).rejects.toThrow('account: storage')
  },
)

it('returns no credentials when signed out or disposed', async () => {
  const f = await fixture()
  expect(await f.account.resolveToken('https://api.deepseek.com')).toBeUndefined()
  expect(await f.account.getPlatformSession()).toBeNull()
  await f.account.cancelSignIn('missing' as import('@deepseek-ai/dsh-deepseek-account').SignInAttemptId)
  await f.dispose()
  expect(await f.account.getProfile(clientMetadata())).toBeNull()
  expect(await f.account.getPlatformSession()).toBeNull()
  await expect(f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')).rejects.toThrow('account: protocol')
  await expect(f.account.signOut(clientMetadata())).rejects.toThrow('account: protocol')
})

it('rejects sign-out and inference grants issued by another environment', async () => {
  const f = await fixture(undefined, {}, {}, 'https://private.example')
  await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, token: 'real-token', issuer: 'https://other.example' },
  }))
  expect(await f.account.resolveToken('https://private.example')).toBeUndefined()
  await expect(f.account.signOut(clientMetadata())).rejects.toThrow('account: protocol')
})

it('never sends a development issuer grant to official inference', async () => {
  const f = await fixture()
  await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, token: 'real-token', issuer: f.origin },
  }))
  expect(await f.account.resolveToken('https://api.deepseek.com')).toBeUndefined()
})

it('merges account cookies when there are no base cookies', async () => {
  const f = await fixture(undefined, {}, { cookie: 'account=value' })
  await storeAccount(f)
  expect(await f.account.getPlatformSession()).toMatchObject({ requestHeaders: { cookie: 'account=value' } })
})

it.each([{ kind: 'api-key' as const, key: 'wrong-kind' }, { kind: 'grant' as const, payload: null }])(
  'rejects invalid durable grants during service initialization: $kind', async (record) => {
    const f = await fixture()
    await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve(record))
    await expect(f.account[Service.init]()).rejects.toThrow('account: storage')
  },
)

it.each(['ftp://api.example', 'https://user:password@api.example', 'https://api.example/path',
  'https://api.example/?query=1', 'https://api.example/#fragment'])('rejects invalid inference origin %s', async (inferenceOrigin) => {
  expect(() => new DeepSeekAccount(new Context(), { inferenceOrigin })).toThrow('account: inferenceOrigin')
})

it('rejects authorization begun without a local account attempt', async () => {
  const f = await fixture()
  await expect(f.ctx.authorization.begin({ key: credentialKey('deepseek-account-platform', 'default'),
    interaction: { notify: () => undefined, prompt: () => Promise.resolve('') },
  })).rejects.toThrow('account: protocol')
})

it('fails sign-in when its shared callback server is absent', async () => {
  const f = await fixture()
  const get = vi.spyOn(f.ctx, 'get').mockImplementation(() => undefined)
  try {
    await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
    expect((await f.wait('failed')).attempt?.errorCode).toBe('protocol')
  } finally { get.mockRestore() }
})

it('reports a credential commit failure without redirecting to success', async () => {
  const f = await fixture()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  const original = f.ctx.credentials.modifyRecord.bind(f.ctx.credentials)
  const modify = vi.spyOn(f.ctx.credentials, 'modifyRecord').mockImplementation((key, mutate) =>
    key === credentialKey('deepseek-account-platform', 'default') ? Promise.reject(new Error('store unavailable')) : original(key, mutate))
  try {
    const callback = await fetch(f.callback(), { redirect: 'manual' })
    expect(callback.status).toBe(204)
    expect((await f.wait('failed')).attempt?.errorCode).toBe('storage')
  } finally { modify.mockRestore() }
})

it('rejects callbacks without a state and reloads of an in-flight exchange', async () => {
  const f = await fixture()
  f.hold()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
  await f.wait('waiting-browser')
  // A return without the CSRF state never reaches the exchange.
  expect((await fetch(`${f.callbackOrigin}${DESKTOP_CALLBACK_PATH}?code=test`)).status).toBe(400)
  expect(f.count()).toBe(0)
  const callback = fetch(f.callback(), { redirect: 'manual' })
  await f.exchanged.promise
  // A reload while the exchange is in flight is answered as consumed instead of exchanging twice.
  expect((await fetch(f.callback())).status).toBe(400)
  f.release.resolve(undefined)
  expect((await callback).status).toBe(200)
  expect(f.count()).toBe(1)
})

it('expires the attempt while waiting for the browser', async () => {
  const f = await fixture()
  const timeout = vi.spyOn(globalThis, 'setTimeout')
  try {
    await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
    await f.wait('waiting-browser')
    const timer = timeout.mock.calls.filter(([, delay]) => typeof delay === 'number' && delay > 590_000).at(-1)?.[0]
    if (typeof timer !== 'function') throw new Error('missing browser deadline')
    timer()
    expect((await f.wait('expired')).status).toBe('signed-out')
  } finally { timeout.mockRestore() }
})

it('holds cancellation and disposal until an admitted account write completes', async () => {
  const f = await fixture()
  const admitted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const original = f.ctx.credentials.modifyRecord.bind(f.ctx.credentials)
  const modify = vi.spyOn(f.ctx.credentials, 'modifyRecord').mockImplementation(async (key, mutate) => {
    if (key === credentialKey('deepseek-account-platform', 'default')) {
      admitted.resolve(undefined)
      await release.promise
    }
    return original(key, mutate)
  })
  let callback: Promise<Response> | undefined
  try {
    await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
    const state = await f.wait('waiting-browser')
    callback = fetch(f.callback(), { redirect: 'manual' })
    await admitted.promise
    const cancelled = f.account.cancelSignIn(state.attempt!.id)
    const disposed = f.dispose()
    release.resolve(undefined)
    expect((await callback).status).toBe(200)
    expect((await cancelled).status).toBe('credential-stored')
    await disposed
  } finally {
    release.resolve(undefined)
    await callback
    modify.mockRestore()
  }
})

it('waits for local sign-out before beginning a new authorization', async () => {
  const f = await fixture()
  await storeAccount(f)
  const admitted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const original = f.ctx.credentials.deleteRecord.bind(f.ctx.credentials)
  const remove = vi.spyOn(f.ctx.credentials, 'deleteRecord').mockImplementation(async (key) => {
    admitted.resolve(undefined)
    await release.promise
    return original(key)
  })
  try {
    const out = f.account.signOut(clientMetadata())
    await admitted.promise
    const login = f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
    release.resolve(undefined)
    expect((await out).status).toBe('signed-out')
    expect((await login).attempt).toBeDefined()
    await f.wait('waiting-browser')
  } finally { release.resolve(undefined); remove.mockRestore() }
})

it('does not begin a remote logout after disposal starts during local removal', async () => {
  const f = await fixture()
  await storeAccount(f)
  const admitted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const original = f.ctx.credentials.deleteRecord.bind(f.ctx.credentials)
  const remove = vi.spyOn(f.ctx.credentials, 'deleteRecord').mockImplementation(async (key) => {
    admitted.resolve(undefined)
    await release.promise
    return original(key)
  })
  try {
    const out = f.account.signOut(clientMetadata())
    await admitted.promise
    const disposed = f.dispose()
    release.resolve(undefined)
    expect((await out).status).toBe('signed-out')
    await disposed
    expect(f.logoutCount()).toBe(0)
  } finally { release.resolve(undefined); remove.mockRestore() }
})

it.each([false, true])('settles a previous attempt before concurrent restart or disposal: %s', async (dispose) => {
  const f = await fixture()
  f.hold()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
  await f.wait('waiting-browser')
  const callback = fetch(f.callback(), { redirect: 'manual' })
  await f.exchanged.promise
  const cancel = f.account.cancelSignIn((await f.account.getState()).attempt!.id)
  await f.wait('cancelled')
  const first = f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
  if (dispose) {
    const rejected = expect(first).rejects.toThrow('account: protocol')
    const disposed = f.dispose()
    f.release.resolve(undefined)
    await rejected
    await disposed
  } else {
    const second = f.account.startSignIn(clientMetadata('zh'), f.callbackOrigin, 'web')
    f.release.resolve(undefined)
    expect((await first).attempt?.id).toBe((await second).attempt?.id)
    await f.wait('waiting-browser')
  }
  await cancel
  expect((await callback).status).toBe(204)
})

it('rejects unsupported interaction and projects unexpected authorization failures safely', async () => {
  const f = await fixture()
  const begin = vi.spyOn(f.ctx.authorization, 'begin').mockImplementation(async (request) => {
    request.interaction.notify({ message: 'ignored' })
    await expect(request.interaction.prompt({ kind: 'text', message: 'unsupported' })).rejects.toThrow('account: protocol')
    throw new Error('private implementation failure')
  })
  try {
    await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
    expect((await f.wait('failed')).attempt?.errorCode).toBe('protocol')
  } finally { begin.mockRestore() }
})

it('claims only its own callback path and delegates everything else', async () => {
  const f = await fixture()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
  await f.wait('waiting-browser')
  // `delegated` inputs must reach the next handler; `answered` inputs are claimed by the account
  // route, which refuses them because their state cannot belong to the attempt.
  for (const [input, expected] of [
    [{ url: 'http://untrusted.invalid/oauth/callback?code=test' }, 'delegated'],
    [{ url: 'http://untrusted.invalid/desktop-auth/callback?code=test&state=wrong' }, 'answered'],
    [{ url: '/other/path?code=test' }, 'delegated'],
    [{ url: `${DESKTOP_CALLBACK_PATH}?code=test` }, 'answered'],
    [{ url: undefined }, 'delegated'],
    [{ url: 'http://[' }, 'delegated'],
  ] as const) {
    const socket = new Socket()
    const req = new IncomingMessage(socket)
    req.method = 'GET'
    req.url = input.url
    req.headers.host = new URL(f.callbackOrigin).host
    const res = new ServerResponse(req)
    const next = vi.fn(async () => {})
    try {
      await f.ctx.waterfall(f.ctx.webServer, 'webserver/request', req, res, next)
      if (expected === 'delegated') {
        expect(next).toHaveBeenCalledOnce()
        expect(res.writableEnded).toBe(false)
      } else {
        expect(next).not.toHaveBeenCalled()
        expect(res.statusCode).toBe(400)
        expect(res.writableEnded).toBe(true)
      }
      expect(f.count()).toBe(0)
    } finally { res.destroy(); socket.destroy() }
  }
})

it('settles an attempt after its browser callback connection closes during exchange', async () => {
  const f = await fixture()
  f.hold()
  await f.account.startSignIn(clientMetadata(), f.callbackOrigin, 'web')
  await f.wait('waiting-browser')
  // The person closes the tab while the token exchange is still in flight.
  const abandoned = new AbortController()
  const callback = fetch(f.callback(), { signal: abandoned.signal }).catch(() => undefined)
  await f.exchanged.promise
  abandoned.abort()
  await callback
  f.release.resolve(undefined)
  // The grant still lands: the exchange, not the dead connection, owns the attempt.
  await f.wait('succeeded')
  expect((await f.account.signOut(clientMetadata())).status).toBe('signed-out')
})

it('invalidates account reads before the shared grant lookup returns to its caller', async () => {
  const f = await fixture()
  await storeAccount(f)
  const key = credentialKey('deepseek-account-platform', 'default')
  const original = f.ctx.credentials.readRecord.bind(f.ctx.credentials)
  const read = vi.spyOn(f.ctx.credentials, 'readRecord').mockImplementation(async (requested) => {
    const record = await original(requested)
    // The first checkpoint lets grant validation finish; the second invalidates its consumer.
    queueMicrotask(() => { queueMicrotask(() => { f.ctx.emit('credentials/record-updated', key) }) })
    return record
  })
  try {
    expect(await f.account.getPlatformSession()).toBeNull()
    expect(await f.account.getProfile(clientMetadata())).toBeNull()
    expect(f.detailRequests).toEqual([])
  } finally { read.mockRestore() }
})

it('publishes a credential snapshot without querying the profile', async () => {
  const f = await fixture()
  await storeAccount(f)
  expect(await f.account.getPlatformSession()).toMatchObject({ userId: null, token: 'test-platform-grant' })
  expect(f.detailRequests).toEqual([])
})

it.each([null, '', 'stable-user'])('exports the stable profile ID for native storage after a profile read: %s', async (id) => {
  const f = await fixture({ email: 'test@example.invalid', id })
  await storeAccount(f)
  await f.account.getProfile(clientMetadata())
  expect(await f.account.getPlatformSession()).toMatchObject({ userId: id || null, token: 'test-platform-grant' })
})

it('publishes a snapshot while the profile read is still pending', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.holdDetails()
  const profile = f.account.getProfile(clientMetadata())
  await f.detailsStarted.promise
  try {
    expect(await f.account.getPlatformSession()).toMatchObject({ userId: null, token: 'test-platform-grant' })
  } finally { f.release.resolve(undefined) }
  await expect(profile).resolves.toMatchObject({ status: 'ready' })
  expect(await f.account.getPlatformSession()).toMatchObject({ userId: 'test-user' })
})

it.each([false, true])('notifies only identity-enabled watchers on profile identity changes (enabled: %s)', async (includeIdentityChanges) => {
  const f = await fixture()
  f.failProfile(true)
  await storeAccount(f)
  expect(await f.account.getProfile(clientMetadata())).toEqual({ status: 'failed' })
  const lifetime = new AbortController()
  const states: Awaited<ReturnType<DeepSeekAccount['getState']>>[] = []
  const watching = (async () => {
    for await (const { state } of f.account.watch(lifetime.signal, includeIdentityChanges)) states.push(state)
  })()
  try {
    await expect.poll(() => states.length).toBe(1)
    f.failProfile(false)
    await expect(f.account.getProfile(clientMetadata())).resolves.toMatchObject({ status: 'ready', value: { id: 'test-user' } })
    if (includeIdentityChanges) await expect.poll(() => states.length).toBe(2)
    expect(await f.account.getPlatformSession()).toMatchObject({ userId: 'test-user' })
    // A later refresh with the same stable ID must not wake publishers again.
    await f.account.getProfile(clientMetadata())
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(states).toHaveLength(includeIdentityChanges ? 2 : 1)
    await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
      kind: 'grant', payload: { version: 1, issuer: f.origin, token: 'replacement-token' },
    }))
    await expect.poll(() => states.length).toBe(includeIdentityChanges ? 3 : 2)
  } finally {
    lifetime.abort()
    await watching
  }
})

it('never publishes a profile identity read from a replaced credential', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.holdDetails()
  const pending = f.account.getProfile(clientMetadata())
  await f.detailsStarted.promise
  await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, issuer: f.origin, token: 'replacement-token' },
  }))
  f.release.resolve(undefined)
  expect(await pending).toBeNull()
  expect(await f.account.getPlatformSession()).toMatchObject({ userId: null, token: 'replacement-token' })
})

it('discards a pending profile read when sign-out removes the credential', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.holdDetails()
  const pending = f.account.getProfile(clientMetadata())
  await f.detailsStarted.promise
  await f.account.signOut(clientMetadata())
  expect(await f.account.getPlatformSession()).toBeNull()
  f.release.resolve(undefined)
  expect(await pending).toBeNull()
})

it('withholds a cached profile identity from a grant it was not read with', async () => {
  const f = await fixture()
  await storeAccount(f)
  await f.account.getProfile(clientMetadata())
  const key = credentialKey('deepseek-account-platform', 'default')
  const original = f.ctx.credentials.readRecord.bind(f.ctx.credentials)
  // Another process may replace the credential document between this provider's reads, so the
  // account ID is only published beside the grant it was read with.
  const read = vi.spyOn(f.ctx.credentials, 'readRecord').mockImplementation(async requested =>
    requested === key
      ? { kind: 'grant', payload: { version: 1, issuer: f.origin, token: 'rotated-token' } }
      : original(requested))
  try {
    expect(await f.account.getPlatformSession()).toMatchObject({ token: 'rotated-token', userId: null })
  } finally { read.mockRestore() }
})

it('reuses the last profile identity without querying again', async () => {
  const f = await fixture()
  await storeAccount(f)
  await f.account.getProfile(clientMetadata())
  f.failProfile(true)
  expect(await f.account.getPlatformSession()).toMatchObject({ userId: 'test-user' })
  expect(f.detailRequests).toHaveLength(1)
})

it('cancels a pending sign-in when the current stored grant expires', async () => {
  const f = await fixture()
  await storeAccount(f)
  await f.account.startSignIn(clientMetadata('en'), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  f.detailStatus(401)
  expect(await f.account.getBalance(clientMetadata())).toBeNull()
  expect(await f.account.getState()).toMatchObject({ status: 'signed-out', attempt: null })
})

it('retains the grant when local expiry removal fails and permits a later retry', async () => {
  const f = await fixture()
  await storeAccount(f)
  f.detailStatus(401)
  const remove = vi.spyOn(f.ctx.credentials, 'deleteRecord').mockRejectedValueOnce(new Error('storage failed'))
  try {
    await expect(f.account.getBalance(clientMetadata())).rejects.toThrow('storage failed')
    expect(await f.account.getState()).toMatchObject({ status: 'credential-stored' })
    expect(await f.account.getState()).not.toHaveProperty('signOutReason')
    expect(await f.account.getBalance(clientMetadata())).toBeNull()
    expect(await f.account.getState()).toMatchObject({ status: 'signed-out' })
  } finally { remove.mockRestore() }
})

it.each([
  ['balance', 'invalidated'], ['balance', 'missing'], ['balance', 'other-kind'],
  ['balance', 'token'], ['balance', 'issuer'], ['profile', 'missing'],
] as const)(
  'rechecks the stored grant before %s expiry removal: %s', async (field, change) => {
    const f = await fixture()
    await storeAccount(f)
    f.detailStatus(401)
    const key = credentialKey('deepseek-account-platform', 'default')
    const original = f.ctx.credentials.readRecord.bind(f.ctx.credentials)
    let reads = 0
    const read = vi.spyOn(f.ctx.credentials, 'readRecord').mockImplementation(async (requested) => {
      const record = await original(requested)
      if (++reads !== 2) return record
      if (change === 'invalidated') f.ctx.emit('credentials/record-updated', key)
      if (change === 'missing') return undefined
      if (change === 'other-kind') return { kind: 'api-key', key: 'another-kind' }
      if (change === 'token' || change === 'issuer') return {
        kind: 'grant', payload: { version: 1, issuer: change === 'issuer' ? 'https://another.example' : f.origin, token: change === 'issuer' ? 'test-platform-grant' : 'replacement-token' },
      }
      return record
    })
    const remove = vi.spyOn(f.ctx.credentials, 'deleteRecord')
    try {
      expect(await (field === 'profile' ? f.account.getProfile(clientMetadata()) : f.account.getBalance(clientMetadata()))).toBeNull()
      expect(remove).not.toHaveBeenCalled()
      expect(await f.account.getState()).toMatchObject({ status: 'credential-stored' })
    } finally { read.mockRestore(); remove.mockRestore() }
  },
)

it('ignores a 401 whose response cleanup overlaps a credential replacement', async () => {
  const f = await fixture()
  await storeAccount(f)
  const response = new Response('', { status: 401 })
  const cancel = response.body!.cancel.bind(response.body)
  const cleanup = vi.spyOn(response.body!, 'cancel').mockImplementation(async () => {
    await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'default'), () => Promise.resolve({
      kind: 'grant', payload: { version: 1, issuer: f.origin, token: 'new-login' },
    }))
    await cancel()
  })
  const fetchResponse = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response)
  try {
    expect(await f.account.getBalance(clientMetadata())).toBeNull()
    expect(await f.account.getState()).toMatchObject({ status: 'credential-stored' })
    expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'default')))
      .toMatchObject({ kind: 'grant', payload: { token: 'new-login' } })
  } finally { cleanup.mockRestore(); fetchResponse.mockRestore() }
})

it('expires an inference-rejected token without another Platform request', async () => {
  const f = await fixture()
  await storeAccount(f)
  const published: string[] = []
  f.ctx.on('deepseek-account/signed-out', () => { published.push('signed-out') })
  f.ctx.on('deepseek-account/session-expired', () => { published.push('session-expired') })
  await f.account.rejectToken('test-platform-grant')
  await f.account.rejectToken('test-platform-grant')
  const state = await f.account.getState()
  expect({ status: state.status, published, detailRequests: f.detailRequests })
    .toMatchInlineSnapshot(`
      {
        "detailRequests": [],
        "published": [
          "session-expired",
          "signed-out",
        ],
        "status": "signed-out",
      }
    `)
})

it('retains a replacement login when inference rejects the previous token', async () => {
  const f = await fixture()
  await storeAccount(f)
  await f.account.rejectToken('previous-platform-grant')
  expect(await f.account.getState()).toMatchObject({ status: 'credential-stored' })
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'default')))
    .toMatchObject({ kind: 'grant', payload: { token: 'test-platform-grant' } })
})

it('ignores an inference rejection while already signed out', async () => {
  const f = await fixture()
  await f.account.rejectToken('previous-platform-grant')
  expect(await f.account.getState()).toMatchObject({ status: 'signed-out' })
  expect(await f.account.getState()).not.toHaveProperty('signOutReason')
})

it('expires the account session when inference rejects the stored language key', async () => {
  const f = await fixture()
  await storeAccount(f)
  await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'speech'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, key: 'sk-test-language-key', issuer: f.origin },
  }))
  await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'profile'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, issuer: f.origin, user: { id: 1, username: 'alice', display_name: 'Alice', role: 1, group: 'default' } },
  }))
  const published: string[] = []
  f.ctx.on('deepseek-account/signed-out', () => { published.push('signed-out') })
  f.ctx.on('deepseek-account/session-expired', () => { published.push('session-expired') })
  expect(await f.account.resolveLanguageKey()).toBe('sk-test-language-key')
  await f.account.rejectToken('sk-test-language-key')
  expect(await f.account.resolveLanguageKey()).toBeUndefined()
  expect(await f.account.getState()).toMatchObject({ status: 'signed-out' })
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'default'))).toBeUndefined()
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'speech'))).toBeUndefined()
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'profile'))).toBeUndefined()
  expect(published).toEqual(['session-expired', 'signed-out'])
})

it('retains a replacement login when inference rejects a previous language key', async () => {
  const f = await fixture()
  await storeAccount(f)
  await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'speech'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, key: 'sk-current-language-key', issuer: f.origin },
  }))
  await f.account.rejectToken('sk-previous-language-key')
  expect(await f.account.getState()).toMatchObject({ status: 'credential-stored' })
  expect(await f.account.resolveLanguageKey()).toBe('sk-current-language-key')
})

it('fails desktop token exchange at requestTimeoutMs instead of waiting for attemptTimeoutMs', async () => {
  const f = await fixture(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
    requestTimeoutMs: 60, attemptTimeoutMs: 60_000,
  })
  f.hold()
  try {
    await f.account.startSignIn(clientMetadata('en'), f.callbackOrigin, 'desktop')
    await f.wait('waiting-browser')
    const callback = fetch(f.callback(), { redirect: 'manual' })
    const failed = await f.wait('failed')
    expect(failed.attempt).toMatchObject({ phase: 'failed', errorCode: 'no-response' })
    await callback
  } finally {
    f.release.resolve(undefined)
  }
})

it('removes the language key together with an expired grant', async () => {
  const f = await fixture()
  await storeAccount(f)
  await f.ctx.credentials.modifyRecord(credentialKey('deepseek-account-platform', 'speech'), () => Promise.resolve({
    kind: 'grant', payload: { version: 1, key: 'sk-test-language-key', issuer: f.origin },
  }))
  await f.account.rejectToken('test-platform-grant')
  expect(await f.account.getState()).toMatchObject({ status: 'signed-out' })
  expect(await f.ctx.credentials.readRecord(credentialKey('deepseek-account-platform', 'speech'))).toBeUndefined()
})


it('clears a completed login from snapshots while credential deletion is still settling', async () => {
  const f = await fixture()
  await f.account.startSignIn(clientMetadata('en'), f.callbackOrigin, 'desktop')
  await f.wait('waiting-browser')
  await fetch(f.callback(), { redirect: 'manual' })
  await f.wait('succeeded')
  const original = f.ctx.credentials.deleteRecord.bind(f.ctx.credentials)
  const removed = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const deletion = vi.spyOn(f.ctx.credentials, 'deleteRecord').mockImplementation(async (key) => {
    await original(key)
    removed.resolve(undefined)
    await release.promise
  })
  const signingOut = f.account.signOut(clientMetadata())
  try {
    await removed.promise
    expect(await f.account.getState()).toMatchObject({ status: 'signed-out', attempt: null })
  } finally {
    release.resolve(undefined)
    await signingOut
    deletion.mockRestore()
  }
})


it('reads credential-free device identity without minting a device', async () => {
  const f = await fixture()
  expect(await f.account.getDeviceIdentity()).toEqual({ osVersion: expect.any(String) as string })
  const key = credentialKey('deepseek-account-platform', 'device')
  expect(await f.ctx.credentials.readRecord(key)).toBeUndefined()
  await f.ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { id: 'invalid' } }))
  expect(await f.account.getDeviceIdentity()).not.toHaveProperty('deviceId')
  await f.ctx.credentials.modifyRecord(key, async () => ({ kind: 'api-key', key: 'private' }))
  expect(await f.account.getDeviceIdentity()).not.toHaveProperty('deviceId')
  const deviceId = '01990000-0000-4000-8000-000000000001'
  await f.ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { id: deviceId } }))
  await storeAccount(f)
  await f.account.getProfile(clientMetadata())
  expect(await f.account.getDeviceIdentity()).toEqual({ deviceId, userId: 'test-user', osVersion: expect.any(String) as string })
})
