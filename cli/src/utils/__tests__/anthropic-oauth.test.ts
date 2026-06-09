import { afterEach, describe, expect, mock, test } from 'bun:test'

import {
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_OAUTH_REDIRECT_URI,
  ANTHROPIC_OAUTH_SCOPES,
} from '@codebuff/common/constants/anthropic-oauth'

import {
  exchangeAnthropicCodeForTokens,
  startAnthropicOAuthFlow,
} from '../anthropic-oauth'

describe('anthropic-oauth utility', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('startAnthropicOAuthFlow builds a valid PKCE authorize URL', () => {
    const { authUrl, codeVerifier } = startAnthropicOAuthFlow()
    const url = new URL(authUrl)

    expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('code')).toBe('true')
    expect(url.searchParams.get('client_id')).toBe(ANTHROPIC_OAUTH_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(
      ANTHROPIC_OAUTH_REDIRECT_URI,
    )
    expect(url.searchParams.get('scope')).toBe(ANTHROPIC_OAUTH_SCOPES)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    // The verifier doubles as the OAuth state.
    expect(url.searchParams.get('state')).toBe(codeVerifier)
  })

  test('exchange parses pasted code#state and posts the right token request', async () => {
    startAnthropicOAuthFlow()

    let capturedBody: any = null
    globalThis.fetch = mock(async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body)
      return {
        ok: false,
        status: 401,
        text: async () => 'invalid_grant',
      } as unknown as Response
    }) as unknown as typeof fetch

    // Error path (401) avoids writing credentials to disk while still
    // exercising the code#state parse + request construction.
    const error = await exchangeAnthropicCodeForTokens(
      'AUTH_CODE#STATE_VALUE',
      'verifier-123',
    ).catch((e) => e)

    expect(capturedBody.code).toBe('AUTH_CODE')
    expect(capturedBody.state).toBe('STATE_VALUE')
    expect(capturedBody.code_verifier).toBe('verifier-123')
    expect(capturedBody.grant_type).toBe('authorization_code')
    expect(capturedBody.client_id).toBe(ANTHROPIC_OAUTH_CLIENT_ID)
    expect(capturedBody.redirect_uri).toBe(ANTHROPIC_OAUTH_REDIRECT_URI)

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('status 401')
  })

  test('exchange accepts a bare code with no state', async () => {
    startAnthropicOAuthFlow()

    let capturedBody: any = null
    globalThis.fetch = mock(async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body)
      return { ok: false, status: 400, text: async () => 'x' } as unknown as Response
    }) as unknown as typeof fetch

    await exchangeAnthropicCodeForTokens('BARE_CODE', 'v').catch((e) => e)

    expect(capturedBody.code).toBe('BARE_CODE')
    expect('state' in capturedBody).toBe(false)
  })
})
