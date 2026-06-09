import { withTimeout } from '@codebuff/common/util/promise'

import type { ClientEnv, CiEnv } from '@codebuff/common/types/contracts/env'
import type { JSONObject } from '@codebuff/common/types/json'
import type { Logger } from '@codebuff/common/types/contracts/logger'

// Generous default so a slow backend never kills long-running agent sessions.
// Override with CODEBUFF_WEB_API_TIMEOUT_MS, or set CODEBUFF_DISABLE_TIMEOUTS=1
// to let requests run without any time bound at all.
const FETCH_TIMEOUT_MS = (() => {
  const envValue =
    typeof process !== 'undefined'
      ? process.env?.CODEBUFF_WEB_API_TIMEOUT_MS
      : undefined
  const parsed = envValue ? Number(envValue) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24 * 60 * 60 * 1000
})()
const MAX_RETRIES = 5
const RETRY_BASE_DELAY_MS = 1000
const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504])

// Token counting is a fast, best-effort call made on the hot path of every
// agent step. Unlike deep web/docs search (which legitimately runs for minutes
// and uses the 24h FETCH_TIMEOUT_MS), it must be bounded tightly so a slow or
// unreachable backend can never stall a step. Override with
// CODEBUFF_TOKEN_COUNT_TIMEOUT_MS; CODEBUFF_DISABLE_TIMEOUTS=1 still disables it.
const TOKEN_COUNT_TIMEOUT_MS = (() => {
  const envValue =
    typeof process !== 'undefined'
      ? process.env?.CODEBUFF_TOKEN_COUNT_TIMEOUT_MS
      : undefined
  const parsed = envValue ? Number(envValue) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000
})()

interface CodebuffWebApiEnv {
  clientEnv: ClientEnv
  ciEnv: CiEnv
}

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const getStringField = (value: unknown, key: string): string | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const field = record[key]
  return typeof field === 'string' ? field : undefined
}

const getNumberField = (value: unknown, key: string): number | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const field = record[key]
  return typeof field === 'number' ? field : undefined
}

const callCodebuffV1 = async (params: {
  endpoint:
    | '/api/v1/web-search'
    | '/api/v1/docs-search'
    | '/api/v1/gravity-index'
  payload: unknown
  fetch: typeof globalThis.fetch
  logger: Logger
  env: CodebuffWebApiEnv
  baseUrl?: string
  apiKey?: string
  requestName: 'web-search' | 'docs-search' | 'gravity-index'
}): Promise<{ json?: unknown; error?: string; creditsUsed?: number }> => {
  const { endpoint, payload, fetch, logger, env, requestName } = params
  const baseUrl = params.baseUrl ?? env.clientEnv.NEXT_PUBLIC_CODEBUFF_APP_URL
  const apiKey = params.apiKey ?? env.ciEnv.CODEBUFF_API_KEY

  if (!baseUrl || !apiKey) {
    return { error: 'Missing Codebuff base URL or API key' }
  }

  const url = `${baseUrl}${endpoint}`
  let lastError: string | undefined

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await withTimeout(
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'x-codebuff-api-key': apiKey,
          },
          body: JSON.stringify(payload),
        }),
        FETCH_TIMEOUT_MS,
        `Request to ${endpoint} timed out after ${FETCH_TIMEOUT_MS}ms`,
      )

      const text = await res.text()
      const json = tryParseJson(text)

      if (!res.ok) {
        const err =
          getStringField(json, 'error') ??
          getStringField(json, 'message') ??
          text ??
          'Request failed'

        // Retry on transient errors
        if (RETRYABLE_STATUS_CODES.has(res.status) && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
          logger.warn(
            {
              url,
              status: res.status,
              statusText: res.statusText,
              attempt,
              maxRetries: MAX_RETRIES,
              nextRetryDelayMs: delay,
            },
            `Web API ${requestName} request failed with retryable status, retrying...`,
          )
          await new Promise((resolve) => setTimeout(resolve, delay))
          lastError = err
          continue
        }

        logger.warn(
          {
            url,
            status: res.status,
            statusText: res.statusText,
            body: text?.slice(0, 500),
            attempt,
          },
          `Web API ${requestName} request failed`,
        )
        return { error: err }
      }

      return { json, creditsUsed: getNumberField(json, 'creditsUsed') }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Network error'

      // Retry on network errors
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
        logger.warn(
          {
            error:
              error instanceof Error
                ? { name: error.name, message: error.message }
                : error,
            attempt,
            maxRetries: MAX_RETRIES,
            nextRetryDelayMs: delay,
          },
          `Web API ${requestName} network error, retrying...`,
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }

      logger.error(
        {
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : error,
          attempt,
        },
        `Web API ${requestName} network error after all retries`,
      )
      return { error: lastError }
    }
  }

  return { error: lastError ?? 'Request failed after all retries' }
}

export async function callWebSearchAPI(params: {
  query: string
  depth?: 'standard' | 'deep'
  repoUrl?: string | null
  fetch: typeof globalThis.fetch
  logger: Logger
  env: CodebuffWebApiEnv
  baseUrl?: string
  apiKey?: string
}): Promise<{ result?: string; error?: string; creditsUsed?: number }> {
  const { query, depth = 'standard', repoUrl, fetch, logger, env } = params
  const payload = { query, depth, ...(repoUrl ? { repoUrl } : {}) }

  const res = await callCodebuffV1({
    endpoint: '/api/v1/web-search',
    payload,
    fetch,
    logger,
    env,
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    requestName: 'web-search',
  })
  if (res.error) return { error: res.error }

  const result = getStringField(res.json, 'result')
  if (result) {
    return { result, creditsUsed: res.creditsUsed }
  }

  const error = getStringField(res.json, 'error')
  return { error: error ?? 'Invalid response format' }
}

