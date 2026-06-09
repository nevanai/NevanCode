import {
  getAnthropicOAuthCredentials,
  getGeminiOAuthCredentials,
  getValidChatGptOAuthCredentials,
  isAnyByokProviderLinked,
} from '@codebuff/sdk'
import { isAnthropicProviderModel } from '@codebuff/common/constants/anthropic-oauth'
import { isGeminiProviderModel } from '@codebuff/common/constants/gemini-oauth'

import { getChatGptOAuthStatus } from './chatgpt-oauth'
import {
  getSelectedOpenAiModel,
  getSelectedOpenAiProviderModel,
} from './openai-models'
import { loadByokSelectedModel } from './settings'

import type { AgentDefinition } from '@codebuff/sdk'

const OPENAI_OVERRIDE_ROOT_AGENT_IDS = new Set([
  'base2',
  'base2-lite',
  'base2-max',
  'base2-plan',
])

const OPENAI_OVERRIDE_SUBAGENT_IDS = new Set([
  'thinker-gpt',
  'editor-gpt-5',
  'code-reviewer-gpt',
  'gpt-5-agent',
])

const mapSpawnableAgentToOpenAiVariant = (agentId: string): string => {
  if (agentId === 'thinker-gpt') {
    return agentId
  }

  if (agentId === 'thinker' || agentId.startsWith('thinker-best-of-n')) {
    return 'thinker-gpt'
  }

  if (agentId === 'editor-gpt-5') {
    return agentId
  }

  if (agentId === 'editor' || agentId === 'editor-multi-prompt') {
    return 'editor-gpt-5'
  }

  if (agentId === 'code-reviewer-gpt') {
    return agentId
  }

  if (agentId === 'code-reviewer' || agentId.startsWith('code-reviewer-')) {
    return 'code-reviewer-gpt'
  }

  if (agentId === 'opus-agent') {
    return 'gpt-5-agent'
  }

  return agentId
}

const dedupeSpawnableAgents = (agentIds: string[]): string[] => {
  const deduped = new Set<string>()

  for (const agentId of agentIds) {
    deduped.add(agentId)
  }

  return [...deduped]
}

const overrideAgentDefinitionModel = (
  definition: AgentDefinition,
  openAiProviderModel: string,
): AgentDefinition => {
  if (
    !OPENAI_OVERRIDE_ROOT_AGENT_IDS.has(definition.id) &&
    !OPENAI_OVERRIDE_SUBAGENT_IDS.has(definition.id)
  ) {
    return definition
  }

  const nextDefinition: AgentDefinition = {
    ...definition,
    model: openAiProviderModel,
    providerOptions: undefined,
  }

  if (OPENAI_OVERRIDE_ROOT_AGENT_IDS.has(definition.id)) {
    nextDefinition.spawnableAgents = dedupeSpawnableAgents(
      (definition.spawnableAgents ?? []).map(mapSpawnableAgentToOpenAiVariant),
    )
  }

  return nextDefinition
}

const isOpenAiOverridableAgent = (agentId: string): boolean => {
  return (
    OPENAI_OVERRIDE_ROOT_AGENT_IDS.has(agentId) ||
    OPENAI_OVERRIDE_SUBAGENT_IDS.has(agentId)
  )
}

export const shouldUseSelectedOpenAiModelForAgent = (
  agent: AgentDefinition | string,
): boolean => {
  return isOpenAiOverridableAgent(typeof agent === 'string' ? agent : agent.id)
}

