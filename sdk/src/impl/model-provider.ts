/**
 * Model provider abstraction for routing requests to the appropriate LLM provider.
 *
 * This module handles:
 * - ChatGPT OAuth: Direct requests to OpenAI API using user's OAuth token
 * - Default: Requests through Codebuff backend (which routes to OpenRouter)
 */

import crypto from 'crypto'
import path from 'path'

import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import {
  ANTHROPIC_CLAUDE_CODE_IDENTITY,
  ANTHROPIC_CODE_ENTRYPOINT_ENV_VAR,
  ANTHROPIC_OAUTH_BETA_FLAGS,
  ANTHROPIC_OAUTH_BILLING_SALT,
  ANTHROPIC_OAUTH_CLIENT_VERSION,
  ANTHROPIC_OAUTH_ENABLED,
  ANTHROPIC_OAUTH_TOOL_PREFIX,
  ANTHROPIC_OAUTH_USER_AGENT,
  toAnthropicModelId,
} from '@codebuff/common/constants/anthropic-oauth'
import {
  GEMINI_CODE_ASSIST_API_VERSION,
  GEMINI_CODE_ASSIST_BASE_URL,
  GEMINI_CODE_ASSIST_CLIENT_METADATA,
  GEMINI_DEFAULT_TIER_ID,
  GEMINI_OAUTH_ENABLED,
  GEMINI_SKIP_THOUGHT_SIGNATURE,
  toGeminiModelId,
} from '@codebuff/common/constants/gemini-oauth'
import { BYOK_OPENROUTER_HEADER } from '@codebuff/common/constants/byok'
import { isFreeMode } from '@codebuff/common/constants/free-agents'
import {
  CHATGPT_BACKEND_BASE_URL,
  CHATGPT_OAUTH_ENABLED,
  isChatGptOAuthModelAllowed,
  isOpenAIProviderModel,
  toOpenAIModelId,
} from '@codebuff/common/constants/chatgpt-oauth'
import {
  OpenAICompatibleChatLanguageModel,
  VERSION,
} from '@codebuff/internal/openai-compatible/index'
import { longLivedFetch } from '@codebuff/common/util/long-lived-fetch'

import { WEBSITE_URL } from '../constants'
import {
  getValidAnthropicOAuthCredentials,
  getValidChatGptOAuthCredentials,
  getValidGeminiOAuthCredentials,
  getFireworksApiKey,
  getOpenRouterApiKey,
  refreshAnthropicOAuthToken,
  refreshGeminiOAuthToken,
  saveGeminiOAuthProject,
} from '../credentials'
import {
  getByokOpenrouterApiKeyFromEnv,
  getGeminiProjectFromEnv,
} from '../env'
import {
  createChatGptBackendFetch,
  extractChatGptAccountId,
} from './chatgpt-backend-fetch'

import type { LanguageModel } from 'ai'

// ============================================================================
// ChatGPT OAuth Rate Limit Cache
// ============================================================================

/** Timestamp (ms) when ChatGPT OAuth rate limit expires, or null if not rate-limited */
let chatGptOAuthRateLimitedUntil: number | null = null

/**
 * Mark ChatGPT OAuth as rate-limited. Subsequent requests will skip direct ChatGPT OAuth
 * and use Codebuff backend until the reset time.
 */
export function markChatGptOAuthRateLimited(resetAt?: Date): void {
  const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000
  chatGptOAuthRateLimitedUntil = resetAt
    ? resetAt.getTime()
    : fiveMinutesFromNow
}

/**
 * Check if ChatGPT OAuth is currently rate-limited.
 */
export function isChatGptOAuthRateLimited(): boolean {
  if (chatGptOAuthRateLimitedUntil === null) {
    return false
  }
  if (Date.now() >= chatGptOAuthRateLimitedUntil) {
    chatGptOAuthRateLimitedUntil = null
    return false
  }
  return true
}

/**
 * Reset the ChatGPT OAuth rate-limit cache.
 * Call this when user reconnects their ChatGPT subscription.
 */
export function resetChatGptOAuthRateLimit(): void {
  chatGptOAuthRateLimitedUntil = null
}

/**
 * Parameters for requesting a model.
 */
export interface ModelRequestParams {
  /** Codebuff API key for backend authentication */
  apiKey: string
  /** Model ID (OpenRouter format, e.g., "anthropic/claude-sonnet-4") */
  model: string
  /** If true, skip ChatGPT OAuth and use Codebuff backend (for fallback after rate limit) */
  skipChatGptOAuth?: boolean
  /** Cost mode (e.g. 'free') — affects fallback behavior for OAuth routes */
  costMode?: string
}

/**
 * Result from getModelForRequest.
 */
export interface ModelResult {
  /** The language model to use for requests */
  model: LanguageModel
  /** Whether this model uses ChatGPT OAuth direct (affects cost tracking) */
  isChatGptOAuth: boolean
}

// Usage accounting type for OpenRouter/Codebuff backend responses
type OpenRouterUsageAccounting = {
  cost: number | null
  costDetails: {
    upstreamInferenceCost: number | null
  }
}

