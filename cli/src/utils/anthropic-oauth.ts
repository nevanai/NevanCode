/**
 * Anthropic (Claude Pro/Max) subscription OAuth PKCE flow.
 *
 * Unlike the ChatGPT flow, the Claude Code OAuth client only permits the hosted
 * console callback as a redirect URI, so this is a manual paste flow: we open
 * the browser, the user authorizes, the console page shows a `code#state`
 * value, and the user pastes it back into the CLI.
 */

import crypto from 'crypto'

import {
  ANTHROPIC_OAUTH_AUTHORIZE_URL,
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_OAUTH_REDIRECT_URI,
  ANTHROPIC_OAUTH_SCOPES,
  ANTHROPIC_OAUTH_TOKEN_URL,
} from '@codebuff/common/constants/anthropic-oauth'
import {
  clearAnthropicOAuthCredentials,
  clearChatGptOAuthCredentials,
  clearGeminiOAuthCredentials,
  getAnthropicOAuthCredentials,
  isAnthropicOAuthValid,
  saveAnthropicOAuthCredentials,
} from '@codebuff/sdk'

import { safeOpen } from './open-url'

import type { AnthropicOAuthCredentials } from '@codebuff/sdk'

function toBase64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function generateCodeVerifier(): string {
  return toBase64Url(crypto.randomBytes(32))
}

function generateCodeChallenge(verifier: string): string {
  return toBase64Url(crypto.createHash('sha256').update(verifier).digest())
}

let pendingCodeVerifier: string | null = null

export function startAnthropicOAuthFlow(): {
  codeVerifier: string
  authUrl: string
} {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)

  pendingCodeVerifier = codeVerifier

  const authUrl = new URL(ANTHROPIC_OAUTH_AUTHORIZE_URL)
  // `code=true` asks the callback page to display the code for manual paste.
  authUrl.searchParams.set('code', 'true')
  authUrl.searchParams.set('client_id', ANTHROPIC_OAUTH_CLIENT_ID)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', ANTHROPIC_OAUTH_REDIRECT_URI)
  authUrl.searchParams.set('scope', ANTHROPIC_OAUTH_SCOPES)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  // The PKCE verifier doubles as the OAuth state, echoed back as `code#state`.
  authUrl.searchParams.set('state', codeVerifier)

  return { codeVerifier, authUrl: authUrl.toString() }
}

/**
 * Open the browser and return the auth URL + PKCE verifier. The caller collects
 * the pasted code and calls {@link exchangeAnthropicCodeForTokens}.
 */
export function connectAnthropicOAuth(): {
  authUrl: string
  codeVerifier: string
} {
  const { codeVerifier, authUrl } = startAnthropicOAuthFlow()
  void safeOpen(authUrl)
  return { authUrl, codeVerifier }
}

/**
 * Parse the pasted value. The console callback returns `code#state`; we also
 * accept a full callback URL or a bare code for resilience.
 */
function parseAuthCodeInput(input: string): { code: string; state?: string } {
  const trimmed = input.trim()

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const callback = new URL(trimmed)
    const code = callback.searchParams.get('code')
    const state = callback.searchParams.get('state') ?? undefined
    if (!code) {
      throw new Error('No authorization code found in callback URL.')
    }
    return { code, state }
  }

  const [code, state] = trimmed.split('#')
  if (!code) {
    throw new Error('No authorization code found.')
  }
  return { code, state: state || undefined }
}

export async function exchangeAnthropicCodeForTokens(
  authCodeInput: string,
  codeVerifier?: string,
): Promise<AnthropicOAuthCredentials> {
  const verifier = codeVerifier ?? pendingCodeVerifier
  if (!verifier) {
    throw new Error('No PKCE verifier found. Please run /connect:claude again.')
  }

  const { code, state } = parseAuthCodeInput(authCodeInput)

  const response = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      redirect_uri: ANTHROPIC_OAUTH_REDIRECT_URI,
      code,
      // The token endpoint validates the state when present.
      ...(state ? { state } : {}),
      code_verifier: verifier,
    }),
  })

  if (!response.ok) {
    throw new Error(
      `Failed to exchange Claude authorization code (status ${response.status}). Please retry /connect:claude.`,
    )
  }

  const data = (await response.json()) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  }

  if (
    typeof data.access_token !== 'string' ||
    data.access_token.trim().length === 0
  ) {
    throw new Error('Token exchange did not return a valid access token.')
  }

  const refreshToken =
    typeof data.refresh_token === 'string' ? data.refresh_token : ''
  const expiresInMs =
    typeof data.expires_in === 'number' &&
    Number.isFinite(data.expires_in) &&
    data.expires_in > 0
      ? data.expires_in * 1000
      : 3600 * 1000

  const credentials: AnthropicOAuthCredentials = {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + expiresInMs,
    connectedAt: Date.now(),
  }

  saveAnthropicOAuthCredentials(credentials)
  // Connecting Claude makes it the sole active OAuth provider — drop the other
  // providers' tokens so a previously-connected Gemini/ChatGPT account doesn't
  // linger in the credentials file.
  clearGeminiOAuthCredentials()
  clearChatGptOAuthCredentials()
  pendingCodeVerifier = null

  return credentials
}

export function disconnectAnthropicOAuth(): void {
  clearAnthropicOAuthCredentials()
  pendingCodeVerifier = null
}

export type AnthropicOAuthConnectionState =
  | 'not-connected'
  | 'expired'
  | 'connected'

export function getAnthropicOAuthStatus(): {
  connected: boolean
  state: AnthropicOAuthConnectionState
  expiresAt?: number
  connectedAt?: number
} {
  const credentials = getAnthropicOAuthCredentials()
  if (!credentials) {
    return { connected: false, state: 'not-connected' }
  }

  if (!isAnthropicOAuthValid()) {
    return {
      connected: false,
      state: 'expired',
      expiresAt: credentials.expiresAt,
      connectedAt: credentials.connectedAt,
    }
  }

  return {
    connected: true,
    state: 'connected',
    expiresAt: credentials.expiresAt,
    connectedAt: credentials.connectedAt,
  }
}
