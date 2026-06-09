import fs from 'fs'
import path from 'path'

import { OPENROUTER_TO_OPENAI_MODEL_MAP } from '@codebuff/common/constants/chatgpt-oauth'
import { isFreebuffModelId } from '@codebuff/common/constants/freebuff-models'

import { getConfigDir } from './auth'
import { AGENT_MODES } from './constants'
import { logger } from './logger'

import type { AgentMode } from './constants'

const DEFAULT_SETTINGS: Settings = {
  mode: 'DEFAULT' as const,
  adsEnabled: true,
}

// Note: The old FREE mode has been renamed back to LITE; migrate on load.

/**
 * Settings schema - add new settings here as the product evolves
 */
export interface Settings {
  mode?: AgentMode
  adsEnabled?: boolean
  /** Last OpenAI model selected via /model in the paid Codebuff CLI.
   *  Persisted as the bare model id (for example: `gpt-5.5`). */
  openAiModel?: string
  /** Last model the user picked in the freebuff model selector. Restored on
   *  next freebuff launch so users land in the queue for their preferred
   *  model without re-picking. Persisted as the canonical model id. */
  freebuffModel?: string
  /** Models discovered from the connected Fireworks.ai account. */
  fireworksDiscoveredModels?: string[]
  /** Models discovered from the connected OpenRouter account. */
  openRouterDiscoveredModels?: string[]
  /** @deprecated Use server-side fallbackToALaCarte setting instead */
  alwaysUseALaCarte?: boolean
  /** @deprecated Use server-side fallbackToALaCarte setting instead */
  fallbackToALaCarte?: boolean
  /** Model selected by the user when a BYOK provider is connected (e.g. fireworks/accounts/…). */
  byokSelectedModel?: string
}

const normalizeOpenAiModelPreference = (model: unknown): string | undefined => {
  if (typeof model !== 'string') {
    return
  }

  const trimmed = model.trim()
  if (!trimmed) {
    return
  }

  if (trimmed in OPENROUTER_TO_OPENAI_MODEL_MAP) {
    return OPENROUTER_TO_OPENAI_MODEL_MAP[trimmed]
  }

  if (`openai/${trimmed}` in OPENROUTER_TO_OPENAI_MODEL_MAP) {
    return trimmed
  }

  return
}

/**
 * Get the settings file path
 */
export const getSettingsPath = (): string => {
  return path.join(getConfigDir(), 'settings.json')
}

/**
 * Ensure the config directory exists, creating it if necessary
 */
const ensureConfigDirExists = (): void => {
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }
}

/**
 * Load all settings from file system
 * @returns The saved settings object, with defaults for missing values
 */
export const loadSettings = (): Settings => {
  const settingsPath = getSettingsPath()

  if (!fs.existsSync(settingsPath)) {
    ensureConfigDirExists()
    // Create default settings file
    fs.writeFileSync(settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 2))
    return DEFAULT_SETTINGS
  }

  try {
    const settingsFile = fs.readFileSync(settingsPath, 'utf8')
    const parsed = JSON.parse(settingsFile)
    return validateSettings(parsed)
  } catch (error) {
    logger.debug(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Error reading settings',
    )
    return {}
  }
}

/**
 * Validate and sanitize settings from file
 */
const validateSettings = (parsed: unknown): Settings => {
  if (typeof parsed !== 'object' || parsed === null) {
    return {}
  }

  const settings: Settings = {}
  const obj = parsed as Record<string, unknown>

  // Validate mode; migrate the previously-saved 'FREE' value to 'LITE'.
  if (typeof obj.mode === 'string') {
    const normalized = obj.mode === 'FREE' ? 'LITE' : obj.mode
    if (AGENT_MODES.includes(normalized as AgentMode)) {
      settings.mode = normalized as AgentMode
    }
  }

  // Validate adsEnabled
  if (typeof obj.adsEnabled === 'boolean') {
    settings.adsEnabled = obj.adsEnabled
  }

  const normalizedOpenAiModel = normalizeOpenAiModelPreference(obj.openAiModel)
  if (normalizedOpenAiModel) {
    settings.openAiModel = normalizedOpenAiModel
  }

  // Validate freebuffModel — drop unknown ids so a removed model doesn't
  // strand the user on a non-existent queue.
  if (
    typeof obj.freebuffModel === 'string' &&
    isFreebuffModelId(obj.freebuffModel)
  ) {
    settings.freebuffModel = obj.freebuffModel
  }

  // Validate discovered model lists for BYOK providers
  if (Array.isArray(obj.fireworksDiscoveredModels)) {
    const models = obj.fireworksDiscoveredModels.filter((m) => typeof m === 'string')
    if (models.length > 0) settings.fireworksDiscoveredModels = models
  }
  if (Array.isArray(obj.openRouterDiscoveredModels)) {
    const models = obj.openRouterDiscoveredModels.filter((m) => typeof m === 'string')
    if (models.length > 0) settings.openRouterDiscoveredModels = models
  }

  // Validate alwaysUseALaCarte (legacy)
  if (typeof obj.alwaysUseALaCarte === 'boolean') {
    settings.alwaysUseALaCarte = obj.alwaysUseALaCarte
  }

  // Validate fallbackToALaCarte (legacy)
  if (typeof obj.fallbackToALaCarte === 'boolean') {
    settings.fallbackToALaCarte = obj.fallbackToALaCarte
  }

  // Validate byokSelectedModel
  if (typeof obj.byokSelectedModel === 'string' && obj.byokSelectedModel.trim()) {
    settings.byokSelectedModel = obj.byokSelectedModel.trim()
  }

  return settings
}