/**
 * Get the appropriate model for a request.
 *
 * If ChatGPT OAuth credentials are available and the model is an OpenAI model,
 * returns an OpenAI direct model. Otherwise, returns the Codebuff backend model.
 * 
 * This function is async because it may need to refresh the OAuth token.
 */
export async function getModelForRequest(params: ModelRequestParams): Promise<ModelResult> {
  const { apiKey, model, skipChatGptOAuth, costMode } = params

  // Fireworks BYOK: when connected, EVERY request routes to Fireworks — never fall
  // through to ChatGPT OAuth or the Codebuff backend. The CLI overrides all agent
  // models to a fireworks/ model; strip that prefix before calling the API. A bare
  // (non-fireworks) model means an internal call slipped through — route it anyway
  // so the user stays on their own provider (a clean 404 beats a silent mid-stream throw).
  const fireworksCreds = getFireworksApiKey()
  if (fireworksCreds) {
    const fireworksModelId = model.startsWith('fireworks/')
      ? model.slice('fireworks/'.length)
      : model
    return {
      model: createFireworksDirectModel(fireworksModelId, fireworksCreds.apiKey),
      isChatGptOAuth: false,
    }
  }

  // OpenRouter BYOK (settings-stored key): routes all requests directly
  const openRouterCreds = getOpenRouterApiKey()
  if (openRouterCreds) {
    return {
      model: createOpenRouterDirectModel(model, openRouterCreds.apiKey),
      isChatGptOAuth: false,
    }
  }

  // Anthropic (Claude Pro/Max) OAuth: when the user has connected their Claude
  // subscription, route EVERY request directly to the native Anthropic API
  // using their OAuth token. Non-Anthropic models are mapped to a default
  // Claude model so the agent keeps working without the Codebuff backend.
  // Applies to streaming and non-streaming alike (the native API supports both).
  if (ANTHROPIC_OAUTH_ENABLED) {
    const anthropicCreds = await getValidAnthropicOAuthCredentials()
    if (anthropicCreds) {
      return {
        model: createAnthropicOAuthModel(model, anthropicCreds.accessToken),
        isChatGptOAuth: false,
      }
    }
  }

  // Gemini (Google account) OAuth: when the user has connected their Google
  // account, route EVERY request directly to the Gemini Code Assist API using
  // their OAuth token. Non-Gemini models are mapped to a default Gemini model so
  // the agent keeps working without the Codebuff backend.
  if (GEMINI_OAUTH_ENABLED) {
    const geminiCreds = await getValidGeminiOAuthCredentials()
    if (geminiCreds) {
      const project = await getOrResolveGeminiProject(geminiCreds)
      return {
        model: createGeminiOAuthModel(model, geminiCreds.accessToken, project),
        isChatGptOAuth: false,
      }
    }
  }

  // Check if we should use ChatGPT OAuth direct
  // Only attempt for allowlisted models; non-allowlisted models silently fall through to backend.
  if (
    CHATGPT_OAUTH_ENABLED &&
    !skipChatGptOAuth &&
    isOpenAIProviderModel(model) &&
    isChatGptOAuthModelAllowed(model)
  ) {
    // In free mode, rate-limited ChatGPT OAuth must not silently fall through to
    // the Codebuff backend — freebuff should only use the direct OpenAI route or fail.
    if (isChatGptOAuthRateLimited()) {
      if (isFreeMode(costMode)) {
        throw new Error(
          'ChatGPT rate limit reached. Please wait a few minutes and try again.',
        )
      }
    } else {
      const chatGptOAuthCredentials = await getValidChatGptOAuthCredentials()

      if (chatGptOAuthCredentials) {
        return {
          model: createOpenAIOAuthModel(model, chatGptOAuthCredentials.accessToken),
          isChatGptOAuth: true,
        }
      }

      // In free mode, if credentials are unavailable, don't fall through to backend.
      if (isFreeMode(costMode)) {
        throw new Error(
          'ChatGPT OAuth credentials unavailable. Please reconnect with /connect:chatgpt.',
        )
      }
    }
  }

  // Fallback: if ChatGPT OAuth credentials are available but the model is not
  // in the OpenAI allowlist (e.g. a subagent left on its google/anthropic default
  // model), route to a Codex model directly. This lets the CLI work without the
  // Codebuff backend when the user logged in via OpenAI OAuth.
  // (BYOK providers already returned above, so they never reach this fallback.)
  //
  // Must be a model SERVED on the ChatGPT-account Codex path — `gpt-5-codex` is
  // the Codex backend's native coding model (the Codex CLI default on ChatGPT
  // sign-in). The old `gpt-5.4` fallback is NOT served there, so every
  // non-OpenAI subagent (basher, file-lister, code-searcher, …) failed with
  // "model not supported when using Codex with a ChatGPT account".
  if (CHATGPT_OAUTH_ENABLED && !skipChatGptOAuth && !isChatGptOAuthRateLimited()) {
    const chatGptOAuthCredentials = await getValidChatGptOAuthCredentials()
    if (chatGptOAuthCredentials) {
      const fallbackOpenAIModel = 'openai/gpt-5-codex'
      return {
        model: createOpenAIOAuthModel(fallbackOpenAIModel, chatGptOAuthCredentials.accessToken),
        isChatGptOAuth: true,
      }
    }
  }

  // Default: use Codebuff backend
  return {
    model: createCodebuffBackendModel(apiKey, model),
    isChatGptOAuth: false,
  }
}

