/**
 * Anthropic (Claude Pro/Max) subscription OAuth constants for direct routing to
 * the native Anthropic Messages API using the user's Claude Code OAuth token.
 *
 * NOTE: This reuses the public Claude Code OAuth client. Using a Pro/Max
 * subscription token in a third-party tool is against Anthropic's consumer
 * terms and may get the account flagged. This is gated behind the user
 * explicitly connecting their account via /connect:claude.
 */

/** Feature flag for Anthropic OAuth (connect:claude) functionality. */
export const ANTHROPIC_OAUTH_ENABLED = true

/** Public OAuth client id used by Claude Code. */
export const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

/** OAuth endpoints (claude.ai authorize → console token endpoint). */
export const ANTHROPIC_OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
export const ANTHROPIC_OAUTH_TOKEN_URL =
  'https://console.anthropic.com/v1/oauth/token'

/**
 * Pinned redirect URI. The client only permits the hosted console callback,
 * which displays a `code#state` value for the user to paste back (manual flow).
 */
export const ANTHROPIC_OAUTH_REDIRECT_URI =
  'https://console.anthropic.com/oauth/code/callback'

/** OAuth scopes required for inference + profile. */
export const ANTHROPIC_OAUTH_SCOPES =
  'org:create_api_key user:profile user:inference'

/** Environment variable for OAuth access-token override (CI / power users). */
export const ANTHROPIC_OAUTH_TOKEN_ENV_VAR = 'CODEBUFF_ANTHROPIC_OAUTH_TOKEN'

/**
 * Beta flags sent on every OAuth request. `oauth-2025-04-20` is what unlocks
 * the subscription path; interleaved thinking matches Claude Code behavior.
 */
export const ANTHROPIC_OAUTH_BETA_FLAGS = [
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
] as const

/**
 * The Anthropic OAuth path only accepts requests whose first system block
 * identifies as Claude Code. Without this exact prefix the API returns 401/403.
 */
export const ANTHROPIC_CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

/** User-Agent + billing-header version markers mirrored from Claude Code. */
export const ANTHROPIC_OAUTH_CLIENT_VERSION = '2.1.76'
export const ANTHROPIC_OAUTH_USER_AGENT = `claude-code/${ANTHROPIC_OAUTH_CLIENT_VERSION}`
export const ANTHROPIC_OAUTH_BILLING_SALT = '59cf53e54c78'
export const ANTHROPIC_CODE_ENTRYPOINT_ENV_VAR = 'CLAUDE_CODE_ENTRYPOINT'

/**
 * Tool names are prefixed with this on the way out and stripped from the
 * response stream. The OAuth path treats arbitrary tool names as if they were
 * external MCP tools; without the prefix native tool calls can be rejected.
 */
export const ANTHROPIC_OAUTH_TOOL_PREFIX = 'mcp_'

// ── Model resolution ─────────────────────────────────────────────────────────

/** Latest real native model ids (per @ai-sdk/anthropic 2.0.50). */
export const ANTHROPIC_OPUS_MODEL = 'claude-opus-4-5'
export const ANTHROPIC_SONNET_MODEL = 'claude-sonnet-4-5'
export const ANTHROPIC_HAIKU_MODEL = 'claude-haiku-4-5'

/** Default model used when a non-Anthropic model is routed to the OAuth path. */
export const ANTHROPIC_OAUTH_DEFAULT_MODEL = ANTHROPIC_SONNET_MODEL

/**
 * Map the repo's OpenRouter-style ids to real native Anthropic ids. Speculative
 * future versions (4.6/4.7) collapse to the latest shipping model of that tier
 * so requests never 404.
 */
export const ANTHROPIC_OAUTH_MODEL_MAP: Record<string, string> = {
  'anthropic/claude-opus-4.8': ANTHROPIC_OPUS_MODEL,
  'anthropic/claude-opus-4.7': ANTHROPIC_OPUS_MODEL,
  'anthropic/claude-opus-4.6': ANTHROPIC_OPUS_MODEL,
  'anthropic/claude-opus-4.5': ANTHROPIC_OPUS_MODEL,
  'anthropic/claude-opus-4.1': 'claude-opus-4-1',
  'anthropic/claude-sonnet-4.6': ANTHROPIC_SONNET_MODEL,
  'anthropic/claude-sonnet-4.5': ANTHROPIC_SONNET_MODEL,
  'anthropic/claude-haiku-4.5': ANTHROPIC_HAIKU_MODEL,
}

/**
 * Models shown in the `/model` picker when a Claude account is connected.
 * Display ids (OpenRouter-style); resolved to real wire ids by
 * {@link toAnthropicModelId}. The user-facing version labels may run ahead of
 * the actual shipping model each one resolves to — that's intentional, so the
 * request never 404s on an unverified id.
 */
export const ANTHROPIC_OAUTH_DISPLAY_MODELS = [
  'anthropic/claude-opus-4.8',
  'anthropic/claude-opus-4.7',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-haiku-4.5',
] as const

/** Whether a model id targets the Anthropic provider (OpenRouter-style). */
export function isAnthropicProviderModel(model: string): boolean {
  return model.startsWith('anthropic/')
}

/**
 * Resolve any model id to a native Anthropic model id usable with the OAuth
 * path. Already-native ids pass through; unknown ids fall back by tier.
 */
export function toAnthropicModelId(model: string): string {
  if (!model.includes('/')) {
    return model
  }

  const mapped = ANTHROPIC_OAUTH_MODEL_MAP[model]
  if (mapped) {
    return mapped
  }

  const lower = model.toLowerCase()
  if (lower.includes('opus')) return ANTHROPIC_OPUS_MODEL
  if (lower.includes('haiku')) return ANTHROPIC_HAIKU_MODEL
  if (lower.includes('sonnet')) return ANTHROPIC_SONNET_MODEL

  // Non-Anthropic model routed to the OAuth path (user connected Claude but the
  // agent requested e.g. an openai/* model) — use the default.
  return ANTHROPIC_OAUTH_DEFAULT_MODEL
}
