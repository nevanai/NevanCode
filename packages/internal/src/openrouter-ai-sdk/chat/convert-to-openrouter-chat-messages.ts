import { getFileUrl } from './file-url-utils'
import { isUrl } from './is-url'
import { ReasoningDetailType } from '../schemas/reasoning-details'

import type { ReasoningDetailUnion } from '../schemas/reasoning-details'
import type {
  ChatCompletionContentPart,
  OpenRouterChatCompletionsInput,
} from '../types/openrouter-chat-completions-input'
import type {
  LanguageModelV2FilePart,
  LanguageModelV2Prompt,
  LanguageModelV2TextPart,
  LanguageModelV2ToolResultPart,
  SharedV2ProviderMetadata,
} from '@ai-sdk/provider'

// Type for OpenRouter Cache Control following Anthropic's pattern
export type OpenRouterCacheControl = { type: 'ephemeral' }

function getCacheControl(
  providerMetadata: SharedV2ProviderMetadata | undefined,
): OpenRouterCacheControl | undefined {
  const anthropic = providerMetadata?.anthropic
  const openrouter = providerMetadata?.openrouter

  // Allow both cacheControl and cache_control:
  return (openrouter?.cacheControl ??
    openrouter?.cache_control ??
    anthropic?.cacheControl ??
    anthropic?.cache_control) as OpenRouterCacheControl | undefined
}

export function convertToOpenRouterChatMessages(
  prompt: LanguageModelV2Prompt,
): OpenRouterChatCompletionsInput {
  const messages: OpenRouterChatCompletionsInput = []
  for (const { role, content, providerOptions } of prompt) {
    switch (role) {
      case 'system': {
        messages.push({
          role: 'system',
          content,
          cache_control: getCacheControl(providerOptions),
        })
        break
      }

      case 'user': {
        // Get message level cache control
        const messageCacheControl = getCacheControl(providerOptions)
        const contentParts: ChatCompletionContentPart[] = content.map(
          (part: LanguageModelV2TextPart | LanguageModelV2FilePart) => {
            const cacheControl =
              getCacheControl(part.providerOptions) ?? messageCacheControl

            switch (part.type) {
              case 'text':
                return {
                  type: 'text' as const,
                  text: part.text,
                  // For text parts, only use part-specific cache control
                  cache_control: cacheControl,
                }
              case 'file': {
                if (part.mediaType?.startsWith('image/')) {
                  const url = getFileUrl({
                    part,
                    defaultMediaType: 'image/jpeg',
                  })
                  return {
                    type: 'image_url' as const,
                    image_url: {
                      url,
                    },
                    // For image parts, use part-specific or message-level cache control
                    cache_control: cacheControl,
                  }
                }

                const fileName = String(
                  part.providerOptions?.openrouter?.filename ??
                    part.filename ??
                    '',
                )

                const fileData = getFileUrl({
                  part,
                  defaultMediaType: 'application/pdf',
                })

                if (
                  isUrl({
                    url: fileData,
                    protocols: new Set(['http:', 'https:']),
                  })
                ) {
                  return {
                    type: 'file' as const,
                    file: {
                      filename: fileName,
                      file_data: fileData,
                    },
                  } satisfies ChatCompletionContentPart
                }

                return {
                  type: 'file' as const,
                  file: {
                    filename: fileName,
                    file_data: fileData,
                  },
                  cache_control: cacheControl,
                } satisfies ChatCompletionContentPart
              }
              default: {
                return {
                  type: 'text' as const,
                  text: '',
                  cache_control: cacheControl,
                }
              }
            }
          },
        )

        // For multi-part messages, don't add cache_control at the root level
        messages.push({
          role: 'user',
          content: contentParts,
        })

        break
      }

      case 'assistant': {
        let text = ''
        let reasoning = ''
        const reasoningDetails: ReasoningDetailUnion[] = []
        const toolCalls: Array<{
          id: string
          type: 'function'
          function: { name: string; arguments: string }
        }> = []

        for (const part of content) {
          switch (part.type) {
            case 'text': {
              text += part.text
              break
            }
            case 'tool-call': {
              toolCalls.push({
                id: part.toolCallId,
                type: 'function',
                function: {
                  name: part.toolName,
                  arguments: JSON.stringify(part.input),
                },
              })
              break
            }
            case 'reasoning': {
              reasoning += part.text
              reasoningDetails.push({
                type: ReasoningDetailType.Text,
                text: part.text,
              })

              break
            }

            case 'file':
              break
            default: {
              break
            }
          }
        }

        messages.push({
          role: 'assistant',
          content: text,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          reasoning: reasoning || undefined,
          reasoning_details:
            reasoningDetails.length > 0 ? reasoningDetails : undefined,
          cache_control: getCacheControl(providerOptions),
        })

        break
      }

      case 'tool': {
        // Images returned by a tool (e.g. computer-use / browser screenshots)
        // cannot live inside a `role:'tool'` message — the OpenAI/OpenRouter
        // chat-completions API only allows a string there. If we stringify them
        // (the old behaviour), the base64 is sent as TEXT: a single ~0.5MB
        // screenshot becomes ~150K tokens, and a handful blow past the model's
        // context window ("prompt is too long"). Instead we keep a short text
        // summary in the tool message (preserving the required one-tool-result-
        // per-call pairing) and emit the images in a following `user` message as
        // `image_url`, where the provider counts them as images (~1600 tokens).
        const trailingImageParts: ChatCompletionContentPart[] = []
        for (const toolResponse of content) {
          const { text, images } = splitToolResultContent(toolResponse)

          messages.push({
            role: 'tool',
            tool_call_id: toolResponse.toolCallId,
            content: text,
            cache_control:
              getCacheControl(providerOptions) ??
              getCacheControl(toolResponse.providerOptions),
          })
          trailingImageParts.push(...images)
        }

        if (trailingImageParts.length > 0) {
          messages.push({
            role: 'user',
            content: trailingImageParts,
          })
        }
        break
      }

      default: {
        break
      }
    }
  }

  return messages
}