/**
 * Create an OpenAI model that routes through the ChatGPT backend API (Codex endpoint).
 * Uses a custom fetch that transforms between Chat Completions and Responses API formats.
 */
function createOpenAIOAuthModel(model: string, oauthToken: string): LanguageModel {
  const openAIModelId = toOpenAIModelId(model)
  const accountId = extractChatGptAccountId(oauthToken)

  return new OpenAICompatibleChatLanguageModel(openAIModelId, {
    provider: 'openai',
    url: () => `${CHATGPT_BACKEND_BASE_URL}/codex/responses`,
    headers: () => ({
      Authorization: `Bearer ${oauthToken}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      accept: 'text/event-stream',
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/codebuff-chatgpt-oauth`,
      ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
    }),
    fetch: createChatGptBackendFetch(),
    supportsStructuredOutputs: true,
    includeUsage: undefined,
  })
}

// ============================================================================
// Anthropic (Claude Pro/Max) OAuth direct routing
// ============================================================================

/** First user-message text — used to derive the Claude Code billing header. */
function extractFirstUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    if ((msg as any).role !== 'user') continue
    const content = (msg as any).content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        block.type === 'text' &&
        typeof block.text === 'string'
      ) {
        return block.text
      }
    }
    return ''
  }
  return ''
}

/**
 * Reproduce Claude Code's `x-anthropic-billing-header`. The exact value is a
 * sampled hash of the first user message; matching the shape keeps the OAuth
 * path from rejecting the request as a non-Claude-Code caller.
 */
function computeAnthropicBillingHeader(bodyStr: string): string {
  let firstUserText = ''
  try {
    firstUserText = extractFirstUserText(JSON.parse(bodyStr).messages)
  } catch {
    /* ignore */
  }
  const sample = [4, 7, 20]
    .map((idx) => firstUserText.charAt(idx) || '0')
    .join('')
  const hash = crypto
    .createHash('sha256')
    .update(
      `${ANTHROPIC_OAUTH_BILLING_SALT}${sample}${ANTHROPIC_OAUTH_CLIENT_VERSION}`,
    )
    .digest('hex')
    .slice(0, 3)
  const entry =
    process.env[ANTHROPIC_CODE_ENTRYPOINT_ENV_VAR]?.trim() || 'cli'
  return `cc_version=${ANTHROPIC_OAUTH_CLIENT_VERSION}.${hash}; cc_entrypoint=${entry}; cch=00000;`
}

/**
 * Rewrite the outgoing /v1/messages body for the OAuth path:
 *  1. Force the first system block to be the Claude Code identity (string and
 *     array shapes both handled) — required or the API returns 401/403.
 *  2. Prefix every tool name (and tool_choice) with `mcp_` so arbitrary tool
 *     names are accepted as if they were external MCP tools. The prefix is
 *     stripped back out of the response stream.
 */
export function transformAnthropicOAuthBody(bodyStr: string): string {
  let json: any
  try {
    json = JSON.parse(bodyStr)
  } catch {
    return bodyStr
  }

  const identity = ANTHROPIC_CLAUDE_CODE_IDENTITY
  if (typeof json.system === 'string') {
    if (!json.system.startsWith(identity)) {
      json.system = json.system.length
        ? `${identity}\n\n${json.system}`
        : identity
    }
  } else if (Array.isArray(json.system)) {
    const first = json.system[0]
    const firstText =
      first && typeof first === 'object' && first.type === 'text'
        ? first.text
        : undefined
    if (firstText !== identity) {
      json.system = [{ type: 'text', text: identity }, ...json.system]
    }
  } else {
    json.system = identity
  }

  const prefix = ANTHROPIC_OAUTH_TOOL_PREFIX
  const addPrefix = (name: string) =>
    name.startsWith(prefix) ? name : `${prefix}${name}`

  if (Array.isArray(json.tools)) {
    json.tools = json.tools.map((tool: any) =>
      tool && typeof tool === 'object' && typeof tool.name === 'string'
        ? { ...tool, name: addPrefix(tool.name) }
        : tool,
    )
  }

  if (
    json.tool_choice &&
    typeof json.tool_choice === 'object' &&
    typeof json.tool_choice.name === 'string'
  ) {
    json.tool_choice = {
      ...json.tool_choice,
      name: addPrefix(json.tool_choice.name),
    }
  }

  if (Array.isArray(json.messages)) {
    json.messages = json.messages.map((msg: any) => {
      if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) {
        return msg
      }
      return {
        ...msg,
        content: msg.content.map((item: any) =>
          item &&
          typeof item === 'object' &&
          item.type === 'tool_use' &&
          typeof item.name === 'string'
            ? { ...item, name: addPrefix(item.name) }
            : item,
        ),
      }
    })
  }

  return JSON.stringify(json)
}

