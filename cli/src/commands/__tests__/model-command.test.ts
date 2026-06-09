import fs from 'fs'
import path from 'path'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const { findCommand } = await import('../command-registry')
const { getSelectedOpenAiModel } = await import('../../utils/openai-models')
const {
  getSettingsPath,
  loadByokSelectedModel,
  saveFireworksDiscoveredModels,
} = await import('../../utils/settings')
const {
  getCredentialsPath,
  clearFireworksApiKey,
  clearOpenRouterApiKey,
  saveFireworksApiKey,
} = await import('@codebuff/sdk')

const makeParams = (inputValue: string, setMessages: (...a: any[]) => void) =>
  ({
    abortControllerRef: { current: null },
    agentMode: 'DEFAULT',
    inputRef: { current: null },
    inputValue,
    isChainInProgressRef: { current: false },
    isStreaming: false,
    logoutMutation: {} as any,
    streamMessageIdRef: { current: null },
    addToQueue: () => {},
    clearMessages: () => {},
    saveToHistory: () => {},
    scrollToLatest: () => {},
    sendMessage: async () => {},
    setCanProcessQueue: () => {},
    setInputFocused: () => {},
    setInputValue: () => {},
    setIsAuthenticated: () => {},
    setMessages,
    setUser: () => {},
    stopStreaming: () => {},
  }) as any

describe('/model command', () => {
  let originalSettingsFile: string | null = null
  let originalCredentialsFile: string | null = null

  beforeEach(() => {
    const settingsPath = getSettingsPath()
    const credentialsPath = getCredentialsPath()

    originalSettingsFile = fs.existsSync(settingsPath)
      ? fs.readFileSync(settingsPath, 'utf8')
      : null
    originalCredentialsFile = fs.existsSync(credentialsPath)
      ? fs.readFileSync(credentialsPath, 'utf8')
      : null

    fs.rmSync(settingsPath, { force: true })
    // Clear BYOK keys so the OpenAI model path is taken during the test
    clearFireworksApiKey()
    clearOpenRouterApiKey()
  })

  afterEach(() => {
    const settingsPath = getSettingsPath()
    const credentialsPath = getCredentialsPath()

    if (originalSettingsFile === null) {
      fs.rmSync(settingsPath, { force: true })
    } else {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
      fs.writeFileSync(settingsPath, originalSettingsFile)
    }
    if (originalCredentialsFile !== null) {
      fs.mkdirSync(path.dirname(credentialsPath), { recursive: true })
      fs.writeFileSync(credentialsPath, originalCredentialsFile)
    }
  })

  test('saves the selected OpenAI model to settings', async () => {
    const setMessages = mock(() => {})
    const command = findCommand('model')

    await command?.handler(
      {
        abortControllerRef: { current: null },
        agentMode: 'DEFAULT',
        inputRef: { current: null },
        inputValue: '/model gpt-5-codex',
        isChainInProgressRef: { current: false },
        isStreaming: false,
        logoutMutation: {} as any,
        streamMessageIdRef: { current: null },
        addToQueue: () => {},
        clearMessages: () => {},
        saveToHistory: () => {},
        scrollToLatest: () => {},
        sendMessage: async () => {},
        setCanProcessQueue: () => {},
        setInputFocused: () => {},
        setInputValue: () => {},
        setIsAuthenticated: () => {},
        setMessages,
        setUser: () => {},
        stopStreaming: () => {},
      },
      'gpt-5.5',
    )

    expect(getSelectedOpenAiModel()?.id).toBe('gpt-5.5')
    expect(fs.existsSync(getSettingsPath())).toBe(true)
    expect(setMessages).toHaveBeenCalled()
  })
})

describe('/model command — Fireworks BYOK', () => {
  let originalSettingsFile: string | null = null
  let originalCredentialsFile: string | null = null

  beforeEach(() => {
    const settingsPath = getSettingsPath()
    const credentialsPath = getCredentialsPath()
    originalSettingsFile = fs.existsSync(settingsPath)
      ? fs.readFileSync(settingsPath, 'utf8')
      : null
    originalCredentialsFile = fs.existsSync(credentialsPath)
      ? fs.readFileSync(credentialsPath, 'utf8')
      : null
    fs.rmSync(settingsPath, { force: true })
    clearFireworksApiKey()
    clearOpenRouterApiKey()
  })

  afterEach(() => {
    const settingsPath = getSettingsPath()
    const credentialsPath = getCredentialsPath()
    clearFireworksApiKey()
    clearOpenRouterApiKey()
    if (originalSettingsFile === null) {
      fs.rmSync(settingsPath, { force: true })
    } else {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
      fs.writeFileSync(settingsPath, originalSettingsFile)
    }
    if (originalCredentialsFile !== null) {
      fs.mkdirSync(path.dirname(credentialsPath), { recursive: true })
      fs.writeFileSync(credentialsPath, originalCredentialsFile)
    }
  })

  test('resolves a model-name-only argument to the full discovered Fireworks id', async () => {
    saveFireworksApiKey('fw-test-key')
    saveFireworksDiscoveredModels([
      'fireworks/accounts/fireworks/models/deepseek-r1',
      'fireworks/accounts/fireworks/models/llama-v3p1-70b-instruct',
    ])

    const command = findCommand('model')
    await command?.handler(makeParams('/model deepseek-r1', () => {}), 'deepseek-r1')

    // Must persist the FULL id (with prefix), not fireworks/deepseek-r1 → 404
    expect(loadByokSelectedModel()).toBe(
      'fireworks/accounts/fireworks/models/deepseek-r1',
    )
  })

  test('keeps a full pasted Fireworks id intact (no double prefix)', async () => {
    saveFireworksApiKey('fw-test-key')
    saveFireworksDiscoveredModels([
      'fireworks/accounts/fireworks/models/deepseek-r1',
    ])

    const command = findCommand('model')
    await command?.handler(
      makeParams('/model x', () => {}),
      'fireworks/accounts/fireworks/models/deepseek-r1',
    )

    expect(loadByokSelectedModel()).toBe(
      'fireworks/accounts/fireworks/models/deepseek-r1',
    )
  })

  test('adds the fireworks/ prefix for an unknown model id', async () => {
    saveFireworksApiKey('fw-test-key')
    // No discovered models

    const command = findCommand('model')
    await command?.handler(
      makeParams('/model accounts/fireworks/models/custom', () => {}),
      'accounts/fireworks/models/custom',
    )

    expect(loadByokSelectedModel()).toBe(
      'fireworks/accounts/fireworks/models/custom',
    )
  })

  test('does not touch the OpenAI model preference when BYOK is connected', async () => {
    saveFireworksApiKey('fw-test-key')
    saveFireworksDiscoveredModels(['fireworks/accounts/fireworks/models/deepseek-r1'])

    const command = findCommand('model')
    await command?.handler(makeParams('/model deepseek-r1', () => {}), 'deepseek-r1')

    // OpenAI selection stays empty — the BYOK path is fully separate
    expect(getSelectedOpenAiModel()).toBeUndefined()
  })
})