/**
 * Splits a tool result into the text that stays in the `role:'tool'` message
 * and any images that must be relocated to a following `user` message.
 *
 * Only `output.type === 'content'` can carry media parts; every other output
 * type is plain text/JSON and yields no images. Images are emitted as
 * `image_url` data URLs — the same representation the user-message path uses —
 * so the provider bills them as images instead of as raw base64 text.
 */
function splitToolResultContent(input: LanguageModelV2ToolResultPart): {
  text: string
  images: ChatCompletionContentPart[]
} {
  const output = input.output

  if (output.type === 'text' || output.type === 'error-text') {
    return { text: output.value, images: [] }
  }

  if (output.type !== 'content') {
    // json / error-json — no media possible.
    return { text: JSON.stringify(output.value), images: [] }
  }

  const textChunks: string[] = []
  const images: ChatCompletionContentPart[] = []
  for (const part of output.value) {
    if (part.type === 'text') {
      textChunks.push(part.text)
    } else if (part.type === 'media' && part.mediaType.startsWith('image/')) {
      images.push({
        type: 'image_url' as const,
        image_url: {
          url: `data:${part.mediaType};base64,${part.data}`,
        },
      })
    } else if (part.type === 'media') {
      // Non-image media (audio, etc.) can't be sent in chat-completions; note
      // it textually rather than dumping base64.
      textChunks.push(`[${part.mediaType} attachment omitted]`)
    }
  }

  // Tool messages must carry non-empty content. When a tool returns only an
  // image, leave a short marker pointing at the following user message.
  const text =
    textChunks.length > 0
      ? textChunks.join('\n')
      : images.length > 0
        ? 'See attached image in the following message.'
        : ''

  return { text, images }
}
