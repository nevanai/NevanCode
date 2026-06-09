/**
 * SDK environment helper for dependency injection.
 *
 * This module provides SDK-specific env helpers that extend the base
 * process env with SDK-specific vars for binary paths and WASM.
 */

import { ANTHROPIC_OAUTH_TOKEN_ENV_VAR } from '@codebuff/common/constants/anthropic-oauth'
import { BYOK_OPENROUTER_ENV_VAR } from '@codebuff/common/constants/byok'
import {
  GEMINI_OAUTH_TOKEN_ENV_VAR,
  GEMINI_PROJECT_ENV_VAR,
} from '@codebuff/common/constants/gemini-oauth'
import { CHATGPT_OAUTH_TOKEN_ENV_VAR } from '@codebuff/common/constants/chatgpt-oauth'
import { API_KEY_ENV_VAR } from '@codebuff/common/constants/paths'
import { getBaseEnv } from '@codebuff/common/env-process'

import type { SdkEnv } from './types/env'

/**
 * Get SDK environment values.
 * Composes from getBaseEnv() + SDK-specific vars.
 */
export const getSdkEnv = (): SdkEnv => ({
  ...getBaseEnv(),

  // SDK-specific paths
  CODEBUFF_RG_PATH: process.env.CODEBUFF_RG_PATH,
  CODEBUFF_WASM_DIR: process.env.CODEBUFF_WASM_DIR,

  // Build flags
  VERBOSE: process.env.VERBOSE,
  OVERRIDE_TARGET: process.env.OVERRIDE_TARGET,
  OVERRIDE_PLATFORM: process.env.OVERRIDE_PLATFORM,
  OVERRIDE_ARCH: process.env.OVERRIDE_ARCH,
})

export const getCodebuffApiKeyFromEnv = (): string | undefined => {
  return process.env[API_KEY_ENV_VAR]
}

export const getSystemProcessEnv = (): NodeJS.ProcessEnv => {
  return process.env
}

export const getByokOpenrouterApiKeyFromEnv = (): string | undefined => {
  return process.env[BYOK_OPENROUTER_ENV_VAR]
}

/**
 * Get ChatGPT OAuth token from environment variable.
 */
export const getChatGptOAuthTokenFromEnv = (): string | undefined => {
  return process.env[CHATGPT_OAUTH_TOKEN_ENV_VAR]
}

/**
 * Get Anthropic (Claude) OAuth access token from environment variable.
 */
export const getAnthropicOAuthTokenFromEnv = (): string | undefined => {
  return process.env[ANTHROPIC_OAUTH_TOKEN_ENV_VAR]
}

/**
 * Get Gemini (Google) OAuth access token from environment variable.
 */
export const getGeminiOAuthTokenFromEnv = (): string | undefined => {
  return process.env[GEMINI_OAUTH_TOKEN_ENV_VAR]
}

/**
 * Get an explicit Code Assist project override from environment variable.
 */
export const getGeminiProjectFromEnv = (): string | undefined => {
  return process.env[GEMINI_PROJECT_ENV_VAR]
}
