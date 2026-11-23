/** Validated platform HTTP messages and restricted browser destinations. */
import { z } from 'zod'
import type {
  AccountConversationMessagesQuery, AccountConversationPatchInput, AccountConversationsQuery,
  AccountNotificationEvent, AccountNotificationId, AccountProfile, AccountUsageLogsQuery, AccountUserId, SignInErrorCode,
} from './types.ts'

/** Protocol errors expose a stable code, never a response body or authorization URL. */
export class PlatformAuthError extends Error {
  /** @param code - safe error classification. */
  constructor(readonly code: SignInErrorCode) { super(`account: ${code}`) }
}

/** An authenticated Platform request was rejected with HTTP 401 or code 40003. */
export class AccountUnauthorizedError extends PlatformAuthError {
  constructor() { super('expired') }
}

/** A conversation patch was rejected with HTTP 409 (stale revision or mutation collision). */
export class DesktopConflictError extends PlatformAuthError {
  constructor() { super('protocol') }
}

/**
 * Parse a canonical dotted-quad hostname into its octets.
 * @param hostname - URL hostname as the WHATWG parser normalized it.
 * @returns the four octets, or undefined when the host is not an IPv4 literal.
 */
function ipv4Octets(hostname: string): number[] | undefined {
  const parts = hostname.split('.')
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    octets.push(octet)
  }
  return octets
}

/**
 * Whether a host is a private IPv4 literal usable over plain HTTP in a trusted intranet deployment.
 * The check demands a whole literal address, not a prefix: the URL parser has already canonicalized
 * every spelling of an IPv4 host, so a name such as `192.168.1.1.example.com` cannot pass here even
 * though a prefix match would have accepted it.
 * @param hostname - URL hostname, with or without IPv6 brackets.
 * @returns whether the host falls in a private RFC 1918 range.
 */
export function isPrivateHttpHost(hostname: string): boolean {
  const octets = ipv4Octets(hostname.startsWith('[') ? hostname.slice(1, -1) : hostname)
  if (octets === undefined) return false
  const [first = -1, second = -1] = octets
  return first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31)
}

/**
 * Accept HTTPS platform endpoints, or plain HTTP on loopback/private intranet hosts when the
 * deployment explicitly opts in (`allowLoopbackHttp`).
 * @param value - configured origin.
 * @param allowLoopbackHttp - development/intranet opt-in for plain HTTP.
 * @param field - configuration field named in validation errors.
 * @returns normalized origin.
 */
export function platformOrigin(value: string, allowLoopbackHttp: boolean,
  field: 'platformOrigin' | 'harnessOrigin'): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !(url.protocol === 'https:' || (allowLoopbackHttp && (loopback || isPrivateHttpHost(url.hostname)) && url.protocol === 'http:'))) {
    throw new Error(`account: ${field} must be an HTTPS origin or an explicitly enabled loopback/private HTTP origin`)
  }
  return url.origin
}

/**
 * Validate Host-only deployment headers without exposing their values in diagnostics.
 * @param values - configured headers for the Platform origin.
 * @returns normalized headers; authorization, routing and framing remain provider-owned.
 */
export function platformHeaders(values: Record<string, string>): Record<string, string> {
  const headers = new Headers()
  const names = new Set<string>()
  for (const [name, value] of Object.entries(values)) {
    const key = name.toLowerCase()
    if (['authorization', 'x-dsh-auth-token', 'host', 'content-length', 'transfer-encoding', 'connection', 'content-type'].includes(key)
      || names.has(key)) throw new Error('account: requestHeaders contains a reserved or duplicate header')
    names.add(key)
    try { headers.set(name, value) }
    catch { throw new Error('account: requestHeaders contains an invalid header') }
  }
  return Object.fromEntries(headers)
}