/**
 * Save settings to file system (merges with existing settings)
 */
export const saveSettings = (newSettings: Partial<Settings>): void => {
  const settingsPath = getSettingsPath()

  try {
    ensureConfigDirExists()

    // Load existing settings and merge
    const existingSettings = loadSettings()
    const mergedSettings = { ...existingSettings, ...newSettings }

    fs.writeFileSync(settingsPath, JSON.stringify(mergedSettings, null, 2))
  } catch (error) {
    logger.debug(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      'Error saving settings',
    )
  }
}

/**
 * Load the saved agent mode preference
 * @returns The saved mode, or 'DEFAULT' if not found or invalid
 */
export const loadModePreference = (): AgentMode => {
  const settings = loadSettings()
  return settings.mode ?? 'DEFAULT'
}

/**
 * Save the agent mode preference
 */
export const saveModePreference = (mode: AgentMode): void => {
  saveSettings({ mode })
}

/**
 * Load the saved freebuff model preference. Returns undefined if none is
 * saved yet — callers should fall back to DEFAULT_FREEBUFF_MODEL_ID.
 */
export const loadFreebuffModelPreference = (): string | undefined => {
  return loadSettings().freebuffModel
}

/**
 * Load the saved OpenAI model preference for the regular Codebuff CLI.
 */
export const loadOpenAiModelPreference = (): string | undefined => {
  return loadSettings().openAiModel
}

/**
 * Save the selected OpenAI model preference.
 */
export const saveOpenAiModelPreference = (model: string): void => {
  const normalizedModel = normalizeOpenAiModelPreference(model)
  if (!normalizedModel) {
    return
  }

  saveSettings({ openAiModel: normalizedModel })
}

/**
 * Clear the saved OpenAI model preference.
 */
export const clearOpenAiModelPreference = (): void => {
  saveSettings({ openAiModel: undefined })
}

/**
 * Save the freebuff model preference. Called whenever the user picks a model
 * in the waiting room so the next launch defaults to it.
 */
export const saveFreebuffModelPreference = (model: string): void => {
  saveSettings({ freebuffModel: model })
}

/**
 * Load models discovered from the connected Fireworks.ai account.
 */
export const loadFireworksDiscoveredModels = (): string[] => {
  return loadSettings().fireworksDiscoveredModels ?? []
}

/**
 * Save models discovered from the connected Fireworks.ai account.
 */
export const saveFireworksDiscoveredModels = (models: string[]): void => {
  saveSettings({ fireworksDiscoveredModels: models })
}

/**
 * Load models discovered from the connected OpenRouter account.
 */
export const loadOpenRouterDiscoveredModels = (): string[] => {
  return loadSettings().openRouterDiscoveredModels ?? []
}

/**
 * Save models discovered from the connected OpenRouter account.
 */
export const saveOpenRouterDiscoveredModels = (models: string[]): void => {
  saveSettings({ openRouterDiscoveredModels: models })
}

/**
 * Load the model selected when a BYOK provider is active.
 */
export const loadByokSelectedModel = (): string | undefined => {
  return loadSettings().byokSelectedModel
}

/**
 * Save the model to use when a BYOK provider is active.
 */
export const saveByokSelectedModel = (model: string): void => {
  saveSettings({ byokSelectedModel: model })
}