/**
 * Strip the `mcp_` tool-name prefix back out of the response. Line-buffered so
 * a tool name never straddles a chunk boundary (works for both the SSE stream
 * and a single non-streaming JSON body).
 */
export function stripMcpToolPrefixFromResponse(res: Response): Response {
  if (!res.body) return res

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const strip = (s: string) =>
    s.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name":"$1"')
  let buffer = ''

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          if (buffer.length > 0) {
            controller.enqueue(encoder.encode(strip(buffer)))
            buffer = ''
          }
          controller.close()
          return
        }
        buffer += decoder.decode(value, { stream: true })
        const lastNewline = buffer.lastIndexOf('\n')
        if (lastNewline >= 0) {
          const ready = buffer.slice(0, lastNewline + 1)
          buffer = buffer.slice(lastNewline + 1)
          controller.enqueue(encoder.encode(strip(ready)))
          return
        }
        // No newline yet — keep reading until we have a complete line.
      }
    },
    cancel(reason) {
      void reader.cancel(reason)
    },
  })

  const headers = new Headers(res.headers)
  // We re-stream decoded bytes, so the original length/encoding no longer apply.
  headers.delete('content-length')
  headers.delete('content-encoding')

  return new Response(stream, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}

/**
 * Create a model that routes directly to the native Anthropic Messages API
 * using a Claude Pro/Max subscription OAuth token. A custom fetch injects the
 * Claude Code identity/headers, prefixes tool names, and refreshes the token
 * once on 401/403.
 */
function createAnthropicOAuthModel(
  model: string,
  initialAccessToken: string,
): LanguageModel {
  const modelId = toAnthropicModelId(model)
  let accessToken = initialAccessToken

  const oauthFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

    let bodyStr: string | undefined
    if (typeof init?.body === 'string') {
      bodyStr = init.body
    } else if (input instanceof Request) {
      bodyStr = await input.text()
    }
    if (bodyStr) {
      bodyStr = transformAnthropicOAuthBody(bodyStr)
    }

    let url: URL | undefined
    try {
      url = new URL(rawUrl)
    } catch {
      /* leave undefined */
    }

    const isMessages = !!url && url.pathname.endsWith('/v1/messages')
    if (isMessages && url && !url.searchParams.has('beta')) {
      url.searchParams.set('beta', 'true')
    }
    const finalUrl = url ? url.toString() : rawUrl

    const method =
      init?.method ?? (input instanceof Request ? input.method : 'POST')

    const doFetch = (token: string): Promise<Response> => {
      const headers = new Headers(
        input instanceof Request ? input.headers : undefined,
      )
      new Headers(init?.headers).forEach((value, key) =>
        headers.set(key, value),
      )

      const existingBeta = headers.get('anthropic-beta') ?? ''
      const betaList = existingBeta
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      headers.set(
        'anthropic-beta',
        [...new Set([...ANTHROPIC_OAUTH_BETA_FLAGS, ...betaList])].join(','),
      )
      headers.set('authorization', `Bearer ${token}`)
      headers.set('user-agent', ANTHROPIC_OAUTH_USER_AGENT)
      headers.set('x-app', 'cli')
      headers.set('content-type', 'application/json')
      headers.delete('x-api-key')
      if (isMessages && bodyStr) {
        headers.set(
          'x-anthropic-billing-header',
          computeAnthropicBillingHeader(bodyStr),
        )
      }

      return longLivedFetch(finalUrl, {
        ...(init ?? {}),
        method,
        headers,
        body: bodyStr ?? init?.body,
      })
    }

    let res = await doFetch(accessToken)
    if (res.status === 401 || res.status === 403) {
      const refreshed = await refreshAnthropicOAuthToken()
      if (refreshed?.accessToken) {
        accessToken = refreshed.accessToken
        res = await doFetch(accessToken)
      }
    }

    return stripMcpToolPrefixFromResponse(res)
  }

  const anthropic = createAnthropic({
    // x-api-key is deleted in oauthFetch; this placeholder only stops the
    // provider from throwing on a missing key.
    apiKey: 'codebuff-anthropic-oauth',
    // Cast: our wrapper omits the Bun/web `preconnect` static, which the
    // FetchFunction (= typeof fetch) type nominally requires but never calls.
    fetch: oauthFetch as typeof globalThis.fetch,
  })

  return anthropic(modelId)
}

// ============================================================================
// Gemini (Google account) OAuth direct routing via the Code Assist API
// ============================================================================

/**
 * Wrap a native Gemini `GenerateContentRequest` body in the Code Assist
 * envelope: `{ model, project?, request }`. The inner `request` is exactly what
 * `@ai-sdk/google` produced (contents, systemInstruction, tools, …).
 */
