/**
 * ChatGPT subscription OAuth constants for experimental direct OpenAI routing.
 */

/**
 * Feature flag for ChatGPT OAuth (connect:chatgpt) functionality.
 * Default OFF until validated.
 */
export const CHATGPT_OAUTH_ENABLED = true

/** OAuth client id used by Codex-compatible OAuth ecosystems. */
export const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** OAuth endpoints */
export const CHATGPT_OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
export const CHATGPT_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'

/** Pinned redirect URI for paste-based localhost callback flow. */
export const CHATGPT_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback'

/** Base URL for ChatGPT backend API (Codex endpoint). */
export const CHATGPT_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api'

/** Environment variable for OAuth token override. */
export const CHATGPT_OAUTH_TOKEN_ENV_VAR = 'CODEBUFF_CHATGPT_OAUTH_TOKEN'

/**
 * OpenRouter-style model IDs allowed for ChatGPT OAuth direct routing, mapped to
 * the wire id actually sent to the Codex Responses endpoint
 * (`/backend-api/codex/responses`).
 *
 * IMPORTANT — only a small set of models is served on the *ChatGPT-account* Codex
 * path (subscription OAuth, not API-key auth). Sending any other id makes the
 * backend reject the request with 400 "<model> is not supported when using Codex
 * with a ChatGPT account", which the CLI surfaces as the misleading "your ChatGPT
 * plan does not include Codex API access" error — even on a paid plan that DOES
 * have Codex. (Confirmed empirically: a connected Plus account serves `gpt-5.5`
 * but rejects plain `gpt-5.4`.)
 *
 * So every alias resolves to a known-served wire id:
 *   - `gpt-5`, `gpt-5.5`            — ChatGPT flagship models served via sign-in
 *   - `gpt-5-codex`, `gpt-5.{1,2,3}-codex` — Codex-tuned models native to this endpoint
 * Plain non-Codex mid-tier ids (`gpt-5.4`, `gpt-5.3`…), the o-series, and gpt-4o
 * are NOT on the ChatGPT-account path, so they clamp to `gpt-5`. Keys are kept so
 * a saved `/model` preference still resolves instead of throwing.
 */
export const OPENROUTER_TO_OPENAI_MODEL_MAP: Record<string, string> = {
  // ── Served as-is on the ChatGPT-account Codex path ────────────────────────
  'openai/gpt-5-codex': 'gpt-5-codex',            // Codex agentic coding specialist
  'openai/gpt-5': 'gpt-5',                        // ChatGPT flagship
  'openai/gpt-5.5': 'gpt-5.5',                    // current flagship (verified served)
  'openai/gpt-5.3-codex': 'gpt-5.3-codex',        // Codex-tuned, native to this endpoint
  'openai/gpt-5.2-codex': 'gpt-5.2-codex',
  'openai/gpt-5.1-codex': 'gpt-5.1-codex',
  // ── Codex-y aliases → nearest served Codex model ──────────────────────────
  'openai/gpt-5.4-codex': 'gpt-5-codex',
  'openai/gpt-5.3-codex-spark': 'gpt-5-codex',
  // ── Not served on the ChatGPT-account path → clamp to the flagship ────────
  'openai/gpt-5.5-instant': 'gpt-5.5',
  'openai/gpt-5.4': 'gpt-5',                      // verified rejected on this path
  'openai/gpt-5.4-mini': 'gpt-5',
  'openai/gpt-5.3': 'gpt-5',
  'openai/gpt-5.2': 'gpt-5',
  'openai/gpt-5.1': 'gpt-5',
  'openai/gpt-5.1-chat': 'gpt-5',
  'openai/o4-mini': 'gpt-5',
  'openai/o3-pro': 'gpt-5',
  'openai/o3': 'gpt-5',
  'openai/o3-mini': 'gpt-5',
  'openai/gpt-4o-2024-11-20': 'gpt-5',
  'openai/gpt-4o-mini-2024-07-18': 'gpt-5',
}

export const CHATGPT_OAUTH_OPENAI_MODEL_ALLOWLIST = Object.keys(
  OPENROUTER_TO_OPENAI_MODEL_MAP,
) as Array<keyof typeof OPENROUTER_TO_OPENAI_MODEL_MAP>

export function isOpenAIProviderModel(model: string): boolean {
  return model.startsWith('openai/')
}

/**
 * Check if model is in the explicit ChatGPT OAuth allowlist.
 */
export function isChatGptOAuthModelAllowed(model: string): boolean {
  return model in OPENROUTER_TO_OPENAI_MODEL_MAP
}

/**
 * Normalize OpenRouter-style model IDs to direct OpenAI model IDs.
 * Example: "openai/gpt-5.3-codex" => "gpt-5.3-codex"
 */
export function toOpenAIModelId(model: string): string {
  if (!model.includes('/')) {
    return model
  }

  if (!model.startsWith('openai/')) {
    throw new Error(
      `Cannot convert non-OpenAI model to OpenAI model ID: ${model}`,
    )
  }

  const mapped = OPENROUTER_TO_OPENAI_MODEL_MAP[model]
  if (mapped) {
    return mapped
  }

  // Unknown openai/* id (new model, stale alias): clamp to a served model rather
  // than emitting an id the ChatGPT-account Codex path would reject with a 400.
  return model.includes('codex') ? 'gpt-5-codex' : 'gpt-5'
}
