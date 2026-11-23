/** DeepSeek account service; browser approval never bypasses local cancellation. */
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { platform, release } from 'node:os'
import { promises as streamPromises } from 'node:stream'
import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { installAccountTaskCancellation, isRunningAccountTask } from './account-tasks.ts'
import { mergePlatformCookies, platformClientHeaders, platformWireLocale } from './client-metadata.ts'
import { type AccountConversationMessagesQuery, type AccountConversationMessagesResult, type AccountConversationPatchInput, type AccountConversationPatchResult, type AccountConversationsQuery, type AccountConversationsResult, type AccountNotification, type AccountNotificationBatch, type AccountNotificationEvent, type AccountNotificationId, type AccountClientMetadata, type AccountDetails, type AccountUsageLogsQuery, type AccountUsageLogsResult, type AccountUserId, type AccountView, type AccountUpdate, type PlatformSession, type SignInAttemptId, type SignInAttemptView } from './types.ts'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { readAccountDetail, readDesktopBalance, readDesktopConversationMessages, readDesktopConversations, readDesktopUsageLogs, writeDesktopConversation } from './details.ts'
import { readNotificationContent, readNotifications, sendNotificationEvent } from './notifications.ts'
import { revokeAccount, type LogoutRetryPolicy } from './logout.ts'
import { AccountUnauthorizedError, PlatformAuthError, platformHeaders, platformOrigin, loginOrigin, desktopAuthorizeUrl, desktopRedirectUri, exchangeDesktopToken, desktopToken, desktopLanguageKey, desktopProfile, desktopUser, DESKTOP_CALLBACK_PATH } from './protocol.ts'

export type * from './types.ts'
export { isPrivateHttpHost } from './protocol.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { deepseekAccount: DeepSeekAccount }
  interface Events {
    /** Local grant removal has completed.
     * @mode emit
     */
    'deepseek-account/signed-out'(): void
  }
}


const KEY = credentialKey('deepseek-account-platform', 'default')
const DEVICE = credentialKey('deepseek-account-platform', 'device')
/** Long-lived speech credential from the utoken desktop exchange; kept apart from the 10-minute access token. */
const SPEECH = credentialKey('deepseek-account-platform', 'speech')
/** Account identity snapshot from the utoken desktop exchange; survives restarts so the gateway
 * profile renders without a DeepSeek profile endpoint. Cleared with the grant. */
const PROFILE = credentialKey('deepseek-account-platform', 'profile')
const grant = z.object({ version: z.literal(1), token: z.string().min(1), issuer: z.url() })
const device = z.object({ id: z.uuid() })
const speechGrant = z.object({ version: z.literal(1), key: z.string().min(1), issuer: z.url() })
const profileGrant = z.object({ version: z.literal(1), issuer: z.url(), user: desktopUser })

/** Deployment-specific platform and request deadlines. */
export interface Config {
  /** Platform origin serving auth-api and browser pages. */
  platformOrigin?: string
  /** Harness API origin for account notifications. */
  harnessOrigin?: string
  /** Native desktop identity for Host API and embedded Platform requests; null identifies the client as web. */
  desktopPlatform?: 'darwin' | 'win32' | null
  /** Optional frontend deployment selector for embedded Usage and Top-up pages. */
  embeddedPageDist?: string
  /** Path of the usage page on platformOrigin; defaults to the official `/usage`. Gateway deployments
   * such as utoken serve it under their own console route (`/usage-logs`). */
  usagePath?: string
  /** Path of the top-up page on platformOrigin; defaults to the official `/top_up`. utoken serves its
   * wallet at `/wallet`. */
  topUpPath?: string
  /** Exact HTTP(S) origin allowed to receive account tokens for inference and files. */
  inferenceOrigin?: string
  /** Allow HTTP only on loopback for the development Mock. */
  allowLoopbackHttp?: boolean
  /** Whether platformOrigin serves the DeepSeek profile/balance endpoints (/auth-api/v0/users/current,
   * /api/v0/users/get_user_summary). When false, gateway deployments such as utoken serve profile from the
   * sign-in snapshot and balance from /api/desktop-auth/balance instead. */
  platformAccountApis?: boolean
  /** Host-only headers for Platform and notification APIs; account authorization cannot be overridden. */
  requestHeaders?: Record<string, string>
  /** Overrides for profile, balance, notification and embedded Platform requests;
   * Cookie pairs merge by name. Logout retains requestHeaders.
   */
  accountRequestHeaders?: Record<string, string>
  /** Deadline for each platform HTTP request. */
  requestTimeoutMs?: number
  /** Deadline for recharge-wallet queries; timeout returns a failed balance outcome. */
  balanceTimeoutMs?: number
  /** Additional logout attempts after the first request fails, at most five. */
  logoutMaxRetries?: number
  /** Delay before the first logout retry; each later delay doubles. */
  logoutRetryDelayMs?: number
  /** Upper bound for the entire local attempt, even if the server advertises a longer TTL. */
  attemptTimeoutMs?: number
}
/** Validated deployment choices. */
const Config = Schema.object({
  platformOrigin: Schema.string().default('https://platform.deepseek.com'),
  harnessOrigin: Schema.string().default('https://harness.deepseek.com'),
  desktopPlatform: Schema.union([Schema.const('darwin'), Schema.const('win32'), Schema.const(null)]).default(null),
  embeddedPageDist: Schema.string().default(''),
  usagePath: Schema.string().default('/usage'),
  topUpPath: Schema.string().default('/top_up'),
  inferenceOrigin: Schema.string().default('https://api.deepseek.com'),
  allowLoopbackHttp: Schema.boolean().default(false),
  platformAccountApis: Schema.boolean().default(true),
  requestHeaders: Schema.dict(Schema.string().role('secret')).default({}),
  accountRequestHeaders: Schema.dict(Schema.string().role('secret')).default({}),
  requestTimeoutMs: Schema.number().min(1).max(120_000).default(30_000),
  balanceTimeoutMs: Schema.number().min(1).max(120_000).default(30_000),
  logoutMaxRetries: Schema.number().min(0).max(5).step(1).default(5),
  logoutRetryDelayMs: Schema.number().min(1).max(60_000).default(1_000),
  attemptTimeoutMs: Schema.number().min(1).max(3_600_000).default(600_000),
})

