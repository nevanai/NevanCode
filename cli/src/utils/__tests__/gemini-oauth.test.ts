import { afterEach, describe, expect, mock, test } from 'bun:test'

import {
  GEMINI_OAUTH_CLIENT_ID,
  GEMINI_OAUTH_CLIENT_SECRET,
  GEMINI_OAUTH_REDIRECT_URI,
  GEMINI_OAUTH_SCOPES,
} from '@codebuff/common/constants/gemini-oauth'

import {
  exchangeGeminiCodeForTokens,
  startGeminiOAuthFlow,
} from '../gemini-oauth'

describe('gemini-oauth utility', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('startGeminiOAuthFlow builds a valid Google PKCE authorize URL', () => {
    const { authUrl, codeVerifier } = startGeminiOAuthFlow()
    const url = new URL(authUrl)

    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    )
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(GEMINI_OAUTH_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(GEMINI_OAUTH_REDIRECT_URI)
    expect(url.searchParams.get('scope')).toBe(GEMINI_OAUTH_SCOPES)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    // Google specifics that the Claude flow omits — required for a refresh token.
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(codeVerifier.length).toBeGreaterThan(0)
  })

  test('exchange posts a form-encoded token request with the client_secret', async () => {
    startGeminiOAuthFlow()

    let capturedBody: any = null
    let capturedContentType: any = null
    globalThis.fetch = mock(async (_url: any, init: any) => {
      capturedContentType = init.headers['Content-Type']
      capturedBody = new URLSearchParams(init.body as string)
      return {
        ok: false,
        status: 401,
        text: async () => 'invalid_grant',
      } as unknown as Response
    }) as unknown as typeof fetch

    // Error path (401) avoids writing credentials to disk while still exercising
    // the form-encoding + request construction.
    const error = await exchangeGeminiCodeForTokens(
      'AUTH_CODE',
      'verifier-123',
    ).catch((e) => e)

    expect(capturedContentType).toBe('application/x-www-form-urlencoded')
    expect(capturedBody!.get('grant_type')).toBe('authorization_code')
    expect(capturedBody!.get('code')).toBe('AUTH_CODE')
    expect(capturedBody!.get('client_id')).toBe(GEMINI_OAUTH_CLIENT_ID)
    expect(capturedBody!.get('client_secret')).toBe(GEMINI_OAUTH_CLIENT_SECRET)
    expect(capturedBody!.get('redirect_uri')).toBe(GEMINI_OAUTH_REDIRECT_URI)
    expect(capturedBody!.get('code_verifier')).toBe('verifier-123')

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('status 401')
  })

  test('exchange strips trailing state/fragment, keeping only the code', async () => {
    startGeminiOAuthFlow()

    let capturedBody: any = null
    globalThis.fetch = mock(async (_url: any, init: any) => {
      capturedBody = new URLSearchParams(init.body as string)
      return { ok: false, status: 400, text: async () => 'x' } as unknown as Response
    }) as unknown as typeof fetch

    await exchangeGeminiCodeForTokens('BARE_CODE#somestate', 'v').catch((e) => e)

    expect(capturedBody!.get('code')).toBe('BARE_CODE')
  })

  test('exchange extracts the code from a full callback URL', async () => {
    startGeminiOAuthFlow()

    let capturedBody: any = null
    globalThis.fetch = mock(async (_url: any, init: any) => {
      capturedBody = new URLSearchParams(init.body as string)
      return { ok: false, status: 400, text: async () => 'x' } as unknown as Response
    }) as unknown as typeof fetch

    await exchangeGeminiCodeForTokens(
      'https://codeassist.google.com/authcode?code=URL_CODE&scope=email',
      'v',
    ).catch((e) => e)

    expect(capturedBody!.get('code')).toBe('URL_CODE')
  })
})