export const applySelectedOpenAiModelToRuntimeAgents = (params: {
  agentDefinitions: AgentDefinition[]
  agent: AgentDefinition | string
}): {
  agentDefinitions: AgentDefinition[]
  agent: AgentDefinition | string
} => {
  // When a Claude account is connected and the user picked a specific Claude
  // model via /model, override every agent to it. With no pick, leave agents on
  // their per-tier defaults — getModelForRequest still routes each to Claude.
  if (!isAnyByokProviderLinked() && getAnthropicOAuthCredentials()) {
    const claudeModel = loadByokSelectedModel()
    if (!claudeModel || !isAnthropicProviderModel(claudeModel)) {
      return params
    }
    const agentDefinitions = params.agentDefinitions.map((definition) => ({
      ...definition,
      model: claudeModel,
      providerOptions: undefined,
    }))
    const agent =
      typeof params.agent === 'string'
        ? params.agent
        : { ...params.agent, model: claudeModel, providerOptions: undefined }
    return { agentDefinitions, agent }
  }

  // Same for a connected Gemini (Google) account: override every agent to the
  // picked google/* model; with no pick, leave per-tier defaults (still routed
  // to Gemini by getModelForRequest).
  if (!isAnyByokProviderLinked() && getGeminiOAuthCredentials()) {
    const geminiModel = loadByokSelectedModel()
    if (!geminiModel || !isGeminiProviderModel(geminiModel)) {
      return params
    }
    const agentDefinitions = params.agentDefinitions.map((definition) => ({
      ...definition,
      model: geminiModel,
      providerOptions: undefined,
    }))
    const agent =
      typeof params.agent === 'string'
        ? params.agent
        : { ...params.agent, model: geminiModel, providerOptions: undefined }
    return { agentDefinitions, agent }
  }

  // When a BYOK provider is connected, route ALL agents through that provider's
  // selected model. Every agent (root + subagents) must use the BYOK model — a
  // subagent left on its default model (e.g. google/gemini) cannot be served by
  // Fireworks and would break the run. We override the model directly and keep
  // the original spawnableAgents graph (no GPT-variant remapping).
  if (isAnyByokProviderLinked()) {
    const byokModel = loadByokSelectedModel()
    if (!byokModel) {
      return params
    }
    const agentDefinitions = params.agentDefinitions.map((definition) => ({
      ...definition,
      model: byokModel,
      providerOptions: undefined,
    }))
    const agent =
      typeof params.agent === 'string'
        ? params.agent
        : { ...params.agent, model: byokModel, providerOptions: undefined }
    return { agentDefinitions, agent }
  }

  const openAiProviderModel = getSelectedOpenAiProviderModel()
  if (!openAiProviderModel) {
    return params
  }

  const agentDefinitions = params.agentDefinitions.map((definition) =>
    overrideAgentDefinitionModel(definition, openAiProviderModel),
  )

  if (typeof params.agent === 'string') {
    return {
      agentDefinitions,
      agent: params.agent,
    }
  }

  if (!isOpenAiOverridableAgent(params.agent.id)) {
    return {
      agentDefinitions,
      agent: params.agent,
    }
  }

  return {
    agentDefinitions,
    agent: overrideAgentDefinitionModel(params.agent, openAiProviderModel),
  }
}

export type SelectedOpenAiModelReadiness =
  | {
      ready: true
    }
  | {
      ready: false
      message: string
      status: ReturnType<typeof getChatGptOAuthStatus>
    }

export const ensureSelectedOpenAiModelReady =
  async (): Promise<SelectedOpenAiModelReadiness> => {
    // BYOK users authenticate via their provider key, not ChatGPT OAuth.
    if (isAnyByokProviderLinked()) {
      return { ready: true }
    }

    // A connected Claude account routes every request to the native Anthropic
    // API, so a stale OpenAI model preference must not force a ChatGPT connect.
    if (getAnthropicOAuthCredentials()) {
      return { ready: true }
    }

    // Same for a connected Gemini (Google) account — every request routes to the
    // Code Assist API, so a stale OpenAI model preference must not gate sends.
    if (getGeminiOAuthCredentials()) {
      return { ready: true }
    }

    const selectedOpenAiModel = getSelectedOpenAiModel()
    if (!selectedOpenAiModel) {
      return { ready: true }
    }

    const credentials = await getValidChatGptOAuthCredentials()
    if (credentials) {
      return { ready: true }
    }

    const status = getChatGptOAuthStatus()
    const reason =
      status.state === 'expired'
        ? 'your ChatGPT connection expired or could not be refreshed'
        : 'no ChatGPT connection is currently linked'

    return {
      ready: false,
      status,
      message: `OpenAI model **${selectedOpenAiModel.label}** is selected, but ${reason}. Reconnect via /connect before sending.`,
    }
  }

export const getSelectedOpenAiRuntimeStatus = () => {
  return {
    selectedModel: getSelectedOpenAiModel(),
    connection: getChatGptOAuthStatus(),
  }
}
