/** Client-supplied request identity and client-safe account state; credentials never cross this projection. */
import type {} from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Identity of the requesting UI for one account operation; the Host derives Platform request headers from it. */
export interface AccountClientMetadata {
  readonly version: string
  /** Active UI language; only its primary subtag selects the Platform wire locale. */
  readonly locale: string
  /** Offset from UTC in seconds, positive east of Greenwich. */
  readonly timezoneOffsetSeconds: number
}

/** Identity of one local login attempt, unrelated to the platform request ID. */
export type SignInAttemptId = Branded<'SignInAttemptId'>
/**
 * Safe failure codes rendered through the caller's locale dictionary.
 * `no-response`: fetch returned no Response; `network`: HTTP or account-detail retrieval failure.
 * `protocol`: invalid response or authorization data; `expired`: authorization expired;
 * `storage`: local credential access or commit failed.
 */
export type SignInErrorCode = 'no-response' | 'network' | 'protocol' | 'expired' | 'storage'
/** Latest login attempt, including terminal outcomes until the next attempt. */
export interface SignInAttemptView {
  readonly id: SignInAttemptId
  readonly phase: 'initializing' | 'waiting-browser' | 'exchanging' | 'committing' | 'succeeded' | 'cancelled' | 'expired' | 'failed'
  readonly authorizeUrl?: string
  readonly expiresAt?: number
  readonly errorCode?: SignInErrorCode
}
/** Browser destinations derived from the Host's platform configuration; never carry tokens. */
export interface AccountLinks {
  readonly usageUrl: string
  readonly topUpUrl: string
}
/** Stored-account presence is not a claim that the server has validated its token. */
export interface AccountView {
  readonly status: 'signed-out' | 'credential-stored'
  readonly links: AccountLinks
  readonly attempt: SignInAttemptView | null
}

/** Ordered account stream item; every item carries the latest safe state. */
export interface AccountUpdate {
  /** Initial state and progress use snapshot; credential writes and removal use credentials-changed. */
  readonly type: 'snapshot' | 'credentials-changed'
  readonly state: AccountView
}

/** Platform account identifier supplied by the current-user endpoint. */
export type AccountUserId = Branded<'AccountUserId'>
/** Display identity; contacts retain Platform masking. */
export interface AccountProfile {
  readonly id: AccountUserId | null
  readonly name: string | null
  readonly contact: string | null
  /** Profile image URL supplied by Platform, absent when no picture is configured. */
  readonly avatarUrl?: string | null
  /** Login account from the utoken desktop exchange; absent on the official Platform profile. */
  readonly username?: string
  /** utoken role: 1 regular user, 10 administrator, 100 super administrator. */
  readonly role?: number
  /** utoken billing group deciding model multipliers. */
  readonly group?: string
}
/** Platform recharge or bonus wallet balance; decimal strings retain server precision. */
export interface AccountWallet {
  readonly currency: 'CNY' | 'USD'
  readonly balance: string
}
/** Active gateway subscription quota returned by utoken desktop balance queries. */
export interface AccountSubscription {
  readonly subscriptionId: number
  readonly planId: number
  /** Optional display title supplied by newer gateway versions. */
  readonly planTitle?: string
  readonly totalPoints: string
  readonly usedPoints: string
  readonly remainingPoints: string
  readonly unlimited: boolean
  /** Unix timestamp in seconds when the subscription expires. */
  readonly endTime: number
}
/** Independent query outcomes allow profile and balance failures to render separately. */
export interface AccountDetails {
  readonly profile: { readonly status: 'ready'; readonly value: AccountProfile } | { readonly status: 'failed' }
  readonly balance: {
    readonly status: 'ready'
    readonly value: readonly AccountWallet[]
    readonly bonusWallets: readonly AccountWallet[]
    /** Active gateway subscriptions; absent on DeepSeek Platform balances. */
    readonly subscriptions?: readonly AccountSubscription[]
  } | { readonly status: 'failed' }
}

/** Query parameters for utoken desktop usage logs (`GET /api/desktop/usage-logs`). */
export interface AccountUsageLogsQuery {
  readonly page?: number
  readonly pageSize?: number
  readonly startTimestamp?: number
  readonly endTimestamp?: number
  readonly modelName?: string
}

/** One model consume or error log entry returned by utoken desktop usage logs. */
export interface AccountUsageLogItem {
  readonly id: number
  /** Unix timestamp in seconds. */
  readonly createdAt: number
  readonly modelName: string
  /** 2 = consume, 5 = model error. */
  readonly type: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly quota: number
  readonly subscriptionQuota: number
  readonly tokenName: string
  readonly requestId: string
  readonly httpStatus: number
  /** Duration in seconds. */
  readonly useTime: number
  readonly isStream: boolean
  readonly cacheHit: boolean
  readonly taskSettle: boolean
}

/** Paginated usage logs envelope returned by utoken desktop usage logs. */
export interface AccountUsageLogsPage {
  readonly page: number
  readonly pageSize: number
  readonly total: number
  readonly items: readonly AccountUsageLogItem[]
}

