import fs from 'fs'
import path from 'node:path'
import os from 'os'

import {
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_OAUTH_TOKEN_URL,
} from '@codebuff/common/constants/anthropic-oauth'
import {
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_TOKEN_URL,
} from '@codebuff/common/constants/chatgpt-oauth'
import {
  GEMINI_OAUTH_CLIENT_ID,
  GEMINI_OAUTH_CLIENT_SECRET,
  GEMINI_OAUTH_TOKEN_URL,
} from '@codebuff/common/constants/gemini-oauth'
import { env } from '@codebuff/common/env'
import { userSchema } from '@codebuff/common/util/credentials'
import { z } from 'zod/v4'

import {
  getAnthropicOAuthTokenFromEnv,
  getChatGptOAuthTokenFromEnv,
  getGeminiOAuthTokenFromEnv,
  getGeminiProjectFromEnv,
} from './env'

import type { ClientEnv } from '@codebuff/common/types/contracts/env'
import type { User } from '@codebuff/common/util/credentials'

const chatGptOAuthSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  connectedAt: z.number(),
})

const anthropicOAuthSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  connectedAt: z.number(),
})

const geminiOAuthSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  connectedAt: z.number(),
  // Resolved Code Assist project id (cloudaicompanionProject). Cached here so a
  // restart doesn't have to re-run loadCodeAssist/onboardUser.
  cloudaicompanionProject: z.string().optional(),
})

const byokApiKeySchema = z.object({
  apiKey: z.string(),
  connectedAt: z.number(),
})

export type ByokApiKeyCredentials = z.infer<typeof byokApiKeySchema>

/**
 * Unified schema for the credentials file.
 * Contains Codebuff user credentials, ChatGPT OAuth credentials, and BYOK provider keys.
 */
const credentialsFileSchema = z.object({
  default: userSchema.optional(),
  chatgptOAuth: chatGptOAuthSchema.optional(),
  anthropicOAuth: anthropicOAuthSchema.optional(),
  geminiOAuth: geminiOAuthSchema.optional(),
  fireworksApiKey: byokApiKeySchema.optional(),
  openRouterApiKey: byokApiKeySchema.optional(),
})

const ensureDirectoryExistsSync = (dir: string) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export const userFromJson = (json: string): User | null => {
  try {
    const credentials = credentialsFileSchema.parse(JSON.parse(json))
    return credentials.default ?? null
  } catch {
    return null
  }
}

/**
 * Get the config directory path based on the environment.
 * Uses the clientEnv to determine the environment suffix.
 */
export const getConfigDir = (clientEnv: ClientEnv = env): string => {
  const envSuffix =
    clientEnv.NEXT_PUBLIC_CB_ENVIRONMENT &&
    clientEnv.NEXT_PUBLIC_CB_ENVIRONMENT !== 'prod'
      ? `-${clientEnv.NEXT_PUBLIC_CB_ENVIRONMENT}`
      : ''
  return path.join(os.homedir(), '.config', `manicode${envSuffix}`)
}

/**
 * Get the credentials file path based on the environment.
 */
export const getCredentialsPath = (clientEnv: ClientEnv = env): string => {
  return path.join(getConfigDir(clientEnv), 'credentials.json')
}

export const getUserCredentials = (clientEnv: ClientEnv = env): User | null => {
  const credentialsPath = getCredentialsPath(clientEnv)
  if (!fs.existsSync(credentialsPath)) {
    return null
  }

  try {
    const credentialsFile = fs.readFileSync(credentialsPath, 'utf8')
    const user = userFromJson(credentialsFile)
    return user || null
  } catch (error) {
    console.error('Error reading credentials', error)
    return null
  }
}

/**
 * ChatGPT OAuth credentials stored in the credentials file.
 */
export interface ChatGptOAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number // Unix timestamp in milliseconds
  connectedAt: number // Unix timestamp in milliseconds
}

/**
 * Get ChatGPT OAuth credentials from environment variable or stored file.
 * Environment variable takes precedence.
 */
