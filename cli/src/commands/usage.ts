import { getChatGptOAuthCredentials, isChatGptOAuthValid } from '@codebuff/sdk'

import { useChatStore } from '../state/chat-store'
import { getChatGptOAuthStatus } from '../utils/chatgpt-oauth'
import { getAuthToken } from '../utils/auth'
import { getSystemMessage } from '../utils/message-history'
import { getSelectedOpenAiModel } from '../utils/openai-models'
import {
  getCliRuntimeIdentity,
  prependCliRuntimeIdentity,
} from '../utils/runtime-identity'

import type { PostUserMessageFn } from '../types/contracts/send-message'
import type { OpenAiModelOption } from '../utils/openai-models'
import type { CliRuntimeIdentity } from '../utils/runtime-identity'

interface OpenAISubscription {
  plan?: { title?: string }
  hard_limit_usd?: number
  soft_limit_usd?: number
  system_hard_limit_usd?: number
  access_until?: number
}

interface OpenAIUsageSummary {
  total_usage?: number // cents
}

async function fetchOpenAIUsageInfo(
  accessToken: string,
  params?: {
    selectedModelLabel?: string
  },
): Promise<string> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }

  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 10)
  const today = now.toISOString().slice(0, 10)

  try {
    // Fetch subscription / limits
    const [subRes, usageRes] = await Promise.all([
      fetch('https://api.openai.com/dashboard/billing/subscription', {
        headers,
      }),
      fetch(
        `https://api.openai.com/dashboard/billing/usage?start_date=${startOfMonth}&end_date=${today}`,
        { headers },
      ),
    ])

    const lines: string[] = ['📊 **OpenAI Account Usage**', '']

    if (params?.selectedModelLabel) {
      lines.push(`Selected model: ${params.selectedModelLabel}`)
      lines.push('Connection: connected')
      lines.push('')
    }

    if (subRes.ok) {
      const sub = (await subRes.json()) as OpenAISubscription
      const plan = sub.plan?.title ?? 'Unknown'
      const hardLimit = sub.hard_limit_usd ?? sub.system_hard_limit_usd
      const softLimit = sub.soft_limit_usd
      const until = sub.access_until
        ? new Date(sub.access_until * 1000).toLocaleDateString()
        : null

      lines.push(`Plan:        ${plan}`)
      if (hardLimit !== undefined)
        lines.push(`Hard limit:  $${hardLimit.toFixed(2)} / month`)
      if (softLimit !== undefined)
        lines.push(`Soft limit:  $${softLimit.toFixed(2)} / month`)
      if (until) lines.push(`Access until: ${until}`)
    } else {
      lines.push(
        'Plan info:   (unavailable — ChatGPT OAuth scope may not include billing)',
      )
    }

    if (usageRes.ok) {
      const usage = (await usageRes.json()) as OpenAIUsageSummary
      const dollars = ((usage.total_usage ?? 0) / 100).toFixed(4)
      lines.push('')
      lines.push(`Used this month: $${dollars}`)
    }

    lines.push('')
    lines.push(`Period: ${startOfMonth} → ${today}`)
    lines.push(
      'Tip: Use /model to see available models, /connect to re-link your account.',
    )

    return lines.join('\n')
  } catch (err) {
    return `Unable to fetch OpenAI usage: ${err instanceof Error ? err.message : String(err)}`
  }
}

interface UsageCommandDeps {
  buildSystemMessage: typeof getSystemMessage
  fetchOpenAIUsageInfo: typeof fetchOpenAIUsageInfo
  getAuthToken: typeof getAuthToken
  getOAuthCredentials: typeof getChatGptOAuthCredentials
  getOAuthStatus: typeof getChatGptOAuthStatus
  getRuntimeIdentity: () => CliRuntimeIdentity
  getSelectedOpenAiModel: () => OpenAiModelOption | undefined
  isOAuthValid: typeof isChatGptOAuthValid
  setInputMode: (mode: 'usage') => void
}

const defaultUsageCommandDeps: UsageCommandDeps = {
  buildSystemMessage: getSystemMessage,
  fetchOpenAIUsageInfo,
  getAuthToken,
  getOAuthCredentials: getChatGptOAuthCredentials,
  getOAuthStatus: getChatGptOAuthStatus,
  getRuntimeIdentity: getCliRuntimeIdentity,
  getSelectedOpenAiModel,
  isOAuthValid: isChatGptOAuthValid,
  setInputMode: (mode) => useChatStore.getState().setInputMode(mode),
}

const appendSystemMessage =
  (
    buildSystemMessage: typeof getSystemMessage,
    content: string,
  ): PostUserMessageFn =>
  (prev) => [...prev, buildSystemMessage(content)]

export async function handleUsageCommand(
  deps: UsageCommandDeps = defaultUsageCommandDeps,
): Promise<{
  postUserMessage: PostUserMessageFn
}> {
  const authToken = deps.getAuthToken()
  const selectedOpenAiModel = deps.getSelectedOpenAiModel()
  const oauthStatus = deps.getOAuthStatus()
  const runtimeIdentity = deps.getRuntimeIdentity()
  const withRuntimeIdentity = (content: string) =>
    prependCliRuntimeIdentity(content, runtimeIdentity)

  if (!authToken) {
    return {
      postUserMessage: appendSystemMessage(
        deps.buildSystemMessage,
        withRuntimeIdentity('Please log in first to view your usage.'),
      ),
    }
  }

  // Check if we have a valid ChatGPT / OpenAI OAuth token
  const oauthCreds = deps.getOAuthCredentials()
  if (oauthCreds && deps.isOAuthValid()) {
    const usageText = await deps.fetchOpenAIUsageInfo(oauthCreds.accessToken, {
      selectedModelLabel: selectedOpenAiModel?.label,
    })
    return {
      postUserMessage: appendSystemMessage(
        deps.buildSystemMessage,
        withRuntimeIdentity(usageText),
      ),
    }
  }

  if (selectedOpenAiModel) {
    deps.setInputMode('usage')
    const connectionLine =
      oauthStatus.state === 'expired'
        ? 'ChatGPT connection expired. Reconnect via /connect to use it.'
        : 'Connect via /connect to use it.'

    return {
      postUserMessage: appendSystemMessage(
        deps.buildSystemMessage,
        withRuntimeIdentity(
          `Selected OpenAI model: **${selectedOpenAiModel.label}**\n${connectionLine}`,
        ),
      ),
    }
  }

  // Fallback: show the built-in Codebuff usage banner
  deps.setInputMode('usage')

  if (!runtimeIdentity.visibleInUi) {
    return { postUserMessage: (prev) => prev }
  }

  return {
    postUserMessage: appendSystemMessage(
      deps.buildSystemMessage,
      runtimeIdentity.label,
    ),
  }
}
