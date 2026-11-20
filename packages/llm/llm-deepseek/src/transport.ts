/** Normalize HTTP and in-band Messages errors into provider-neutral failures. */

import { brandString } from '@deepseek-ai/dsh-brand'
import { isAuthenticationFailure, isContextWindowExceededError, isQuotaExceededError, LlmError, PROVIDER_REJECTED_CODE, type ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type { BuiltinLlmFailureCode } from '@deepseek-ai/dsh-llm'

/** Read only provider error fields used by bounded Files recovery.
 * @param raw - decoded HTTP error response.
 * @returns code, type, and message text, without unrelated response fields.
 */
export function providerErrorDetail(raw: unknown): string {
  const error = typeof raw === 'object' && raw !== null && 'error' in raw ? raw.error : undefined
  if (typeof error !== 'object' || error === null) return ''
  const fields = error as Record<string, unknown>
  return [fields.code, fields.type, fields.message].filter((value): value is string => typeof value === 'string').join(' ')
}

const GATEWAY_QUOTA_PATTERNS = [
  /用户额度不足|预扣费额度失败|订阅额度不足|子额度上限/u,
  /insufficient[\s_-]+(?:user|token)[\s_-]+quota/i,
  /subscription quota insufficient|organization (?:member )?quota/i,
] as const

function isGatewayQuotaRejection(providerCode: string, detail: string): boolean {
  return providerCode === 'insufficient_user_quota'
    || providerCode === 'pre_consume_token_quota_failed'
    || GATEWAY_QUOTA_PATTERNS.some(pattern => pattern.test(detail))
}

/** Classify a provider error without trusting arbitrary response fields.
 * @param raw - decoded response or in-band error event.
 * @param status - HTTP status when the error preceded streaming.
 * @param headers - response headers for retry delay and request identity.
 * @returns a stable error consumed by LlmRuntime and llm-retry.
 */
export function providerError(raw: unknown, status: number | undefined, headers?: Headers): LlmError {
  const envelope = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const error = typeof envelope.error === 'object' && envelope.error !== null ? envelope.error as Record<string, unknown> : {}
  const message = typeof error.message === 'string' ? error.message : `DeepSeek Messages request failed (${status ?? 'stream error'})`
  const type = typeof error.type === 'string' ? error.type : ''
  const detail = `${type} ${typeof error.code === 'string' ? error.code : ''} ${message}`
  let code: BuiltinLlmFailureCode
  const providerCode = typeof error.code === 'string' ? error.code : ''
  // utoken reports exhausted wallet, subscription, org pool, or token quotas with HTTP 403.
  // Its /v1/messages body carries only the localized message (no `code`), so match the text too.
  if (isGatewayQuotaRejection(providerCode, detail)) code = 'INSUFFICIENT_QUOTA'
  else if (isAuthenticationFailure(status, type, providerCode)) code = 'AUTH'
  else if (isQuotaExceededError(detail) || status === 402) code = 'QUOTA'
  else if (status === 429 || type === 'rate_limit_error') code = 'RATE_LIMIT'
  else if (isContextWindowExceededError(detail)) code = 'CONTEXT_WINDOW_EXCEEDED'
  else if (status === 400 || status === 413 || type === 'invalid_request_error') code = 'INVALID_REQUEST'
  else if ((status !== undefined && status >= 500) || ['api_error', 'overloaded_error'].includes(type)) code = 'SERVER'
  else if (status !== undefined && status >= 400 && status < 500) code = PROVIDER_REJECTED_CODE
  else code = status === undefined ? 'SERVER' : `HTTP_${status}`
  const retry = headers?.get('retry-after')
  const delay = retry == null ? NaN : /^\d+(?:\.\d+)?$/u.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()
  const id = headers?.get('request-id') ?? headers?.get('x-request-id') ?? headers?.get('x-deepseek-request-id')
  return new LlmError(message, code, {
    ...status === undefined ? {} : { status },
    ...id ? { requestId: brandString<ProviderRequestId>(id) } : {},
    ...Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {},
  })
}