export const getChatGptOAuthCredentials = (
  clientEnv: ClientEnv = env,
): ChatGptOAuthCredentials | null => {
  // 1. Environment variable takes highest precedence
  const envToken = getChatGptOAuthTokenFromEnv()
  if (envToken) {
    return {
      accessToken: envToken,
      refreshToken: '',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      connectedAt: Date.now(),
    }
  }

  // 2. Codebuff's own stored credentials
  // Parse the chatgptOAuth field independently — the broader credentials
  // file schema requires fingerprint fields on `default` that may not be
  // present when the user logged in via OpenAI OAuth, and a single bad
  // sibling field would otherwise mask a perfectly valid OAuth record.
  const credentialsPath = getCredentialsPath(clientEnv)
  if (fs.existsSync(credentialsPath)) {
    try {
      const credentialsFile = fs.readFileSync(credentialsPath, 'utf8')
      const raw = JSON.parse(credentialsFile) as { chatgptOAuth?: unknown }
      const parsedOAuth = chatGptOAuthSchema.safeParse(raw.chatgptOAuth)
      if (parsedOAuth.success) {
        return parsedOAuth.data
      }
    } catch {
      // Fall through
    }
  }

  return null
}

export const saveChatGptOAuthCredentials = (
  credentials: ChatGptOAuthCredentials,
  clientEnv: ClientEnv = env,
): void => {
  const configDir = getConfigDir(clientEnv)
  const credentialsPath = getCredentialsPath(clientEnv)

  ensureDirectoryExistsSync(configDir)

  let existingData: Record<string, unknown> = {}
  if (fs.existsSync(credentialsPath)) {
    try {
      existingData = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
    } catch {
      // Ignore parse errors, start fresh
    }
  }

  const updatedData = {
    ...existingData,
    chatgptOAuth: credentials,
  }

  fs.writeFileSync(credentialsPath, JSON.stringify(updatedData, null, 2))
}

export const clearChatGptOAuthCredentials = (
  clientEnv: ClientEnv = env,
): void => {
  const credentialsPath = getCredentialsPath(clientEnv)
  if (!fs.existsSync(credentialsPath)) {
    return
  }

  try {
    const existingData = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
    delete existingData.chatgptOAuth
    fs.writeFileSync(credentialsPath, JSON.stringify(existingData, null, 2))
  } catch {
    // Ignore errors
  }
}

// ── BYOK provider helpers ─────────────────────────────────────────────────────