const envelope = z.object({ code: z.literal(0), data: z.object({ biz_code: z.number().int(), biz_data: z.unknown() }) })
/** Successful initialization response. */
export const initialization = z.object({
  authorize_url: z.url(), authorize_id: z.string().min(1), expires_in: z.number().positive(),
})
/** Successful code exchange response. */
export const exchange = z.object({ token: z.string().regex(/^[\x21-\x7e]+$/), authorized_url: z.url(), user: z.unknown().optional() })

/** Desktop client id registered by the utoken (new-api) authorization server. */
export const DESKTOP_CLIENT_ID = 'yun-token-desktop'
/** Loopback callback path the desktop authorization server redirects to. */
export const DESKTOP_CALLBACK_PATH = '/desktop-auth/callback'

/**
 * Account snapshot carried by the utoken desktop exchange and `/api/desktop-auth/me`
 * (`desktopUserPayload()` in `controller/desktop_auth.go`). Credentials are never included.
 * `display_name` may be an empty string.
 */
export const desktopUser = z.object({
  id: z.number().int(),
  username: z.string().max(20),
  display_name: z.string(),
  /** 1 regular user, 10 administrator, 100 super administrator. */
  role: z.number().int(),
  /** Billing group deciding model multipliers; `default` unless assigned. */
  group: z.string(),
})

/**
 * Successful utoken desktop code exchange. The server returns the language-model key as
 * `language_api_key` (utoken vip branch, `controller/desktop_auth.go`). `user` is omitted
 * entirely (no key, not null) when the server has no account for the grant.
 */
export const desktopToken = z.object({
  access_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  language_api_key: z.string().regex(/^sk-[A-Za-z0-9_-]+$/),
  // Display-only snapshot: a shape drift must not block sign-in, so it degrades to "no profile".
  user: desktopUser.optional().catch(undefined),
})

/**
 * Project the utoken account snapshot into the UI profile, falling back to the login account
 * when `display_name` is empty.
 * @param user - validated desktop account snapshot.
 * @returns UI account profile carrying the gateway identity fields.
 */
export function desktopProfile(user: z.infer<typeof desktopUser>): AccountProfile {
  return {
    id: String(user.id) as AccountUserId,
    name: user.display_name || user.username,
    contact: null,
    username: user.username,
    role: user.role,
    group: user.group,
  }
}

/**
 * The language-model key carried by a desktop token response.
 * @param token - validated desktop token response.
 * @returns the `sk-`-prefixed key.
 */
export function desktopLanguageKey(token: z.infer<typeof desktopToken>): string {
  return token.language_api_key
}

/**
 * Build the desktop OAuth loopback redirect URI from a validated callback origin.
 * utoken accepts only `http://127.0.0.1:<port>/desktop-auth/callback`, while the callback route
 * matches by CSRF state rather than Host, so `localhost` normalizes to `127.0.0.1` without
 * altering where the browser returns.
 * @param callbackOrigin - validated loopback HTTP origin from {@link loginOrigin}.
 * @returns exact loopback callback URL sent in authorize and token requests.
 */
export function desktopRedirectUri(callbackOrigin: string): string {
  const url = new URL(callbackOrigin)
  const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname
  const port = url.port || '80'
  return `${url.protocol}//${host}:${port}${DESKTOP_CALLBACK_PATH}`
}

/**
 * Build the browser authorization URL the utoken server expects for a desktop client.
 * @param origin - validated authorization server origin.
 * @param redirectUri - exact loopback callback the client is listening on.
 * @param state - CSRF state value.
 * @param challenge - PKCE S256 challenge.
 * @returns absolute authorization URL.
 */
export function desktopAuthorizeUrl(origin: string, redirectUri: string, state: string, challenge: string): string {
  const url = new URL('/api/desktop-auth/authorize', origin)
  url.search = new URLSearchParams({
    response_type: 'code', client_id: DESKTOP_CLIENT_ID, redirect_uri: redirectUri,
    state, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString()
  return url.href
}

/**
 * Exchange a desktop authorization code for the access token and speech credential.
 * @param origin - authorization server origin.
 * @param code - one-time authorization code from the loopback callback.
 * @param redirectUri - the same redirect URI used to authorize.
 * @param verifier - PKCE verifier whose S256 challenge was sent.
 * @param signal - attempt cancellation and timeout.
 * @param headers - deployment headers for this origin.
 * @returns the raw JSON payload, validated by the caller.
 */
export function exchangeDesktopToken(origin: string, code: string, redirectUri: string, verifier: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return desktopRequest(`${origin}/api/desktop-auth/token`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: DESKTOP_CLIENT_ID,
      code, redirect_uri: redirectUri, code_verifier: verifier,
    }).toString(),
  }, signal)
}

