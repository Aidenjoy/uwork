/** Platform Web profile and wallet queries projected for account UI consumers. */
import { z } from 'zod'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  AccountConversationMessagesQuery, AccountConversationMessagesResult, AccountConversationPatchInput,
  AccountConversationPatchResult, AccountConversationsQuery, AccountConversationsResult,
  AccountDetails, AccountProfile, AccountUsageLogsQuery, AccountUsageLogsResult, AccountUserId,
} from './types.ts'
import {
  AccountUnauthorizedError, DesktopConflictError, PlatformAuthError,
  patchDesktopConversation, requestAccount, requestDesktopBalance,
  requestDesktopConversationMessages, requestDesktopConversations, requestDesktopUsageLogs,
} from './protocol.ts'

const user = z.object({
  id: z.string().nullish(),
  email: z.string(), mobile: z.string().optional(), mobile_number: z.string().optional(),
  id_profile: z.object({ name: z.string().nullable(), picture: z.string().nullish() }).nullish(),
})
// balance and amount arrive as strings that Platform's Web client passes to big.js, whose decimal
// grammar also accepts an omitted integer or fraction part and a decimal exponent (0E-16, 1e+3).
const decimal = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
const numericString = z.union([
  z.number().transform(value => String(value)),
  z.string().regex(decimal),
])
const desktopSubscription = z.object({
  subscription_id: z.number().int(),
  plan_id: z.number().int(),
  plan_title: z.string().nullish(),
  total_points: numericString,
  used_points: numericString,
  remaining_points: numericString,
  unlimited: z.boolean(),
  end_time: z.number().int(),
})
const desktopBalanceEnvelope = z.object({
  success: z.literal(true),
  data: z.object({
    user_id: z.number().int().optional(),
    wallet_balance: numericString,
    wallet_quota: z.number().optional(),
    quota_display_type: z.string().nullish(),
    subscriptions: z.array(desktopSubscription).nullish(),
  }),
})
const desktopUsageLogItem = z.object({
  id: z.number().int(),
  created_at: z.number().int(),
  model_name: z.string(),
  type: z.number().int(),
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  quota: z.number().int(),
  subscription_quota: z.number().int(),
  token_name: z.string(),
  request_id: z.string(),
  http_status: z.number().int(),
  use_time: z.number().int(),
  is_stream: z.boolean(),
  cache_hit: z.boolean(),
  task_settle: z.boolean(),
})
const desktopUsageLogsEnvelope = z.object({
  success: z.literal(true),
  message: z.string().optional(),
  data: z.object({
    page: z.number().int(),
    page_size: z.number().int(),
    total: z.number().int(),
    items: z.array(desktopUsageLogItem).nullish(),
  }),
})
const desktopConversationSummary = z.object({
  id: z.string(),
  title: z.string(),
  revision: z.number().int(),
  create_time: z.string(),
  update_time: z.string(),
})
const desktopConversationsEnvelope = z.object({
  success: z.literal(true),
  message: z.string().optional(),
  data: z.object({
    items: z.array(desktopConversationSummary).nullish(),
    has_more: z.boolean(),
  }),
})
const desktopConversationMessage = z.object({
  id: z.string(),
  sequence: z.number().int(),
  payload: z.record(z.string(), z.unknown()),
})
const desktopConversationMessagesEnvelope = z.object({
  success: z.literal(true),
  message: z.string().optional(),
  data: z.object({
    revision: z.number().int(),
    items: z.array(desktopConversationMessage).nullish(),
    has_more: z.boolean(),
  }),
})
const desktopConversationPatchEnvelope = z.object({
  success: z.literal(true),
  message: z.string().optional(),
  data: desktopConversationSummary,
})
const wallet = z.object({
  currency: z.enum(['CNY', 'USD']), balance: z.string().regex(decimal),
})
const summary = z.object({ normal_wallets: z.array(wallet), bonus_wallets: z.array(wallet) })
/** Project Platform user data without retaining credentials or unneeded fields.
 * @param value - current or exchange user response.
 * @returns UI account profile.
 */
export function profile(value: unknown): AccountProfile {
  const parsed = user.safeParse(value)
  if (!parsed.success) throw new PlatformAuthError('protocol')
  return projectProfile(parsed.data)
}