function readByokKey(
  field: 'fireworksApiKey' | 'openRouterApiKey',
  clientEnv: ClientEnv = env,
): ByokApiKeyCredentials | null {
  const credentialsPath = getCredentialsPath(clientEnv)
  if (!fs.existsSync(credentialsPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as Record<string, unknown>
    const parsed = byokApiKeySchema.safeParse(raw[field])
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function saveByokKey(
  field: 'fireworksApiKey' | 'openRouterApiKey',
  apiKey: string,
  clientEnv: ClientEnv = env,
): void {
  const configDir = getConfigDir(clientEnv)
  const credentialsPath = getCredentialsPath(clientEnv)
  ensureDirectoryExistsSync(configDir)

  let existing: Record<string, unknown> = {}
  if (fs.existsSync(credentialsPath)) {
    try { existing = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) } catch { /* ok */ }
  }
  fs.writeFileSync(
    credentialsPath,
    JSON.stringify({ ...existing, [field]: { apiKey, connectedAt: Date.now() } }, null, 2),
  )
}

function clearByokKey(
  field: 'fireworksApiKey' | 'openRouterApiKey',
  clientEnv: ClientEnv = env,
): void {
  const credentialsPath = getCredentialsPath(clientEnv)
  if (!fs.existsSync(credentialsPath)) return
  try {
    const existing = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')) as Record<string, unknown>
    delete existing[field]
    fs.writeFileSync(credentialsPath, JSON.stringify(existing, null, 2))
  } catch { /* ignore */ }
}

export const getFireworksApiKey = (clientEnv?: ClientEnv): ByokApiKeyCredentials | null =>
  readByokKey('fireworksApiKey', clientEnv)
export const saveFireworksApiKey = (apiKey: string, clientEnv?: ClientEnv): void =>
  saveByokKey('fireworksApiKey', apiKey, clientEnv)
export const clearFireworksApiKey = (clientEnv?: ClientEnv): void =>
  clearByokKey('fireworksApiKey', clientEnv)

export const getOpenRouterApiKey = (clientEnv?: ClientEnv): ByokApiKeyCredentials | null =>
  readByokKey('openRouterApiKey', clientEnv)
export const saveOpenRouterApiKey = (apiKey: string, clientEnv?: ClientEnv): void =>
  saveByokKey('openRouterApiKey', apiKey, clientEnv)
export const clearOpenRouterApiKey = (clientEnv?: ClientEnv): void =>
  clearByokKey('openRouterApiKey', clientEnv)

/** Returns true if any BYOK provider key is stored — used to skip Codebuff auth validation. */
export const isAnyByokProviderLinked = (clientEnv?: ClientEnv): boolean =>
  !!getFireworksApiKey(clientEnv) || !!getOpenRouterApiKey(clientEnv)

export const isChatGptOAuthValid = (clientEnv: ClientEnv = env): boolean => {
  const credentials = getChatGptOAuthCredentials(clientEnv)
  if (!credentials) {
    return false
  }
  const bufferMs = 5 * 60 * 1000
  return credentials.expiresAt > Date.now() + bufferMs
}

let chatGptRefreshPromise: Promise<ChatGptOAuthCredentials | null> | null = null

export const refreshChatGptOAuthToken = async (
  clientEnv: ClientEnv = env,
): Promise<ChatGptOAuthCredentials | null> => {
  if (chatGptRefreshPromise) {
    return chatGptRefreshPromise
  }

  const credentials = getChatGptOAuthCredentials(clientEnv)
  if (!credentials?.refreshToken) {
    return null
  }

  chatGptRefreshPromise = (async () => {
    try {
      const response = await fetch(CHATGPT_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: credentials.refreshToken,
          client_id: CHATGPT_OAUTH_CLIENT_ID,
        }),
      })

      if (!response.ok) {
        console.debug(`ChatGPT OAuth token refresh failed (status ${response.status})`)
        return null
      }

      const data = await response.json()

      if (
        typeof data?.access_token !== 'string' ||
        data.access_token.trim().length === 0
      ) {
        console.debug('ChatGPT OAuth token refresh returned empty access token')
        return null
      }

      const expiresIn =
        typeof data.expires_in === 'number' ? data.expires_in * 1000 : 3600 * 1000

      const newCredentials: ChatGptOAuthCredentials = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? credentials.refreshToken,
        expiresAt: Date.now() + expiresIn,
        connectedAt: credentials.connectedAt,
      }

      saveChatGptOAuthCredentials(newCredentials, clientEnv)

      return newCredentials
    } catch (error) {
      console.debug('ChatGPT OAuth token refresh failed:', error instanceof Error ? error.message : String(error))
      return null
    } finally {
      chatGptRefreshPromise = null
    }
  })()

  return chatGptRefreshPromise
}

export const getValidChatGptOAuthCredentials = async (
  clientEnv: ClientEnv = env,
): Promise<ChatGptOAuthCredentials | null> => {
  const credentials = getChatGptOAuthCredentials(clientEnv)
  if (!credentials) {
    return null
  }

  const bufferMs = 5 * 60 * 1000

  // No refresh token (e.g. env var override) — return only if still valid
  if (!credentials.refreshToken) {
    return credentials.expiresAt > Date.now() + bufferMs ? credentials : null
  }

  if (credentials.expiresAt > Date.now() + bufferMs) {
    return credentials
  }

  return refreshChatGptOAuthToken(clientEnv)
}

// ── Anthropic (Claude Pro/Max) OAuth credentials ─────────────────────────────

