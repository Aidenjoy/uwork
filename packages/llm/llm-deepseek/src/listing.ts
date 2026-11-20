/** DeepSeek `GET /models` listing: one authenticated request and per-entry decoding. */
import { APP_IDENTITY, attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmModelBadge, LlmModelBadgeTone, ModelModality } from '@deepseek-ai/dsh-llm'
import { timeoutOf } from '@deepseek-ai/dsh-timeout'

const LISTED_MODALITIES = ['text', 'image'] as const satisfies readonly ModelModality[]
const BADGE_TONES = ['neutral', 'info', 'success', 'warning'] as const satisfies readonly LlmModelBadgeTone[]
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u
const UNREADABLE_BADGE_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u
const VISIBLE_BADGE_CHARACTER = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}]/u
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Longest badge text this build displays, in user-perceived characters, for every translation. */
export const MAX_BADGE_TEXT_LENGTH = 12

/** Code of a listing deadline's timeout reason; {@link requestModelListing} reports it as `TIMEOUT`. */
export const LISTING_TIMEOUT = 'MODEL_LISTING_TIMEOUT'

/** Endpoint types a gateway must declare before this build chats with one of its models. */
const GATEWAY_ENDPOINT_TYPES = ['anthropic', 'openai'] as const

/**
 * The listing endpoint of a Messages root.
 * A version root (`/v1`, or none at all) lists beneath itself; a provider segment such as
 * `/anthropic` belongs to Messages only, so its listing stays at the origin.
 * @param baseURL - Messages `baseURL`.
 * @returns `/models` at the only origin that receives the route's credential.
 */
export function modelListingURL(baseURL: string): string {
  const root = new URL(baseURL)
  const path = root.pathname.replace(/\/+$/u, '')
  return path === '' || path === '/v1' ? `${root.origin}/v1/models` : `${root.origin}/models`
}

/**
 * The compact model listing of a gateway, whose endpoint sits at the origin root.
 * A version or provider path in the Messages `baseURL` belongs to Messages only, so the
 * listing always uses the origin that receives this route's credential. Redirects are
 * refused by {@link requestModelListing}, exactly as for the full listing.
 * @param baseURL - Messages `baseURL`.
 * @returns `/v1/modelsinfo?type=text` at that origin.
 */
export function gatewayModelListingURL(baseURL: string): string {
  return `${new URL(baseURL).origin}/v1/modelsinfo?type=text`
}

/** The requirement one listing entry declares under this client's product token. */
export type ClientRequirement =
  | { readonly kind: 'none' }
  | { readonly kind: 'min-version'; readonly version: string }
  | { readonly kind: 'invalid' }

/** Capabilities a usable listing entry declares, in catalog vocabulary. */
export interface ListedFacts {
  /** Accepted request modalities this build sends. */
  readonly inputModalities: readonly ModelModality[]
  /** Combined request and response context, when declared. */
  readonly contextWindow?: number
  /** Output capability, when declared. */
  readonly maxOutputTokens?: number
  /** Messages system prompt mode, when declared; any value other than `in-history` reads as `leading-only`. */
  readonly systemPromptUpdate?: 'in-history' | 'leading-only'
  /** Messages tool update mode, when declared; any value other than `in-history` or `addition-only` reads as `leading-only`. */
  readonly toolUpdate?: 'in-history' | 'addition-only' | 'leading-only'
}

/** A badge one listing entry declares, or why this build cannot display it. */
export type ListedBadge =
  | { readonly kind: 'badge'; readonly badge: LlmModelBadge }
  | { readonly kind: 'invalid'; readonly reason: string }

/** Declared capabilities, or why the Messages transport cannot drive the model. */
export type ListedCapabilities =
  | { readonly usable: true; readonly facts: ListedFacts }
  | { readonly usable: false; readonly reason: string }