export function wrapCodeAssistRequestBody(
  bodyStr: string,
  modelId: string,
  project?: string,
): string {
  let request: unknown
  try {
    request = JSON.parse(bodyStr)
  } catch {
    return bodyStr
  }
  const wrapped: Record<string, unknown> = { model: modelId, request }
  if (project) {
    wrapped.project = project
  }
  return JSON.stringify(wrapped)
}

// ── Gemini thought-signature round-trip ──────────────────────────────────────
// Gemini 3 / thinking models attach a `thoughtSignature` to every `functionCall`
// and REQUIRE it to be echoed back (in the matching functionCall part) on the
// follow-up request, or the API rejects the call with
// "Function call is missing a thought_signature". The agent runtime's message
// history doesn't carry this provider-specific field across turns, so we cache
// it here (keyed by the call's name+args, which are stable across replay) and
// re-inject it on the next request. Process-lifetime, soft-capped.

const geminiThoughtSignatures = new Map<string, string>()
const MAX_THOUGHT_SIGNATURES = 500

/**
 * Recursively sort object keys so two equal arg objects serialize to the same
 * string regardless of key order. The runtime round-trips tool-call args through
 * schema validation, which can reorder keys between the captured response and the
 * replayed request — without this the cache key would miss and a real signature
 * would be lost (degrading to the skip token).
 */
function canonicalizeArgs(value: any): any {
  if (Array.isArray(value)) {
    return value.map(canonicalizeArgs)
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, any> = {}
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalizeArgs(value[key])
    }
    return sorted
  }
  return value
}

function thoughtSigKey(fc: any): string | null {
  if (!fc || typeof fc !== 'object' || typeof fc.name !== 'string') {
    return null
  }
  let argsStr = ''
  try {
    argsStr = JSON.stringify(canonicalizeArgs(fc.args ?? {}))
  } catch {
    argsStr = ''
  }
  // `\u0000` (an escape, not a literal NUL byte in the source) is a safe
  // delimiter that can't appear in a tool name or JSON text.
  return `${fc.name}\u0000${argsStr}`
}

/** Record thoughtSignatures emitted on a response's functionCall parts. */
function captureThoughtSignatures(responseObj: any): void {
  const candidates = responseObj?.candidates
  if (!Array.isArray(candidates)) {
    return
  }
  for (const cand of candidates) {
    const parts = cand?.content?.parts
    if (!Array.isArray(parts)) {
      continue
    }
    for (const part of parts) {
      if (
        part?.functionCall &&
        typeof part.thoughtSignature === 'string' &&
        part.thoughtSignature
      ) {
        const key = thoughtSigKey(part.functionCall)
        if (key) {
          if (geminiThoughtSignatures.size >= MAX_THOUGHT_SIGNATURES) {
            geminiThoughtSignatures.clear()
          }
          geminiThoughtSignatures.set(key, part.thoughtSignature)
        }
      }
    }
  }
}

/**
 * Ensure every request `functionCall` part carries a thoughtSignature, which
 * Gemini 3 / thinking models require or they 400 with "Function call is missing
 * a thought_signature in functionCall parts".
 *
 * Preference order per part:
 *  1. A real signature we captured from the model's own response (best — keeps
 *     the model's reasoning context across turns).
 *  2. The documented skip token (`GEMINI_SKIP_THOUGHT_SIGNATURE`) for calls that
 *     never had one: programmatic agents (e.g. basher yields run_terminal_command
 *     itself, so Gemini never signed it) or capture misses. This bypasses
 *     validation so tools work, at a small reasoning-quality cost.
 */
export function injectGeminiThoughtSignatures(bodyStr: string): string {
  let json: any
  try {
    json = JSON.parse(bodyStr)
  } catch {
    return bodyStr
  }
  const contents = json?.contents
  if (!Array.isArray(contents)) {
    return bodyStr
  }
  let changed = false
  for (const content of contents) {
    const parts = content?.parts
    if (!Array.isArray(parts)) {
      continue
    }
    for (const part of parts) {
      if (part?.functionCall && !part.thoughtSignature) {
        const key = thoughtSigKey(part.functionCall)
        const sig = key ? geminiThoughtSignatures.get(key) : undefined
        part.thoughtSignature = sig ?? GEMINI_SKIP_THOUGHT_SIGNATURE
        changed = true
      }
    }
  }
  return changed ? JSON.stringify(json) : bodyStr
}

/** Parse the `@ai-sdk/google` request URL into model id + action + stream flag. */
export function parseGeminiAction(rawUrl: string): {
  modelId: string
  action: string
  isStream: boolean
  search: string
} | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  const marker = '/models/'
  const idx = url.pathname.indexOf(marker)
  if (idx < 0) {
    return null
  }
  const tail = url.pathname.slice(idx + marker.length)
  const colon = tail.indexOf(':')
  if (colon < 0) {
    return null
  }
  const modelId = decodeURIComponent(tail.slice(0, colon))
  const action = tail.slice(colon + 1)
  return { modelId, action, isStream: action.startsWith('stream'), search: url.search }
}

