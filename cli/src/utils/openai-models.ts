import {
  clearOpenAiModelPreference as clearOpenAiModelPreferenceInSettings,
  loadOpenAiModelPreference,
  saveOpenAiModelPreference as saveOpenAiModelPreferenceInSettings,
} from './settings'

export interface OpenAiModelOption {
  id: string
  label: string
  note: string
}

export const OPENAI_MODEL_OPTIONS: OpenAiModelOption[] = [
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    note: 'Frontier coding and knowledge work',
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    note: 'SOTA 1M context and computer use',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    note: 'Fast and efficient GPT-5.4',
  },
  {
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',
    note: 'Agentic coding specialist',
  },
  {
    id: 'gpt-5-codex',
    label: 'GPT-5 Codex',
    note: 'Agentic coding model served by the Codex backend',
  },
  {
    id: 'gpt-5',
    label: 'GPT-5',
    note: 'ChatGPT flagship — strong general coding and reasoning',
  },
  // NOTE: the o-series (o3/o3-pro/o3-mini/o4-mini) is intentionally NOT offered.
  // Those reasoning models are not served on the ChatGPT-account Codex path, so a
  // pick would clamp to gpt-5 (see OPENROUTER_TO_OPENAI_MODEL_MAP) — offering them
  // as distinct models would be misleading. The gpt-5.x entries above are kept per
  // the repo's display-ahead-of-wire convention (they resolve to served gpt-5 ids).
]

const normalizeModelLookupKey = (value: string): string => {
  return value.trim().toLowerCase()
}

export const findOpenAiModelOption = (
  value: string,
): OpenAiModelOption | undefined => {
  const normalized = normalizeModelLookupKey(value)
  if (!normalized) {
    return
  }

  return OPENAI_MODEL_OPTIONS.find((model) => {
    return (
      normalizeModelLookupKey(model.id) === normalized ||
      normalizeModelLookupKey(model.label) === normalized ||
      normalizeModelLookupKey(`openai/${model.id}`) === normalized
    )
  })
}

export const getSelectedOpenAiModel = (): OpenAiModelOption | undefined => {
  const savedModel = loadOpenAiModelPreference()
  if (!savedModel) {
    return
  }

  return findOpenAiModelOption(savedModel)
}

export const getSelectedOpenAiProviderModel = (): string | undefined => {
  const selectedModel = getSelectedOpenAiModel()
  return selectedModel ? `openai/${selectedModel.id}` : undefined
}

export const saveOpenAiModelPreference = (model: string): void => {
  saveOpenAiModelPreferenceInSettings(model)
}

export const clearOpenAiModelPreference = (): void => {
  clearOpenAiModelPreferenceInSettings()
}
