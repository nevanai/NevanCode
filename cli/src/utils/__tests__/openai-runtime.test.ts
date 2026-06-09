import fs from 'fs'
import path from 'path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

import type { AgentDefinition, ChatGptOAuthCredentials } from '@codebuff/sdk'

ensureCliTestEnv()

const {
  getCredentialsPath,
  saveFireworksApiKey,
  clearFireworksApiKey,
  saveOpenRouterApiKey,
  clearOpenRouterApiKey,
} = await import('@codebuff/sdk')
const { getSettingsPath, saveByokSelectedModel, loadByokSelectedModel } = await import('../settings')
const { saveOpenAiModelPreference, clearOpenAiModelPreference } =
  await import('../openai-models')
const {
  applySelectedOpenAiModelToRuntimeAgents,
  ensureSelectedOpenAiModelReady,
  shouldUseSelectedOpenAiModelForAgent,
} = await import('../openai-runtime')

const writeCredentials = (credentials: ChatGptOAuthCredentials) => {
  const credentialsPath = getCredentialsPath()
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true })
  fs.writeFileSync(
    credentialsPath,
    JSON.stringify({ chatgptOAuth: credentials }, null, 2),
  )
}

describe('openai runtime helpers', () => {
  let originalCredentialsFile: string | null = null
  let originalSettingsFile: string | null = null
  let originalChatGptOAuthToken: string | undefined

  beforeEach(() => {
    originalChatGptOAuthToken = process.env.CODEBUFF_CHATGPT_OAUTH_TOKEN
    delete process.env.CODEBUFF_CHATGPT_OAUTH_TOKEN
    const credentialsPath = getCredentialsPath()
    const settingsPath = getSettingsPath()
    originalCredentialsFile = fs.existsSync(credentialsPath)
      ? fs.readFileSync(credentialsPath, 'utf8')
      : null
    originalSettingsFile = fs.existsSync(settingsPath)
      ? fs.readFileSync(settingsPath, 'utf8')
      : null
    fs.rmSync(credentialsPath, { force: true })
    fs.rmSync(settingsPath, { force: true })
    saveOpenAiModelPreference('gpt-5.5')
  })

  afterEach(() => {
    clearOpenAiModelPreference()
    const credentialsPath = getCredentialsPath()
    const settingsPath = getSettingsPath()
    if (originalCredentialsFile === null) {
      fs.rmSync(credentialsPath, { force: true })
    } else {
      fs.mkdirSync(path.dirname(credentialsPath), { recursive: true })
      fs.writeFileSync(credentialsPath, originalCredentialsFile)
    }
    if (originalSettingsFile === null) {
      fs.rmSync(settingsPath, { force: true })
    } else {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
      fs.writeFileSync(settingsPath, originalSettingsFile)
    }
    if (originalChatGptOAuthToken === undefined) {
      delete process.env.CODEBUFF_CHATGPT_OAUTH_TOKEN
    } else {
      process.env.CODEBUFF_CHATGPT_OAUTH_TOKEN = originalChatGptOAuthToken
    }
  })

  test('rewrites overridable agents to the selected OpenAI model', () => {
    const definitions: AgentDefinition[] = [
      {
        id: 'base2',
        displayName: 'Base2',
        model: 'anthropic/claude-opus-4.7',
        spawnableAgents: [
          'file-picker',
          'thinker',
          'opus-agent',
          'gpt-5-agent',
          'editor',
          'code-reviewer',
          'basher',
        ],
      },
      {
        id: 'base2-max',
        displayName: 'Base2 Max',
        model: 'anthropic/claude-opus-4.7',
        spawnableAgents: [
          'file-picker-max',
          'opus-agent',
          'thinker-best-of-n-opus',
          'editor-multi-prompt',
          'code-reviewer-multi-prompt',
          'basher',
        ],
      },
      {
        id: 'thinker-gpt',
        displayName: 'Thinker GPT',
        model: 'openai/gpt-5.4',
      },
      {
        id: 'editor-gpt-5',
        displayName: 'Editor GPT',
        model: 'openai/gpt-5.1',
      },
      {
        id: 'code-reviewer-gpt',
        displayName: 'Reviewer GPT',
        model: 'openai/gpt-5.4',
      },
      {
        id: 'gpt-5-agent',
        displayName: 'GPT-5 Agent',
        model: 'openai/gpt-5.4',
      },
      {
        id: 'file-picker',
        displayName: 'File Picker',
        model: 'moonshotai/kimi-k2.6',
      },
      {
        id: 'file-picker-max',
        displayName: 'File Picker Max',
        model: 'moonshotai/kimi-k2.6',
      },
      { id: 'basher', displayName: 'Basher', model: 'moonshotai/kimi-k2.6' },
    ]

    const runtimeConfig = applySelectedOpenAiModelToRuntimeAgents({
      agentDefinitions: definitions,
      agent: 'base2',
    })

    expect(runtimeConfig.agent).toBe('base2')
    expect(shouldUseSelectedOpenAiModelForAgent(runtimeConfig.agent)).toBe(true)

    const base2 = runtimeConfig.agentDefinitions.find(
      (def) => def.id === 'base2',
    )
    const base2Max = runtimeConfig.agentDefinitions.find(
      (def) => def.id === 'base2-max',
    )
    const thinker = runtimeConfig.agentDefinitions.find(
      (def) => def.id === 'thinker-gpt',
    )
    const editor = runtimeConfig.agentDefinitions.find(
      (def) => def.id === 'editor-gpt-5',
    )
    const reviewer = runtimeConfig.agentDefinitions.find(
      (def) => def.id === 'code-reviewer-gpt',
    )
    const gpt5Agent = runtimeConfig.agentDefinitions.find(
      (def) => def.id === 'gpt-5-agent',
    )

    expect(base2?.model).toBe('openai/gpt-5.5')
    expect(base2?.spawnableAgents).toEqual([
      'file-picker',
      'thinker-gpt',
      'gpt-5-agent',
      'editor-gpt-5',
      'code-reviewer-gpt',
      'basher',
    ])
    expect(base2Max?.spawnableAgents).toEqual([
      'file-picker-max',
      'gpt-5-agent',
      'thinker-gpt',
      'editor-gpt-5',
      'code-reviewer-gpt',
      'basher',
    ])
    expect(thinker?.model).toBe('openai/gpt-5.5')
    expect(editor?.model).toBe('openai/gpt-5.5')
    expect(reviewer?.model).toBe('openai/gpt-5.5')
    expect(gpt5Agent?.model).toBe('openai/gpt-5.5')
  })

  test('blocks when the selected model has no ChatGPT connection', async () => {
    const readiness = await ensureSelectedOpenAiModelReady()

    expect(readiness.ready).toBe(false)
    if (!readiness.ready) {
      expect(readiness.status.state).toBe('not-connected')
      expect(readiness.message).toContain('/connect')
    }
  })

  test('reports expired ChatGPT credentials clearly', async () => {
    writeCredentials({
      accessToken: 'expired-token',
      refreshToken: '',
      expiresAt: Date.now() - 60_000,
      connectedAt: Date.now() - 120_000,
    })

    const readiness = await ensureSelectedOpenAiModelReady()

    expect(readiness.ready).toBe(false)
    if (!readiness.ready) {
      expect(readiness.status.state).toBe('expired')
      expect(readiness.message).toContain('expired')
    }
  })

  test('allows sending when valid ChatGPT credentials exist', async () => {
    writeCredentials({
      accessToken: 'valid-token',
      refreshToken: '',
      expiresAt: Date.now() + 60 * 60 * 1000,
      connectedAt: Date.now() - 120_000,
    })

    await expect(ensureSelectedOpenAiModelReady()).resolves.toEqual({
      ready: true,
    })
  })
})

