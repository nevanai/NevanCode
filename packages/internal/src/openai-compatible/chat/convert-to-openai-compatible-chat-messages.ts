import { UnsupportedFunctionalityError } from '@ai-sdk/provider'
import { convertToBase64 } from '@ai-sdk/provider-utils'

import type { OpenAICompatibleChatPrompt } from './openai-compatible-api-types'
import type {
  LanguageModelV2Prompt,
  SharedV2ProviderMetadata,
} from '@ai-sdk/provider'

function getOpenAIMetadata(message: {
  providerOptions?: SharedV2ProviderMetadata
}) {
  return message?.providerOptions?.openaiCompatible ?? {}
}

export function convertToOpenAICompatibleChatMessages(
  prompt: LanguageModelV2Prompt,
): OpenAICompatibleChatPrompt {
  const messages: OpenAICompatibleChatPrompt = []
  for (const { role, content, ...message } of prompt) {
    const metadata = getOpenAIMetadata({ ...message })
    switch (role) {
      case 'system': {
        messages.push({ role: 'system', content, ...metadata })
        break
      }

      case 'user': {
        messages.push({
          role: 'user',
          content: content.map((part) => {
            const partMetadata = getOpenAIMetadata(part)
            switch (part.type) {
              case 'text': {
                return { type: 'text', text: part.text, ...partMetadata }
              }
              case 'file': {
                if (part.mediaType.startsWith('image/')) {
                  const mediaType =
                    part.mediaType === 'image/*' ? 'image/jpeg' : part.mediaType

                  return {
                    type: 'image_url',
                    image_url: {
                      url:
                        part.data instanceof URL
                          ? part.data.toString()
                          : `data:${mediaType};base64,${convertToBase64(part.data)}`,
                    },
                    ...partMetadata,
                  }
                } else {
                  throw new UnsupportedFunctionalityError({
                    functionality: `file part media type ${part.mediaType}`,
                  })
                }
              }
            }
          }),
          ...metadata,
        })

        break
      }

      case 'assistant': {
        let text = ''
        let reasoningContent = ''
        const toolCalls: Array<{
          id: string
          type: 'function'
          function: { name: string; arguments: string }
        }> = []

        for (const part of content) {
          const partMetadata = getOpenAIMetadata(part)
          switch (part.type) {
            case 'text': {
              text += part.text
              break
            }
            case 'reasoning': {
              reasoningContent += part.text
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
                ...partMetadata,
              })
              break
            }
          }
        }

        messages.push({
          role: 'assistant',
          content: text,
          reasoning_content:
            reasoningContent.length > 0 ? reasoningContent : undefined,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          ...metadata,
        })

        break
      }

      case 'tool': {
        // Images returned by a tool (computer-use / browser screenshots) can't
        // live in a `role:'tool'` message — OpenAI-compatible APIs only allow a
        // string there. Stringifying them (the old `JSON.stringify(output.value)`
        // for `content`) sent the base64 as TEXT: one ~0.5MB screenshot became
        // ~150K tokens, and a few blew past the context window ("prompt is too
        // long"). Instead keep a short text summary in the tool message
        // (preserving the one-tool-result-per-call pairing) and relocate the
        // images into a following `user` message as `image_url`, where the
        // provider bills them as images (~1600 tokens).
        const trailingImageParts: Array<{
          type: 'image_url'
          image_url: { url: string }
        }> = []
        for (const toolResponse of content) {
          const output = toolResponse.output

          let contentValue: string
          switch (output.type) {
            case 'text':
            case 'error-text':
              contentValue = output.value
              break
            case 'json':
            case 'error-json':
              contentValue = JSON.stringify(output.value)
              break
            case 'content': {
              const textChunks: string[] = []
              for (const part of output.value) {
                if (part.type === 'text') {
                  textChunks.push(part.text)
                } else if (
                  part.type === 'media' &&
                  part.mediaType.startsWith('image/')
                ) {
                  const mediaType =
                    part.mediaType === 'image/*' ? 'image/jpeg' : part.mediaType
                  trailingImageParts.push({
                    type: 'image_url',
                    image_url: {
                      url: `data:${mediaType};base64,${part.data}`,
                    },
                  })
                } else if (part.type === 'media') {
                  textChunks.push(`[${part.mediaType} attachment omitted]`)
                }
              }
              contentValue =
                textChunks.length > 0
                  ? textChunks.join('\n')
                  : trailingImageParts.length > 0
                    ? 'See attached image in the following message.'
                    : ''
              break
            }
          }

          const toolResponseMetadata = getOpenAIMetadata(toolResponse)
          messages.push({
            role: 'tool',
            tool_call_id: toolResponse.toolCallId,
            content: contentValue,
            ...toolResponseMetadata,
          })
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
        const _exhaustiveCheck: never = role
        throw new Error(`Unsupported role: ${_exhaustiveCheck}`)
      }
    }
  }

  return messages
}
