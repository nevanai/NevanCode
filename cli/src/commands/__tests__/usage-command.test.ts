import os from 'os'
import path from 'path'

import { describe, expect, test } from 'bun:test'

import { handleUsageCommand } from '../usage'
import { buildCliRuntimeIdentity } from '../../utils/runtime-identity'

describe('/usage command', () => {
  test('includes runtime and config details when a dev runtime has an OpenAI model selected', async () => {
    let inputMode: string | null = null

    const { postUserMessage } = await handleUsageCommand({
      buildSystemMessage: (content) => ({
        id: 'sys-1',
        variant: 'ai',
        content: typeof content === 'string' ? content : '',
        timestamp: 'now',
      }),
      fetchOpenAIUsageInfo: async () => 'unused',
      getAuthToken: () => 'token',
      getOAuthCredentials: () => null,
      getOAuthStatus: () => ({ state: 'not-connected', connected: false }),
      getRuntimeIdentity: () =>
        buildCliRuntimeIdentity({
          environment: 'dev',
          configDir: path.join(os.homedir(), '.config', 'manicode-dev'),
        }),
      getSelectedOpenAiModel: () => ({
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        note: 'Frontier coding and knowledge work',
      }),
      isOAuthValid: () => false,
      setInputMode: (mode) => {
        inputMode = mode
      },
    })

    const messages = postUserMessage([])
    expect(inputMode === 'usage').toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.content).toBe(
      'Runtime: dev · Config: ~/.config/manicode-dev\n\nSelected OpenAI model: **GPT-5.5**\nConnect via /connect to use it.',
    )
  })

  test('shows a runtime-only confirmation message when the dev runtime falls back to the usage banner', async () => {
    let inputMode: string | null = null

    const { postUserMessage } = await handleUsageCommand({
      buildSystemMessage: (content) => ({
        id: 'sys-2',
        variant: 'ai',
        content: typeof content === 'string' ? content : '',
        timestamp: 'now',
      }),
      fetchOpenAIUsageInfo: async () => 'unused',
      getAuthToken: () => 'token',
      getOAuthCredentials: () => null,
      getOAuthStatus: () => ({ state: 'not-connected', connected: false }),
      getRuntimeIdentity: () =>
        buildCliRuntimeIdentity({
          environment: 'test',
          configDir: path.join(os.homedir(), '.config', 'manicode-test'),
        }),
      getSelectedOpenAiModel: () => undefined,
      isOAuthValid: () => false,
      setInputMode: (mode) => {
        inputMode = mode
      },
    })

    const messages = postUserMessage([])
    expect(inputMode === 'usage').toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.content).toBe(
      'Runtime: test · Config: ~/.config/manicode-test',
    )
  })
})