/** One decoded listing entry; unusable capabilities never hide its id, name, or requirement. */
export interface ListingEntry {
  /** Wire model id. */
  readonly id: string
  /** Display name, when the entry declares a non-empty one. */
  readonly name?: string
  /** Requirement declared under `client_requirements[APP_IDENTITY.product]`. */
  readonly requirement: ClientRequirement
  /** Whether the entry declared `api_capabilities`, which DeepSeek's own catalog always does. */
  readonly selfDescribed: boolean
  /** Declared capabilities. */
  readonly capabilities: ListedCapabilities
  /**
   * Selector badge declared under `client_metadata[APP_IDENTITY.product].badge`; absent when the
   * entry declares none, and never a reason to hide the entry.
   */
  readonly badge?: ListedBadge
}

/** A decoded listing with at least one entry. */
export interface ModelListing {
  /** Entries in listing order. */
  readonly entries: readonly ListingEntry[]
  /** Rows without a usable id, and repeated ids. */
  readonly skipped: number
  /**
   * Whether this listing came from a gateway rather than DeepSeek's catalog: no entry declares
   * `api_capabilities`, and every entry declares either `supported_endpoint_types` or the compact
   * `type: "text"` model kind. Such a listing is the authority on which models exist, so it is
   * offered as listed.
   */
  readonly gateway: boolean
}

type Fields = Readonly<Record<string, unknown>>

function fieldsOf(value: unknown): Fields | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fields : undefined
}

/** Listed modalities this build sends, in listing order without repeats; `undefined` when the value is not an array. */
function knownModalities(value: unknown): ModelModality[] | undefined {
  if (!Array.isArray(value)) return undefined
  const listed: readonly unknown[] = value
  return LISTED_MODALITIES.filter(modality => listed.includes(modality))
    .toSorted((left, right) => listed.indexOf(left) - listed.indexOf(right))
}

/** A declared capacity: `undefined` when absent, `false` when not a positive safe integer. */
function capacity(value: unknown): number | undefined | false {
  if (value === undefined) return undefined
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : false
}

function requirementOf(entry: Fields): ClientRequirement {
  if (entry.client_requirements === undefined) return { kind: 'none' }
  const requirements = fieldsOf(entry.client_requirements)
  if (requirements === undefined) return { kind: 'invalid' }
  const declared = requirements[APP_IDENTITY.product]
  if (declared === undefined) return { kind: 'none' }
  const own = fieldsOf(declared)
  if (own === undefined) return { kind: 'invalid' }
  if (own.min_version === undefined) return { kind: 'none' }
  return typeof own.min_version === 'string' && own.min_version.length > 0
    ? { kind: 'min-version', version: own.min_version }
    : { kind: 'invalid' }
}

/** One trimmed, visible badge text on one line, without control characters and at most {@link MAX_BADGE_TEXT_LENGTH} graphemes. */
function badgeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  const length = Array.from(GRAPHEMES.segment(text)).length
  return length <= MAX_BADGE_TEXT_LENGTH && VISIBLE_BADGE_CHARACTER.test(text) && !UNREADABLE_BADGE_CHARACTER.test(value)
    ? text : undefined
}

/** A literal badge text, or translations keyed by lowercase language id that include English. */
function localizedBadgeText(value: unknown): LlmModelBadge['text'] | undefined {
  if (typeof value === 'string') return badgeText(value)
  const variants = fieldsOf(value)
  if (variants === undefined) return undefined
  const texts: [string, string][] = []
  for (const [language, variant] of Object.entries(variants)) {
    const text = badgeText(variant)
    if (!LANGUAGE_ID.test(language) || text === undefined) return undefined
    texts.push([language, text])
  }
  const translations = Object.fromEntries(texts)
  const en = translations.en
  return en === undefined ? undefined : { ...translations, en }
}

/** This client's entry in a listing entry's `client_metadata`, as diagnostics name it. */
const OWN_METADATA = `client_metadata["${APP_IDENTITY.product}"]`

/** An optional object field: `undefined` when absent or `null`, `false` when it is not an object. */
function optionalFields(value: unknown): Fields | undefined | false {
  return value === undefined || value === null ? undefined : fieldsOf(value) ?? false
}