/**
 * Fetch wallet balance and active subscriptions from utoken's desktop balance endpoint.
 * @param origin - configured account API origin.
 * @param token - stored desktop access token (`Bearer`).
 * @param signal - credential lifetime and request timeout.
 * @param headers - validated deployment headers for this origin.
 * @returns parsed JSON payload, validated by the caller.
 */
export function requestDesktopBalance(origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return desktopRequest(`${origin}/api/desktop-auth/balance`, {
    method: 'GET',
    headers: { ...headers, authorization: `Bearer ${token}` },
  }, signal, 65_536)
}

/**
 * Fetch paginated model usage logs from utoken's desktop usage logs endpoint.
 * @param origin - configured account API origin.
 * @param token - stored desktop access token (`Bearer`).
 * @param query - pagination and filter parameters; offset is clamped to `<= 9999`.
 * @param signal - credential lifetime and request timeout.
 * @param headers - validated deployment headers for this origin.
 * @returns parsed JSON payload, validated by the caller.
 */
export function requestDesktopUsageLogs(origin: string, token: string, query: AccountUsageLogsQuery,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  const url = new URL('/api/desktop/usage-logs', origin)
  const rawSize = query.pageSize
  const pageSize = typeof rawSize === 'number' && Number.isInteger(rawSize) ? Math.min(100, Math.max(1, rawSize)) : 20
  const maxPage = Math.floor(9_999 / pageSize) + 1
  const rawPage = query.page
  const page = typeof rawPage === 'number' && Number.isInteger(rawPage) ? Math.min(maxPage, Math.max(1, rawPage)) : 1
  url.searchParams.set('p', String(page))
  url.searchParams.set('page_size', String(pageSize))
  if (typeof query.startTimestamp === 'number' && Number.isInteger(query.startTimestamp) && query.startTimestamp > 0) {
    url.searchParams.set('start_timestamp', String(query.startTimestamp))
  }
  if (typeof query.endTimestamp === 'number' && Number.isInteger(query.endTimestamp) && query.endTimestamp > 0) {
    url.searchParams.set('end_timestamp', String(query.endTimestamp))
  }
  if (typeof query.modelName === 'string' && query.modelName.length > 0 && Buffer.byteLength(query.modelName, 'utf8') <= 256) {
    url.searchParams.set('model_name', query.modelName)
  }
  return desktopRequest(url.href, {
    method: 'GET',
    headers: { ...headers, authorization: `Bearer ${token}` },
  }, signal, 524_288)
}

/**
 * Fetch paginated cloud conversations from utoken (`GET /api/conversations`).
 * @param origin - configured account API origin.
 * @param token - stored desktop access token (`Bearer`).
 * @param query - offset and limit parameters.
 * @param signal - credential lifetime and request timeout.
 * @param headers - validated deployment headers for this origin.
 * @returns parsed JSON payload, validated by the caller.
 */
export function requestDesktopConversations(origin: string, token: string, query: AccountConversationsQuery,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  const url = new URL('/api/conversations', origin)
  const rawLimit = query.limit
  const limit = typeof rawLimit === 'number' && Number.isInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 30
  const rawOffset = query.offset
  const offset = typeof rawOffset === 'number' && Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0
  url.searchParams.set('offset', String(offset))
  url.searchParams.set('limit', String(limit))
  return desktopRequest(url.href, {
    method: 'GET',
    headers: { ...headers, authorization: `Bearer ${token}` },
  }, signal, 524_288)
}

