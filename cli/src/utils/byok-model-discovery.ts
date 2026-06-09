/**
 * Auto-discovery of available models for BYOK providers.
 * Called after the user saves a provider API key.
 * Runs in the background — failures are silently swallowed.
 */

import {
  saveFireworksDiscoveredModels,
  saveOpenRouterDiscoveredModels,
} from './settings'

interface OpenAIModel {
  id: string
  object?: string
}

interface OpenAIModelsResponse {
  data: OpenAIModel[]
}

async function fetchModels(
  baseUrl: string,
  apiKey: string,
  extraHeaders?: Record<string, string>,
): Promise<string[]> {
  const res = await fetch(`${baseUrl}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) return []

  const body = (await res.json()) as OpenAIModelsResponse
  if (!Array.isArray(body?.data)) return []

  return body.data
    .map((m) => m.id)
    .filter((id) => typeof id === 'string' && id.length > 0)
    .sort()
}

/**
 * Discover and store Fireworks models in the background.
 * Model IDs returned by Fireworks are prefixed with `fireworks/` so the
 * routing in model-provider.ts can identify them.
 */
export async function discoverFireworksModels(apiKey: string): Promise<void> {
  try {
    const ids = await fetchModels('https://api.fireworks.ai/inference/v1', apiKey)
    if (ids.length === 0) return
    // Prefix all IDs so the router recognises them as Fireworks models.
    const prefixed = ids.map((id) => (id.startsWith('fireworks/') ? id : `fireworks/${id}`))
    saveFireworksDiscoveredModels(prefixed)
  } catch {
    // Discovery is best-effort — don't surface errors to the user.
  }
}

/**
 * Discover and store OpenRouter models in the background.
 */
export async function discoverOpenRouterModels(apiKey: string): Promise<void> {
  try {
    const ids = await fetchModels('https://openrouter.ai/api/v1', apiKey, {
      'HTTP-Referer': 'https://nevancode.app',
      'X-Title': 'NevanCode',
    })
    if (ids.length === 0) return
    saveOpenRouterDiscoveredModels(ids)
  } catch {
    // Discovery is best-effort — don't surface errors to the user.
  }
}