function badgeOf(entry: Fields): ListedBadge | undefined {
  // `null` at any level declares no badge, like an absent field; this build ships none to fall back on.
  const metadata = optionalFields(entry.client_metadata)
  if (metadata === false) return { kind: 'invalid', reason: 'client_metadata is not an object' }
  const own = optionalFields(metadata?.[APP_IDENTITY.product])
  if (own === false) return { kind: 'invalid', reason: `${OWN_METADATA} is not an object` }
  const declared = optionalFields(own?.badge)
  if (declared === false) return { kind: 'invalid', reason: `${OWN_METADATA}.badge is not an object` }
  if (declared === undefined) return undefined
  const text = localizedBadgeText(declared.text)
  if (text === undefined) {
    return {
      kind: 'invalid',
      reason: `${OWN_METADATA}.badge.text is not a string or an object of lowercase language ids including "en", `
        + `each text 1 to ${MAX_BADGE_TEXT_LENGTH} characters on one line`,
    }
  }
  // An absent or unrecognized tone keeps the text at the least emphasis.
  const tone = BADGE_TONES.find(candidate => candidate === declared.tone) ?? 'neutral'
  return { kind: 'badge', badge: { text, tone } }
}

/** Non-chat endpoint segments rejected even when paired with an OpenAI-compatible gateway route. */
const NON_CHAT_ENDPOINT_PATTERN =
  /(?:^|[-_])(?:image|video|embed|embeddings|rerank|audio|speech|tts|whisper|transcrib|moderation|midjourney|suno|kling|jimeng)(?:$|[-_])/iu

/** Model id patterns identifying non-chat models (embeddings, rerank, audio/ASR/TTS, image/video/3D, moderation, OCR). */
const NON_CHAT_MODEL_ID_PATTERNS = [
  /(?:^|[/._-])(?:text-)?embed(?:ding|dings)?(?:$|[/._-]|[-_]?v?\d)/iu,
  /(?:^|[/._-])(?:bge-(?:large|base|small|m3)|m3e|gte|voyage|nomic-embed|snowflake-arctic-embed)(?:$|[/._-]|[-_]?v?\d)/iu,
  /(?:^|[/._-])rerank(?:er)?(?:$|[/._-]|[-_]?v?\d)/iu,
  /(?:^|[/._-])(?:tts|whisper|transcrib\w*|speech|asr|paraformer|sensevoice|cosyvoice|sambert|realtime|audio)(?:$|[/._-]|[-_]?\d)/iu,
  /(?:^|[/._-])(?:dall-?e|gpt-image|chatgpt-image|imagen|flux|midjourney|mj|sdxl|sd3|stable-diffusion)(?:$|[/._-]|[-_]?\d)/iu,
  /(?:^|[/._-])(?:seedream|seededit|wanx|cogview|kolors|recraft|ideogram|jimeng|nova-canvas|titan-image|bagel)(?:$|[/._-]|[-_]?\d)/iu,
  /(?:^|[/._-])(?:image|video|t2i|i2i|t2v|i2v|v2v)(?:$|[/._-])/iu,
  /(?:^|[/._-])(?:sora|veo|kling|vidu|seedance|cogvideox?|hailuo|luma|dream-machine|runway|pika|pixverse)(?:$|[/._-]|[-_]?\d)/iu,
  /(?:^|[/._-])(?:nova-reel|wan-?2\.\d)(?:$|[/._-]|[-_]?\d)/iu,
  /(?:^|[/._-])(?:suno|udio|music|moderation|llama-guard|shieldgemma|prompt-guard|ocr|tripo|meshy|rodin)(?:$|[/._-]|[-_]?\d)/iu,
  /^(?:babbage|davinci)-002$/iu,
] as const

/** Endpoint types one entry declares it is served by; `undefined` when the field is absent or unreadable. */
function endpointTypes(entry: Fields): readonly unknown[] | undefined {
  const declared = entry.supported_endpoint_types
  return Array.isArray(declared) ? declared : undefined
}