/**
 * Unwrap a single Code Assist SSE line. Each streamed event is
 * `data: {"response": {…GenerateContentResponse…}}`; `@ai-sdk/google` expects
 * the bare response object, so we lift `.response` out. Non-data lines and
 * `[DONE]` pass through untouched.
 */
export function unwrapCodeAssistStreamLine(line: string): string {
  const trimmed = line.trimStart()
  if (!trimmed.startsWith('data:')) {
    return line
  }
  const prefix = line.slice(0, line.length - trimmed.length)
  const dataStr = trimmed.slice('data:'.length).trim()
  if (!dataStr || dataStr === '[DONE]') {
    return line
  }
  try {
    const parsed = JSON.parse(dataStr)
    if (parsed && typeof parsed === 'object' && 'response' in parsed) {
      const response = (parsed as { response: unknown }).response
      captureThoughtSignatures(response)
      return `${prefix}data: ${JSON.stringify(response)}`
    }
  } catch {
    // A complete SSE line should be valid JSON; if not, leave it untouched.
  }
  return line
}

function processCodeAssistChunk(chunk: string): string {
  return chunk.split('\n').map(unwrapCodeAssistStreamLine).join('\n')
}

/** Line-buffered SSE unwrap so a JSON event never straddles a chunk boundary. */
function unwrapCodeAssistStream(res: Response): Response {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          if (buffer.length > 0) {
            controller.enqueue(encoder.encode(processCodeAssistChunk(buffer)))
            buffer = ''
          }
          controller.close()
          return
        }
        buffer += decoder.decode(value, { stream: true })
        const lastNewline = buffer.lastIndexOf('\n')
        if (lastNewline >= 0) {
          const ready = buffer.slice(0, lastNewline + 1)
          buffer = buffer.slice(lastNewline + 1)
          controller.enqueue(encoder.encode(processCodeAssistChunk(ready)))
          return
        }
      }
    },
    cancel(reason) {
      void reader.cancel(reason)
    },
  })

  const headers = new Headers(res.headers)
  headers.delete('content-length')
  headers.delete('content-encoding')
  return new Response(stream, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}

/** Unwrap the Code Assist `{response:…}` envelope for streaming or JSON bodies. */
export async function unwrapCodeAssistResponse(
  res: Response,
  isStream: boolean,
): Promise<Response> {
  // Error bodies aren't wrapped — pass them through so the provider can surface
  // the real status/message.
  if (!res.body || !res.ok) {
    return res
  }
  if (isStream) {
    return unwrapCodeAssistStream(res)
  }
  const text = await res.text()
  const headers = new Headers(res.headers)
  headers.delete('content-length')
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && 'response' in parsed) {
      const response = (parsed as { response: unknown }).response
      captureThoughtSignatures(response)
      return new Response(JSON.stringify(response), {
        status: res.status,
        statusText: res.statusText,
        headers,
      })
    }
  } catch {
    // Fall through and re-emit the original text.
  }
  return new Response(text, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}

/**
 * Parse the retry delay (ms) suggested by a Code Assist 429. Free-tier throttles
 * carry either a RetryInfo `retryDelay: "6s"` or a human "reset after 6s" hint.
 * Returns the body text too (the 429 body is consumed to read it). Capped so a
 * pathological hint can't stall the agent.
 */
export async function parseCodeAssist429(
  res: Response,
): Promise<{ delayMs: number | null; bodyText: string }> {
  const bodyText = await res.text().catch(() => '')
  let seconds: number | null = null
  const retryInfo = bodyText.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/)
  const resetHint = bodyText.match(/reset after (\d+(?:\.\d+)?)\s*s/i)
  if (retryInfo) {
    seconds = parseFloat(retryInfo[1])
  } else if (resetHint) {
    seconds = parseFloat(resetHint[1])
  }
  const delayMs =
    seconds != null && Number.isFinite(seconds)
      ? Math.min(seconds * 1000 + 500, 30_000)
      : null
  return { delayMs, bodyText }
}

// ── Code Assist project resolution ───────────────────────────────────────────

let cachedGeminiProject: string | undefined
let geminiProjectPromise: Promise<string | undefined> | null = null