/**
 * Fetch paginated structured messages for one cloud conversation (`GET /api/conversations/{id}/messages`).
 * @param origin - configured account API origin.
 * @param token - stored desktop access token (`Bearer`).
 * @param id - conversation identifier (1..64 chars).
 * @param query - optional cursor (`before`, `revision`) and `limit`.
 * @param signal - credential lifetime and request timeout.
 * @param headers - validated deployment headers for this origin.
 * @returns parsed JSON payload, validated by the caller.
 */
export function requestDesktopConversationMessages(origin: string, token: string, id: string,
  query: AccountConversationMessagesQuery, signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  if (id.length === 0 || id.length > 64) throw new PlatformAuthError('protocol')
  const url = new URL(`/api/conversations/${encodeURIComponent(id)}/messages`, origin)
  const rawLimit = query.limit
  const limit = typeof rawLimit === 'number' && Number.isInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50
  url.searchParams.set('limit', String(limit))
  if (typeof query.before === 'number' && Number.isInteger(query.before) && query.before > 0) {
    url.searchParams.set('before', String(query.before))
  }
  if (typeof query.revision === 'number' && Number.isInteger(query.revision) && query.revision >= 0) {
    url.searchParams.set('revision', String(query.revision))
  }
  return desktopRequest(url.href, {
    method: 'GET',
    headers: { ...headers, authorization: `Bearer ${token}` },
  }, signal, 1_048_576)
}

/**
 * Apply one idempotent revisioned patch to a cloud conversation (`PATCH /api/conversations/{id}`).
 * @param origin - configured account API origin.
 * @param token - stored desktop access token (`Bearer`).
 * @param id - conversation identifier (1..64 chars).
 * @param input - revision, mutation_id, title, messages, and deleted_ids.
 * @param signal - credential lifetime and request timeout.
 * @param headers - validated deployment headers for this origin.
 * @returns parsed JSON payload, validated by the caller.
 */
export function patchDesktopConversation(origin: string, token: string, id: string,
  input: AccountConversationPatchInput, signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  if (id.length === 0 || id.length > 64) throw new PlatformAuthError('protocol')
  const url = new URL(`/api/conversations/${encodeURIComponent(id)}`, origin)
  return desktopRequest(url.href, {
    method: 'PATCH',
    headers: { ...headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      revision: input.revision,
      mutation_id: input.mutationId,
      title: input.title,
      messages: input.messages,
      deleted_ids: input.deletedIds,
    }),
  }, signal, 65_536)
}

/** Read and bound one utoken response that is plain JSON, not the platform envelope. */
async function desktopRequest(url: string, init: RequestInit, signal: AbortSignal, maxBytes = 4_096): Promise<unknown> {
  const path = new URL(url).pathname
  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal })
  } catch {
    if (!callerCancelled(signal)) console.error('[deepseek-account] desktop request failed', { path, errorCode: 'no-response' })
    throw new PlatformAuthError('no-response')
  }
  if (!response.ok || response.body === null) {
    if (!callerCancelled(signal)) console.error('[deepseek-account] desktop request failed', { path, status: response.status, errorCode: 'network' })
    await response.body?.cancel()
    if (response.status === 409) throw new DesktopConflictError()
    throw new PlatformAuthError('network')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let stage = 'read-body'
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) {
        stage = 'body-limit'
        throw new PlatformAuthError('protocol')
      }
      chunks.push(next.value)
    }
    stage = 'parse-json'
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    if (stage === 'read-body' && signal.aborted) {
      if (!callerCancelled(signal)) console.error('[deepseek-account] desktop request failed', { path, errorCode: 'no-response' })
      throw new PlatformAuthError('no-response')
    }
    if (!callerCancelled(signal)) console.error('[deepseek-account] desktop response rejected', { path, stage })
    if (error instanceof PlatformAuthError) throw error
    throw new PlatformAuthError('protocol')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/**
 * Read one bounded platform response; non-cancellation failures emit non-secret diagnostics to stderr.
 * @param origin - validated platform origin.
 * @param method - platform endpoint suffix.
 * @param body - protocol request, never logged.
 * @param signal - attempt cancellation and timeout.
 * @param headers - validated deployment headers for this origin.
 * @returns successful business payload, validated by its caller.
 */
