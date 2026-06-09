/**
 * Auto-select a default OpenAI model for users who connect via ChatGPT OAuth.
 *
 * Without an OpenAI model picked, the agent would run on the default Claude
 * route through the Codebuff backend, which doesn't make sense for users who
 * linked their ChatGPT subscription specifically to bypass the backend. This
 * helper ensures we always route directly to the user's ChatGPT account once
 * they've connected, so they never see "connecting..." stuck on the Codebuff
 * backend health check.
 */

import { logger } from './logger'
import {
  getSelectedOpenAiModel,
  OPENAI_MODEL_OPTIONS,
  saveOpenAiModelPreference,
} from './openai-models'

/** Sensible default — the model the Codex backend actually serves to ChatGPT
 *  free-tier users (gpt-5-codex / gpt-5 require a paid plan). */
const DEFAULT_CHATGPT_OAUTH_MODEL_ID = 'gpt-5.5'

/**
 * If the user has not yet picked an OpenAI model, save the default ChatGPT
 * model so requests route directly to OpenAI rather than the Codebuff backend.
 *
 * Idempotent: if a model is already selected, this is a no-op.
 */
export const ensureDefaultOpenAiModelForChatGptSession = (): void => {
  if (getSelectedOpenAiModel()) {
    return
  }

  // Pick the configured default if it exists in the option list, otherwise
  // fall back to the first option so we never crash on a stale model id.
  const defaultOption =
    OPENAI_MODEL_OPTIONS.find(
      (option) => option.id === DEFAULT_CHATGPT_OAUTH_MODEL_ID,
    ) ?? OPENAI_MODEL_OPTIONS[0]

  if (!defaultOption) {
    return
  }

  // saveOpenAiModelPreference swallows file I/O errors internally, so no
  // try/catch needed here.
  saveOpenAiModelPreference(defaultOption.id)
  logger.info(
    { modelId: defaultOption.id },
    'Auto-selected default OpenAI model for ChatGPT OAuth session',
  )
}
