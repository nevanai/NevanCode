/**
 * Gemini (Google account) OAuth constants for direct routing to the Gemini
 * Code Assist API using the user's personal Google login — the same free path
 * the Gemini CLI uses.
 *
 * NOTE: This reuses the public Gemini CLI OAuth client and the internal
 * `cloudcode-pa.googleapis.com` Code Assist API. Using these in a third-party
 * tool is against Google's terms and may get the account flagged. This is gated
 * behind the user explicitly connecting their account via /connect:gemini.
 */

/** Feature flag for Gemini OAuth (connect:gemini) functionality. */
export const GEMINI_OAUTH_ENABLED = true

/**
 * OAuth client id + secret. Keep these out of git; provide them via env vars
 * when enabling Gemini OAuth locally or in CI.
 */
export const GEMINI_OAUTH_CLIENT_ID =
  process.env.CODEBUFF_GEMINI_OAUTH_CLIENT_ID ?? ''
export const GEMINI_OAUTH_CLIENT_SECRET =
  process.env.CODEBUFF_GEMINI_OAUTH_CLIENT_SECRET ?? ''

/** Google OAuth endpoints (accounts authorize → oauth2 token endpoint). */
export const GEMINI_OAUTH_AUTHORIZE_URL =
  'https://accounts.google.com/o/oauth2/v2/auth'
export const GEMINI_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/**
 * Pinned redirect URI. The Gemini CLI registers this hosted page as the
 * "no browser" callback — it displays the authorization code for the user to
 * paste back (manual flow, mirroring the Claude paste flow). The value MUST be
 * byte-identical between the authorize request and the token exchange.
 */
export const GEMINI_OAUTH_REDIRECT_URI = 'https://codeassist.google.com/authcode'

/** OAuth scopes required for Code Assist inference + profile. */
export const GEMINI_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ')

/** Environment variable for OAuth access-token override (CI / power users). */
export const GEMINI_OAUTH_TOKEN_ENV_VAR = 'CODEBUFF_GEMINI_OAUTH_TOKEN'

/** Optional override for the resolved Code Assist GCP project. */
export const GEMINI_PROJECT_ENV_VAR = 'CODEBUFF_GEMINI_PROJECT'

// ── Code Assist API ──────────────────────────────────────────────────────────

/** Base URL of the internal Code Assist API the Gemini CLI talks to. */
export const GEMINI_CODE_ASSIST_BASE_URL = 'https://cloudcode-pa.googleapis.com'
/** API version segment used by the Code Assist endpoints. */
export const GEMINI_CODE_ASSIST_API_VERSION = 'v1internal'

/**
 * Client metadata sent with loadCodeAssist / onboardUser so the request looks
 * like a Gemini CLI caller.
 */
export const GEMINI_CODE_ASSIST_CLIENT_METADATA = {
  ideType: 'IDE_UNSPECIFIED',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI',
} as const

/** Default onboarding tier when the account has no provisioned project yet. */
export const GEMINI_DEFAULT_TIER_ID = 'free-tier'

/**
 * Dummy thought-signature that tells the Gemini API to skip thought-signature
 * validation for a `functionCall` part. Gemini 3 / thinking models REQUIRE a
 * `thoughtSignature` on function calls echoed back in history; calls we construct
 * ourselves (programmatic agents like basher) or whose real signature we couldn't
 * capture have none, and the API hard-rejects them with 400 "Function call is
 * missing a thought_signature in functionCall parts".
 *
 * Google documents two opaque skip tokens for manually-constructed calls
 * (`context_engineering_is_the_way_to_go` / `skip_thought_signature_validator`),
 * passed as the base64 of the literal string (matching litellm's Gemini-3
 * handling). It's a last resort — a real captured signature is always preferred,
 * since skipping validation can slightly degrade model performance.
 * See https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export const GEMINI_SKIP_THOUGHT_SIGNATURE =
  // base64('skip_thought_signature_validator') — hardcoded (not Buffer.from at
  // load time) so this constant is safe to import from any runtime/bundle.
  'c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I='

// ── Model resolution ─────────────────────────────────────────────────────────

/**
 * Real Code Assist wire model ids.
 */
export const GEMINI_PRO_MODEL = 'gemini-2.5-pro'
export const GEMINI_FLASH_MODEL = 'gemini-2.5-flash'
export const GEMINI_FLASH_LITE_MODEL = 'gemini-2.5-flash-lite'

/** Default model used when a non-Gemini model is routed to the OAuth path. */
export const GEMINI_OAUTH_DEFAULT_MODEL = GEMINI_FLASH_MODEL

/**
 * Map display ids to real Code Assist wire ids.
 */
export const GEMINI_OAUTH_MODEL_MAP: Record<string, string> = {
  // Gemini
  'google/gemini-3-flash-preview':      'gemini-3-flash-preview',
  'google/gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite-preview',
  'google/gemini-2.5-flash':            GEMINI_FLASH_MODEL,
  'google/gemini-2.5-flash-lite':       GEMINI_FLASH_LITE_MODEL,
  // Legacy display ids
  'google/gemini-3.5-flash':            GEMINI_FLASH_MODEL,
  'google/gemini-3.1-pro':              GEMINI_PRO_MODEL,
  'google/gemini-3-flash':              GEMINI_FLASH_MODEL,
  'google/gemini-3-pro':                GEMINI_PRO_MODEL,
  'google/gemini-2.5-pro':              GEMINI_PRO_MODEL,
  // Gemma
  'google/gemma-4-31b-it':              'gemma-4-31b-it',
  'google/gemma-4-26b-a4b-it':          'gemma-4-26b-a4b-it',
}

/**
 * Models shown in the `/model` picker when a Gemini account is connected.
 */
export const GEMINI_OAUTH_DISPLAY_MODELS = [
  'google/gemini-3.1-pro',
  'google/gemini-3.5-flash',
  'google/gemini-3-flash-preview',
  'google/gemini-3.1-flash-lite-preview',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',
  'google/gemma-4-31b-it',
  'google/gemma-4-26b-a4b-it',
] as const

/** Whether a model id targets the Gemini provider (display id form). */
export function isGeminiProviderModel(model: string): boolean {
  return model.startsWith('google/')
}

/**
 * Resolve any model id to a native Gemini wire id usable with the Code Assist
 * OAuth path. Already-native ids (no slash) pass through; unknown ids fall back
 * by tier (pro/flash) and finally to the default flash model.
 */
export function toGeminiModelId(model: string): string {
  if (!model.includes('/')) {
    return model
  }

  const mapped = GEMINI_OAUTH_MODEL_MAP[model]
  if (mapped) {
    return mapped
  }

  const lower = model.toLowerCase()
  if (lower.includes('gemma')) return lower.includes('/') ? model.split('/').pop()! : model
  if (lower.includes('pro')) return GEMINI_PRO_MODEL
  if (lower.includes('flash')) return GEMINI_FLASH_MODEL

  // Non-Gemini model routed to the OAuth path — use the default.
  return GEMINI_OAUTH_DEFAULT_MODEL
}