/**
 * Reject a page path that would leave the configured platform origin. A deployment may only move these
 * destinations inside its own site, never point them at a second authority.
 * @param value - configured path.
 * @param name - configuration key reported in the error.
 * @returns the same path with its query preserved.
 */
function accountPagePath(value: string, name: string): string {
  const base = 'http://account-page.invalid'
  let parsed: URL
  try {
    parsed = new URL(value, base)
  } catch {
    throw new Error(`account: ${name} must be an absolute path on the platform origin`)
  }
  if (parsed.origin !== base || !value.startsWith('/')) {
    throw new Error(`account: ${name} must be an absolute path on the platform origin`)
  }
  return `${parsed.pathname}${parsed.search}`
}

interface Attempt {
  locale: 'en_US' | 'zh_CN'
  clientHeaders: Record<string, string>
  view: SignInAttemptView
  controller: AbortController
  done: Promise<void>
  running: Promise<void>
  origin: string
  loginSource: 'web' | 'desktop'
  /** CSRF state carried by the authorization request; the callback route matches on it. */
  state?: string | undefined
  /** Handoff for the authorization code the callback route delivers. */
  code?: PromiseWithResolvers<string> | undefined
  callback?: ServerResponse
  initialProfile?: { token: string; value: AccountDetails['profile'] }
}

/** Account login, credentials, and client-safe Remote operations. */
export class DeepSeekAccount extends TypertRemoteService {
  static inject = ['credentials', 'authorization']
  static Config = Config
  private readonly origin: string
  private readonly harnessOrigin: string
  /**
   * Whether the notification service may judge this deployment's grant. A service only speaks for the
   * tokens its own authority minted: DeepSeek's harness answers every token it did not issue with
   * `40003`, so asking it from a deployment that signs in elsewhere would revoke a valid login.
   */
  private readonly harnessMayJudgeGrant: boolean
  /** Whether platformOrigin serves the DeepSeek-only profile/balance account APIs. */
  private readonly platformAccountApis: boolean
  private readonly embeddedPageDist: string
  /** Platform page destinations the account panel links to and the Desktop view embeds. */
  private readonly usagePath: string
  private readonly topUpPath: string
  private readonly inferenceOrigin: string
  private readonly platform: 'darwin' | 'win32' | null
  private readonly requestHeaders: Record<string, string>
  private readonly accountRequestHeaders: Record<string, string>
  private readonly requestTimeout: number
  private readonly balanceTimeout: number
  private readonly attemptTimeout: number
  private readonly logoutPolicy: LogoutRetryPolicy
  private readonly logoutLifetime = new AbortController()
  private readonly revocations = new Set<Promise<void>>()
  private attempt: Attempt | undefined
  private readonly listeners = new Set<(kind: 'snapshot' | 'credentials-changed' | 'identity') => void>()
  /**
   * Latest ready profile read and the grant token it was read with. Binding the token keeps a
   * cached identity from answering for a credential that has since changed.
   */
  private lastProfile: { readonly token: string; readonly profile: Extract<AccountDetails['profile'], { status: 'ready' }> } | undefined
  private detailsLifetime = new AbortController()
  private closed = false
  private removing: Promise<AccountView> | undefined