export async function requestPlatform(origin: string, method: string, body: unknown,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}/auth-api/v0/dsh/${method}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, signal)
}

/**
 * Fetch a fixed Platform account endpoint with the grant kept in Host request headers.
 * @param origin - configured and grant-matched origin.
 * @param path - account endpoint.
 * @param token - account grant.
 * @param signal - credential lifetime and request timeout.
 * @param headers - validated deployment headers for this origin.
 * @returns successful business payload.
 */
export function requestAccount(origin: string, path: '/auth-api/v0/users/current' | '/api/v0/users/get_user_summary',
  token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}${path}`, { method: 'GET', headers: accountHeaders(headers, token) }, signal)
}

/**
 * Read unconsumed account notifications in server order.
 * @param origin - configured account API origin.
 * @param token - stored account grant.
 * @param signal - credential lifetime and request timeout.
 * @param headers - deployment and client identity headers for this origin.
 * @returns successful business payload holding the notification list.
 */
export function requestNotifications(origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}/api/v0/users/notifications/list`,
    { method: 'GET', headers: accountHeaders(headers, token) }, signal)
}

/**
 * Read localized notification content, including a consumed notification.
 * @param origin - configured account API origin.
 * @param token - stored account grant.
 * @param id - notification requested by its owning account.
 * @param signal - credential lifetime and request timeout.
 * @param headers - deployment and client identity headers for this origin.
 * @returns successful business payload containing one notification.
 */
export function requestNotificationContent(origin: string, token: string, id: AccountNotificationId,
  signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}/api/v0/users/notifications/content?id=${encodeURIComponent(id)}`,
    { method: 'GET', headers: accountHeaders(headers, token) }, signal)
}

/**
 * Report an account notification interaction to the events endpoint.
 * @param origin - configured account API origin.
 * @param token - stored account grant.
 * @param id - notification the user interacted with.
 * @param event - displayed frame, business-action click, or explicit dismissal.
 * @param signal - credential lifetime and request timeout.
 * @param headers - deployment and client identity headers for this origin.
 * @returns successful business payload containing the consumption decision.
 */
export function requestNotificationEvent(origin: string, token: string, id: AccountNotificationId,
  event: AccountNotificationEvent, signal: AbortSignal, headers: Record<string, string>): Promise<unknown> {
  return platformRequest(`${origin}/api/v0/users/notifications/events`, {
    method: 'POST', headers: { ...accountHeaders(headers, token), 'content-type': 'application/json' },
    body: JSON.stringify({ notification_id: id, type: event }),
  }, signal)
}

// The grant is provider-owned; deployment requestHeaders cannot override it or the client identity.
function accountHeaders(headers: Record<string, string>, token: string): Record<string, string> {
  return { ...headers, 'x-dsh-auth-token': token }
}

/**
 * End the Platform session using its existing logout endpoint.
 * @param origin - configured account API origin.
 * @param token - stored account token.
 * @param signal - logout request deadline.
 * @param headers - validated deployment headers for this origin.
 * @returns after Platform confirms logout.
 */
export async function logoutAccount(origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<void> {
  await platformRequest(`${origin}/auth-api/v0/users/logout`, {
    method: 'POST', headers: { ...headers, 'x-dsh-auth-token': token },
  }, signal)
}

/**
 * End a utoken desktop authorization session on sign-out.
 * @param origin - configured account API origin.
 * @param token - stored 43-character desktop access token.
 * @param signal - logout request deadline.
 * @param headers - validated deployment headers for this origin.
 * @returns after revocation succeeds or the token is already gone (401).
 */
export async function revokeDesktopSession(origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<void> {
  const path = '/api/desktop-auth/revoke'
  let response: Response
  try {
    response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${token}` },
      redirect: 'error',
      signal,
    })
  } catch {
    if (!callerCancelled(signal)) console.error('[deepseek-account] desktop request failed', { path, errorCode: 'no-response' })
    throw new PlatformAuthError('no-response')
  }
  await response.body?.cancel().catch(() => undefined)
  if (response.ok || response.status === 401) return
  if (!callerCancelled(signal)) console.error('[deepseek-account] desktop request failed', { path, status: response.status, errorCode: 'network' })
  throw new PlatformAuthError('network')
}