function projectProfile(value: z.infer<typeof user>): AccountProfile {
  const { email, mobile, mobile_number: mobileNumber, id_profile: identity } = value
  return {
    id: value.id == null ? null : value.id as AccountUserId,
    avatarUrl: identity?.picture || null,
    name: identity?.name || null, contact: mobile || mobileNumber || email || null,
  }
}

function accountPayload<T>(schema: z.ZodType<T>, value: unknown, field: 'profile' | 'balance' | 'usage-logs' | 'conversations'): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    console.error(`[deepseek-account] ${field} schema rejected`, {
      issues: parsed.error.issues.map(issue => ({ path: issue.path, code: issue.code })),
    })
    throw new PlatformAuthError('protocol')
  }
  return parsed.data
}

const queries: { [K in keyof AccountDetails]: {
  path: '/auth-api/v0/users/current' | '/api/v0/users/get_user_summary'
  parse: (value: unknown) => AccountDetails[K]
} } = {
  profile: { path: '/auth-api/v0/users/current', parse: value => ({
    status: 'ready', value: projectProfile(accountPayload(user, value, 'profile')),
  }) },
  balance: { path: '/api/v0/users/get_user_summary', parse: (value) => {
    const parsed = accountPayload(summary, value, 'balance')
    return { status: 'ready', value: parsed.normal_wallets, bonusWallets: parsed.bonus_wallets }
  } },
}

/**
 * Read one Platform account field without waiting for the other query.
 * @param field - profile or recharge and bonus wallet balances.
 * @param origin - configured account API origin.
 * @param token - stored authorization token; response tokens are discarded.
 * @param signal - request and credential lifetime.
 * @param headers - validated deployment headers for the configured origin.
 * @returns sanitized query outcome; failure never becomes a zero balance.
 * @throws AccountUnauthorizedError when Platform rejects the stored token with HTTP 401 or response code 40003.
 */
