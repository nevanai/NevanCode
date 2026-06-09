import { describe, expect, test } from 'bun:test'

import {
  OPENROUTER_TO_OPENAI_MODEL_MAP,
  isChatGptOAuthModelAllowed,
  isOpenAIProviderModel,
  toOpenAIModelId,
} from '../chatgpt-oauth'

// Models actually served on the ChatGPT-account Codex path. Any wire id outside
// this set makes the backend 400 "not supported when using Codex with a ChatGPT
// account", which surfaces as the misleading "plan does not include Codex" error.
const SERVED_WIRE_IDS = new Set([
  'gpt-5',
  'gpt-5.5',
  'gpt-5-codex',
  'gpt-5.1-codex',
  'gpt-5.2-codex',
  'gpt-5.3-codex',
])

describe('toOpenAIModelId clamps to ChatGPT-account-served wire ids', () => {
  test('every allowlisted alias resolves to a served wire id', () => {
    for (const [alias, wire] of Object.entries(OPENROUTER_TO_OPENAI_MODEL_MAP)) {
      expect(isChatGptOAuthModelAllowed(alias)).toBe(true)
      expect(SERVED_WIRE_IDS.has(wire)).toBe(true)
      expect(toOpenAIModelId(alias)).toBe(wire)
    }
  })

  test('the empirically-rejected plain gpt-5.4 clamps to gpt-5', () => {
    expect(toOpenAIModelId('openai/gpt-5.4')).toBe('gpt-5')
    expect(toOpenAIModelId('openai/gpt-5.4-mini')).toBe('gpt-5')
  })

  test('reasoning + 4o models clamp to gpt-5 (not on the ChatGPT-account path)', () => {
    expect(toOpenAIModelId('openai/o3')).toBe('gpt-5')
    expect(toOpenAIModelId('openai/o3-pro')).toBe('gpt-5')
    expect(toOpenAIModelId('openai/o4-mini')).toBe('gpt-5')
    expect(toOpenAIModelId('openai/gpt-4o-2024-11-20')).toBe('gpt-5')
  })

  test('verified-served flagship + codex models pass through unchanged', () => {
    expect(toOpenAIModelId('openai/gpt-5.5')).toBe('gpt-5.5')
    expect(toOpenAIModelId('openai/gpt-5')).toBe('gpt-5')
    expect(toOpenAIModelId('openai/gpt-5-codex')).toBe('gpt-5-codex')
  })

  test('unknown openai/* ids clamp instead of throwing', () => {
    // codex-y unknown → codex model; everything else → flagship.
    expect(toOpenAIModelId('openai/gpt-7-codex-ultra')).toBe('gpt-5-codex')
    expect(toOpenAIModelId('openai/gpt-7-turbo')).toBe('gpt-5')
  })

  test('bare ids pass through; non-OpenAI provider ids throw', () => {
    expect(toOpenAIModelId('gpt-5-codex')).toBe('gpt-5-codex')
    expect(() => toOpenAIModelId('anthropic/claude-opus-4.7')).toThrow()
  })

  test('isOpenAIProviderModel detects the openai/ prefix', () => {
    expect(isOpenAIProviderModel('openai/gpt-5.5')).toBe(true)
    expect(isOpenAIProviderModel('google/gemini-3.1-flash-lite-preview')).toBe(
      false,
    )
  })
})