// ── BYOK provider awareness ───────────────────────────────────────────────────

describe('openai runtime — BYOK provider isolation', () => {
  let originalCredentialsFile: string | null = null
  let originalSettingsFile: string | null = null

  beforeEach(() => {
    delete process.env.CODEBUFF_CHATGPT_OAUTH_TOKEN
    const credentialsPath = getCredentialsPath()
    const settingsPath = getSettingsPath()
    originalCredentialsFile = fs.existsSync(credentialsPath)
      ? fs.readFileSync(credentialsPath, 'utf8')
      : null
    originalSettingsFile = fs.existsSync(settingsPath)
      ? fs.readFileSync(settingsPath, 'utf8')
      : null
    fs.rmSync(credentialsPath, { force: true })
    fs.rmSync(settingsPath, { force: true })
    saveOpenAiModelPreference('gpt-5.5')
  })

  afterEach(() => {
    clearOpenAiModelPreference()
    clearFireworksApiKey()
    clearOpenRouterApiKey()
    const credentialsPath = getCredentialsPath()
    const settingsPath = getSettingsPath()
    if (originalCredentialsFile === null) {
      fs.rmSync(credentialsPath, { force: true })
    } else {
      fs.mkdirSync(path.dirname(credentialsPath), { recursive: true })
      fs.writeFileSync(credentialsPath, originalCredentialsFile)
    }
    if (originalSettingsFile === null) {
      fs.rmSync(settingsPath, { force: true })
    } else {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
      fs.writeFileSync(settingsPath, originalSettingsFile)
    }
  })

  test('ensureSelectedOpenAiModelReady returns ready when Fireworks BYOK is connected (no ChatGPT needed)', async () => {
    saveFireworksApiKey('fw-test-api-key')

    const readiness = await ensureSelectedOpenAiModelReady()

    expect(readiness.ready).toBe(true)
  })

  test('ensureSelectedOpenAiModelReady returns ready when OpenRouter BYOK is connected (no ChatGPT needed)', async () => {
    saveOpenRouterApiKey('or-test-api-key')

    const readiness = await ensureSelectedOpenAiModelReady()

    expect(readiness.ready).toBe(true)
  })

  test('applySelectedOpenAiModelToRuntimeAgents overrides EVERY agent to the BYOK model', () => {
    saveFireworksApiKey('fw-test-api-key')
    saveByokSelectedModel('fireworks/accounts/fireworks/models/deepseek-r1')

    // Mix of root + subagents on diverse models — all must move to the BYOK model,
    // since Fireworks cannot serve google/anthropic/moonshotai ids by those names.
    const definitions: AgentDefinition[] = [
      { id: 'base2', displayName: 'Base2', model: 'anthropic/claude-sonnet-4' },
      { id: 'file-picker', displayName: 'File Picker', model: 'moonshotai/kimi-k2.6' },
      { id: 'basher', displayName: 'Basher', model: 'google/gemini-3.1-flash-lite-preview' },
      { id: 'context-pruner', displayName: 'Context Pruner', model: 'anthropic/claude-sonnet-4.6' },
    ]

    const result = applySelectedOpenAiModelToRuntimeAgents({
      agentDefinitions: definitions,
      agent: 'base2',
    })

    const expected = 'fireworks/accounts/fireworks/models/deepseek-r1'
    for (const def of result.agentDefinitions) {
      expect(def.model).toBe(expected)
    }
  })

  test('applySelectedOpenAiModelToRuntimeAgents preserves the spawnableAgents graph (no GPT remap)', () => {
    saveFireworksApiKey('fw-test-api-key')
    saveByokSelectedModel('fireworks/accounts/fireworks/models/deepseek-r1')

    const definitions: AgentDefinition[] = [
      {
        id: 'base2',
        displayName: 'Base2',
        model: 'anthropic/claude-opus-4.7',
        spawnableAgents: ['file-picker', 'thinker', 'editor', 'code-reviewer', 'basher'],
      },
    ]

    const result = applySelectedOpenAiModelToRuntimeAgents({
      agentDefinitions: definitions,
      agent: 'base2',
    })

    const base2 = result.agentDefinitions.find((d) => d.id === 'base2')
    // spawnableAgents must NOT be remapped to GPT variants for BYOK
    expect(base2?.spawnableAgents).toEqual([
      'file-picker',
      'thinker',
      'editor',
      'code-reviewer',
      'basher',
    ])
  })

  test('applySelectedOpenAiModelToRuntimeAgents returns params unchanged when BYOK connected but no model selected', () => {
    saveFireworksApiKey('fw-test-api-key')
    // No byokSelectedModel saved

    const definitions: AgentDefinition[] = [
      { id: 'base2', displayName: 'Base2', model: 'anthropic/claude-sonnet-4' },
    ]

    const result = applySelectedOpenAiModelToRuntimeAgents({
      agentDefinitions: definitions,
      agent: 'base2',
    })

    const base2 = result.agentDefinitions.find((d) => d.id === 'base2')
    expect(base2?.model).toBe('anthropic/claude-sonnet-4')
  })

  test('applySelectedOpenAiModelToRuntimeAgents uses OpenAI model when no BYOK is connected', () => {
    // No BYOK keys — OpenAI model preference (set in beforeEach) should apply
    const definitions: AgentDefinition[] = [
      { id: 'base2', displayName: 'Base2', model: 'anthropic/claude-sonnet-4' },
    ]

    const result = applySelectedOpenAiModelToRuntimeAgents({
      agentDefinitions: definitions,
      agent: 'base2',
    })

    const base2 = result.agentDefinitions.find((d) => d.id === 'base2')
    expect(base2?.model).toBe('openai/gpt-5.5')
  })
})