export async function readAccountDetail<K extends keyof AccountDetails>(field: K, origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<AccountDetails[K]> {
  const query = queries[field]
  try { return query.parse(await requestAccount(origin, query.path, token, signal, headers)) }
  catch (error) {
    if (error instanceof AccountUnauthorizedError) throw error
    return { status: 'failed' }
  }
}

/**
 * Read utoken desktop wallet balance and active subscription points without mutating login state on HTTP 401.
 * @param origin - configured account API origin.
 * @param token - stored desktop access token (`Bearer`).
 * @param signal - request and credential lifetime.
 * @param headers - validated deployment headers for this origin.
 * @returns normalized wallet and subscription balance, or `{ status: 'failed' }` when unavailable.
 */
export async function readDesktopBalance(origin: string, token: string,
  signal: AbortSignal, headers: Record<string, string>): Promise<AccountDetails['balance']> {
  try {
    const raw = await requestDesktopBalance(origin, token, signal, headers)
    const parsed = accountPayload(desktopBalanceEnvelope, raw, 'balance')
    // utoken desktop wallet_balance is already site-converted RMB regardless of quota_display_type.
    return {
      status: 'ready',
      value: [{ currency: 'CNY', balance: parsed.data.wallet_balance }],
      bonusWallets: [],
      subscriptions: (parsed.data.subscriptions ?? []).map(item => ({
        subscriptionId: item.subscription_id,
        planId: item.plan_id,
        ...item.plan_title ? { planTitle: item.plan_title } : {},
        totalPoints: item.total_points,
        usedPoints: item.used_points,
        remainingPoints: item.remaining_points,
        unlimited: item.unlimited,
        endTime: item.end_time,
      })),
    }
  } catch (_error) {
    // Keep active sessions alive when the desktop access token expires ahead of the long-lived language key.
    return { status: 'failed' }
  }
}

/**
 * Read utoken desktop model usage logs without mutating login state on HTTP 401.
 * @param origin - configured account API origin.
 * @param token - stored desktop access token (`Bearer`).
 * @param query - pagination and filter parameters.
 * @param signal - request and credential lifetime.
 * @param headers - validated deployment headers for this origin.
 * @returns normalized usage logs page, or `{ status: 'failed' }` when unavailable.
 */
export async function readDesktopUsageLogs(origin: string, token: string, query: AccountUsageLogsQuery,
  signal: AbortSignal, headers: Record<string, string>): Promise<AccountUsageLogsResult> {
  try {
    const raw = await requestDesktopUsageLogs(origin, token, query, signal, headers)
    const parsed = accountPayload(desktopUsageLogsEnvelope, raw, 'usage-logs')
    return {
      status: 'ready',
      value: {
        page: parsed.data.page,
        pageSize: parsed.data.page_size,
        total: parsed.data.total,
        items: (parsed.data.items ?? []).map(item => ({
          id: item.id,
          createdAt: item.created_at,
          modelName: item.model_name,
          type: item.type,
          promptTokens: item.prompt_tokens,
          completionTokens: item.completion_tokens,
          quota: item.quota,
          subscriptionQuota: item.subscription_quota,
          tokenName: item.token_name,
          requestId: item.request_id,
          httpStatus: item.http_status,
          useTime: item.use_time,
          isStream: item.is_stream,
          cacheHit: item.cache_hit,
          taskSettle: item.task_settle,
        })),
      },
    }
  } catch (_error) {
    return { status: 'failed' }
  }
}

function projectConversationSummary(item: z.infer<typeof desktopConversationSummary>) {
  return {
    id: item.id,
    title: item.title,
    revision: item.revision,
    createTime: item.create_time,
    updateTime: item.update_time,
  }
}

/**
 * Read paginated utoken cloud conversations without mutating login state on HTTP 401.
 * @param origin - configured account API origin.
 * @param token - stored desktop access token (`Bearer`).
 * @param query - offset and limit parameters.
 * @param signal - request and credential lifetime.
 * @param headers - validated deployment headers for this origin.
 * @returns normalized conversation list page, or `{ status: 'failed' }` when unavailable.
 */
export async function readDesktopConversations(origin: string, token: string, query: AccountConversationsQuery,
  signal: AbortSignal, headers: Record<string, string>): Promise<AccountConversationsResult> {
  try {
    const raw = await requestDesktopConversations(origin, token, query, signal, headers)
    const parsed = accountPayload(desktopConversationsEnvelope, raw, 'conversations')
    return {
      status: 'ready',
      value: {
        items: (parsed.data.items ?? []).map(projectConversationSummary),
        hasMore: parsed.data.has_more,
      },
    }
  } catch (_error) {
    return { status: 'failed' }
  }
}

/**
 * Read paginated structured messages for one utoken cloud conversation without mutating login state on HTTP 401.
 * @param origin - configured account API origin.
 * @param token - stored desktop access token (`Bearer`).
 * @param id - conversation identifier.
 * @param query - optional `before`, `revision`, and `limit` parameters.
 * @param signal - request and credential lifetime.
 * @param headers - validated deployment headers for this origin.
 * @returns normalized message page, or `{ status: 'failed' }` when unavailable.
 */
export async function readDesktopConversationMessages(origin: string, token: string, id: string,
  query: AccountConversationMessagesQuery, signal: AbortSignal,
  headers: Record<string, string>): Promise<AccountConversationMessagesResult> {
  try {
    const raw = await requestDesktopConversationMessages(origin, token, id, query, signal, headers)
    const parsed = accountPayload(desktopConversationMessagesEnvelope, raw, 'conversations')
    return {
      status: 'ready',
      value: {
        revision: parsed.data.revision,
        items: (parsed.data.items ?? []).map(item => ({
          id: item.id,
          sequence: item.sequence,
          payload: item.payload as Record<string, JsonValue>,
        })),
        hasMore: parsed.data.has_more,
      },
    }
  } catch (_error) {
    return { status: 'failed' }
  }
}

/**
 * Apply one idempotent revisioned patch to a utoken cloud conversation.
 * @param origin - configured account API origin.
 * @param token - stored desktop access token (`Bearer`).
 * @param id - conversation identifier.
 * @param input - revision, mutation_id, title, messages, and deleted_ids.
 * @param signal - request and credential lifetime.
 * @param headers - validated deployment headers for this origin.
 * @returns updated conversation metadata, `conflict` on HTTP 409, or `failed` on other errors.
 */
export async function writeDesktopConversation(origin: string, token: string, id: string,
  input: AccountConversationPatchInput, signal: AbortSignal,
  headers: Record<string, string>): Promise<AccountConversationPatchResult> {
  try {
    const raw = await patchDesktopConversation(origin, token, id, input, signal, headers)
    const parsed = accountPayload(desktopConversationPatchEnvelope, raw, 'conversations')
    return { status: 'ready', value: projectConversationSummary(parsed.data) }
  } catch (error) {
    if (error instanceof DesktopConflictError) return { status: 'conflict' }
    return { status: 'failed' }
  }
}
