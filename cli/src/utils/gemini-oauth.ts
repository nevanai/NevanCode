/**
 * Gemini (Google account) OAuth PKCE flow.
 *
 * Mirrors the Claude paste flow: we open the browser, the user authorizes with
 * their Google account, the Gemini CLI "no browser" callback page
 * (https://codeassist.google.com/authcode) shows an authorization code, and the
 * user pastes it back into the CLI.
 *
 * Google specifics that differ from the Claude flow:
 *  - The token endpoint is form-encoded and requires the client_secret.
 *  - `access_type=offline` + `prompt=consent` are required to reliably receive a
 *    refresh_token.
 *  - The redirect_uri must be byte-identical between authorize and exchange.
 */

import crypto from 'crypto'

import {
  GEMINI_OAUTH_AUTHORIZE_URL,
  GEMINI_OAUTH_CLIENT_ID,
  GEMINI_OAUTH_CLIENT_SECRET,
  GEMINI_OAUTH_REDIRECT_URI,
  GEMINI_OAUTH_SCOPES,
  GEMINI_OAUTH_TOKEN_URL,
} from '@codebuff/common/constants/gemini-oauth'
import {
  clearAnthropicOAuthCredentials,
  clearChatGptOAuthCredentials,
  clearGeminiOAuthCredentials,
  getGeminiOAuthCredentials,
  isGeminiOAuthValid,
  saveGeminiOAuthCredentials,
} from '@codebuff/sdk'

import { safeOpen } from './open-url'

import type { GeminiOAuthCredentials } from '@codebuff/sdk'

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

export function startGeminiOAuthFlow(): {
  codeVerifier: string
  authUrl: string
} {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)

  pendingCodeVerifier = codeVerifier

  const authUrl = new URL(GEMINI_OAUTH_AUTHORIZE_URL)
  authUrl.searchParams.set('client_id', GEMINI_OAUTH_CLIENT_ID)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', GEMINI_OAUTH_REDIRECT_URI)
  authUrl.searchParams.set('scope', GEMINI_OAUTH_SCOPES)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  // Required for Google to mint (and keep re-issuing) a refresh_token.
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('prompt', 'consent')
  // CSRF marker. PKCE already binds the exchange, so we don't enforce it on the
  // paste path (the user types only the code).
  authUrl.searchParams.set('state', toBase64Url(crypto.randomBytes(16)))

  return { codeVerifier, authUrl: authUrl.toString() }
}

/**
 * Open the browser and return the auth URL + PKCE verifier. The caller collects
 * the pasted code and calls {@link exchangeGeminiCodeForTokens}.
 */
export function connectGeminiOAuth(): {
  authUrl: string
  codeVerifier: string
} {
  const { codeVerifier, authUrl } = startGeminiOAuthFlow()
  void safeOpen(authUrl)
  return { authUrl, codeVerifier }
}

/**
 * Parse the pasted value. The authcode page shows a bare code; we also accept a
 * full callback URL (with `?code=`) for resilience.
 */
function parseAuthCodeInput(input: string): { code: string } {
  const trimmed = input.trim()

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const callback = new URL(trimmed)
    const code = callback.searchParams.get('code')
    if (!code) {
      throw new Error('No authorization code found in callback URL.')
    }
    return { code }
  }

  // Some flows return `code#state` or `code&...`; keep only the code segment.
  const code = trimmed.split(/[#&\s]/)[0]
  if (!code) {
    throw new Error('No authorization code found.')
  }
  return { code }
}

export async function exchangeGeminiCodeForTokens(
  authCodeInput: string,
  codeVerifier?: string,
): Promise<GeminiOAuthCredentials> {
  const verifier = codeVerifier ?? pendingCodeVerifier
  if (!verifier) {
    throw new Error('No PKCE verifier found. Please run /connect:gemini again.')
  }

  const { code } = parseAuthCodeInput(authCodeInput)

  // Google's token endpoint is form-encoded and requires the client_secret.
  const response = await fetch(GEMINI_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: GEMINI_OAUTH_CLIENT_ID,
      client_secret: GEMINI_OAUTH_CLIENT_SECRET,
      redirect_uri: GEMINI_OAUTH_REDIRECT_URI,
      code_verifier: verifier,
    }).toString(),
  })

  if (!response.ok) {
    throw new Error(
      `Failed to exchange Gemini authorization code (status ${response.status}). Please retry /connect:gemini.`,
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

  const credentials: GeminiOAuthCredentials = {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + expiresInMs,
    connectedAt: Date.now(),
  }

  saveGeminiOAuthCredentials(credentials)
  // Connecting Gemini makes it the sole active OAuth provider. The router,
  // `/model`, and the auth gates all check Anthropic/ChatGPT BEFORE Gemini, so
  // leaving their tokens in place would keep shadowing the just-connected Gemini
  // account. Clear them so Gemini actually takes effect.
  clearAnthropicOAuthCredentials()
  clearChatGptOAuthCredentials()
  pendingCodeVerifier = null

  return credentials
}

export function disconnectGeminiOAuth(): void {
  clearGeminiOAuthCredentials()
  pendingCodeVerifier = null
}

export type GeminiOAuthConnectionState =
  | 'not-connected'
  | 'expired'
  | 'connected'

export function getGeminiOAuthStatus(): {
  connected: boolean
  state: GeminiOAuthConnectionState
  expiresAt?: number
  connectedAt?: number
} {
  const credentials = getGeminiOAuthCredentials()
  if (!credentials) {
    return { connected: false, state: 'not-connected' }
  }

  if (!isGeminiOAuthValid()) {
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