export async function callDocsSearchAPI(params: {
  libraryTitle: string
  topic?: string
  maxTokens?: number
  repoUrl?: string | null
  fetch: typeof globalThis.fetch
  logger: Logger
  env: CodebuffWebApiEnv
  baseUrl?: string
  apiKey?: string
}): Promise<{ documentation?: string; error?: string; creditsUsed?: number }> {
  const { libraryTitle, topic, maxTokens, repoUrl, fetch, logger, env } = params
  const payload: Record<string, unknown> = { libraryTitle }
  if (topic) payload.topic = topic
  if (typeof maxTokens === 'number') payload.maxTokens = maxTokens
  if (repoUrl) payload.repoUrl = repoUrl

  const res = await callCodebuffV1({
    endpoint: '/api/v1/docs-search',
    payload,
    fetch,
    logger,
    env,
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    requestName: 'docs-search',
  })
  if (res.error) return { error: res.error }

  const documentation = getStringField(res.json, 'documentation')
  if (documentation) {
    return { documentation, creditsUsed: res.creditsUsed }
  }

  const error = getStringField(res.json, 'error')
  return { error: error ?? 'Invalid response format' }
}

export async function callGravityIndexAPI(params: {
  input: JSONObject
  fetch: typeof globalThis.fetch
  logger: Logger
  env: CodebuffWebApiEnv
  baseUrl?: string
  apiKey?: string
}): Promise<{
  result?: JSONObject
  error?: string
  creditsUsed?: number
}> {
  const { input, fetch, logger, env } = params

  const res = await callCodebuffV1({
    endpoint: '/api/v1/gravity-index',
    payload: input,
    fetch,
    logger,
    env,
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    requestName: 'gravity-index',
  })
  if (res.error) return { error: res.error }

  if (res.json && typeof res.json === 'object' && !Array.isArray(res.json)) {
    return {
      result: res.json as JSONObject,
      creditsUsed: res.creditsUsed,
    }
  }

  const error = getStringField(res.json, 'error')
  return { error: error ?? 'Invalid response format' }
}

export async function callTokenCountAPI(params: {
  messages: unknown[]
  system?: string
  model?: string
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>
  fetch: typeof globalThis.fetch
  logger: Logger
  env: CodebuffWebApiEnv
  baseUrl?: string
  apiKey?: string
  // Hard bound on this single call. Defaults to TOKEN_COUNT_TIMEOUT_MS. Pass 0
  // or a negative number (or set CODEBUFF_DISABLE_TIMEOUTS=1) to disable.
  timeoutMs?: number
  // Caller's abort signal (e.g. user cancel). When it fires, the request is
  // actually aborted and the socket released.
  signal?: AbortSignal
}): Promise<{ inputTokens?: number; error?: string }> {
  const { messages, system, model, tools, fetch, logger, env } = params
  const baseUrl = params.baseUrl ?? env.clientEnv.NEXT_PUBLIC_CODEBUFF_APP_URL
  const apiKey = params.apiKey ?? env.ciEnv.CODEBUFF_API_KEY

  if (!baseUrl || !apiKey) {
    return { error: 'Missing Codebuff base URL or API key' }
  }

  const url = `${baseUrl}/api/v1/token-count`
  const payload: Record<string, unknown> = { messages }
  if (system) payload.system = system
  if (model) payload.model = model
  if (tools) payload.tools = tools

  // Use a real AbortController so a hung backend's socket is actually closed on
  // timeout (Promise.race/withTimeout leaks the underlying fetch). The timeout
  // and the caller's signal both abort the same controller.
  const timeoutsDisabled =
    typeof process !== 'undefined' &&
    process.env?.CODEBUFF_DISABLE_TIMEOUTS === '1'
  const timeoutMs = params.timeoutMs ?? TOKEN_COUNT_TIMEOUT_MS
  const controller = new AbortController()
  const onExternalAbort = () => controller.abort()
  if (params.signal) {
    if (params.signal.aborted) controller.abort()
    else params.signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  const timeoutId =
    !timeoutsDisabled && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'x-codebuff-api-key': apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    const text = await res.text()
    const json = tryParseJson(text)

    if (!res.ok) {
      const err =
        getStringField(json, 'error') ??
        getStringField(json, 'message') ??
        text ??
        'Request failed'
      logger.warn(
        {
          url,
          status: res.status,
          statusText: res.statusText,
          body: text?.slice(0, 500),
        },
        'Web API token-count request failed',
      )
      return { error: err }
    }

    const inputTokens = getNumberField(json, 'inputTokens')
    if (typeof inputTokens === 'number') {
      return { inputTokens }
    }

    return { error: 'Invalid response format' }
  } catch (error) {
    const timedOut = controller.signal.aborted && !params.signal?.aborted
    logger.warn(
      {
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : error,
        timedOut,
        timeoutMs,
      },
      timedOut
        ? 'Web API token-count timed out'
        : 'Web API token-count network error',
    )
    return {
      error: timedOut
        ? `token-count timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : 'Network error',
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    if (params.signal)
      params.signal.removeEventListener('abort', onExternalAbort)
  }
}