async function callCodeAssist(
  method: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<any> {
  const res = await longLivedFetch(
    `${GEMINI_CODE_ASSIST_BASE_URL}/${GEMINI_CODE_ASSIST_API_VERSION}:${method}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `Code Assist ${method} failed (${res.status}): ${text.slice(0, 200)}`,
    )
  }
  return res.json()
}

/**
 * Resolve the Code Assist project (cloudaicompanionProject) for the account.
 * `loadCodeAssist` returns it directly for provisioned accounts; otherwise we
 * `onboardUser` (a long-running operation) and poll until a project is minted.
 * This is the least self-testable piece — it requires a real Google login — so
 * it is isolated here as the single seam tests mock.
 */
export async function resolveGeminiProject(
  accessToken: string,
): Promise<string | undefined> {
  const envProject = getGeminiProjectFromEnv()
  const load = await callCodeAssist('loadCodeAssist', accessToken, {
    ...(envProject ? { cloudaicompanionProject: envProject } : {}),
    metadata: GEMINI_CODE_ASSIST_CLIENT_METADATA,
  })
  if (
    typeof load?.cloudaicompanionProject === 'string' &&
    load.cloudaicompanionProject
  ) {
    return load.cloudaicompanionProject
  }

  const tierId =
    (Array.isArray(load?.allowedTiers)
      ? load.allowedTiers.find((t: any) => t?.isDefault)?.id
      : undefined) ?? GEMINI_DEFAULT_TIER_ID

  const onboardBody = {
    tierId,
    ...(envProject ? { cloudaicompanionProject: envProject } : {}),
    metadata: GEMINI_CODE_ASSIST_CLIENT_METADATA,
  }
  let lro = await callCodeAssist('onboardUser', accessToken, onboardBody)
  for (let i = 0; i < 10 && lro && !lro.done; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    lro = await callCodeAssist('onboardUser', accessToken, onboardBody)
  }
  const proj = lro?.response?.cloudaicompanionProject
  if (typeof proj === 'string' && proj) {
    return proj
  }
  if (proj && typeof proj === 'object' && typeof proj.id === 'string') {
    return proj.id
  }
  return envProject
}

/** Resolve the project once per process; cache in memory and persist to disk. */
async function getOrResolveGeminiProject(creds: {
  accessToken: string
  cloudaicompanionProject?: string
}): Promise<string | undefined> {
  if (creds.cloudaicompanionProject) {
    return creds.cloudaicompanionProject
  }
  const envProject = getGeminiProjectFromEnv()
  if (envProject) {
    return envProject
  }
  if (cachedGeminiProject) {
    return cachedGeminiProject
  }
  if (geminiProjectPromise) {
    return geminiProjectPromise
  }
  geminiProjectPromise = (async () => {
    try {
      const proj = await resolveGeminiProject(creds.accessToken)
      if (proj) {
        cachedGeminiProject = proj
        try {
          saveGeminiOAuthProject(proj)
        } catch {
          /* best-effort persistence */
        }
      }
      return proj
    } catch (error) {
      // Don't crash the run on a resolution failure — send the request without a
      // project field (the API may still serve some accounts) and let any error
      // surface as a model error rather than a CLI crash.
      console.debug(
        'Gemini project resolution failed:',
        error instanceof Error ? error.message : String(error),
      )
      return undefined
    } finally {
      geminiProjectPromise = null
    }
  })()
  return geminiProjectPromise
}

/**
 * Create a model that routes directly to the Gemini Code Assist API using a
 * personal Google-account OAuth token. A custom fetch rewrites the URL to the
 * `cloudcode-pa` endpoint, wraps the body in the Code Assist envelope, unwraps
 * the response, and refreshes the token once on 401/403.
 */
function createGeminiOAuthModel(
  model: string,
  initialAccessToken: string,
  project?: string,
): LanguageModel {
  const modelId = toGeminiModelId(model)
  let accessToken = initialAccessToken

  const oauthFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

    let bodyStr: string | undefined
    if (typeof init?.body === 'string') {
      bodyStr = init.body
    } else if (input instanceof Request) {
      bodyStr = await input.text()
    }

    const parsed = parseGeminiAction(rawUrl)
    let finalUrl = rawUrl
    if (parsed) {
      finalUrl = `${GEMINI_CODE_ASSIST_BASE_URL}/${GEMINI_CODE_ASSIST_API_VERSION}:${parsed.action}${parsed.search}`
      if (bodyStr) {
        // Re-attach any thoughtSignatures the runtime's history dropped, then
        // wrap in the Code Assist envelope.
        bodyStr = injectGeminiThoughtSignatures(bodyStr)
        bodyStr = wrapCodeAssistRequestBody(bodyStr, parsed.modelId, project)
      }
    }

    const method =
      init?.method ?? (input instanceof Request ? input.method : 'POST')

    const doFetch = (token: string): Promise<Response> => {
      const headers = new Headers(
        input instanceof Request ? input.headers : undefined,
      )
      new Headers(init?.headers).forEach((value, key) =>
        headers.set(key, value),
      )
      headers.set('authorization', `Bearer ${token}`)
      headers.set('content-type', 'application/json')
      // The Code Assist path authenticates with the bearer token, not an API key.
      headers.delete('x-goog-api-key')
      headers.delete('x-api-key')

      return longLivedFetch(finalUrl, {
        ...(init ?? {}),
        method,
        headers,
        body: bodyStr ?? init?.body,
      })
    }

    let res = await doFetch(accessToken)
    if (res.status === 401 || res.status === 403) {
      const refreshed = await refreshGeminiOAuthToken()
      if (refreshed?.accessToken) {
        accessToken = refreshed.accessToken
        res = await doFetch(accessToken)
      }
    }

    // Code Assist's free tier throttles by requests-per-minute and returns 429
    // with a short reset window. The AI SDK's generic backoff (≈1–2s) often
    // retries before that window clears and still gets 429, so a single user
    // message (which fans out into several model calls) surfaces a hard
    // "usage: your usage rate limit". Here we wait the server-suggested delay and
    // retry, absorbing transient throttles. Sustained/daily exhaustion still
    // falls through as a 429 after the bounded retries.
    let rateLimitRetries = 0
    while (res.status === 429 && rateLimitRetries < 2) {
      const { delayMs, bodyText } = await parseCodeAssist429(res)
      if (delayMs == null) {
        // No usable hint — hand the (already-consumed) body back so the provider
        // can surface the real error rather than an empty one.
        return new Response(bodyText, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        })
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      rateLimitRetries++
      res = await doFetch(accessToken)
    }

    return unwrapCodeAssistResponse(res, parsed?.isStream ?? false)
  }

  const google = createGoogleGenerativeAI({
    // The placeholder key only stops the provider from throwing on a missing
    // key; the real auth header is set in oauthFetch.
    apiKey: 'codebuff-gemini-oauth',
    // Cast: our wrapper omits the Bun/web `preconnect` static, which the
    // FetchFunction (= typeof fetch) type nominally requires but never calls.
    fetch: oauthFetch as typeof globalThis.fetch,
  })

  return google(modelId)
}

/**
 * Create a model that routes directly to Fireworks.ai (BYOK).
 * Base URL: https://api.fireworks.ai/inference/v1 (OpenAI-compatible)
 */
function createFireworksDirectModel(model: string, apiKey: string): LanguageModel {
  return new OpenAICompatibleChatLanguageModel(model, {
    provider: 'fireworks',
    url: ({ path: endpoint }) => `https://api.fireworks.ai/inference/v1${endpoint}`,
    headers: () => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/nevan-fireworks`,
    }),
    fetch: longLivedFetch,
    supportsStructuredOutputs: false,
    includeUsage: undefined,
  })
}

/**
 * Create a model that routes directly to OpenRouter (BYOK, settings-stored key).
 * Base URL: https://openrouter.ai/api/v1 (OpenAI-compatible)
 */
function createOpenRouterDirectModel(model: string, apiKey: string): LanguageModel {
  return new OpenAICompatibleChatLanguageModel(model, {
    provider: 'openrouter',
    url: ({ path: endpoint }) => `https://openrouter.ai/api/v1${endpoint}`,
    headers: () => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://nevancode.app',
      'X-Title': 'NevanCode',
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/nevan-openrouter`,
    }),
    fetch: longLivedFetch,
    supportsStructuredOutputs: false,
    includeUsage: undefined,
  })
}

/**
 * Create a model that routes through the Codebuff backend.
 * This is the existing behavior - requests go to Codebuff backend which forwards to OpenRouter.
 */
function createCodebuffBackendModel(
  apiKey: string,
  model: string,
): LanguageModel {
  const openrouterUsage: OpenRouterUsageAccounting = {
    cost: null,
    costDetails: {
      upstreamInferenceCost: null,
    },
  }

  const openrouterApiKey = getByokOpenrouterApiKeyFromEnv()

  return new OpenAICompatibleChatLanguageModel(model, {
    provider: 'codebuff',
    url: ({ path: endpoint }) =>
      new URL(path.join('/api/v1', endpoint), WEBSITE_URL).toString(),
    headers: () => ({
      Authorization: `Bearer ${apiKey}`,
      'user-agent': `ai-sdk/openai-compatible/${VERSION}/codebuff`,
      ...(openrouterApiKey && { [BYOK_OPENROUTER_HEADER]: openrouterApiKey }),
    }),
    metadataExtractor: {
      extractMetadata: async ({ parsedBody }: { parsedBody: any }) => {
        if (openrouterApiKey !== undefined) {
          return { codebuff: { usage: openrouterUsage } }
        }

        if (typeof parsedBody?.usage?.cost === 'number') {
          openrouterUsage.cost = parsedBody.usage.cost
        }
        if (
          typeof parsedBody?.usage?.cost_details?.upstream_inference_cost ===
          'number'
        ) {
          openrouterUsage.costDetails.upstreamInferenceCost =
            parsedBody.usage.cost_details.upstream_inference_cost
        }
        return { codebuff: { usage: openrouterUsage } }
      },
      createStreamExtractor: () => ({
        processChunk: (parsedChunk: any) => {
          if (openrouterApiKey !== undefined) {
            return
          }

          if (typeof parsedChunk?.usage?.cost === 'number') {
            openrouterUsage.cost = parsedChunk.usage.cost
          }
          if (
            typeof parsedChunk?.usage?.cost_details?.upstream_inference_cost ===
            'number'
          ) {
            openrouterUsage.costDetails.upstreamInferenceCost =
              parsedChunk.usage.cost_details.upstream_inference_cost
          }
        },
        buildMetadata: () => {
          return { codebuff: { usage: openrouterUsage } }
        },
      }),
    },
    // Long-lived fetch keeps the stream socket open through quiet stretches
    // (deep reasoning, large tool calls), which Bun's default idle timeout
    // would otherwise terminate as "The operation timed out.".
    fetch: longLivedFetch,
    includeUsage: undefined,
    supportsStructuredOutputs: true,
  })
}