/**
 * Anthropic (Claude) OAuth credentials stored in the credentials file.
 */
export interface AnthropicOAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number // Unix timestamp in milliseconds
  connectedAt: number // Unix timestamp in milliseconds
}

/**
 * Get Anthropic OAuth credentials from environment variable or stored file.
 * Environment variable takes precedence.
 */
export const getAnthropicOAuthCredentials = (
  clientEnv: ClientEnv = env,
): AnthropicOAuthCredentials | null => {
  // 1. Environment variable takes highest precedence
  const envToken = getAnthropicOAuthTokenFromEnv()
  if (envToken) {
    return {
      accessToken: envToken,
      refreshToken: '',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      connectedAt: Date.now(),
    }
  }

  // 2. Stored credentials — parse the anthropicOAuth field independently so a
  // bad sibling field can't mask a valid OAuth record.
  const credentialsPath = getCredentialsPath(clientEnv)
  if (fs.existsSync(credentialsPath)) {
    try {
      const credentialsFile = fs.readFileSync(credentialsPath, 'utf8')
      const raw = JSON.parse(credentialsFile) as { anthropicOAuth?: unknown }
      const parsedOAuth = anthropicOAuthSchema.safeParse(raw.anthropicOAuth)
      if (parsedOAuth.success) {
        return parsedOAuth.data
      }
    } catch {
      // Fall through
    }
  }

  return null
}

export const saveAnthropicOAuthCredentials = (
  credentials: AnthropicOAuthCredentials,
  clientEnv: ClientEnv = env,
): void => {
  const configDir = getConfigDir(clientEnv)
  const credentialsPath = getCredentialsPath(clientEnv)

  ensureDirectoryExistsSync(configDir)

  let existingData: Record<string, unknown> = {}
  if (fs.existsSync(credentialsPath)) {
    try {
      existingData = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
    } catch {
      // Ignore parse errors, start fresh
    }
  }

  const updatedData = {
    ...existingData,
    anthropicOAuth: credentials,
  }

  fs.writeFileSync(credentialsPath, JSON.stringify(updatedData, null, 2))
}

export const clearAnthropicOAuthCredentials = (
  clientEnv: ClientEnv = env,
): void => {
  const credentialsPath = getCredentialsPath(clientEnv)
  if (!fs.existsSync(credentialsPath)) {
    return
  }

  try {
    const existingData = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
    delete existingData.anthropicOAuth
    fs.writeFileSync(credentialsPath, JSON.stringify(existingData, null, 2))
  } catch {
    // Ignore errors
  }
}

export const isAnthropicOAuthValid = (clientEnv: ClientEnv = env): boolean => {
  const credentials = getAnthropicOAuthCredentials(clientEnv)
  if (!credentials) {
    return false
  }
  const bufferMs = 5 * 60 * 1000
  return credentials.expiresAt > Date.now() + bufferMs
}

let anthropicRefreshPromise: Promise<AnthropicOAuthCredentials | null> | null =
  null

export const refreshAnthropicOAuthToken = async (
  clientEnv: ClientEnv = env,
): Promise<AnthropicOAuthCredentials | null> => {
  if (anthropicRefreshPromise) {
    return anthropicRefreshPromise
  }

  const credentials = getAnthropicOAuthCredentials(clientEnv)
  if (!credentials?.refreshToken) {
    return null
  }

  anthropicRefreshPromise = (async () => {
    try {
      const response = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: credentials.refreshToken,
          client_id: ANTHROPIC_OAUTH_CLIENT_ID,
        }),
      })

      if (!response.ok) {
        console.debug(
          `Anthropic OAuth token refresh failed (status ${response.status})`,
        )
        return null
      }

      const data = await response.json()

      if (
        typeof data?.access_token !== 'string' ||
        data.access_token.trim().length === 0
      ) {
        console.debug('Anthropic OAuth token refresh returned empty access token')
        return null
      }

      const expiresIn =
        typeof data.expires_in === 'number'
          ? data.expires_in * 1000
          : 3600 * 1000

      const newCredentials: AnthropicOAuthCredentials = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? credentials.refreshToken,
        expiresAt: Date.now() + expiresIn,
        connectedAt: credentials.connectedAt,
      }

      saveAnthropicOAuthCredentials(newCredentials, clientEnv)

      return newCredentials
    } catch (error) {
      console.debug(
        'Anthropic OAuth token refresh failed:',
        error instanceof Error ? error.message : String(error),
      )
      return null
    } finally {
      anthropicRefreshPromise = null
    }
  })()

  return anthropicRefreshPromise
}

