import fs from 'fs'
import path from 'path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const {
  getCredentialsPath,
  saveChatGptOAuthCredentials,
  getChatGptOAuthCredentials,
  saveFireworksApiKey,
  getFireworksApiKey,
  saveOpenRouterApiKey,
  getOpenRouterApiKey,
  isAnyByokProviderLinked,
} = await import('@codebuff/sdk')
const { logoutUser } = await import('../auth')

/**
 * Verifies that logoutUser() clears ALL provider credentials:
 * - Codebuff user (default)
 * - ChatGPT OAuth
 * - Fireworks BYOK API key
 * - OpenRouter BYOK API key
 *
 * This prevents the case where a user logs out but the tool silently
 * continues routing requests through a previously connected provider.
 */
describe('logoutUser — clears all provider credentials', () => {
  let originalCredentialsFile: string | null = null

  beforeEach(() => {
    const credentialsPath = getCredentialsPath()
    originalCredentialsFile = fs.existsSync(credentialsPath)
      ? fs.readFileSync(credentialsPath, 'utf8')
      : null
    fs.rmSync(credentialsPath, { force: true })
  })

  afterEach(() => {
    const credentialsPath = getCredentialsPath()
    if (originalCredentialsFile === null) {
      fs.rmSync(credentialsPath, { force: true })
    } else {
      fs.mkdirSync(path.dirname(credentialsPath), { recursive: true })
      fs.writeFileSync(credentialsPath, originalCredentialsFile)
    }
  })

  test('clears Fireworks BYOK key on logout', async () => {
    saveFireworksApiKey('fw-test-key')
    expect(getFireworksApiKey()).not.toBeNull()

    await logoutUser()

    expect(getFireworksApiKey()).toBeNull()
  })

  test('clears OpenRouter BYOK key on logout', async () => {
    saveOpenRouterApiKey('or-test-key')
    expect(getOpenRouterApiKey()).not.toBeNull()

    await logoutUser()

    expect(getOpenRouterApiKey()).toBeNull()
  })

  test('clears ChatGPT OAuth credentials on logout', async () => {
    saveChatGptOAuthCredentials({
      accessToken: 'chatgpt-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 60_000,
      connectedAt: Date.now(),
    })
    expect(getChatGptOAuthCredentials()).not.toBeNull()

    await logoutUser()

    expect(getChatGptOAuthCredentials()).toBeNull()
  })

  test('clears all BYOK providers simultaneously', async () => {
    saveFireworksApiKey('fw-test-key')
    saveOpenRouterApiKey('or-test-key')
    saveChatGptOAuthCredentials({
      accessToken: 'chatgpt-token',
      refreshToken: '',
      expiresAt: Date.now() + 60_000,
      connectedAt: Date.now(),
    })

    expect(isAnyByokProviderLinked()).toBe(true)

    await logoutUser()

    expect(getFireworksApiKey()).toBeNull()
    expect(getOpenRouterApiKey()).toBeNull()
    expect(getChatGptOAuthCredentials()).toBeNull()
    expect(isAnyByokProviderLinked()).toBe(false)
  })

  test('logout succeeds even when no credentials exist', async () => {
    // Credentials file does not exist
    expect(getFireworksApiKey()).toBeNull()

    await expect(logoutUser()).resolves.toBe(true)
  })
})