  /** @param ctx - Host with authorization and credentials services. @param config - deployment options. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'deepseekAccount', { namespace: 'account' })
    installAccountTaskCancellation(ctx)
    const resolved = Config(config)
    this.embeddedPageDist = resolved.embeddedPageDist
    this.usagePath = accountPagePath(resolved.usagePath, 'usagePath')
    this.topUpPath = accountPagePath(resolved.topUpPath, 'topUpPath')
    this.platformAccountApis = resolved.platformAccountApis
    this.origin = platformOrigin(resolved.platformOrigin, resolved.allowLoopbackHttp, 'platformOrigin')
    this.harnessOrigin = platformOrigin(resolved.harnessOrigin, resolved.allowLoopbackHttp, 'harnessOrigin')
    // Same authority (an unconfigured harness inherits the account deployment, an explicit one that
    // shares its origin), or the official pair the defaults describe.
    this.harnessMayJudgeGrant = new URL(this.harnessOrigin).origin === this.origin
      || (this.origin === 'https://platform.deepseek.com' && this.harnessOrigin === 'https://harness.deepseek.com')
    const inference = new URL(resolved.inferenceOrigin)
    if (!['http:', 'https:'].includes(inference.protocol) || inference.username || inference.password
      || inference.pathname !== '/' || inference.search || inference.hash) {
      throw new Error('account: inferenceOrigin must be an HTTP(S) origin without credentials, path, query or fragment')
    }
    this.inferenceOrigin = inference.origin
    this.platform = resolved.desktopPlatform
    this.requestHeaders = platformHeaders(resolved.requestHeaders)
    const accountHeaders = platformHeaders(resolved.accountRequestHeaders)
    this.accountRequestHeaders = { ...this.requestHeaders, ...accountHeaders }
    if (accountHeaders.cookie !== undefined) {
      this.accountRequestHeaders.cookie = mergePlatformCookies(this.requestHeaders.cookie ?? '', accountHeaders.cookie)
    }
    this.requestTimeout = resolved.requestTimeoutMs
    this.balanceTimeout = resolved.balanceTimeoutMs
    this.attemptTimeout = resolved.attemptTimeoutMs
    this.logoutPolicy = {
      maxRetries: resolved.logoutMaxRetries, delayMs: resolved.logoutRetryDelayMs, requestTimeoutMs: this.requestTimeout,
    }
    ctx.authorization.registerFlow({
      key: KEY, label: 'DeepSeek', methods: [{ id: 'browser', label: 'DeepSeek' }],
      run: (session) => {
        const attempt = this.attempt
        if (attempt === undefined) return Promise.reject(new PlatformAuthError('protocol'))
        attempt.running = this.run(session, attempt)
        return attempt.running
      },
    })
    ctx.on('credentials/record-updated', (key) => {
      if (key !== KEY) return
      this.invalidateDetails()
      this.changed('credentials-changed')
    })
    this.installCallbackRoute(ctx)
    ctx.effect(() => async () => {
      this.closed = true
      this.logoutLifetime.abort()
      this.invalidateDetails()
      const active = this.attempt
      if (active !== undefined) {
        if (active.view.phase !== 'committing') active.controller.abort()
        await active.done
      }
      await this.removing
      await Promise.all(this.revocations)
      this.changed('snapshot')
    }, 'account: active attempt lifetime')
  }

  async [Service.init](): Promise<void> {
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record === undefined) return
    if (record.kind !== 'grant') throw new PlatformAuthError('storage')
    const parsed = grant.safeParse(record.payload)
    if (!parsed.success) throw new PlatformAuthError('storage')
    if (parsed.data.issuer === this.origin) return
    await this.ctx.credentials.deleteRecord(KEY)
  }

  /**
   * Read stored-account presence and the latest login attempt.
   * @returns a snapshot without credentials or PKCE secrets.
   */
  @Remote
  async getState(): Promise<AccountView> {
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record !== undefined && (record.kind !== 'grant' || !grant.safeParse(record.payload).success)) {
      throw new PlatformAuthError('storage')
    }
    const attempt = this.attempt?.view ?? null
    return {
      status: record === undefined ? 'signed-out' : 'credential-stored',
      // Credential removal can notify watchers before sign-out finishes clearing the attempt.
      attempt: record === undefined && attempt?.phase === 'succeeded' ? null : attempt,
      links: { usageUrl: new URL(this.usagePath, this.origin).href, topUpUrl: new URL(this.topUpPath, this.origin).href },
    }
  }

  /**
   * Query Platform profile independently of wallet balances.
   * A ready result whose stable profile ID first becomes available or changes notifies identity-enabled watch
   * consumers, so they re-read getPlatformSession; repeated IDs stay silent.
   * @param client - identity of the requesting UI for this call.
   * @returns profile outcome, or null if signed out or the grant changed during the query.
   */
  @Remote
  async getProfile(client: AccountClientMetadata): Promise<AccountDetails['profile'] | null> {
    // Gateway deployments (e.g. utoken) have no DeepSeek profile endpoint; serve the account
    // snapshot captured at sign-in instead of issuing a request that can only fail.
    if (!this.platformAccountApis) return this.readProfileSnapshot()
    const lifetime = this.detailsLifetime
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null || lifetime.signal.aborted) return null
    const result = await this.getDetail('profile', this.detailHeaders(client), { lifetime, stored })
    if (this.detailsLifetime !== lifetime) return null
    if (result !== null) this.cacheProfile(stored.token, result)
    if (result?.status !== 'failed') return result
    // Only this same grant's last ready read may stand in for a failed refresh.
    const cached = this.lastProfile?.token === stored.token ? this.lastProfile.profile : undefined
    return cached ?? result
  }

  /**
   * Query Platform recharge and bonus wallet balances independently of profile data.
   * @param client - identity of the requesting UI for this call.
   * @returns balance outcome, or null if signed out or the grant changed during the query.
   */
  @Remote
  getBalance(client: AccountClientMetadata): Promise<AccountDetails['balance'] | null> {
    if (!this.platformAccountApis) return this.getDesktopBalance(this.detailHeaders(client))
    return this.getDetail('balance', this.detailHeaders(client))
  }

  /**
   * Query paginated model usage logs from utoken's desktop endpoint without expiring the session on 401.
   * @param client - identity of the requesting UI for this call.
   * @param query - optional pagination and filter parameters.
   * @returns usage logs page outcome, or null when using Platform account APIs or signed out.
   */
  @Remote
  async getUsageLogs(client: AccountClientMetadata,
    query?: AccountUsageLogsQuery): Promise<AccountUsageLogsResult | null> {
    if (this.platformAccountApis) return null
    const lifetime = this.detailsLifetime
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null || lifetime.signal.aborted) return null
    const result = await readDesktopUsageLogs(this.origin, stored.token, query ?? {},
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(this.balanceTimeout)]), this.detailHeaders(client))
    return this.detailsLifetime !== lifetime ? null : result
  }

  /**
   * List utoken cloud conversations without expiring the session on HTTP 401.
   * @param client - identity of the requesting UI for this call.
   * @param query - optional offset and limit parameters.
   * @returns conversation list outcome, or null when using Platform account APIs or signed out.
   */
  @Remote
  async listConversations(client: AccountClientMetadata,
    query?: AccountConversationsQuery): Promise<AccountConversationsResult | null> {
    if (this.platformAccountApis) return null
    const lifetime = this.detailsLifetime
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null || lifetime.signal.aborted) return null
    const result = await readDesktopConversations(this.origin, stored.token, query ?? {},
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(this.balanceTimeout)]), this.detailHeaders(client))
    return this.detailsLifetime !== lifetime ? null : result
  }

  /**
   * Read paginated structured messages for one utoken cloud conversation without expiring the session on HTTP 401.
   * @param client - identity of the requesting UI for this call.
   * @param id - conversation identifier.
   * @param query - optional cursor (`before`, `revision`) and `limit` parameters.
   * @returns conversation messages outcome, or null when using Platform account APIs or signed out.
   */
  @Remote
  async getConversationMessages(client: AccountClientMetadata, id: string,
    query?: AccountConversationMessagesQuery): Promise<AccountConversationMessagesResult | null> {
    if (this.platformAccountApis) return null
    const lifetime = this.detailsLifetime
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null || lifetime.signal.aborted) return null
    const result = await readDesktopConversationMessages(this.origin, stored.token, id, query ?? {},
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(this.balanceTimeout)]), this.detailHeaders(client))
    return this.detailsLifetime !== lifetime ? null : result
  }

  /**
   * Apply one idempotent revisioned patch to a utoken cloud conversation without expiring the session on HTTP 401.
   * @param client - identity of the requesting UI for this call.
   * @param id - conversation identifier.
   * @param input - revision, mutation_id, title, messages, and deleted_ids.
   * @returns updated conversation metadata, conflict on HTTP 409, or null when unsupported or signed out.
   */
  @Remote
  async patchConversation(client: AccountClientMetadata, id: string,
    input: AccountConversationPatchInput): Promise<AccountConversationPatchResult | null> {
    if (this.platformAccountApis) return null
    const lifetime = this.detailsLifetime
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null || lifetime.signal.aborted) return null
    const result = await writeDesktopConversation(this.origin, stored.token, id, input,
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(this.balanceTimeout)]), this.detailHeaders(client))
    return this.detailsLifetime !== lifetime ? null : result
  }

  /**
   * Query unconsumed account notifications in server order without reading profile data.
   * @param client - identity of the requesting UI for this call; its language selects the server-authored message.
   * @returns notifications with their next query delay, or null if signed out or the grant changed during the query.
   */
  @Remote
  async getNotifications(client: AccountClientMetadata): Promise<AccountNotificationBatch | null> {
    // A notification service that did not mint this grant cannot report on it; asking would revoke the login.
    if (!this.harnessMayJudgeGrant) return null
    const lifetime = this.detailsLifetime
    const headers = this.detailHeaders(client)
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null) return null
    try {
      const batch = await readNotifications(this.harnessOrigin, stored.token,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(this.requestTimeout)]), headers)
      return this.detailsLifetime === lifetime ? batch : null
    } catch (error) {
      if (this.detailsLifetime !== lifetime) return null
      if (error instanceof AccountUnauthorizedError) {
        await this.expireCredential(stored.token, lifetime)
        return null
      }
      throw error
    }
  }

  /**
   * Query localized content of a notification, including one already consumed.
   * @param id - notification whose content is requested.
   * @param client - identity of the requesting UI; its language selects the localized content.
   * @returns content without changing consumption, or null if signed out or the grant changed.
   */
  @Remote
  async getNotificationContent(id: AccountNotificationId,
    client: AccountClientMetadata): Promise<AccountNotification | null> {
    if (!this.harnessMayJudgeGrant) return null
    const lifetime = this.detailsLifetime
    const headers = this.detailHeaders(client)
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null) return null
    try {
      const content = await readNotificationContent(this.harnessOrigin, stored.token, id,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(this.requestTimeout)]), headers)
      return this.detailsLifetime === lifetime ? content : null
    } catch (error) {
      if (this.detailsLifetime !== lifetime) return null
      if (error instanceof AccountUnauthorizedError) {
        await this.expireCredential(stored.token, lifetime)
        return null
      }
      throw error
    }
  }

  /**
   * Report a notification interaction; the backend decides consumption.
   * @param id - notification the user interacted with.
   * @param event - displayed frame, non-dismiss action click, or explicit dismissal.
   * @param client - identity of the requesting UI for this call.
   * @returns true once the server accepts the event; false if signed out or credentials changed during the call.
   */
  @Remote
  async reportNotificationEvent(id: AccountNotificationId,
    event: AccountNotificationEvent, client: AccountClientMetadata): Promise<boolean> {
    if (!this.harnessMayJudgeGrant) return false
    const lifetime = this.detailsLifetime
    const headers = this.detailHeaders(client)
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null) return false
    try {
      await sendNotificationEvent(this.harnessOrigin, stored.token, id, event,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(this.requestTimeout)]), headers)
      return this.detailsLifetime === lifetime
    } catch (error) {
      if (this.detailsLifetime !== lifetime) return false
      if (error instanceof AccountUnauthorizedError) {
        await this.expireCredential(stored.token, lifetime)
        return false
      }
      throw error
    }
  }

  /**
   * Cache one ready profile against the grant token it was read with, so identity reuse cannot cross
   * a credential change. A stable ID that first appears or changes notifies identity-enabled watch consumers, so
   * identity consumers re-read getPlatformSession; repeated IDs stay silent.
   * @param token - grant the profile was read with.
   * @param profile - profile outcome to record when it carries account data.
   */
  private cacheProfile(token: string, profile: AccountDetails['profile']): void {
    if (profile.status !== 'ready') return
    // Identity publishers re-read the session snapshot; wake them only when the stable ID changes.
    const previous = this.lastProfile?.profile.value.id || null
    this.lastProfile = { token, profile }
    if (previous !== (profile.value.id || null)) this.changed('identity')
  }

  /**
   * Read the account snapshot persisted by the desktop exchange. The snapshot is bound to the
   * configured origin so a deployment switch cannot surface another environment's identity.
   * @returns the cached profile, null while signed out, or a failed outcome without a snapshot.
   */
  private async readProfileSnapshot(): Promise<AccountDetails['profile'] | null> {
    const lifetime = this.detailsLifetime
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null || lifetime.signal.aborted) return null
    const cached = this.lastProfile?.token === stored.token ? this.lastProfile.profile : undefined
    if (cached !== undefined) return cached
    const record = await this.ctx.credentials.readRecord(PROFILE)
    if (record?.kind !== 'grant') return { status: 'failed' }
    const parsed = profileGrant.safeParse(record.payload)
    if (!parsed.success || parsed.data.issuer !== this.origin) return { status: 'failed' }
    const value: AccountDetails['profile'] = { status: 'ready', value: desktopProfile(parsed.data.user) }
    this.cacheProfile(stored.token, value)
    return value
  }

  private async getDetail<K extends keyof AccountDetails>(field: K, headers: Record<string, string>,
    captured?: { lifetime: AbortController; stored: z.infer<typeof grant> }): Promise<AccountDetails[K] | null> {
    const lifetime = captured?.lifetime ?? this.detailsLifetime
    const stored = captured?.stored ?? await this.readCurrentGrant(lifetime)
    if (stored === null || lifetime.signal.aborted) return null
    if (field === 'profile' && this.attempt?.initialProfile?.token === stored.token) {
      const initial = this.attempt.initialProfile.value
      delete this.attempt.initialProfile
      return initial as AccountDetails[K]
    }
    try {
      const details = await readAccountDetail(field, this.origin, stored.token,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(field === 'balance' ? this.balanceTimeout : this.requestTimeout)]), headers)
      return this.detailsLifetime !== lifetime ? null : details
    } catch (_unauthorized) {
      // readAccountDetail exposes only authenticated credential rejection failures.
      if (this.detailsLifetime === lifetime) await this.expireCredential(stored.token, lifetime)
      return null
    }
  }

  private async getDesktopBalance(headers: Record<string, string>): Promise<AccountDetails['balance'] | null> {
    const lifetime = this.detailsLifetime
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null || lifetime.signal.aborted) return null
    const details = await readDesktopBalance(this.origin, stored.token,
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(this.balanceTimeout)]), headers)
    return this.detailsLifetime !== lifetime ? null : details
  }

  /** Deployment account headers plus the client identity headers derived from one call's metadata. */
  private detailHeaders(client: AccountClientMetadata): Record<string, string> {
    return { ...this.accountRequestHeaders, ...platformClientHeaders(this.platform, client) }
  }

  /**
   * Remove an inference-rejected credential and expire the account session when the stored access
   * token or language key is rejected, so the UI prompts a fresh sign-in instead of stranding the
   * user in a signed-in state whose model requests all fail.
   * @param token - token captured by the rejected inference request.
   * @returns after matching credentials are removed and expiry is notified.
   */
  async rejectToken(token: string): Promise<void> {
    const lifetime = this.detailsLifetime
    const stored = await this.readCurrentGrant(lifetime)
    // Match the rejected value against the two stored credentials instead of guessing from its shape:
    // a key that is not the grant is the independently revocable language key.
    const speech = await this.ctx.credentials.readRecord(SPEECH)
    const parsedSpeech = speech?.kind === 'grant' ? speechGrant.safeParse(speech.payload) : undefined
    const languageKey = parsedSpeech?.success === true
      && parsedSpeech.data.issuer === this.origin
      && parsedSpeech.data.key === token
    // A rejection names the credential the request used; logging only its role keeps the secret out of
    // the log while distinguishing an access token from the long-lived language key.
    console.error('[deepseek-account] rejectToken called', {
      tokenShape: languageKey ? 'language-key' : 'access-token',
      matchesStoredGrant: stored?.token === token,
    })
    // Model traffic authenticates exclusively with the language key and there is no silent refresh
    // path to mint another without signing in again. Leaving KEY intact after dropping SPEECH strands
    // the UI as "signed in" while every turn fails with ACCOUNT_SIGN_IN_REQUIRED, so expire the
    // session together with the revoked key.
    if (languageKey) {
      if (this.detailsLifetime !== lifetime || this.closed) return
      if (stored !== null) {
        await this.expireCredential(stored.token, lifetime)
      } else {
        await this.ctx.credentials.deleteRecord(SPEECH)
      }
      return
    }
    if (stored?.token !== token || this.detailsLifetime !== lifetime) return
    await this.expireCredential(token, lifetime)
  }

  private async expireCredential(token: string, lifetime: AbortController): Promise<void> {
    console.error('[deepseek-account] credential expired', { origin: this.origin })
    this.removing ??= (async () => {
      if (this.attempt !== undefined) await this.cancelSignIn(this.attempt.view.id)
      const record = await this.ctx.credentials.readRecord(KEY)
      if (this.closed || this.detailsLifetime !== lifetime || record?.kind !== 'grant') return this.getState()
      const current = grant.parse(record.payload)
      if (current.token !== token || current.issuer !== this.origin) return this.getState()
      await this.ctx.credentials.deleteRecord(KEY)
      // The model key belongs to the grant it was minted with, so it leaves with it.
      await this.ctx.credentials.deleteRecord(SPEECH)
      await this.ctx.credentials.deleteRecord(PROFILE)
      this.ctx.emit('deepseek-account/session-expired')
      this.attempt = undefined
      this.ctx.emit('deepseek-account/signed-out')
      this.changed('snapshot')
      return this.getState()
    })().finally(() => { this.removing = undefined })
    await this.removing
  }

  /**
   * Read existing login identity without creating a device or returning credentials.
   * @returns optional device/account identifiers and the provider's OS version string.
   */
  async getDeviceIdentity(): Promise<{ deviceId?: string; userId?: AccountUserId; osVersion: string }> {
    const [record, session] = await Promise.all([
      this.ctx.credentials.readRecord(DEVICE),
      this.getPlatformSession(),
    ])
    const parsed = record?.kind === 'grant' ? device.safeParse(record.payload) : undefined
    return {
      ...parsed?.success ? { deviceId: parsed.data.id } : {},
      ...session?.userId == null ? {} : { userId: session.userId },
      osVersion: deviceOsVersion(),
    }
  }

  /**
   * Read credentials for the configured embedded-page origin, bound to their account environment, and
   * pair them with the account ID from the last successful profile read; no profile request is made.
   * @returns a Host-only snapshot, or null while signed out or when the credential changed during the read.
   */
  async getPlatformSession(): Promise<PlatformSession | null> {
    const lifetime = this.detailsLifetime
    const stored = await this.readCurrentGrant(lifetime)
    if (stored === null || lifetime.signal.aborted) return null
    // Deployment headers only; the consuming client adds the identity of its own UI.
    const requestHeaders = { ...this.accountRequestHeaders }
    // Identity comes from the profile read for this same grant; an unknown ID requires disposable
    // browser storage. A replaced credential never publishes the account its predecessor named.
    return { origin: this.origin, token: stored.token,
      userId: this.lastProfile?.token === stored.token ? this.lastProfile.profile.value.id || null : null,
      ...(this.embeddedPageDist ? { embeddedPageDist: this.embeddedPageDist } : {}),
      usagePath: this.usagePath, topUpPath: this.topUpPath,
      requestHeaders }
  }

  private async readCurrentGrant(lifetime: AbortController): Promise<z.infer<typeof grant> | null> {
    if (this.closed) return null
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record === undefined || lifetime.signal.aborted) return null
    if (record.kind !== 'grant') throw new PlatformAuthError('storage')
    const parsed = grant.safeParse(record.payload)
    if (!parsed.success) throw new PlatformAuthError('storage')
    // A private origin override must never forward a grant issued by another environment.
    if (parsed.data.issuer !== this.origin) throw new PlatformAuthError('protocol')
    return parsed.data
  }

  /**
   * Resolve a credential only for the inference origin allowed by the provider.
   * @param url - actual request destination or API base URL.
   * @returns stored token, or undefined for other origins or a signed-out account.
   */
  async resolveToken(url: string): Promise<string | undefined> {
    if (this.closed || this.removing !== undefined) return undefined
    const destination = new URL(url)
    if (destination.origin !== this.inferenceOrigin || destination.username || destination.password) return undefined
    const record = await this.ctx.credentials.readRecord(KEY)
    if (record === undefined) return undefined
    if (record.kind !== 'grant') throw new PlatformAuthError('storage')
    const result = grant.safeParse(record.payload)
    if (!result.success) throw new PlatformAuthError('storage')
    // Development grants cannot authenticate production model or file requests.
    const issuer = new URL(result.data.issuer)
    if (result.data.token.startsWith('dsh_mock_')) return undefined
    if (this.inferenceOrigin === 'https://api.deepseek.com') {
      if (['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname)) return undefined
    } else if (issuer.origin !== this.origin) return undefined
    return result.data.token
  }

  /**
   * Read the long-lived language-model key issued by the utoken desktop exchange. It is the
   * credential for model and speech requests, kept apart from the 10-minute access token.
   * @param destination - actual request destination or API base URL; when supplied, only the
   * configured inference origin may receive the key.
   * @returns the `sk-`-prefixed key, or undefined while signed out, when the record was issued by
   * a different authorization origin, or when the destination is not the inference origin.
   */
  async resolveLanguageKey(destination?: string): Promise<string | undefined> {
    if (this.closed) return undefined
    // A key minted by this deployment only leaves for the configured inference origin, exactly like
    // the account access token: a profile that names another Messages baseURL must not carry it.
    if (destination !== undefined) {
      const url = new URL(destination)
      if (url.origin !== this.inferenceOrigin || url.username || url.password) {
        console.error('[deepseek-account] language key withheld for a foreign inference origin', {
          destination: url.origin, inferenceOrigin: this.inferenceOrigin,
        })
        return undefined
      }
    }
    const record = await this.ctx.credentials.readRecord(SPEECH)
    if (record === undefined) return undefined
    if (record.kind !== 'grant') throw new PlatformAuthError('storage')
    const parsed = speechGrant.safeParse(record.payload)
    if (!parsed.success) throw new PlatformAuthError('storage')
    if (parsed.data.issuer !== this.origin) return undefined
    return parsed.data.key
  }

  /**
   * Join an active attempt or start browser authorization.
   * @param client - identity of the requesting UI; a new attempt captures it, and joining retains the original attempt's identity.
   * @param callbackOrigin - browser-accessible loopback HTTP origin, including any SSH local port.
   * @param loginSource - initiating UI, used to return from a failed exchange.
   * @returns the initial snapshot without waiting for browser approval.
   */
  @Remote
  async startSignIn(client: AccountClientMetadata, callbackOrigin: string, loginSource: 'web' | 'desktop'): Promise<AccountView> {
    if (this.removing !== undefined) await this.removing
    const origin = loginOrigin(callbackOrigin)
    if (this.closed) throw new PlatformAuthError('protocol')
    if (this.attempt !== undefined && ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(this.attempt.view.phase)) {
      return this.getState()
    }
    const previous = this.attempt
    if (previous !== undefined) {
      await previous.done
      // Disposal can close the provider while the previous attempt settles.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (this.closed) throw new PlatformAuthError('protocol')
      if (this.attempt !== previous) return this.getState()
    }
    const attempt: Attempt = {
      origin, loginSource,
      locale: platformWireLocale(client.locale),
      clientHeaders: platformClientHeaders(this.platform, client),
      view: { id: randomUUID() as SignInAttemptId, phase: 'initializing' },
      controller: new AbortController(), done: Promise.resolve(), running: Promise.resolve(),
    }
    this.attempt = attempt
    attempt.done = this.ctx.authorization.begin({
      key: KEY, signal: attempt.controller.signal,
      interaction: { notify: () => undefined, prompt: () => Promise.reject(new PlatformAuthError('protocol')) },
    }).then((outcome) => {
      this.update(attempt, { phase: outcome.status === 'authorized' ? 'succeeded' : 'cancelled' })
      if (outcome.status === 'authorized') {
        // utoken has no post-authorization page, so the return tab shows its own confirmation and
        // closes itself instead of leaving the blank body a 204 renders.
        this.finishSucceededCallback(attempt)
      } else attempt.callback?.writeHead(204, { 'cache-control': 'no-store' }).end()
    }).catch((error: unknown) => {
      const code = error instanceof PlatformAuthError ? error.code : 'protocol'
      console.error('[deepseek-account] sign-in failed', { errorCode: code })
      this.update(attempt, { phase: code === 'expired' ? 'expired' : 'failed', errorCode: code })
      this.finishFailedCallback(attempt)
    }).then(async () => {
      // begin() may report cancellation before the HTTP work observes its signal.
      await attempt.running.catch(() => undefined)
      if (attempt.callback !== undefined) {
        await streamPromises.finished(attempt.callback, { cleanup: true }).catch(() => undefined)
      }
      // The callback route lives for the plugin lifetime, so a late return still gets an answer.
      attempt.state = undefined
      attempt.code = undefined
    })
    this.changed('snapshot')
    return this.getState()
  }

  /**
   * Cancel only the named attempt; committing attempts settle before returning.
   * @param attemptId - attempt identity from this Host.
   * @returns state after cancellation or an already-started commit.
   */
  @Remote
  async cancelSignIn(attemptId: SignInAttemptId): Promise<AccountView> {
    const attempt = this.attempt
    if (attempt?.view.id === attemptId) {
      if (attempt.view.phase !== 'committing') {
        attempt.controller.abort()
        this.ctx.authorization.cancel(KEY)
      }
      await attempt.done
    }
    return this.getState()
  }

  /**
   * Remove the local grant while retaining API keys; the provider revokes it in the background.
   * @param client - identity of the requesting UI, captured for the background revocation retries.
   * @returns the signed-out state after local removal; remote failures never restore the grant.
   */
  @Remote
  signOut(client: AccountClientMetadata): Promise<AccountView> {
    this.removing ??= (async () => {
      if (this.closed) throw new PlatformAuthError('protocol')
      if (this.attempt !== undefined) await this.cancelSignIn(this.attempt.view.id)
      const record = await this.ctx.credentials.readRecord(KEY)
      if (record !== undefined) {
        if (record.kind !== 'grant') throw new PlatformAuthError('storage')
        const parsed = grant.safeParse(record.payload)
        if (!parsed.success) throw new PlatformAuthError('storage')
        if (parsed.data.issuer !== this.origin) throw new PlatformAuthError('protocol')
        await this.ctx.credentials.deleteRecord(KEY)
        await this.ctx.credentials.deleteRecord(SPEECH)
        await this.ctx.credentials.deleteRecord(PROFILE)
        this.revoke(parsed.data.token, platformClientHeaders(this.platform, client))
      }
      this.attempt = undefined
      this.ctx.emit('deepseek-account/signed-out')
      this.changed('snapshot')
      return this.getState()
    })().finally(() => { this.removing = undefined })
    return this.removing
  }

  /**
   * Inspect running work before sign-out.
   * @returns whether a running task's latest request uses the account route; false when the optional agents service is absent.
   */
  @Remote
  hasRunningAccountTasks(): boolean {
    return this.ctx.get('agents')?.list().some(isRunningAccountTask) ?? false
  }

  /**
   * Subscribe to live credential expiry without replay.
   * @param signal - subscription lifetime; provider disposal also ends it.
   * @returns expiry notifications emitted during the subscription.
   */
  @Remote({ mode: 'stream' })
  async *watchExpiry(signal: AbortSignal): AsyncIterable<'session-expired'> {
    const lifetime = AbortSignal.any([signal, this.logoutLifetime.signal])
    let pending = 0
    let wake: (() => void) | undefined
    const stop = this.ctx.on('deepseek-account/session-expired', () => { pending++; wake?.() })
    const abort = (): void => { wake?.() }
    lifetime.addEventListener('abort', abort, { once: true })
    try {
      while (!lifetime.aborted) {
        if (pending > 0) { pending--; yield 'session-expired'; continue }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      stop()
      lifetime.removeEventListener('abort', abort)
    }
  }

  /**
   * Subscribe to ordered updates including a complete initial snapshot.
   * @param signal - subscription lifetime; ending it never cancels login.
   * @param includeIdentityChanges - also notify when cached Platform identity changes; defaults to false.
   * @returns complete state with snapshot or credentials-changed event type; credential changes take priority when updates coalesce.
   */
  watch(signal: AbortSignal, includeIdentityChanges: boolean = false): AsyncIterable<AccountUpdate> {
    return this.observeUpdates(signal, includeIdentityChanges)
  }

  /**
   * Stream account state without the Host-only identity subscription option.
   * @param signal - subscription lifetime.
   * @returns initial state, login progress, and credential-change updates.
   */
  @Remote({ name: 'watch', mode: 'stream' })
  watchState(signal: AbortSignal): AsyncIterable<AccountUpdate> {
    return this.observeUpdates(signal, false)
  }

  private async *observeUpdates(signal: AbortSignal, includeIdentityChanges: boolean): AsyncIterable<AccountUpdate> {
    let pending: AccountUpdate['type'] | undefined = 'snapshot'
    let wake: (() => void) | undefined
    const changed = (kind: 'snapshot' | 'credentials-changed' | 'identity'): void => {
      if (kind === 'identity' && !includeIdentityChanges) return
      if (kind === 'credentials-changed' || pending === undefined) {
        pending = kind === 'credentials-changed' ? kind : 'snapshot'
      }
      wake?.()
    }
    const abort = (): void => { wake?.() }
    this.listeners.add(changed)
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!this.closed && !signal.aborted) {
        if (pending !== undefined) {
          const type = pending
          pending = undefined
          const lifetime = this.detailsLifetime
          const state = await this.getState()
          // A credential write during the read owns the next event and its replacement state.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Abort or disposal can occur during the state read.
          if (lifetime !== this.detailsLifetime || signal.aborted || this.closed) continue
          yield { type, state }
          continue
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      this.listeners.delete(changed)
      signal.removeEventListener('abort', abort)
    }
  }

  private revoke(token: string, headers: Record<string, string>): void {
    if (this.closed) return
    const mode = this.platformAccountApis ? 'platform' : 'desktop'
    const revocation = revokeAccount(this.origin, token, this.logoutPolicy,
      this.logoutLifetime.signal, { ...this.requestHeaders, ...headers }, mode).finally(() => { this.revocations.delete(revocation) })
    this.revocations.add(revocation)
  }

  private invalidateDetails(): void {
    this.lastProfile = undefined
    this.detailsLifetime.abort()
    this.detailsLifetime = new AbortController()
  }

  private changed(kind: 'snapshot' | 'credentials-changed' | 'identity'): void {
    for (const listener of this.listeners) listener(kind)
  }

  private update(attempt: Attempt, value: Partial<SignInAttemptView>): void {
    const { authorizeUrl: _url, ...rest } = attempt.view
    attempt.view = { ...rest, ...value }
    this.changed('snapshot')
  }

  private async run(session: AuthorizationSession, attempt: Attempt): Promise<void> {
    const webServer = this.ctx.get('webServer')
    if (webServer === undefined) throw new PlatformAuthError('protocol')
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const code = Promise.withResolvers<string>()
    // The route installed for the plugin lifetime hands codes over through these fields; a
    // callback that arrives after this attempt settled is answered by the route itself.
    attempt.state = state
    attempt.code = code
    // Callback requests may precede initialization settlement; the rejection is observed immediately.
    void code.promise.catch(() => undefined)
    const deadline = new AbortController()
    const expiresAt = Date.now() + this.attemptTimeout
    const signal = AbortSignal.any([session.signal, deadline.signal])
    const timer = setTimeout(() =>{  deadline.abort() }, this.attemptTimeout)
    const abort = (): void => { code.reject(new PlatformAuthError('expired')) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      const redirectUri = desktopRedirectUri(attempt.origin)
      // utoken (new-api) serves the authorization page directly; no init round-trip.
      const authorizeUrl = desktopAuthorizeUrl(this.origin, redirectUri, state, challenge)
      this.update(attempt, { phase: 'waiting-browser', authorizeUrl, expiresAt })
      const receivedCode = await code.promise
      signal.throwIfAborted()
      this.update(attempt, { phase: 'exchanging' })
      const result = desktopToken.safeParse(await exchangeDesktopToken(
        this.origin, receivedCode, redirectUri, verifier,
        AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeout)]),
        { ...this.requestHeaders, ...attempt.clientHeaders }))
      if (!result.success) this.rejectPayload('desktop_token', result.error)
      if (Date.now() >= expiresAt) deadline.abort()
      signal.throwIfAborted()
      this.update(attempt, { phase: 'committing' })
      clearTimeout(timer)
      // The speech key outlives the 10-minute access token, so it is stored in its own record and
      // is never cleared by access-token expiry.
      try {
        await this.ctx.credentials.modifyRecord(SPEECH, () => Promise.resolve({
          kind: 'grant', payload: { version: 1, key: desktopLanguageKey(result.data), issuer: this.origin },
        }))
        await session.commit({ kind: 'grant', payload: { version: 1, token: result.data.access_token, issuer: this.origin } })
        // utoken returns the account snapshot on the exchange; persist it so the gateway profile
        // renders across restarts without the DeepSeek profile endpoint.
        const account = result.data.user
        if (account !== undefined) {
          const value: AccountDetails['profile'] = { status: 'ready', value: desktopProfile(account) }
          await this.ctx.credentials.modifyRecord(PROFILE, () => Promise.resolve({
            kind: 'grant', payload: { version: 1, issuer: this.origin, user: account },
          }))
          this.cacheProfile(result.data.access_token, value)
        }
      } catch { throw new PlatformAuthError('storage') }
    } catch (error) {
      if (deadline.signal.aborted) throw new PlatformAuthError('expired')
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      // begin() settles the browser response and removes only this attempt's callback listener.
    }
  }

  private rejectPayload(stage: string, error: z.ZodError): never {
    console.error('[deepseek-account] payload rejected', {
      stage, issues: error.issues.map(issue => ({
        path: issue.path, code: issue.code,
        receivedType: issue.input === null ? 'null' : Array.isArray(issue.input) ? 'array' : typeof issue.input,
      })),
    })
    throw new PlatformAuthError('protocol')
  }

  /**
   * Answer the desktop callback route for the plugin lifetime, so a return that outlives its
   * attempt still gets a readable page instead of the WebServer admission refusal. The route runs
   * ahead of admission — the return is a cross-site top-level navigation, which the browser-trust
   * fence rejects — and the CSRF state, not the Host header, decides which attempt a code belongs
   * to: loopback Host spellings and local port forwards must not silently detach a login.
   * @param ctx - owning plugin context; disposal removes the route.
   */
  private installCallbackRoute(ctx: Context): void {
    ctx.effect(() => ctx.on('webserver/request', async (req, res, next) => {
      let url: URL
      try { url = new URL(req.url ?? '/', 'http://127.0.0.1') } catch { await next(); return }
      if (url.pathname !== DESKTOP_CALLBACK_PATH) { await next(); return }
      const attempt = this.attempt
      const received = url.searchParams.get('state') ?? ''
      const expected = attempt?.state
      const stateMatches = expected !== undefined && Buffer.byteLength(received) === Buffer.byteLength(expected)
        && timingSafeEqual(Buffer.from(received), Buffer.from(expected))
      if (attempt === undefined || !stateMatches) {
        const reason = attempt === undefined ? 'no-attempt' : expected === undefined ? 'consumed' : 'state-mismatch'
        this.answerCallback(res, attempt, reason, req.headers.host)
        return
      }
      if (req.method !== 'GET' || url.searchParams.getAll('state').length !== 1) {
        this.answerCallback(res, attempt, 'malformed', req.headers.host)
        return
      }
      // A second arrival for the same attempt is a reload of the return page, not a new grant.
      if (attempt.callback !== undefined || attempt.view.phase !== 'waiting-browser' || attempt.code === undefined) {
        this.answerCallback(res, attempt, 'consumed', req.headers.host)
        return
      }
      const receivedCode = url.searchParams.get('code')
      // utoken reports a declined consent as error=access_denied with no code.
      if (url.searchParams.get('error') === 'access_denied' && receivedCode === null) {
        attempt.callback = res
        attempt.code.reject(new PlatformAuthError('expired'))
        return
      }
      if (receivedCode === null || receivedCode === '' || url.searchParams.getAll('code').length !== 1) {
        this.answerCallback(res, attempt, 'malformed', req.headers.host)
        return
      }
      attempt.callback = res
      attempt.code.resolve(receivedCode)
    }), 'account: desktop callback route')
  }

  /**
   * End one callback request the attempt cannot consume with a page a person can act on, and log
   * the classification so a rejected return is diagnosable without inspecting the browser.
   * @param res - the callback response, still unheadered.
   * @param attempt - active attempt when one exists; supplies the page language.
   * @param reason - why the return could not be consumed.
   * @param host - request authority, logged only to expose port-forward or host-spelling drift.
   */
  private answerCallback(res: ServerResponse, attempt: Attempt | undefined, reason: string, host: string | undefined): void {
    const locale = attempt?.locale ?? 'zh_CN'
    const phase = attempt?.view.phase ?? 'none'
    console.error('[deepseek-account] desktop callback rejected', { reason, phase, host })
    const message = locale === 'zh_CN'
      ? '登录会话已失效，请关闭此标签页，回到云大师 Agent 重新登录。'
      : 'This sign-in session has expired. Close this tab and start sign-in again in Yundashi Agent.'
    const nonce = randomBytes(16).toString('base64url')
    res.writeHead(400, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`,
      'referrer-policy': 'no-referrer',
    }).end(`<!doctype html><html lang="${locale === 'zh_CN' ? 'zh-CN' : 'en'}"><meta charset="utf-8">`
      + `<title>${message}</title><body><p>${message}</p>`
      + `<p style="color:#888;font-size:12px">${reason}</p><script nonce="${nonce}">window.close()</script></body></html>`)
  }

  /**
   * Close out a successful Web return with the confirmation the browser tab can read, then let the
   * tab retire itself; the application tab owns the signed-in state.
   * @param attempt - attempt whose callback response is still open.
   */
  private finishSucceededCallback(attempt: Attempt): void {
    const nonce = randomBytes(16).toString('base64url')
    const message = attempt.locale === 'zh_CN' ? '登录成功，可以关闭此标签页。'
      : 'Signed in. You can close this tab.'
    attempt.callback?.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`,
      'referrer-policy': 'no-referrer',
    }).end(`<!doctype html><html lang="${attempt.locale === 'zh_CN' ? 'zh-CN' : 'en'}"><meta charset="utf-8"><title>${message}</title>`
      + `<body><p>${message}</p><script nonce="${nonce}">window.close()</script></body></html>`)
  }

  private finishFailedCallback(attempt: Attempt): void {
    if (attempt.loginSource === 'web') {
      const nonce = randomBytes(16).toString('base64url')
      const message = attempt.locale === 'zh_CN' ? '登录失败，请关闭此标签页并在原页面重试。'
        : 'Sign-in failed. Close this tab and try again in the original tab.'
      attempt.callback?.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`,
        'referrer-policy': 'no-referrer',
      }).end(`<!doctype html><html lang="${attempt.locale === 'zh_CN' ? 'zh-CN' : 'en'}"><meta charset="utf-8"><title>${message}</title>`
        + `<body><p>${message}</p><script nonce="${nonce}">window.close()</script></body></html>`)
    } else {
      // Native account subscribers focus the login window; retain the browser’s Platform document.
      attempt.callback?.writeHead(204, { 'cache-control': 'no-store' }).end()
    }
  }
}
export default DeepSeekAccount

/** OS identification shared by login and credential-free identity reads. */
function deviceOsVersion(): string {
  return `${platform()} ${release()}`
}