/** Whether a gateway entry serves a chat language model this build can drive. */
function gatewayServesChat(entry: Fields, id: string): boolean {
  const served = endpointTypes(entry)
  if (served === undefined) return false
  if (served.some(type => typeof type === 'string' && NON_CHAT_ENDPOINT_PATTERN.test(type))) return false
  if (!GATEWAY_ENDPOINT_TYPES.some(type => served.includes(type))) return false
  return !NON_CHAT_MODEL_ID_PATTERNS.some(pattern => pattern.test(id))
}

const COMPACT_GATEWAY_TYPES = new Set(['text', 'image', 'video'])

/** Whether an entry uses the compact gateway listing's model-kind discriminator, case-insensitively. */
function compactGatewayRow(entry: Fields): boolean {
  const type = entry.type
  return typeof type === 'string' && COMPACT_GATEWAY_TYPES.has(type.toLowerCase())
}

/** Whether an entry uses the compact gateway listing's text-model kind, case-insensitively. */
function compactTextRow(entry: Fields): boolean {
  const type = entry.type
  return typeof type === 'string' && type.toLowerCase() === 'text'
}

/** Whether a compact entry also names a non-chat endpoint, which its `type` may not override. */
function compactRowDeclaresNonChatEndpoint(entry: Fields): boolean {
  const served = endpointTypes(entry)
  return served !== undefined && served.some(type => typeof type === 'string' && NON_CHAT_ENDPOINT_PATTERN.test(type))
}

/** Whether a compact text row names a chat language model this build can drive. */
function compactRowServesChat(entry: Fields, id: string): boolean {
  return compactTextRow(entry)
    && !compactRowDeclaresNonChatEndpoint(entry)
    && !NON_CHAT_MODEL_ID_PATTERNS.some(pattern => pattern.test(id))
}

/** Gateway capability facts: text input plus any valid optional context or output bounds. */
function gatewayFacts(entry: Fields): ListedFacts {
  const contextWindow = capacity(entry.context_window)
  const maxOutputTokens = capacity(entry.max_output_tokens)
  return {
    inputModalities: ['text'],
    ...typeof contextWindow === 'number' ? { contextWindow } : {},
    ...typeof maxOutputTokens === 'number' ? { maxOutputTokens } : {},
  }
}

function capabilitiesOf(entry: Fields, id: string): ListedCapabilities {
  const messages = fieldsOf(fieldsOf(entry.api_capabilities)?.anthropic_messages)
  if (messages === undefined) {
    // A gateway lists models without Messages capabilities and declares endpoint types or a compact
    // `type` discriminator instead; exclude non-chat routes and ignore unreadable capacities.
    if (gatewayServesChat(entry, id) || compactRowServesChat(entry, id)) {
      return { usable: true, facts: gatewayFacts(entry) }
    }
    return {
      usable: false,
      reason: endpointTypes(entry) !== undefined || typeof entry.type === 'string'
        ? 'is not a chat language model' : 'declares no api_capabilities.anthropic_messages',
    }
  }
  const outputs = entry.output_modalities === undefined ? ['text'] : knownModalities(entry.output_modalities)
  if (outputs?.includes('text') !== true) return { usable: false, reason: 'declares no text output' }
  const inputs = entry.input_modalities === undefined ? ['text' as const] : knownModalities(entry.input_modalities)
  if (inputs === undefined || inputs.length === 0) return { usable: false, reason: 'declares no input modality DeepSeek Harness supports' }
  const contextWindow = capacity(entry.context_window)
  const maxOutputTokens = capacity(entry.max_output_tokens)
  if (contextWindow === false || maxOutputTokens === false) {
    return { usable: false, reason: 'declares an invalid context_window or max_output_tokens' }
  }
  // `null` declares nothing, like an absent field, so a serializer that writes empty values as null keeps this build's knowledge.
  const promptUpdate = messages.system_prompt_update ?? undefined
  const toolUpdate = messages.tool_update ?? undefined
  return {
    usable: true,
    facts: {
      inputModalities: inputs,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxOutputTokens === undefined ? {} : { maxOutputTokens },
      ...promptUpdate === undefined ? {} : { systemPromptUpdate: promptUpdate === 'in-history' ? 'in-history' : 'leading-only' },
      ...toolUpdate === undefined ? {} : {
        toolUpdate: toolUpdate === 'in-history' || toolUpdate === 'addition-only' ? toolUpdate : 'leading-only',
      },
    },
  }
}

