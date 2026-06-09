import { modelMessageSchema } from 'ai'
import { cloneDeep, has, isEqual } from 'lodash'

import type { Logger } from '../types/contracts/logger'
import type { JSONValue } from '../types/json'
import type {
  AssistantMessage,
  AuxiliaryMessageData,
  Message,
  SystemMessage,
  ToolMessage,
  UserMessage,
} from '../types/messages/codebuff-message'
import type { ToolResultOutput } from '../types/messages/content-part'
import type { ProviderMetadata } from '../types/messages/provider-metadata'
import type {
  AssistantModelMessage,
  ModelMessage,
  SystemModelMessage,
  ToolModelMessage,
  UserModelMessage,
} from 'ai'


export function toContentString(msg: ModelMessage): string {
  const { content } = msg
  if (typeof content === 'string') return content
  return content
    .map((item) =>
      item && 'text' in item && typeof item.text === 'string' ? item.text : '',
    )
    .join('\n')
}

export function withCacheControl<
  T extends { providerOptions?: ProviderMetadata },
>(obj: T): T {
  const wrapper = cloneDeep(obj)
  if (!wrapper.providerOptions) {
    wrapper.providerOptions = {}
  }

  /* 'codebuff' provider name is not compatible with providerMetadata for
   * messages, so we need to use 'openaiCompatible' instead.
   * https://github.com/vercel/ai/blob/8e4fdac31b4f8c6a8d07a606a8833e74adf99470/packages/openai-compatible/src/chat/convert-to-openai-compatible-chat-messages.ts#L9
   */
  for (const provider of [
    'anthropic',
    'openrouter',
    'openaiCompatible',
  ] as const) {
    if (!wrapper.providerOptions[provider]) {
      wrapper.providerOptions[provider] = {}
    }
    wrapper.providerOptions[provider].cache_control = { type: 'ephemeral' }
  }

  return wrapper
}

export function withoutCacheControl<
  T extends { providerOptions?: ProviderMetadata },
>(obj: T): T {
  const wrapper = cloneDeep(obj)

  for (const provider of [
    'anthropic',
    'openrouter',
    'openaiCompatible',
  ] as const) {
    if (has(wrapper.providerOptions?.[provider]?.cache_control, 'type')) {
      delete wrapper.providerOptions?.[provider]?.cache_control?.type
    }
    if (
      Object.keys(wrapper.providerOptions?.[provider]?.cache_control ?? {})
        .length === 0
    ) {
      delete wrapper.providerOptions?.[provider]?.cache_control
    }
    if (Object.keys(wrapper.providerOptions?.[provider] ?? {}).length === 0) {
      delete wrapper.providerOptions?.[provider]
    }
  }

  if (Object.keys(wrapper.providerOptions ?? {}).length === 0) {
    delete wrapper.providerOptions
  }

  return wrapper
}

type NonStringContent<T extends { content: any }> = Omit<T, 'content'> & {
  content: Exclude<T['content'], string>
}
type ModelMessageWithAuxiliaryData = (
  | SystemModelMessage
  | NonStringContent<UserModelMessage>
  | NonStringContent<AssistantModelMessage>
  | ToolModelMessage
) &
  AuxiliaryMessageData

function assistantToCodebuffMessage(
  message: Omit<AssistantMessage, 'content'> & {
    content: Exclude<AssistantMessage['content'], string>[number]
  },
): AssistantMessage {
  // if (message.content.type === 'tool-call') {
  //   return cloneDeep({
  //     ...message,
  //     content: [
  //       {
  //         type: 'text',
  //         text: getToolCallString(
  //           message.content.toolName,
  //           message.content.input,
  //           false,
  //         ),
  //       },
  //     ],
  //   })
  // }
  return cloneDeep({ ...message, content: [message.content] })
}

