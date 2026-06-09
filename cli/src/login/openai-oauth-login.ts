/**
 * OpenAI OAuth 2.1 PKCE login flow for Codebuff.
 * Supports ChatGPT OAuth and Codex CLI OAuth (same auth server, different params).
 */
import crypto from 'crypto'
import http from 'http'

import {
  clearAnthropicOAuthCredentials,
  clearGeminiOAuthCredentials,
  saveChatGptOAuthCredentials,
} from '@codebuff/sdk'

import { saveUserCredentials } from '../utils/auth'
import { safeOpen } from '../utils/open-url'

import type { User } from '../utils/auth'

export type OpenAIAuthProvider = 'chatgpt' | 'codex'

const OPENAI_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OPENAI_USERINFO_URL = 'https://auth.openai.com/userinfo'
const CALLBACK_PORT = 1455
const CALLBACK_PATH = '/auth/callback'
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const TIMEOUT_MS = 5 * 60 * 1000

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function buildCodeVerifier(): string {
  return toBase64Url(crypto.randomBytes(32))
}

function buildCodeChallenge(verifier: string): string {
  return toBase64Url(crypto.createHash('sha256').update(verifier).digest())
}

interface OAuthTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<OAuthTokens> {
  const res = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code,
      code_verifier: codeVerifier,
    }),
  })

  if (!res.ok) {
    throw new Error(`Token exchange failed (HTTP ${res.status})`)
  }

  const data = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }

  if (!data.access_token) throw new Error('No access_token in OAuth response')

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? '',
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  }
}

async function fetchUserInfo(accessToken: string): Promise<{ id: string; name: string; email: string }> {
  try {
    const res = await fetch(OPENAI_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (res.ok) {
      const d = (await res.json()) as { sub?: string; name?: string; email?: string }
      return {
        id: d.sub ?? 'openai-user',
        name: d.name ?? d.email ?? 'OpenAI User',
        email: d.email ?? 'openai@connected',
      }
    }
  } catch {
    // Fall through to defaults
  }
  return { id: 'openai-user', name: 'OpenAI User', email: 'openai@connected' }
}

function successHtml(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connected — NevanCode</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#000000;color:#ffffff">
<div style="text-align:center;padding:2rem">
<h1 style="color:#ffffff">✓ Connected to OpenAI</h1>
<p style="color:#bfbfbf">You can close this tab and return to NevanCode.</p>
</div></body></html>`
}

function failureHtml(msg: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connection Failed — NevanCode</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#000000;color:#ffffff">
<div style="text-align:center;padding:2rem">
<h1 style="color:#ffffff">Connection Failed</h1>
<p style="color:#bfbfbf">${msg.replace(/</g, '&lt;').replace(/>/g, '&gt;')} Return to NevanCode and try again.</p>
</div></body></html>`
}

let activeCallbackServer: http.Server | null = null

export function stopOpenAICallbackServer(): void {
  if (activeCallbackServer) {
    try { activeCallbackServer.close() } catch { /* ignore */ }
    activeCallbackServer = null
  }
}

function waitForCallback(codeVerifier: string, expectedState: string): Promise<OAuthTokens> {
  return new Promise<OAuthTokens>((resolve, reject) => {
    const timer = setTimeout(() => {
      stopOpenAICallbackServer()
      reject(new Error('OAuth timed out after 5 minutes. Please try again.'))
    }, TIMEOUT_MS)

    const server = http.createServer(async (req, res) => {
      try {
        const parsed = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`)
        if (parsed.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end('Not found')
          return
        }

        const code = parsed.searchParams.get('code')
        const returnedState = parsed.searchParams.get('state')

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(failureHtml('No authorization code received.'))
          clearTimeout(timer)
          stopOpenAICallbackServer()
          reject(new Error('No code in OAuth callback'))
          return
        }

        if (returnedState !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(failureHtml('State mismatch. Please try again.'))
          clearTimeout(timer)
          stopOpenAICallbackServer()
          reject(new Error('OAuth state mismatch'))
          return
        }

        const tokens = await exchangeCodeForTokens(code, codeVerifier)
        res.writeHead(200, { 'Content-Type': 'text/html' }).end(successHtml())
        clearTimeout(timer)
        stopOpenAICallbackServer()
        resolve(tokens)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Token exchange failed'
        res.writeHead(500, { 'Content-Type': 'text/html' }).end(failureHtml(msg))
        clearTimeout(timer)
        stopOpenAICallbackServer()
        reject(err instanceof Error ? err : new Error(msg))
      }
    })

    server.on('error', (err) => {
      clearTimeout(timer)
      activeCallbackServer = null
      reject(err)
    })

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      activeCallbackServer = server
    })
  })
}

export interface OpenAIOAuthResult {
  authUrl: string
  /** Resolves with a fully-populated User once the browser callback completes. */
  userPromise: Promise<User>
}

/**
 * Starts an OpenAI PKCE OAuth flow, opens the browser, and returns a promise
 * that resolves to a User after the callback is received.
 */
export function startOpenAIOAuth(provider: OpenAIAuthProvider): OpenAIOAuthResult {
  stopOpenAICallbackServer()

  const codeVerifier = buildCodeVerifier()
  const codeChallenge = buildCodeChallenge(codeVerifier)
  const state = toBase64Url(crypto.randomBytes(16))

  const url = new URL(OPENAI_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('scope', 'openid profile email offline_access')
  url.searchParams.set('id_token_add_organizations', 'true')

  if (provider === 'codex') {
    url.searchParams.set('codex_cli_simplified_flow', 'true')
    url.searchParams.set('originator', 'codex_cli_rs')
  }

  const authUrl = url.toString()

  const userPromise = waitForCallback(codeVerifier, state).then(async (tokens) => {
    const info = await fetchUserInfo(tokens.accessToken)
    const user: User = {
      id: info.id,
      name: info.name,
      email: info.email,
      authToken: tokens.accessToken,
    }
    saveUserCredentials(user)

    // Also persist as ChatGPT OAuth credentials so the SDK can route
    // AI requests directly to OpenAI without the Codebuff backend.
    saveChatGptOAuthCredentials({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      connectedAt: Date.now(),
    })
    // Connecting ChatGPT/Codex makes it the sole active OAuth provider — clear
    // the others so a previously-connected Gemini/Claude account doesn't keep
    // shadowing it (both are checked before ChatGPT in routing and /model).
    clearGeminiOAuthCredentials()
    clearAnthropicOAuthCredentials()

    return user
  })

  void safeOpen(authUrl)

  return { authUrl, userPromise }
}