export const getValidAnthropicOAuthCredentials = async (
  clientEnv: ClientEnv = env,
): Promise<AnthropicOAuthCredentials | null> => {
  const credentials = getAnthropicOAuthCredentials(clientEnv)
  if (!credentials) {
    return null
  }

  const bufferMs = 5 * 60 * 1000

  // No refresh token (e.g. env var override) — return only if still valid
  if (!credentials.refreshToken) {
    return credentials.expiresAt > Date.now() + bufferMs ? credentials : null
  }

  if (credentials.expiresAt > Date.now() + bufferMs) {
    return credentials
  }

  return refreshAnthropicOAuthToken(clientEnv)
}

// ── Gemini (Google account) OAuth credentials ────────────────────────────────

/**
 * Gemini (Google) OAuth credentials stored in the credentials file. Unlike the
 * other OAuth providers, Google's token endpoint is form-encoded and requires
 * the client_secret on both exchange and refresh.
 */
export interface GeminiOAuthCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number // Unix timestamp in milliseconds
  connectedAt: number // Unix timestamp in milliseconds
  /** Cached Code Assist project id (cloudaicompanionProject), if resolved. */
  cloudaicompanionProject?: string
}

/**
 * Get Gemini OAuth credentials from environment variable or stored file.
 * Environment variable takes precedence.
 */
export const getGeminiOAuthCredentials = (
  clientEnv: ClientEnv = env,
): GeminiOAuthCredentials | null => {
  // 1. Environment variable takes highest precedence
  const envToken = getGeminiOAuthTokenFromEnv()
  if (envToken) {
    return {
      accessToken: envToken,
      refreshToken: '',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      connectedAt: Date.now(),
      cloudaicompanionProject: getGeminiProjectFromEnv(),
    }
  }

  // 2. Stored credentials — parse the geminiOAuth field independently so a bad
  // sibling field can't mask a valid OAuth record.
  const credentialsPath = getCredentialsPath(clientEnv)
  if (fs.existsSync(credentialsPath)) {
    try {
      const credentialsFile = fs.readFileSync(credentialsPath, 'utf8')
      const raw = JSON.parse(credentialsFile) as { geminiOAuth?: unknown }
      const parsedOAuth = geminiOAuthSchema.safeParse(raw.geminiOAuth)
      if (parsedOAuth.success) {
        // An env-var project override still wins over the persisted one.
        const envProject = getGeminiProjectFromEnv()
        return envProject
          ? { ...parsedOAuth.data, cloudaicompanionProject: envProject }
          : parsedOAuth.data
      }
    } catch {
      // Fall through
    }
  }

  return null
}

export const saveGeminiOAuthCredentials = (
  credentials: GeminiOAuthCredentials,
  clientEnv: ClientEnv = env,
): void => {
  const configDir = getConfigDir(clientEnv)
  const credentialsPath = getCredentialsPath(clientEnv)

  ensureDirectoryExistsSync(configDir)

  let existingData: Record<string, unknown> = {}
  if (fs.existsSync(credentialsPath)) {
    try {
      existingData = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
    } catch {
      // Ignore parse errors, start fresh
    }
  }

  const updatedData = {
    ...existingData,
    geminiOAuth: credentials,
  }

  fs.writeFileSync(credentialsPath, JSON.stringify(updatedData, null, 2))
}

/**
 * Persist the resolved Code Assist project id onto the stored Gemini
 * credentials so subsequent runs skip loadCodeAssist/onboardUser.
 */