function convertToolResultMessage(
  message: ToolMessage,
): ModelMessageWithAuxiliaryData[] {
  if (message.content.length === 0) {
    return [
      cloneDeep<ToolModelMessage>({
        ...message,
        role: 'tool',
        content: [
          {
            ...message,
            output: { type: 'json', value: '' },
            type: 'tool-result',
          },
        ],
      }),
    ]
  }

  // Anthropic (and other providers) require every assistant `tool-call` to be
  // followed by a `tool-result` with the same toolCallId. Splitting media into
  // a standalone user message breaks that pairing, and the model retries the
  // tool call repeatedly (visible to the user as the screenshot tool "looping"
  // for minutes). We must always emit exactly one `tool-result` per call.
  //
  // The AI SDK supports `output.type === 'content'` carrying interleaved text
  // and media parts, which providers translate into the appropriate image /
  // document blocks inside `tool_result`. We use that whenever the MCP tool
  // returns any media, so the screenshot lands inside the tool result and the
  // model sees a proper completion.
  const hasMedia = message.content.some((c) => c.type === 'media')
  if (hasMedia) {
    const contentParts = message.content.map((c) => {
      if (c.type === 'json') {
        return {
          type: 'text' as const,
          text:
            typeof c.value === 'string' ? c.value : JSON.stringify(c.value),
        }
      }
      return {
        type: 'media' as const,
        data: c.data,
        mediaType: c.mediaType,
      }
    })
    return [
      cloneDeep<ToolModelMessage>({
        ...message,
        role: 'tool',
        content: [
          {
            ...message,
            type: 'tool-result',
            output: { type: 'content', value: contentParts },
          } as any,
        ],
      }),
    ]
  }

  return message.content.map((c) => {
    if (c.type === 'json') {
      return cloneDeep<ToolModelMessage>({
        ...message,
        role: 'tool',
        content: [{ ...message, output: c, type: 'tool-result' }],
      })
    }
    if (c.type === 'media') {
      // Unreachable: handled above. Kept for exhaustiveness.
      return cloneDeep<UserMessage>({
        ...message,
        role: 'user',
        content: [{ type: 'file', data: c.data, mediaType: c.mediaType }],
      })
    }
    c satisfies never
    throw new Error(
      `Invalid tool output type: ${(c as { type: unknown }).type}`,
    )
  })
}

function convertToolMessage(message: Message): ModelMessageWithAuxiliaryData[] {
  if (message.role === 'system') {
    return [
      {
        ...message,
        content: message.content.map(({ text }) => text).join('\n\n'),
      },
    ]
  }
  if (message.role === 'user') {
    return [cloneDeep(message)]
  }
  if (message.role === 'assistant') {
    if (typeof message.content === 'string') {
      return [
        cloneDeep({
          ...message,
          content: [{ type: 'text' as const, text: message.content }],
        }),
      ]
    }
    return message.content.map((c) => {
      return assistantToCodebuffMessage({
        ...message,
        content: c,
      })
    })
  }
  if (message.role === 'tool') {
    return convertToolResultMessage(message)
  }
  message satisfies never
  throw new Error(
    `Invalid message role: ${(message as { role: unknown }).role}`,
  )
}

function convertToolMessages(
  messages: Message[],
): ModelMessageWithAuxiliaryData[] {
  const withoutToolMessages: ModelMessageWithAuxiliaryData[] = []
  for (const message of messages) {
    withoutToolMessages.push(...convertToolMessage(message))
  }
  return withoutToolMessages
}

