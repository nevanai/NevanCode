import fs from 'fs'
import path from 'path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ensureCliTestEnv } from '../../__tests__/test-utils'

ensureCliTestEnv()

const {
  clearOpenAiModelPreference,
  findOpenAiModelOption,
  getSelectedOpenAiModel,
  saveOpenAiModelPreference,
} = await import('../openai-models')
const { getSettingsPath, loadSettings } = await import('../settings')

describe('openai model preferences', () => {
  let originalSettingsFile: string | null = null

  beforeEach(() => {
    const settingsPath = getSettingsPath()
    originalSettingsFile = fs.existsSync(settingsPath)
      ? fs.readFileSync(settingsPath, 'utf8')
      : null
    fs.rmSync(settingsPath, { force: true })
  })

  afterEach(() => {
    const settingsPath = getSettingsPath()
    if (originalSettingsFile === null) {
      fs.rmSync(settingsPath, { force: true })
    } else {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
      fs.writeFileSync(settingsPath, originalSettingsFile)
    }
  })

  test('accepts bare ids, labels, and provider ids', () => {
    expect(findOpenAiModelOption('gpt-5.5')?.id).toBe('gpt-5.5')
    expect(findOpenAiModelOption('GPT-5.5')?.id).toBe('gpt-5.5')
    expect(findOpenAiModelOption('openai/gpt-5.5')?.id).toBe('gpt-5.5')
  })

  test('persists the selected model in settings', () => {
    saveOpenAiModelPreference('openai/gpt-5.5')

    expect(getSelectedOpenAiModel()?.id).toBe('gpt-5.5')
    expect(loadSettings().openAiModel).toBe('gpt-5.5')

    const rawSettings = JSON.parse(
      fs.readFileSync(getSettingsPath(), 'utf8'),
    ) as {
      openAiModel?: string
    }
    expect(rawSettings.openAiModel).toBe('gpt-5.5')
  })

  test('clears the selected model preference', () => {
    saveOpenAiModelPreference('gpt-5.5')
    clearOpenAiModelPreference()

    expect(getSelectedOpenAiModel()).toBeUndefined()
    expect(loadSettings().openAiModel).toBeUndefined()
  })
})