export const saveGeminiOAuthProject = (
  project: string,
  clientEnv: ClientEnv = env,
): void => {
  const credentials = getGeminiOAuthCredentials(clientEnv)
  if (!credentials) {
    return
  }
  saveGeminiOAuthCredentials(
    { ...credentials, cloudaicompanionProject: project },
    clientEnv,
  )
}

export const clearGeminiOAuthCredentials = (
  clientEnv: ClientEnv = env,
): void => {
  const credentialsPath = getCredentialsPath(clientEnv)
  if (!fs.existsSync(credentialsPath)) {
    return
  }

  try {
    const existingData = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
    delete existingData.geminiOAuth
    fs.writeFileSync(credentialsPath, JSON.stringify(existingData, null, 2))
  } catch {
    // Ignore errors
  }
}

export const isGeminiOAuthValid = (clientEnv: ClientEnv = env): boolean => {
  const credentials = getGeminiOAuthCredentials(clientEnv)
  if (!credentials) {
    return false
  }
  const bufferMs = 5 * 60 * 1000
  return credentials.expiresAt > Date.now() + bufferMs
}

let geminiRefreshPromise: Promise<GeminiOAuthCredentials | null> | null = null

export const refreshGeminiOAuthToken = async (
  clientEnv: ClientEnv = env,
): Promise<GeminiOAuthCredentials | null> => {
  if (geminiRefreshPromise) {
    return geminiRefreshPromise
  }

  const credentials = getGeminiOAuthCredentials(clientEnv)
  if (!credentials?.refreshToken) {
    return null
  }

  geminiRefreshPromise = (async () => {
    try {
      // Google's token endpoint is form-encoded and requires the client_secret.
      const response = await fetch(GEMINI_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: credentials.refreshToken,
          client_id: GEMINI_OAUTH_CLIENT_ID,
          client_secret: GEMINI_OAUTH_CLIENT_SECRET,
        }).toString(),
      })

      if (!response.ok) {
        console.debug(
          `Gemini OAuth token refresh failed (status ${response.status})`,
        )
        return null
      }

      const data = await response.json()

      if (
        typeof data?.access_token !== 'string' ||
        data.access_token.trim().length === 0
      ) {
        console.debug('Gemini OAuth token refresh returned empty access token')
        return null
      }

      const expiresIn =
        typeof data.expires_in === 'number'
          ? data.expires_in * 1000
          : 3600 * 1000

      const newCredentials: GeminiOAuthCredentials = {
        accessToken: data.access_token,
        // Google usually omits a fresh refresh_token on refresh — keep the old.
        refreshToken:
          typeof data.refresh_token === 'string' && data.refresh_token
            ? data.refresh_token
            : credentials.refreshToken,
        expiresAt: Date.now() + expiresIn,
        connectedAt: credentials.connectedAt,
        // Preserve the resolved project across refreshes.
        cloudaicompanionProject: credentials.cloudaicompanionProject,
      }

      saveGeminiOAuthCredentials(newCredentials, clientEnv)

      return newCredentials
    } catch (error) {
      console.debug(
        'Gemini OAuth token refresh failed:',
        error instanceof Error ? error.message : String(error),
      )
      return null
    } finally {
      geminiRefreshPromise = null
    }
  })()

  return geminiRefreshPromise
}

export const getValidGeminiOAuthCredentials = async (
  clientEnv: ClientEnv = env,
): Promise<GeminiOAuthCredentials | null> => {
  const credentials = getGeminiOAuthCredentials(clientEnv)
  if (!credentials) {
    return null
  }

  const bufferMs = 5 * 60 * 1000

  // No refresh token (e.g. env var override) — return only if still valid
  if (!credentials.refreshToken) {
    return credentials.expiresAt > Date.now() + bufferMs ? credentials : null
  }

  if (credentials.expiresAt > Date.now() + bufferMs) {
    return credentials
  }

  return refreshGeminiOAuthToken(clientEnv)
}