export function convertCbToModelMessages({
  messages,
  includeCacheControl = true,
  logger,
}: {
  messages: Message[]
  includeCacheControl?: boolean
  logger?: Logger
}): ModelMessage[] {
  const toolMessagesConverted: ModelMessageWithAuxiliaryData[] =
    convertToolMessages(messages)

  const aggregated: ModelMessageWithAuxiliaryData[] = []
  for (const message of toolMessagesConverted) {
    if (aggregated.length === 0) {
      aggregated.push(message)
      continue
    }

    const lastMessage = aggregated[aggregated.length - 1]
    if (
      lastMessage.timeToLive !== message.timeToLive ||
      !isEqual(lastMessage.providerOptions, message.providerOptions) ||
      !isEqual(lastMessage.tags, message.tags)
    ) {
      aggregated.push(message)
      continue
    }
    if (lastMessage.role === 'system' && message.role === 'system') {
      lastMessage.content += '\n\n' + message.content
      continue
    }
    if (lastMessage.role === 'user' && message.role === 'user') {
      lastMessage.content.push(...message.content)
      continue
    }
    if (lastMessage.role === 'assistant' && message.role === 'assistant') {
      lastMessage.content.push(...message.content)
      continue
    }

    aggregated.push(message)
  }

  if (!includeCacheControl) {
    return aggregated
  }

  // Anthropic accepts at most 4 cache_control breakpoints per request, shared
  // across system messages, tool definitions, and conversation messages. We
  // allocate 3 slots here for stable system-prompt segments (T0.2 system base,
  // T0.3 knowledge files, T0.4 project memory) and reserve the 4th slot for
  // the tools-schema breakpoint applied in loopAgentSteps (run-agent-step.ts).
  const MAX_CACHE_BREAKPOINTS = 3
  const cachedIndices = new Set<number>()

  // T0.2: Always cache the system message (when present) as the highest-priority
  // breakpoint. The system prompt rarely changes between requests, so it is the
  // most valuable cache target. Without this guarantee, system caching depends
  // on a USER_PROMPT/STEP_PROMPT walk-back happening to land at index 0, which
  // isn't reliable for long histories or after context pruning.
  if (aggregated.length > 0 && aggregated[0].role === 'system') {
    aggregated[0] = withCacheControl(aggregated[0])
    cachedIndices.add(0)
  }

  // T0.3: Cache the knowledge-files segment explicitly. The agent runtime
  // splits a rendered system prompt on sentinels and emits a second
  // `SystemMessage` tagged KNOWLEDGE_FILES; we give it its own breakpoint so
  // it stays cached even when later, more volatile system parts (project
  // memory, git changes, system info) change between requests.
  for (let i = 0; i < aggregated.length; i++) {
    if (cachedIndices.size >= MAX_CACHE_BREAKPOINTS) break
    if (
      aggregated[i].tags?.includes('KNOWLEDGE_FILES') &&
      !cachedIndices.has(i)
    ) {
      aggregated[i] = withCacheControl(aggregated[i])
      cachedIndices.add(i)
    }
  }

  // T0.4: Cache the project-memory segment. The agent runtime splits the
  // rendered system prompt on PROJECT_MEMORY sentinels and emits a
  // `SystemMessage` tagged PROJECT_MEMORY; we give it its own breakpoint so
  // the stable `.nevan/memory.md` content is cached independently of the
  // volatile tail (system info, git changes).
  for (let i = 0; i < aggregated.length; i++) {
    if (cachedIndices.size >= MAX_CACHE_BREAKPOINTS) break
    if (
      aggregated[i].tags?.includes('PROJECT_MEMORY') &&
      !cachedIndices.has(i)
    ) {
      aggregated[i] = withCacheControl(aggregated[i])
      cachedIndices.add(i)
    }
  }

  // Add cache control to specific messages (max of 3 message-level slots):
  // - The message right before the three tagged messages
  // - Last message
  for (const tag of [
    'LAST_ASSISTANT_MESSAGE',
    'USER_PROMPT',
    'STEP_PROMPT',
    undefined, // Last message
  ] as const) {
    if (cachedIndices.size >= MAX_CACHE_BREAKPOINTS) {
      break
    }
    let index =
      tag === 'LAST_ASSISTANT_MESSAGE'
        ? aggregated.findLastIndex((m) => m.role === 'assistant')
        : tag
          ? aggregated.findLastIndex((m) => m.tags?.includes(tag))
          : aggregated.length
    if (index <= 0) {
      continue
    }

    // Iterate to find the last "valid" message that we can cache control
    let prevMessage: (typeof aggregated)[number]
    let contentBlock: (typeof prevMessage)['content']
    addCacheControlLoop: while (true) {
      index--

      // No message found
      if (index < 0) {
        break
      }

      prevMessage = aggregated[index]
      contentBlock = prevMessage.content

      if (typeof contentBlock === 'string') {
        // This must be a system message
        aggregated[index] = withCacheControl(aggregated[index])
        cachedIndices.add(index)
        break
      }

      // Iterate to find the last valid content part (not a very short string)
      let lastContentIndex = contentBlock.length
      let lastContentPart: (typeof contentBlock)[number]
      while (true) {
        lastContentIndex--
        lastContentPart = contentBlock[lastContentIndex]

        if (lastContentIndex < 0) {
          // Continue searching in next message
          break
        }

        if (lastContentPart.type !== 'text') {
          contentBlock[lastContentIndex] = withCacheControl(
            contentBlock[lastContentIndex],
          )
          cachedIndices.add(index)
          break addCacheControlLoop
        }

        prevMessage.content = [
          ...contentBlock.slice(0, lastContentIndex),
          withCacheControl(lastContentPart),
          ...contentBlock.slice(lastContentIndex + 1),
        ] as typeof contentBlock
        cachedIndices.add(index)

        break addCacheControlLoop
      }
      break
    }
  }

  // Validate each message against the AI SDK schema
  for (let i = 0; i < aggregated.length; i++) {
    const message = aggregated[i]
    const result = modelMessageSchema.safeParse(message)
    if (!result.success) {
      if (logger) {
        logger.error(
          { message, aggregated, error: result.error },
          `convertCbToModelMessages: Message at index ${i} failed schema validation.`,
        )
      }
      throw new Error(
        `convertCbToModelMessages: Message at index ${i} failed schema validation.\n` +
        `Role: ${message.role}\n` +
        `Message:\n${result.error.message}`,
      )
    }
  }

  return aggregated
}

