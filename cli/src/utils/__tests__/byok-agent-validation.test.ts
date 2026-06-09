import fs from 'fs'
import path from 'path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const {
  getCredentialsPath,
  getChatGptOAuthCredentials,
  isAnyByokProviderLinked,
  saveFireworksApiKey,
  clearFireworksApiKey,
  saveOpenRouterApiKey,
  clearOpenRouterApiKey,
  validateAgents,
} = await import('@codebuff/sdk')

import type { AgentDefinition } from '@codebuff/sdk'

const VALID_AGENT: AgentDefinition = {
  id: 'base2',
  displayName: 'Base2',
  model: 'anthropic/claude-sonnet-4',
}

describe('BYOK agent validation — skips remote endpoint', () => {
  let originalCredentialsFile: string | null = null

  beforeEach(() => {
    const credentialsPath = getCredentialsPath()
    originalCredentialsFile = fs.existsSync(credentialsPath)
      ? fs.readFileSync(credentialsPath, 'utf8')
      : null
    fs.rmSync(credentialsPath, { force: true })
    clearFireworksApiKey()
    clearOpenRouterApiKey()
  })

  afterEach(() => {
    clearFireworksApiKey()
    clearOpenRouterApiKey()
    const credentialsPath = getCredentialsPath()
    if (originalCredentialsFile === null) {
      fs.rmSync(credentialsPath, { force: true })
    } else {
      fs.mkdirSync(path.dirname(credentialsPath), { recursive: true })
      fs.writeFileSync(credentialsPath, originalCredentialsFile)
    }
  })

  // The hook computes: !getChatGptOAuthCredentials() && !isAnyByokProviderLinked()
  // When BYOK is connected, isAnyByokProviderLinked() === true, so useRemoteValidation === false.
  // Local validation must succeed so the send is not silently blocked.

  test('Fireworks BYOK: isAnyByokProviderLinked returns true, no ChatGPT creds', () => {
    saveFireworksApiKey('fw-test-key')

    expect(isAnyByokProviderLinked()).toBe(true)
    expect(getChatGptOAuthCredentials()).toBeNull()

    // The hook condition: !getChatGptOAuthCredentials() && !isAnyByokProviderLinked()
    const useRemoteValidation = !getChatGptOAuthCredentials() && !isAnyByokProviderLinked()
    expect(useRemoteValidation).toBe(false)
  })

  test('OpenRouter BYOK: isAnyByokProviderLinked returns true, no ChatGPT creds', () => {
    saveOpenRouterApiKey('or-test-key')

    expect(isAnyByokProviderLinked()).toBe(true)
    expect(getChatGptOAuthCredentials()).toBeNull()

    const useRemoteValidation = !getChatGptOAuthCredentials() && !isAnyByokProviderLinked()
    expect(useRemoteValidation).toBe(false)
  })

  test('Fireworks BYOK: local validation succeeds for valid agent (send is not blocked)', async () => {
    saveFireworksApiKey('fw-test-key')

    const result = await validateAgents([VALID_AGENT], { remote: false })

    expect(result.success).toBe(true)
    expect(result.validationErrors).toEqual([])
  })

  test('OpenRouter BYOK: local validation succeeds for valid agent (send is not blocked)', async () => {
    saveOpenRouterApiKey('or-test-key')

    const result = await validateAgents([VALID_AGENT], { remote: false })

    expect(result.success).toBe(true)
    expect(result.validationErrors).toEqual([])
  })

  test('no provider linked: remote validation is selected (normal Codebuff path)', () => {
    // Neither BYOK nor ChatGPT OAuth

    const useRemoteValidation = !getChatGptOAuthCredentials() && !isAnyByokProviderLinked()
    expect(useRemoteValidation).toBe(true)
  })
})