/**
 * Decode one `/models` body entry by entry.
 * @param body - parsed JSON response.
 * @returns the entries with a usable id, in listing order.
 * @throws LlmError `INVALID_RESPONSE` when the body has no `data` array or no usable entry.
 */
export function parseModelListing(body: unknown): ModelListing {
  const data = fieldsOf(body)?.data
  if (!Array.isArray(data)) throw new LlmError('DeepSeek model listing has no "data" array', 'INVALID_RESPONSE')
  const rows: readonly unknown[] = data
  const entries: ListingEntry[] = []
  const seen = new Set<string>()
  let gatewayRows = 0
  for (const row of rows) {
    const entry = fieldsOf(row)
    const id = entry?.id
    if (entry === undefined || typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const badge = badgeOf(entry)
    const selfDescribed = fieldsOf(fieldsOf(entry.api_capabilities)?.anthropic_messages) !== undefined
    if (!selfDescribed && (endpointTypes(entry) !== undefined || compactGatewayRow(entry))) gatewayRows += 1
    entries.push({
      id,
      ...typeof entry.name === 'string' && entry.name.length > 0 ? { name: entry.name } : {},
      requirement: requirementOf(entry),
      selfDescribed,
      capabilities: capabilitiesOf(entry, id),
      ...badge === undefined ? {} : { badge },
    })
  }
  if (entries.length === 0) throw new LlmError('DeepSeek model listing contains no model entry', 'INVALID_RESPONSE')
  return { entries, skipped: rows.length - entries.length, gateway: gatewayRows === entries.length }
}

/**
 * Request and decode one model listing. Redirects fail, so credentials stay on the requested origin.
 * @param url - listing endpoint.
 * @param headers - authentication headers for this endpoint.
 * @param signal - cancellation and deadline of the whole exchange.
 * @returns the decoded listing.
 * @throws LlmError `TIMEOUT` when a {@link LISTING_TIMEOUT} deadline elapses before a complete body, `ABORTED` for
 *   another abort, `TRANSPORT` for a network failure, `HTTP_<status>` for a non-2xx answer,
 *   and `INVALID_RESPONSE` for a body that is not a JSON listing.
 */
export async function requestModelListing(
  url: string, headers: Readonly<Record<string, string>>, signal: AbortSignal,
): Promise<ModelListing> {
  let response: Response
  let text: string
  try {
    response = await fetch(url, {
      method: 'GET', redirect: 'error', signal,
      headers: { ...attributionHeaders(), accept: 'application/json', ...headers },
    })
    text = await response.text()
  } catch (error) {
    const expired = timeoutOf(signal, LISTING_TIMEOUT)
    if (expired !== undefined) {
      throw new LlmError(`DeepSeek model listing request to ${url} timed out after ${expired.timeoutMs} ms`, 'TIMEOUT', { cause: error })
    }
    throw signal.aborted
      ? new LlmError(`DeepSeek model listing request to ${url} was aborted`, 'ABORTED', { cause: error })
      : new LlmError(`could not reach ${url}`, 'TRANSPORT', { cause: error })
  }
  if (!response.ok) throw new LlmError(`${url} answered HTTP ${response.status}`, `HTTP_${response.status}`, { status: response.status })
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error) {
    throw new LlmError(`${url} did not answer with JSON`, 'INVALID_RESPONSE', { cause: error })
  }
  return parseModelListing(body)
}