/** Caller cancellation stays silent; standard TimeoutError aborts remain failures. */
function callerCancelled(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason
  return signal.aborted && !(reason instanceof Error && reason.name === 'TimeoutError')
}

async function platformRequest(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
  const path = new URL(url).pathname
  let response: Response
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal })
  } catch {
    if (!callerCancelled(signal)) console.error('[deepseek-account] request failed', { path, errorCode: 'no-response', aborted: signal.aborted })
    throw new PlatformAuthError('no-response')
  }
  if (response.status === 401 && new Headers(init.headers).has('x-dsh-auth-token')) {
    if (!callerCancelled(signal)) console.error('[deepseek-account] request failed', { path, status: response.status, errorCode: 'expired' })
    await response.body?.cancel()
    throw new AccountUnauthorizedError()
  }
  if (!response.ok || response.body === null) {
    if (!callerCancelled(signal)) console.error('[deepseek-account] request failed', { path, status: response.status, errorCode: 'network' })
    await response.body?.cancel()
    throw new PlatformAuthError('network')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let stage = 'read-body'
  let codes: { code: number; data?: { biz_code: number } | undefined } | undefined
  let validationError: z.ZodError | undefined
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > 65_536) {
        stage = 'body-limit'
        throw new PlatformAuthError('protocol')
      }
      chunks.push(next.value)
    }
    stage = 'parse-json'
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const responseCodes = z.object({ code: z.number().int(), data: z.object({ biz_code: z.number().int() }).optional() }).safeParse(payload)
    if (responseCodes.success) codes = responseCodes.data
    const authorization = z.object({ code: z.literal(40003) }).safeParse(payload)
    if (authorization.success && new Headers(init.headers).has('x-dsh-auth-token')) {
      throw new AccountUnauthorizedError()
    }
    stage = 'envelope'
    const parsed = envelope.safeParse(payload)
    if (!parsed.success) {
      validationError = parsed.error
      throw new PlatformAuthError('protocol')
    }
    stage = 'business-code'
    if (parsed.data.data.biz_code !== 0) {
      // TODO(product-error-ui): Apply product-defined copy and UI behavior for the supplied biz_code values.
      // Business failures use the existing generic failure UI until then; backend messages stay Host-only.
      throw new PlatformAuthError('protocol')
    }
    return parsed.data.data.biz_data
  } catch (error) {
    if (!callerCancelled(signal)) console.error('[deepseek-account] response rejected', {
      path, status: response.status, stage, code: codes?.code, bizCode: codes?.data?.biz_code,
      issues: validationError?.issues.map(issue => ({ path: issue.path, code: issue.code })),
      errorCode: error instanceof PlatformAuthError ? error.code : 'protocol',
    })
    if (error instanceof PlatformAuthError) throw error
    throw new PlatformAuthError('protocol')
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/**
 * Accept a browser-accessible loopback HTTP origin for local or SSH-forwarded login.
 * @param value - loopback HTTP origin with an explicit port supplied by the authenticated initiating client.
 * @returns normalized origin; remote domains and path-based proxies are unsupported.
 */
export function loginOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new PlatformAuthError('protocol') }
  const explicitPort = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):([0-9]+)\/?$/i.exec(value)?.[1]
  if (explicitPort === undefined || Number(explicitPort) === 0
    || url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new PlatformAuthError('protocol')
  }
  return `${url.protocol}//${url.hostname}:${Number(explicitPort)}`
}