/** Independent query outcome for desktop usage logs. */
export type AccountUsageLogsResult =
  | { readonly status: 'ready'; readonly value: AccountUsageLogsPage }
  | { readonly status: 'failed' }

/** Query parameters for listing utoken cloud conversations (`GET /api/conversations`). */
export interface AccountConversationsQuery {
  readonly offset?: number
  readonly limit?: number
}

/** One cloud conversation summary returned by utoken. */
export interface AccountConversationSummary {
  readonly id: string
  readonly title: string
  readonly revision: number
  readonly createTime: string
  readonly updateTime: string
}

/** Paginated cloud conversations envelope returned by utoken. */
export interface AccountConversationsPage {
  readonly items: readonly AccountConversationSummary[]
  readonly hasMore: boolean
}

/** Independent query outcome for listing cloud conversations. */
export type AccountConversationsResult =
  | { readonly status: 'ready'; readonly value: AccountConversationsPage }
  | { readonly status: 'failed' }

/** Query parameters for reading one cloud conversation's messages (`GET /api/conversations/{id}/messages`). */
export interface AccountConversationMessagesQuery {
  readonly before?: number
  readonly revision?: number
  readonly limit?: number
}

/** One structured cloud conversation message. */
export interface AccountConversationMessage {
  readonly id: string
  readonly sequence: number
  readonly payload: Record<string, JsonValue>
}

/** Paginated cloud conversation messages envelope returned by utoken. */
export interface AccountConversationMessagesPage {
  readonly revision: number
  readonly items: readonly AccountConversationMessage[]
  readonly hasMore: boolean
}

/** Independent query outcome for reading cloud conversation messages. */
export type AccountConversationMessagesResult =
  | { readonly status: 'ready'; readonly value: AccountConversationMessagesPage }
  | { readonly status: 'failed' }

/** One message payload item submitted in a conversation patch. */
export interface AccountConversationPatchMessage {
  readonly id: string
  readonly payload: Record<string, JsonValue>
}

/** Idempotent revisioned patch body for `PATCH /api/conversations/{id}`. */
export interface AccountConversationPatchInput {
  readonly revision: number
  readonly mutationId: string
  readonly title: string
  readonly messages: readonly AccountConversationPatchMessage[]
  readonly deletedIds: readonly string[]
}

/** Outcome of patching a cloud conversation; `conflict` indicates HTTP 409 stale revision or mutation collision. */
export type AccountConversationPatchResult =
  | { readonly status: 'ready'; readonly value: AccountConversationSummary }
  | { readonly status: 'conflict' }
  | { readonly status: 'failed' }

/** Opaque string notification identity; stable across devices, sign-ins, and languages. */
export type AccountNotificationId = Branded<'AccountNotificationId'>
/** Presentation, any non-dismiss action click, or explicit dismissal; independent of backend consumption. */
export type AccountNotificationEvent = 'displayed' | 'cta_clicked' | 'dismissed'
/** Client action supported by the account notification presentation. */
export interface AccountNotificationAction {
  readonly label: string
  readonly style: 'primary' | 'secondary'
  readonly target: { readonly type: 'app_route'; readonly name: 'account' } | { readonly type: 'dismiss' }
}
/** One account notification with server-localized plain text and actions. */
export interface AccountNotification {
  readonly id: AccountNotificationId
  readonly createdAt: string
  /** Display deadline; null means the notification never expires. */
  readonly displayUntil: string | null
  readonly title: string
  readonly body: string
  readonly actions: readonly AccountNotificationAction[]
  /** Optional business data, retained independently of the localized copy. */
  readonly data?: JsonValue
}
/** Unconsumed notifications in server order, without account-profile data. */
export interface AccountNotificationBatch {
  /** Positive delay in seconds before querying again, within the browser timer range. */
  readonly nextPollAfterSeconds: number
  readonly notifications: readonly AccountNotification[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Server rejection removed the current account credential; this notification is not replayed.
     * @mode emit
     */
    'deepseek-account/session-expired'(): void
    /** An account model request requires the user to sign in.
     * @mode emit
     */
    'deepseek-account/model-sign-in-required'(): void
  }
}

/** Host-only credentials for an embedded Platform document; never expose through account RPC. */
export interface PlatformSession {
  readonly origin: string
  readonly token: string
  /** Stable issuer account ID from the last successful profile read; null requires disposable browser storage. */
  readonly userId: AccountUserId | null
  /** Optional dist query value selecting the embedded frontend deployment. */
  readonly embeddedPageDist?: string
  /** Path of the usage page on `origin`; absent means the official `/usage`. */
  readonly usagePath?: string
  /** Path of the top-up page on `origin`; absent means the official `/top_up`. */
  readonly topUpPath?: string
  /** Host-only deployment request headers; the consuming client adds its own dynamic identity, and neither reaches renderer bootstrap. */
  readonly requestHeaders?: Readonly<Record<string, string>>
}
