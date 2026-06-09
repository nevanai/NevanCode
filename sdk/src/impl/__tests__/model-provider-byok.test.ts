import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import {
  clearMockedModules,
  mockModule,
} from '@codebuff/common/testing/mock-modules'

/**
 * Verifies that BYOK (Bring Your Own Key) routing is isolated from ChatGPT OAuth.
 * When a BYOK provider is connected, all requests must route through that provider
 * and must never fall through to ChatGPT OAuth.
 */
describe('getModelForRequest — BYOK routing', () => {
  type ByokCreds = { apiKey: string; connectedAt: number } | null
  type ChatGptCreds = { accessToken: string; refreshToken: string; expiresAt: number; connectedAt: number } | null

  type GeminiCreds =
    | {
        accessToken: string
        refreshToken: string
        expiresAt: number
        connectedAt: number
        cloudaicompanionProject?: string
      }
    | null

  const mockGetFireworksApiKey = mock(() => null as ByokCreds)
  const mockGetOpenRouterApiKey = mock(() => null as ByokCreds)
  const mockGetValidChatGptOAuthCredentials = mock(() => Promise.resolve(null as ChatGptCreds))
  const mockGetValidAnthropicOAuthCredentials = mock(() => Promise.resolve(null as ChatGptCreds))
  const mockGetValidGeminiOAuthCredentials = mock(() => Promise.resolve(null as GeminiCreds))

  const FIREWORKS_CREDS = { apiKey: 'fw-test-key', connectedAt: Date.now() }
  const OPENROUTER_CREDS = { apiKey: 'or-test-key', connectedAt: Date.now() }
  const CHATGPT_CREDS = {
    accessToken: 'chatgpt-token',
    refreshToken: '',
    expiresAt: Date.now() + 60_000,
    connectedAt: Date.now(),
  }

  beforeEach(async () => {
    await mockModule('@codebuff/common/constants/chatgpt-oauth', () => ({
      CHATGPT_OAUTH_ENABLED: true,
      isChatGptOAuthModelAllowed: () => true,
      isOpenAIProviderModel: (m: string) => m.startsWith('openai/'),
      toOpenAIModelId: (m: string) => m.replace('openai/', ''),
      CHATGPT_BACKEND_BASE_URL: 'https://chatgpt.example.com',
    }))

    mock.module('../../credentials', () => ({
      getFireworksApiKey: mockGetFireworksApiKey,
      getOpenRouterApiKey: mockGetOpenRouterApiKey,
      getValidChatGptOAuthCredentials: mockGetValidChatGptOAuthCredentials,
      getValidAnthropicOAuthCredentials: mockGetValidAnthropicOAuthCredentials,
      refreshAnthropicOAuthToken: () => Promise.resolve(null),
      getValidGeminiOAuthCredentials: mockGetValidGeminiOAuthCredentials,
      refreshGeminiOAuthToken: () => Promise.resolve(null),
      saveGeminiOAuthProject: () => {},
    }))

    mockGetFireworksApiKey.mockReturnValue(null)
    mockGetOpenRouterApiKey.mockReturnValue(null)
    // Clear call history (not just return value) so per-test call-count
    // assertions aren't polluted by earlier tests.
    mockGetValidChatGptOAuthCredentials.mockClear()
    mockGetValidChatGptOAuthCredentials.mockResolvedValue(null)
    mockGetValidAnthropicOAuthCredentials.mockClear()
    mockGetValidAnthropicOAuthCredentials.mockResolvedValue(null)
    mockGetValidGeminiOAuthCredentials.mockClear()
    mockGetValidGeminiOAuthCredentials.mockResolvedValue(null)
  })

  afterEach(() => {
    mock.restore()
    clearMockedModules()
  })

  async function importFresh() {
    const mod = await import('../model-provider')
    mod.resetChatGptOAuthRateLimit()
    return mod
  }

  // ── Fireworks BYOK ────────────────────────────────────────────────────────

  test('Fireworks BYOK: fireworks/ model routes to Fireworks (not ChatGPT)', async () => {
    mockGetFireworksApiKey.mockReturnValue(FIREWORKS_CREDS)
    const { getModelForRequest } = await importFresh()

    const result = await getModelForRequest({
      apiKey: 'codebuff-key',
      model: 'fireworks/accounts/fireworks/models/deepseek-r1',
    })

    expect(result.isChatGptOAuth).toBe(false)
  })

  test('Fireworks BYOK: non-fireworks model still routes to Fireworks (never ChatGPT/backend)', async () => {
    // A subagent left on its default model (e.g. anthropic/...) must NOT break the
    // run or leak to ChatGPT — it routes to Fireworks so the user stays on-provider.
    mockGetFireworksApiKey.mockReturnValue(FIREWORKS_CREDS)
    const { getModelForRequest } = await importFresh()

    const result = await getModelForRequest({
      apiKey: 'codebuff-key',
      model: 'anthropic/claude-sonnet-4',
    })

    expect(result.isChatGptOAuth).toBe(false)
  })

  test('Fireworks BYOK: routes to Fireworks even when ChatGPT OAuth credentials exist', async () => {
    mockGetFireworksApiKey.mockReturnValue(FIREWORKS_CREDS)
    mockGetValidChatGptOAuthCredentials.mockResolvedValue(CHATGPT_CREDS)
    const { getModelForRequest } = await importFresh()

    // Must NOT silently route to ChatGPT when Fireworks is connected
    const result = await getModelForRequest({
      apiKey: 'codebuff-key',
      model: 'openai/gpt-5.5',
    })

    expect(result.isChatGptOAuth).toBe(false)
  })

  // ── OpenRouter BYOK ───────────────────────────────────────────────────────

  test('OpenRouter BYOK: routes any model to OpenRouter (not ChatGPT)', async () => {
    mockGetOpenRouterApiKey.mockReturnValue(OPENROUTER_CREDS)
    const { getModelForRequest } = await importFresh()

    const result = await getModelForRequest({
      apiKey: 'codebuff-key',
      model: 'anthropic/claude-sonnet-4',
    })

    expect(result.isChatGptOAuth).toBe(false)
  })

  test('OpenRouter BYOK: does not fall through to ChatGPT fallback even when ChatGPT OAuth exists', async () => {
    mockGetOpenRouterApiKey.mockReturnValue(OPENROUTER_CREDS)
    mockGetValidChatGptOAuthCredentials.mockResolvedValue(CHATGPT_CREDS)
    const { getModelForRequest } = await importFresh()

    // meta-llama model would normally trigger ChatGPT fallback (not in allowlist)
    const result = await getModelForRequest({
      apiKey: 'codebuff-key',
      model: 'meta-llama/llama-3.1-70b',
    })

    expect(result.isChatGptOAuth).toBe(false)
  })

  test('OpenRouter BYOK: routes openai/ prefixed model to OpenRouter, not ChatGPT', async () => {
    mockGetOpenRouterApiKey.mockReturnValue(OPENROUTER_CREDS)
    mockGetValidChatGptOAuthCredentials.mockResolvedValue(CHATGPT_CREDS)
    const { getModelForRequest } = await importFresh()

    const result = await getModelForRequest({
      apiKey: 'codebuff-key',
      model: 'openai/gpt-5.5',
    })

    expect(result.isChatGptOAuth).toBe(false)
  })

  // ── Anthropic (Claude Pro/Max) OAuth ──────────────────────────────────────

  const ANTHROPIC_CREDS = {
    accessToken: 'anthropic-oauth-token',
    refreshToken: 'anthropic-refresh',
    expiresAt: Date.now() + 60_000,
    connectedAt: Date.now(),
  }

  test('Anthropic OAuth: connected account routes every model to Claude (not ChatGPT/backend)', async () => {
    mockGetValidAnthropicOAuthCredentials.mockResolvedValue(ANTHROPIC_CREDS)
    mockGetValidChatGptOAuthCredentials.mockResolvedValue(CHATGPT_CREDS)
    const { getModelForRequest } = await importFresh()

    const result = await getModelForRequest({
      apiKey: 'codebuff-key',
      model: 'openai/gpt-5.5',
    })

    expect(result.isChatGptOAuth).toBe(false)
    expect(result.model).toBeDefined()
    // Anthropic short-circuits before the ChatGPT OAuth path is consulted.
    expect(mockGetValidChatGptOAuthCredentials).not.toHaveBeenCalled()
  })

  test('Anthropic OAuth: explicit BYOK key still wins over a connected Claude account', async () => {
    mockGetOpenRouterApiKey.mockReturnValue(OPENROUTER_CREDS)
    mockGetValidAnthropicOAuthCredentials.mockResolvedValue(ANTHROPIC_CREDS)
    const { getModelForRequest } = await importFresh()

    const result = await getModelForRequest({
      apiKey: 'codebuff-key',
      model: 'anthropic/claude-sonnet-4.5',
    })

    expect(result.isChatGptOAuth).toBe(false)
    // BYOK returns first, so the Anthropic OAuth path is never consulted.
    expect(mockGetValidAnthropicOAuthCredentials).not.toHaveBeenCalled()
  })

  // ── Gemini (Google account) OAuth ─────────────────────────────────────────

  const GEMINI_CREDS = {
    accessToken: 'gemini-oauth-token',
    refreshToken: 'gemini-refresh',
    expiresAt: Date.now() + 60_000,
    connectedAt: Date.now(),
    // Pre-resolved project so routing never makes a network call in the test.
    cloudaicompanionProject: 'test-project',
  }

  test('Gemini OAuth: connected account routes every model to Gemini (not ChatGPT/backend)', async () => {
    mockGetValidGeminiOAuthCredentials.mockResolvedValue(GEMINI_CREDS)
    mockGetValidChatGptOAuthCredentials.mockResolvedValue(CHATGPT_CREDS)
    const { getModelForRequest } = await importFresh()

    const result = await getModelForRequest({
      apiKey: 'codebuff-key',
      model: 'openai/gpt-5.5',
    })

    expect(result.isChatGptOAuth).toBe(false)
    expect(result.model).toBeDefined()
    // Gemini short-circuits before the ChatGPT OAuth path is consulted.
    expect(mockGetValidChatGptOAuthCredentials).not.toHaveBeenCalled()
  })

  test('Gemini OAuth: a connected Claude account still wins over Gemini (checked first)', async () => {
    mockGetValidAnthropicOAuthCredentials.mockResolvedValue(ANTHROPIC_CREDS)
    mockGetValidGeminiOAuthCredentials.mockResolvedValue(GEMINI_CREDS)
    const { getModelForRequest } = await importFresh()

    const result = await getModelForRequest({
      apiKey: 'codebuff-key',
      model: 'google/gemini-3.1-pro',
    })

    expect(result.isChatGptOAuth).toBe(false)
    // Anthropic returns first, so the Gemini OAuth path is never consulted.
    expect(mockGetValidGeminiOAuthCredentials).not.toHaveBeenCalled()
  })

  test('Gemini OAuth: explicit BYOK key still wins over a connected Gemini account', async () => {
    mockGetOpenRouterApiKey.mockReturnValue(OPENROUTER_CREDS)
    mockGetValidGeminiOAuthCredentials.mockResolvedValue(GEMINI_CREDS)
    const { getModelForRequest } = await importFresh()

    const result = await getModelForRequest({
      apiKey: 'codebuff-key',
      model: 'google/gemini-3.1-pro',
    })

    expect(result.isChatGptOAuth).toBe(false)
    // BYOK returns first, so the Gemini OAuth path is never consulted.
    expect(mockGetValidGeminiOAuthCredentials).not.toHaveBeenCalled()
  })

  // ── No BYOK — existing behavior unchanged ─────────────────────────────────

  test('No BYOK: routes to Codebuff backend when no credentials', async () => {
    // Both BYOK mocks return null; ChatGPT OAuth also null
    const { getModelForRequest } = await importFresh()

    const result = await getModelForRequest({
      apiKey: 'codebuff-key',
      model: 'anthropic/claude-sonnet-4',
    })

    expect(result.isChatGptOAuth).toBe(false)
  })

  // ── ChatGPT OAuth fallback (the basher/subagent bug) ──────────────────────

  test('ChatGPT OAuth: a non-OpenAI subagent model falls back to gpt-5-codex (served), not gpt-5.4', async () => {
    // basher/file-lister/researcher default to google/gemini-* and are NOT in the
    // CLI's OpenAI override set, so they reach this fallback. It must emit a model
    // SERVED on the ChatGPT-account Codex path. The old gpt-5.4 fallback was
    // rejected ("not supported when using Codex with a ChatGPT account").
    mockGetValidChatGptOAuthCredentials.mockResolvedValue(CHATGPT_CREDS)
    const { getModelForRequest } = await importFresh()

    const result = await getModelForRequest({
      apiKey: 'codebuff-key',
      model: 'google/gemini-3.1-flash-lite-preview',
    })

    expect(result.isChatGptOAuth).toBe(true)
    expect((result.model as { modelId?: string }).modelId).toBe('gpt-5-codex')
  })
})