// type NoContent<T> = T & { content?: never }
export type SystemContent =
  | string
  | SystemMessage['content'][number]
  | SystemMessage['content']
export function systemContent(
  content: SystemContent,
): SystemMessage['content'] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) {
    return content
  }
  return [content]
}

export function systemMessage(
  params:
    | SystemContent
    | ({
      content: SystemContent
    } & Omit<SystemMessage, 'role' | 'content'>),
): SystemMessage {
  if (typeof params === 'object' && 'content' in params) {
    return {
      ...params,
      role: 'system',
      content: systemContent(params.content),
    }
  }
  return {
    role: 'system',
    content: systemContent(params),
  }
}

export type UserContent =
  | string
  | UserMessage['content'][number]
  | UserMessage['content']
export function userContent(content: UserContent): UserMessage['content'] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) {
    return content
  }
  return [content]
}

export function userMessage(
  params:
    | UserContent
    | ({
      content: UserContent
    } & Omit<UserMessage, 'role' | 'content'>),
): UserMessage {
  if (typeof params === 'object' && 'content' in params) {
    return {
      ...params,
      role: 'user',
      content: userContent(params.content),
      sentAt: Date.now(),
    }
  }
  return {
    role: 'user',
    content: userContent(params),
    sentAt: Date.now(),
  }
}

export type AssistantContent =
  | string
  | AssistantMessage['content'][number]
  | AssistantMessage['content']
export function assistantContent(
  content: AssistantContent,
): AssistantMessage['content'] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) {
    return content
  }
  return [content]
}

export function assistantMessage(
  params:
    | AssistantContent
    | ({
      content: AssistantContent
    } & Omit<AssistantMessage, 'role' | 'content'>),
): AssistantMessage {
  if (typeof params === 'object' && 'content' in params) {
    return {
      ...params,
      role: 'assistant',
      content: assistantContent(params.content),
      sentAt: Date.now(),
    }
  }
  return {
    role: 'assistant',
    content: assistantContent(params),
    sentAt: Date.now(),
  }
}

export function jsonToolResult<T extends JSONValue>(
  value: T,
): [
    Extract<ToolResultOutput, { type: 'json' }> & {
      value: T
    },
  ] {
  return [
    {
      type: 'json',
      value,
    },
  ]
}

export function mediaToolResult(params: {
  data: string
  mediaType: string
}): [Extract<ToolResultOutput, { type: 'media' }>] {
  const { data, mediaType } = params
  return [
    {
      type: 'media',
      data,
      mediaType,
    },
  ]
}
