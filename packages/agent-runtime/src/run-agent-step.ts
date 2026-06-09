import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { shouldUseLocalTokenCountForFreebuffDeepseekFlash } from '@codebuff/common/constants/free-agents'
import { supportsCacheControl } from '@codebuff/common/old-constants'
import { TOOLS_WHICH_WONT_FORCE_NEXT_STEP } from '@codebuff/common/tools/constants'
import { buildArray } from '@codebuff/common/util/array'
import {
  AbortError,
  extractApiErrorDetails,
  getErrorObject,
  isAbortError,
} from '@codebuff/common/util/error'
import { serializeCacheDebugCorrelation } from '@codebuff/common/util/cache-debug'
import { userMessage } from '@codebuff/common/util/messages'
import { type ToolSet } from 'ai'
import { cloneDeep, mapValues } from 'lodash'

import { CACHE_DEBUG_FULL_LOGGING } from './constants'
import { callTokenCountAPI } from './llm-api/codebuff-web-api'
import { getMCPToolData } from './mcp'
import { getAgentStreamFromTemplate } from './prompt-agent-stream'
import { runProgrammaticStep } from './run-programmatic-step'
import { additionalSystemPrompts } from './system-prompt/prompts'
import { captureTrajectory } from './trajectory'
import { getAgentTemplate } from './templates/agent-registry'
import { buildAgentToolSet } from './templates/prompts'
import { getAgentPrompt } from './templates/strings'
import { getToolSet } from './tools/prompts'
import { processStream } from './tools/stream-parser'
import { getAgentOutput } from './util/agent-output'
import {
  createCacheDebugSnapshot,
  enrichCacheDebugSnapshotWithProviderRequest,
  enrichCacheDebugSnapshotWithUsage,
} from './util/cache-debug'
import {
  withSystemInstructionTags,
  withSystemTags as withSystemTags,
  buildSystemMessagesWithKnowledgeCache,
  buildUserMessageContent,
  expireMessages,
} from './util/messages'
import { countTokensJson } from './util/token-counter'

import type { AgentTemplate } from '@codebuff/common/types/agent-template'
import type { TrackEventFn } from '@codebuff/common/types/contracts/analytics'
import type {
  AddAgentStepFn,
  FinishAgentRunFn,
  StartAgentRunFn,
} from '@codebuff/common/types/contracts/database'
import type {
  CacheDebugUsageData,
  PromptAiSdkFn,
} from '@codebuff/common/types/contracts/llm'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type { ParamsExcluding } from '@codebuff/common/types/function-params'
import type {
  Message,
  ToolMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import type {
  TextPart,
  ImagePart,
} from '@codebuff/common/types/messages/content-part'
import type { PrintModeEvent } from '@codebuff/common/types/print-mode'
import type {
  AgentTemplateType,
  AgentState,
  AgentOutput,
} from '@codebuff/common/types/session-state'
import type {
  CustomToolDefinitions,
  ProjectFileContext,
} from '@codebuff/common/util/file'

async function additionalToolDefinitions(
  params: {
    agentTemplate: AgentTemplate
    fileContext: ProjectFileContext
  } & ParamsExcluding<
    typeof getMCPToolData,
    'toolNames' | 'mcpServers' | 'writeTo'
  >,
): Promise<CustomToolDefinitions> {
  const { agentTemplate, fileContext } = params

  const defs = cloneDeep(
    Object.fromEntries(
      Object.entries(fileContext.customToolDefinitions).filter(([toolName]) =>
        agentTemplate!.toolNames.includes(toolName),
      ),
    ),
  )
  return getMCPToolData({
    ...params,
    toolNames: agentTemplate!.toolNames,
    mcpServers: agentTemplate!.mcpServers,
    writeTo: defs,
  })
}

export const runAgentStep = async (
  params: {
    userId: string | undefined
    userInputId: string
    clientSessionId: string
    costMode?: string
    fingerprintId: string
    repoId: string | undefined
    onResponseChunk: (chunk: string | PrintModeEvent) => void

    agentType: AgentTemplateType
    agentTemplate: AgentTemplate
    fileContext: ProjectFileContext
    agentState: AgentState
    localAgentTemplates: Record<string, AgentTemplate>

    prompt: string | undefined
    spawnParams: Record<string, any> | undefined
    system: string
    n?: number

    trackEvent: TrackEventFn
    promptAiSdk: PromptAiSdkFn
  } & ParamsExcluding<
    typeof processStream,
    | 'agentContext'
    | 'agentState'
    | 'agentStepId'
    | 'agentTemplate'
    | 'fullResponse'
    | 'messages'
    | 'onCostCalculated'
    | 'repoId'
    | 'stream'
  > &
    ParamsExcluding<
      typeof getAgentStreamFromTemplate,
      | 'agentId'
      | 'includeCacheControl'
      | 'messages'
      | 'onCostCalculated'
      | 'template'
    > &
    ParamsExcluding<typeof getAgentTemplate, 'agentId'> &
    ParamsExcluding<
      typeof getAgentPrompt,
      'agentTemplate' | 'promptType' | 'agentState' | 'agentTemplates'
    > &
    ParamsExcluding<
      typeof getMCPToolData,
      'toolNames' | 'mcpServers' | 'writeTo'
    > &
    ParamsExcluding<
      PromptAiSdkFn,
      'messages' | 'model' | 'onCostCalculated' | 'n'
    >,
): Promise<{
  agentState: AgentState
  fullResponse: string
  shouldEndTurn: boolean
  messageId: string | null
  nResponses?: string[]
  // Whether the turn ended because the model explicitly signalled completion
  // (task_completed / end_turn) rather than just running out of tool calls.
  endedByExplicitCompletion: boolean
  // Whether this step did real tool work (used to reset the no-progress streak
  // that bounds the auto-continue guard in loopAgentSteps).
  madeToolProgress: boolean
  // The todo list from the most recent write_todos call in this step, if any.
  // loopAgentSteps uses incomplete todos as the signal to auto-continue instead
  // of stopping after a narration-only step.
  latestTodos?: Array<{ task: string; completed: boolean }>
}> => {
  const {
    agentType,
    clientSessionId,
    fileContext,
    agentTemplate,
    fingerprintId,
    localAgentTemplates,
    logger,
    prompt,
    repoId,
    spawnParams,
    system,
    userId,
    userInputId,
    onResponseChunk,
    promptAiSdk,
    trackEvent,
    additionalToolDefinitions,
  } = params
  let agentState = params.agentState

  const { agentContext } = agentState

  const startTime = Date.now()

  // Generates a unique ID for each main prompt run (ie: a step of the agent loop)
  // This is used to link logs within a single agent loop
  const agentStepId = crypto.randomUUID()
  trackEvent({
    event: AnalyticsEvent.AGENT_STEP,
    userId: userId ?? '',
    properties: {
      agentStepId,
      clientSessionId,
      fingerprintId,
      userInputId,
      userId,
      repoName: repoId,
    },
    logger,
  })

  if (agentState.stepsRemaining <= 0) {
    logger.warn(
      `Detected too many consecutive assistant messages without user prompt`,
    )

    onResponseChunk(`${STEP_WARNING_MESSAGE}\n\n`)

    // Update message history to include the warning
    agentState = {
      ...agentState,
      messageHistory: [
        ...expireMessages(agentState.messageHistory, 'userPrompt'),
        userMessage(
          withSystemTags(
            `The assistant has responded too many times in a row. The assistant's turn has automatically been ended. The maximum number of responses can be configured via maxAgentSteps.`,
          ),
        ),
      ],
    }
    return {
      agentState,
      fullResponse: STEP_WARNING_MESSAGE,
      shouldEndTurn: true,
      messageId: null,
      // Hitting the step cap is a hard stop — do not let the auto-continue
      // guard override it.
      endedByExplicitCompletion: true,
      madeToolProgress: false,
      latestTodos: undefined,
    }
  }

  const stepPrompt = await getAgentPrompt({
    ...params,
    agentTemplate,
    promptType: { type: 'stepPrompt' },
    fileContext,
    agentState,
    agentTemplates: localAgentTemplates,
    logger,
    additionalToolDefinitions,
  })

  const agentMessagesUntruncated = buildArray<Message>(
    ...expireMessages(agentState.messageHistory, 'agentStep'),

    stepPrompt &&
      userMessage({
        content: stepPrompt,
        tags: ['STEP_PROMPT'],

        // James: Deprecate the below, only use tags, which are not prescriptive.
        timeToLive: 'agentStep' as const,
        keepDuringTruncation: true,
      }),
  )

  agentState.messageHistory = agentMessagesUntruncated

  const { model } = agentTemplate

  let stepCreditsUsed = 0

  const onCostCalculated = async (credits: number) => {
    stepCreditsUsed += credits
    agentState.creditsUsed += credits
    agentState.directCreditsUsed += credits
  }

  const iterationNum = agentState.messageHistory.length
  const systemTokens = countTokensJson(system)

  let cacheDebugCorrelation:
    | ReturnType<typeof createCacheDebugSnapshot>
    | undefined
  if (CACHE_DEBUG_FULL_LOGGING) {
    try {
      cacheDebugCorrelation = createCacheDebugSnapshot({
        agentType: String(agentType),
        system,
        toolDefinitions: params.tools
          ? Object.fromEntries(
              Object.entries(params.tools).map(([name, tool]) => [
                name,
                {
                  description: tool.description,
                  inputSchema: tool.inputSchema as {},
                },
              ]),
            )
          : {},
        messages: [
          ...buildSystemMessagesWithKnowledgeCache(system),
          ...agentState.messageHistory,
        ],
        logger,
        projectRoot: fileContext.projectRoot,
        runId: agentState.runId,
        userInputId,
        agentStepId,
        model,
      })
    } catch (err) {
      logger.warn({ error: err }, '[Cache Debug] Failed to create snapshot')
    }
  }

  const onCacheDebugProviderRequestBuilt = cacheDebugCorrelation
    ? ({
        provider,
        rawBody,
        normalizedBody,
      }: {
        provider: string
        rawBody: unknown
        normalizedBody?: unknown
      }) => {
        enrichCacheDebugSnapshotWithProviderRequest({
          correlation: cacheDebugCorrelation,
          provider,
          rawBody,
          normalized: normalizedBody ?? rawBody,
          logger,
        })
      }
    : undefined

  // T0.5: Always emit cache hit/miss telemetry — not gated by CACHE_DEBUG_FULL_LOGGING.
  // Wrapped in try/catch so a telemetry failure never crashes the agent run.
  const onCacheDebugUsageReceived = (usage: CacheDebugUsageData) => {
    try {
      const cacheHitRate =
        usage.inputTokens > 0 ? usage.cachedInputTokens / usage.inputTokens : 0
      trackEvent({
        event: AnalyticsEvent.CACHE_HIT_TELEMETRY,
        userId: userId ?? '',
        properties: {
          agentStepId,
          clientSessionId,
          agentType: String(agentType),
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          totalTokens: usage.totalTokens,
          cacheHitRate,
          estimatedSavingsTokens: usage.cachedInputTokens,
        },
        logger,
      })
    } catch {
      // Telemetry failures must never crash the main flow.
    }

    if (cacheDebugCorrelation) {
      enrichCacheDebugSnapshotWithUsage({
        correlation: cacheDebugCorrelation,
        usage,
        logger,
      })
    }
  }

  logger.debug(
    {
      iteration: iterationNum,
      runId: agentState.runId,
      model,
      duration: Date.now() - startTime,
      contextTokenCount: agentState.contextTokenCount,
      agentMessages: agentState.messageHistory.concat().reverse(),
      system,
      prompt,
      params: spawnParams,
      agentContext,
      systemTokens,
      agentTemplate,
      tools: params.tools,
    },
    `Start agent ${agentType} step ${iterationNum} (${userInputId}${prompt ? ` - Prompt: ${prompt.slice(0, 20)}` : ''})`,
  )

  // Handle n parameter for generating multiple responses
  if (params.n !== undefined) {
    const result = await promptAiSdk({
      ...params,
      messages: agentState.messageHistory,
      model,
      n: params.n,
      onCostCalculated,
      cacheDebugCorrelation: cacheDebugCorrelation
        ? serializeCacheDebugCorrelation(cacheDebugCorrelation)
        : undefined,
      onCacheDebugProviderRequestBuilt,
      onCacheDebugUsageReceived,
    })

    if (result.aborted) {
      return {
        agentState,
        fullResponse: '',
        shouldEndTurn: true,
        messageId: null,
        nResponses: undefined,
        endedByExplicitCompletion: true,
        madeToolProgress: false,
        latestTodos: undefined,
      }
    }

    const responsesString = result.value
    let nResponses: string[]
    try {
      nResponses = JSON.parse(responsesString) as string[]
      if (!Array.isArray(nResponses)) {
        if (params.n > 1) {
          throw new Error(
            `Expected JSON array response from LLM when n > 1, got non-array: ${responsesString.slice(0, 50)}`,
          )
        }
        // If it parsed but isn't an array, treat as single response
        nResponses = [responsesString]
      }
    } catch (e) {
      if (params.n > 1) {
        throw e
      }
      // If parsing fails, treat as single raw response (common for n=1)
      nResponses = [responsesString]
    }

    return {
      agentState,
      fullResponse: responsesString,
      shouldEndTurn: false,
      messageId: null,
      nResponses,
      endedByExplicitCompletion: false,
      madeToolProgress: true,
      latestTodos: undefined,
    }
  }

  let fullResponse = ''
  const toolResults: ToolMessage[] = []

  // Raw stream from AI SDK
  const stream = getAgentStreamFromTemplate({
    ...params,
    agentId: agentState.parentId ? agentState.agentId : undefined,
    costMode: params.costMode,
    cacheDebugCorrelation: cacheDebugCorrelation
      ? serializeCacheDebugCorrelation(cacheDebugCorrelation)
      : undefined,
    includeCacheControl: supportsCacheControl(agentTemplate.model),
    messages: [
      ...buildSystemMessagesWithKnowledgeCache(system),
      ...agentState.messageHistory,
    ],
    onCacheDebugProviderRequestBuilt,
    onCacheDebugUsageReceived,
    template: agentTemplate,
    onCostCalculated,
  })

  const {
    fullResponse: fullResponseAfterStream,
    fullResponseChunks,
    hadToolCallError,
    messageId,
    toolCalls,
    toolResults: newToolResults,
  } = await processStream({
    ...params,
    agentContext,
    agentState,
    agentStepId,
    agentTemplate,
    fullResponse,
    messages: agentState.messageHistory,
    repoId,
    stream,
    onCostCalculated,
  })

  toolResults.push(...newToolResults)

  fullResponse = fullResponseAfterStream

  agentState.messageHistory = expireMessages(
    agentState.messageHistory,
    'agentStep',
  )

  // Handle /compact command: replace message history with the summary
  const wasCompacted =
    prompt &&
    (prompt.toLowerCase() === '/compact' || prompt.toLowerCase() === 'compact')
  if (wasCompacted) {
    agentState.messageHistory = [
      userMessage(
        withSystemTags(
          `The following is a summary of the conversation between you and the user. The conversation continues after this summary:\n\n${fullResponse}`,
        ),
      ),
    ]
    logger.debug({ summary: fullResponse }, 'Compacted messages')
  }

  const hasNoToolResults =
    toolCalls.filter(
      (call) => !TOOLS_WHICH_WONT_FORCE_NEXT_STEP.includes(call.toolName),
    ).length === 0 &&
    toolResults.filter(
      (result) => !TOOLS_WHICH_WONT_FORCE_NEXT_STEP.includes(result.toolName),
    ).length === 0 &&
    !hadToolCallError // Tool call errors should also force another step so the agent can retry

  const hasTaskCompleted = toolCalls.some(
    (call) =>
      call.toolName === 'task_completed' || call.toolName === 'end_turn',
  )

  // If the response is only <think>...</think> tags with no other non-whitespace content,
  // the model was just thinking and should continue rather than end its turn.
  const responseWithoutThinkTags = fullResponse
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/, '')
    .trim()
  const isThinkOnly =
    hasNoToolResults &&
    responseWithoutThinkTags.length === 0 &&
    fullResponse.trim().length > 0

  // If the agent has the task_completed tool, it must be called to end its turn.
  const requiresExplicitCompletion =
    agentTemplate.toolNames.includes('task_completed')

  let shouldEndTurn: boolean
  if (requiresExplicitCompletion) {
    // For models requiring explicit completion, only end turn when:
    // - task_completed is called, OR
    // - end_turn is called (backward compatibility)
    shouldEndTurn = hasTaskCompleted
  } else {
    // For other models, also end turn when there are no tool calls
    // Exception: if the response is only <think> tags, continue the turn
    shouldEndTurn = hasTaskCompleted || (hasNoToolResults && !isThinkOnly)
  }

  agentState = {
    ...agentState,
    stepsRemaining: agentState.stepsRemaining - 1,
    agentContext,
  }

  logger.debug(
    {
      iteration: iterationNum,
      agentId: agentState.agentId,
      model,
      prompt,
      shouldEndTurn,
      duration: Date.now() - startTime,
      fullResponse,
      finalMessageHistoryWithToolResults: agentState.messageHistory
        .concat()
        .reverse(),
      toolCalls,
      toolResults,
      agentContext,
      fullResponseChunks,
      stepCreditsUsed,
    },
    `End agent ${agentType} step ${iterationNum} (${userInputId}${prompt ? ` - Prompt: ${prompt.slice(0, 20)}` : ''})`,
  )

  // Surface the latest todo list (if the model rewrote it this step) so the
  // loop can tell "narration pause with work left" from "genuinely done".
  const latestWriteTodosCall = [...toolCalls]
    .reverse()
    .find((call) => call.toolName === 'write_todos')
  const latestTodos = latestWriteTodosCall
    ? (
        latestWriteTodosCall.input as {
          todos?: Array<{ task: string; completed: boolean }>
        }
      ).todos
    : undefined

  return {
    agentState,
    fullResponse,
    shouldEndTurn,
    messageId,
    nResponses: undefined,
    endedByExplicitCompletion: hasTaskCompleted,
    madeToolProgress: !hasNoToolResults,
    latestTodos,
  }
}

/**
 * Runs the agent loop.
 *
 * IMPORTANT: This function mutates `params.agentState` in place throughout the
 * run (not just at return time). Fields like `messageHistory`, `systemPrompt`,
 * `toolDefinitions`, `creditsUsed`, and `output` are updated as work progresses
 * so that callers holding a reference to the same object (e.g. the SDK's
 * `sessionState.mainAgentState`) see in-progress work immediately — which
 * matters when an error is thrown mid-run and the normal return path is
 * skipped.
 */
export async function loopAgentSteps(
  params: {
    addAgentStep: AddAgentStepFn
    agentState: AgentState
    agentType: string
    clearUserPromptMessagesAfterResponse?: boolean
    clientSessionId: string
    content?: Array<TextPart | ImagePart>
    costMode?: string
    fileContext: ProjectFileContext
    finishAgentRun: FinishAgentRunFn
    localAgentTemplates: Record<string, AgentTemplate>
    logger: Logger
    parentSystemPrompt?: string
    parentTools?: ToolSet
    prompt: string | undefined
    signal: AbortSignal
    spawnParams: Record<string, any> | undefined
    startAgentRun: StartAgentRunFn
    userId: string | undefined
    userInputId: string
    agentTemplate?: AgentTemplate
  } & ParamsExcluding<typeof additionalToolDefinitions, 'agentTemplate'> &
    ParamsExcluding<
      typeof runProgrammaticStep,
      | 'agentState'
      | 'onCostCalculated'
      | 'prompt'
      | 'runId'
      | 'stepNumber'
      | 'stepsComplete'
      | 'system'
      | 'template'
      | 'toolCallParams'
      | 'tools'
    > &
    ParamsExcluding<typeof getAgentTemplate, 'agentId'> &
    ParamsExcluding<
      typeof getAgentPrompt,
      | 'agentTemplate'
      | 'promptType'
      | 'agentTemplates'
      | 'additionalToolDefinitions'
    > &
    ParamsExcluding<
      typeof getMCPToolData,
      'toolNames' | 'mcpServers' | 'writeTo'
    > &
    ParamsExcluding<StartAgentRunFn, 'agentId' | 'ancestorRunIds'> &
    ParamsExcluding<
      FinishAgentRunFn,
      'runId' | 'status' | 'totalSteps' | 'directCredits' | 'totalCredits'
    > &
    ParamsExcluding<
      typeof runAgentStep,
      | 'additionalToolDefinitions'
      | 'agentState'
      | 'agentTemplate'
      | 'prompt'
      | 'runId'
      | 'spawnParams'
      | 'system'
      | 'tools'
    > &
    ParamsExcluding<
      AddAgentStepFn,
      | 'agentRunId'
      | 'stepNumber'
      | 'credits'
      | 'childRunIds'
      | 'messageId'
      | 'status'
      | 'startTime'
    >,
): Promise<{
  agentState: AgentState
  output: AgentOutput
}> {
  const {
    addAgentStep,
    agentState: initialAgentState,
    agentType,
    clearUserPromptMessagesAfterResponse = true,
    clientSessionId,
    content,
    fileContext,
    finishAgentRun,
    localAgentTemplates,
    logger,
    parentSystemPrompt,
    parentTools,
    prompt,
    signal,
    spawnParams,
    startAgentRun,
    userId,
    userInputId,
    clientEnv,
    ciEnv,
  } = params

  let agentTemplate = params.agentTemplate
  if (!agentTemplate) {
    agentTemplate =
      (await getAgentTemplate({
        ...params,
        agentId: agentType,
      })) ?? undefined
  }
  if (!agentTemplate) {
    throw new Error(`Agent template not found for type: ${agentType}`)
  }

  if (signal.aborted) {
    return {
      agentState: initialAgentState,
      output: {
        type: 'error',
        message: 'Run cancelled by user',
      },
    }
  }

  const runId = await startAgentRun({
    ...params,
    agentId: agentTemplate.id,
    ancestorRunIds: initialAgentState.ancestorRunIds,
  })
  if (!runId) {
    throw new Error('Failed to start agent run')
  }
  initialAgentState.runId = runId

  let cachedAdditionalToolDefinitions: CustomToolDefinitions | undefined
  // Use parent's tools for prompt caching when inheritParentSystemPrompt is true
  const useParentTools =
    agentTemplate.inheritParentSystemPrompt && parentTools !== undefined

  // Initialize message history with user prompt and instructions on first iteration
  const instructionsPrompt = await getAgentPrompt({
    ...params,
    agentTemplate,
    promptType: { type: 'instructionsPrompt' },
    agentTemplates: localAgentTemplates,
    useParentTools,
    additionalToolDefinitions: async () => {
      if (!cachedAdditionalToolDefinitions) {
        cachedAdditionalToolDefinitions = await additionalToolDefinitions({
          ...params,
          agentTemplate,
        })
      }
      return cachedAdditionalToolDefinitions
    },
  })

  // Build the initial message history with user prompt and instructions
  // Generate system prompt once, using parent's if inheritParentSystemPrompt is true
  let system: string
  if (agentTemplate.inheritParentSystemPrompt && parentSystemPrompt) {
    system = parentSystemPrompt
  } else {
    const systemPrompt = await getAgentPrompt({
      ...params,
      agentTemplate,
      promptType: { type: 'systemPrompt' },
      agentTemplates: localAgentTemplates,
      additionalToolDefinitions: async () => {
        if (!cachedAdditionalToolDefinitions) {
          cachedAdditionalToolDefinitions = await additionalToolDefinitions({
            ...params,
            agentTemplate,
          })
        }
        return cachedAdditionalToolDefinitions
      },
    })
    system = systemPrompt ?? ''
  }

  // Build agent tools (agents as direct tool calls) for non-inherited tools
  const agentTools = useParentTools
    ? {}
    : await buildAgentToolSet({
        ...params,
        spawnableAgents: agentTemplate.spawnableAgents,
        agentTemplates: localAgentTemplates,
      })

  const tools = useParentTools
    ? parentTools
    : await getToolSet({
        toolNames: agentTemplate.toolNames,
        additionalToolDefinitions: async () => {
          if (!cachedAdditionalToolDefinitions) {
            cachedAdditionalToolDefinitions = await additionalToolDefinitions({
              ...params,
              agentTemplate,
            })
          }
          return cachedAdditionalToolDefinitions
        },
        agentTools,
        skills: fileContext.skills ?? {},
      })

  // T0.4: Add cache_control to the last tool definition so the entire tools
  // schema is cached as the 4th Anthropic cache breakpoint. Message-level
  // caching is capped at MAX_CACHE_BREAKPOINTS=3 (system, knowledge, memory)
  // to leave room for this slot. Only applied when the model supports
  // cache_control and we built our own tools (not inherited from parent).
  if (!useParentTools && tools && supportsCacheControl(agentTemplate.model)) {
    const toolEntries = Object.entries(tools)
    if (toolEntries.length > 0) {
      const [lastToolName, lastTool] = toolEntries[toolEntries.length - 1]
      tools[lastToolName] = {
        ...lastTool,
        providerOptions: {
          ...(lastTool as { providerOptions?: Record<string, unknown> })
            .providerOptions,
          anthropic: {
            ...((
              lastTool as {
                providerOptions?: { anthropic?: Record<string, unknown> }
              }
            ).providerOptions?.anthropic ?? {}),
            cacheControl: { type: 'ephemeral' },
          },
        },
      } as (typeof tools)[string]
    }
  }

  const hasUserMessage = Boolean(
    prompt ||
    (spawnParams && Object.keys(spawnParams).length > 0) ||
    (content && content.length > 0),
  )

  const initialMessages = buildArray<Message>(
    ...initialAgentState.messageHistory,

    hasUserMessage && [
      {
        // Actual user message!
        role: 'user' as const,
        content: buildUserMessageContent(prompt, spawnParams, content),
        tags: ['USER_PROMPT'],
        sentAt: Date.now(),

        // James: Deprecate the below, only use tags, which are not prescriptive.
        keepDuringTruncation: true,
      },
      prompt &&
        prompt in additionalSystemPrompts &&
        userMessage(
          withSystemInstructionTags(
            additionalSystemPrompts[
              prompt as keyof typeof additionalSystemPrompts
            ],
          ),
        ),
      ,
    ],

    instructionsPrompt &&
      userMessage({
        content: instructionsPrompt,
        tags: ['INSTRUCTIONS_PROMPT'],

        // James: Deprecate the below, only use tags, which are not prescriptive.
        keepLastTags: ['INSTRUCTIONS_PROMPT'],
      }),
  )

  // Convert tools to a serializable format for context-pruner token counting
  const toolDefinitions = mapValues(tools, (tool) => ({
    description: tool.description,
    inputSchema: tool.inputSchema as {},
  }))

  const additionalToolDefinitionsWithCache = async () => {
    if (!cachedAdditionalToolDefinitions) {
      cachedAdditionalToolDefinitions = await additionalToolDefinitions({
        ...params,
        agentTemplate,
      })
    }
    return cachedAdditionalToolDefinitions
  }

  // Mutate initialAgentState so that in-progress work propagates back to the
  // caller's shared reference (e.g. SDK's sessionState.mainAgentState) even if
  // an error is thrown before we return.
  initialAgentState.messageHistory = initialMessages
  initialAgentState.systemPrompt = system
  initialAgentState.toolDefinitions = toolDefinitions
  let currentAgentState: AgentState = initialAgentState

  // Convert tool definitions to Anthropic format for accurate token counting
  // Tool definitions are stored as { [name]: { description, inputSchema } }
  // Anthropic count_tokens API expects [{ name, description, input_schema }]
  const toolsForTokenCount = Object.entries(toolDefinitions).map(
    ([name, def]) => ({
      name,
      ...(def.description && { description: def.description }),
      ...(def.inputSchema && { input_schema: def.inputSchema }),
    }),
  )

  let shouldEndTurn = false
  let hasRetriedOutputSchema = false
  let currentPrompt = prompt
  let currentParams = spawnParams
  let totalSteps = 0
  let nResponses: string[] | undefined = undefined

  // Background token-count refresh state. The web token-count call no longer
  // sits on the step's hot path (see below); at most one refresh runs at a
  // time, and `tokenCountEpoch` (bumped each step) lets a refresh discard its
  // result if a newer step has already set a fresher local estimate — so a
  // stale precise count can never under-count and mask a needed prune.
  let tokenCountRefreshInFlight = false
  let tokenCountEpoch = 0

  // Auto-continue guard state. `latestTodos` tracks the most recent todo list
  // the agent wrote (persists across steps until rewritten); incomplete todos
  // mean the task isn't done. `consecutiveNoProgressSteps` counts steps with no
  // real tool work in a row and resets on any progress, bounding how long we
  // keep nudging a model that only narrates.
  let latestTodos: Array<{ task: string; completed: boolean }> | undefined
  let consecutiveNoProgressSteps = 0
  // Total auto-continues used this turn. Unlike consecutiveNoProgressSteps
  // (which resets on ANY tool work), this never resets, so a model that
  // interleaves real tool calls with narration can't be nudged onward forever.
  let totalAutoContinues = 0
  // Wall-clock start of this user turn and its budget. The only other governor
  // is the 200-step cap with no time bound, so a large plan in MAX mode can
  // otherwise grind for hours and fill the context window; this ends the turn
  // at the next step boundary and hands control back to the user instead.
  const turnStartTime = Date.now()
  const maxTurnMs = getMaxAgentTurnDurationMs()
  const maxTotalAutoContinues = getMaxTotalAutoContinues()

  try {
    while (true) {
      // Soft wall-clock budget: never interrupt an in-flight step, but once a
      // turn has run longer than the budget, end it at the next boundary with
      // all in-progress work preserved — even if the model still wants to call
      // tools. The user can type "continue" to resume.
      if (Date.now() - turnStartTime > maxTurnMs) {
        logger.warn(
          {
            runId,
            totalSteps,
            elapsedMs: Date.now() - turnStartTime,
            maxTurnMs,
          },
          'Agent turn exceeded wall-clock budget; ending turn and returning control to the user',
        )
        params.onResponseChunk(`\n\n${TURN_BUDGET_MESSAGE}\n\n`)
        currentAgentState.messageHistory = [
          ...currentAgentState.messageHistory,
          userMessage(
            withSystemTags(
              `The assistant's turn was automatically ended because it ran for over ${Math.round(
                maxTurnMs / 60_000,
              )} minutes. In-progress work has been preserved; the user can type "continue" to resume. The limit is configurable via CODEBUFF_AGENT_MAX_TURN_MS.`,
            ),
          ),
        ]
        shouldEndTurn = true
        break
      }

      totalSteps++
      if (signal.aborted) {
        throw new AbortError()
      }

      const startTime = new Date()

      const stepPrompt = await getAgentPrompt({
        ...params,
        agentTemplate,
        promptType: { type: 'stepPrompt' },
        fileContext,
        agentState: currentAgentState,
        agentTemplates: localAgentTemplates,
        logger,
        additionalToolDefinitions: additionalToolDefinitionsWithCache,
      })
      const messagesWithStepPrompt = buildArray(
        ...currentAgentState.messageHistory,
        stepPrompt &&
          userMessage({
            content: stepPrompt,
          }),
      )

      // Summed per message (not the whole array at once) so unchanged messages
      // hit the token cache and only new content is re-tokenized — keeping this
      // ~O(new content) instead of O(full history) on every step, which matters
      // because it now runs synchronously on every step (see below).
      const estimateContextTokensLocally = () =>
        messagesWithStepPrompt.reduce(
          (sum, message) => sum + countTokensJson(message),
          0,
        ) +
        countTokensJson(system) +
        countTokensJson(toolsForTokenCount)

      // Token accounting must never sit between the user and the model's next
      // token. The inline context-pruner reads contextTokenCount THIS step, so
      // we always set a fast, synchronous LOCAL estimate first. It is
      // intentionally conservative (1.35x fudge), so pruning errs early and
      // never overflows.
      tokenCountEpoch += 1
      const epochForThisStep = tokenCountEpoch
      currentAgentState.contextTokenCount = estimateContextTokensLocally()

      // Surface the MAIN agent's live context usage to the client so the
      // context-window bar shows the REAL model context as it changes mid-run,
      // not a transcript estimate. Subagents (parentId set) have their own,
      // separate budgets — don't report those onto the user's bar.
      // maxContextTokens mirrors the operational window the context-pruner
      // compacts against (params.maxContextLength, default 200K), so the bar
      // fills to ~80% exactly when auto-compaction fires.
      const isMainAgentStep = currentAgentState.parentId === undefined
      const stepMaxContextTokens =
        typeof currentParams?.maxContextLength === 'number'
          ? currentParams.maxContextLength
          : 200_000
      const emitContextUsage = (contextTokenCount: number) => {
        if (!isMainAgentStep) return
        params.onResponseChunk({
          type: 'context_usage',
          contextTokenCount,
          maxContextTokens: stepMaxContextTokens,
          agentId: currentAgentState.agentId,
        })
      }
      // First the fast, conservative local estimate; the background refresh
      // below re-emits with the provider-accurate count when it lands.
      emitContextUsage(currentAgentState.contextTokenCount)

      // For models whose real tokenizer differs from the local GPT-4o BPE,
      // refine with the provider-accurate count — but in the BACKGROUND, so a
      // slow or unreachable backend can't stall the step. (Previously this was
      // an awaited round-trip with a 24h timeout on every step's hot path; in
      // real degraded-backend sessions it failed on every step and the agent
      // sat in "working" with no output.) At most one refresh is in flight;
      // the result is discarded if a newer step has superseded it.
      if (
        !shouldUseLocalTokenCountForFreebuffDeepseekFlash({
          agentId: agentTemplate.id,
          model: agentTemplate.model,
        }) &&
        !tokenCountRefreshInFlight
      ) {
        tokenCountRefreshInFlight = true
        const agentStateForRefresh = currentAgentState
        void callTokenCountAPI({
          messages: messagesWithStepPrompt,
          system,
          model: agentTemplate.model,
          tools: toolsForTokenCount,
          fetch,
          logger,
          env: { clientEnv, ciEnv },
          signal,
        })
          .then((tokenCountResult) => {
            if (
              !signal.aborted &&
              tokenCountResult.inputTokens !== undefined &&
              epochForThisStep === tokenCountEpoch
            ) {
              agentStateForRefresh.contextTokenCount =
                tokenCountResult.inputTokens
              // Re-emit with the provider-accurate count so the bar refines
              // from the conservative local estimate to the real number.
              emitContextUsage(agentStateForRefresh.contextTokenCount)
            }
          })
          .catch((error) => {
            logger.debug(
              { error: getErrorObject(error) },
              'Background token-count refresh failed; keeping local estimate',
            )
          })
          .finally(() => {
            tokenCountRefreshInFlight = false
          })
      }

      // 1. Run programmatic step first if it exists
      let n: number | undefined = undefined

      if (agentTemplate.handleSteps) {
        const programmaticResult = await runProgrammaticStep({
          ...params,

          agentState: currentAgentState,
          localAgentTemplates,
          nResponses,
          onCostCalculated: async (credits: number) => {
            currentAgentState.creditsUsed += credits
            currentAgentState.directCreditsUsed += credits
          },
          prompt: currentPrompt,
          runId,
          stepNumber: totalSteps,
          stepsComplete: shouldEndTurn,
          system,
          tools,
          template: agentTemplate,
          toolCallParams: currentParams,
        })
        const {
          agentState: programmaticAgentState,
          endTurn,
          stepNumber,
          generateN,
        } = programmaticResult
        n = generateN

        Object.assign(initialAgentState, programmaticAgentState)
        currentAgentState = initialAgentState
        totalSteps = stepNumber

        shouldEndTurn = endTurn
      }

      // Check if output is required but missing
      if (
        agentTemplate.outputSchema &&
        currentAgentState.output === undefined &&
        shouldEndTurn &&
        !hasRetriedOutputSchema
      ) {
        hasRetriedOutputSchema = true
        logger.warn(
          {
            agentType,
            agentId: currentAgentState.agentId,
            runId,
          },
          'Agent finished without setting required output, restarting loop',
        )

        // Add system message instructing to use set_output
        const outputSchemaMessage = withSystemTags(
          `You must use the "set_output" tool to provide a result that matches the output schema before ending your turn. The output schema is required for this agent.`,
        )

        currentAgentState.messageHistory = [
          ...currentAgentState.messageHistory,
          userMessage({
            content: outputSchemaMessage,
            keepDuringTruncation: true,
          }),
        ]

        // Reset shouldEndTurn to continue the loop
        shouldEndTurn = false
      }

      // End turn if programmatic step ended turn, or if the previous runAgentStep ended turn
      if (shouldEndTurn) {
        break
      }

      const creditsBefore = currentAgentState.directCreditsUsed
      const childrenBefore = currentAgentState.childRunIds.length

      // Wrap runAgentStep in transient-error retry so a flaky network or a
      // single timeout doesn't kill an agent that's been running for hours.
      // Aborts (user cancel), payment-required errors, and validation errors
      // still propagate immediately via isTransientStepError below.
      const stepResult = await runAgentStepWithTransientRetry({
        runStep: () =>
          runAgentStep({
            ...params,

            agentState: currentAgentState,
            agentTemplate: agentTemplate!,
            n,
            prompt: currentPrompt,
            runId,
            spawnParams: currentParams,
            system,
            tools,
            additionalToolDefinitions: additionalToolDefinitionsWithCache,
          }),
        signal,
        logger,
        onResponseChunk: params.onResponseChunk,
      })
      const {
        agentState: newAgentState,
        shouldEndTurn: llmShouldEndTurn,
        messageId,
        nResponses: generatedResponses,
        endedByExplicitCompletion,
        madeToolProgress,
        latestTodos: stepTodos,
      } = stepResult

      // Track todo state and the no-progress streak for the auto-continue guard.
      if (stepTodos !== undefined) {
        latestTodos = stepTodos
      }
      if (madeToolProgress) {
        consecutiveNoProgressSteps = 0
      } else {
        consecutiveNoProgressSteps += 1
      }

      if (newAgentState.runId) {
        await addAgentStep({
          ...params,
          agentRunId: newAgentState.runId,
          stepNumber: totalSteps,
          credits: newAgentState.directCreditsUsed - creditsBefore,
          childRunIds: newAgentState.childRunIds.slice(childrenBefore),
          messageId,
          status: 'completed',
          startTime,
        })
      } else {
        logger.error('No runId found for agent state after finishing agent run')
      }

      Object.assign(initialAgentState, newAgentState)
      currentAgentState = initialAgentState
      nResponses = generatedResponses

      // Auto-continue guard: don't make the user type "continue" between phases
      // (analysis → implementation → testing). When a turn would end *only*
      // because the model emitted narration with no tool call, but there are
      // still incomplete todos, treat it as a premature stop: nudge the model
      // and keep looping. Bounded by the no-progress streak so a model that
      // just repeats narration can't run away. Agents that never write todos
      // (sub-agents, fast mode, simple Q&A) have no incomplete todos and so end
      // normally — this is self-scoped to real multi-step tasks.
      const hasIncompleteTodos =
        latestTodos !== undefined && latestTodos.some((t) => !t.completed)
      // The very first stop the user described ("راح أبدأ بالتحليل") happens
      // BEFORE any todo list exists, so incomplete-todos can't catch it. For a
      // planning-capable agent that hasn't written todos yet, treat a
      // forward-looking phase announcement ("I'll start…", "سأبدأ…") as "more
      // work coming" and keep going. Conclusive answers/summaries don't match,
      // so simple Q&A still ends; a non-match just falls back to stopping.
      const announcesMoreWorkBeforePlanning =
        latestTodos === undefined &&
        agentTemplate.toolNames.includes('write_todos') &&
        FORWARD_INTENT_REGEX.test(stepResult.fullResponse ?? '')
      const shouldAutoContinue =
        llmShouldEndTurn &&
        !endedByExplicitCompletion &&
        (hasIncompleteTodos || announcesMoreWorkBeforePlanning) &&
        !signal.aborted &&
        consecutiveNoProgressSteps < MAX_CONSECUTIVE_NO_PROGRESS_STEPS &&
        totalAutoContinues < maxTotalAutoContinues

      if (shouldAutoContinue) {
        totalAutoContinues += 1
        // Keep at most one nudge in history (most-recent wins) to avoid
        // accumulating duplicates across multiple continuations in a turn.
        currentAgentState.messageHistory =
          currentAgentState.messageHistory.filter(
            (m) =>
              !(
                m.role === 'user' &&
                m.content?.[0]?.type === 'text' &&
                m.content[0].text.includes(AUTO_CONTINUE_NUDGE_MARKER)
              ),
          )
        currentAgentState.messageHistory.push(
          userMessage({
            content: withSystemTags(AUTO_CONTINUE_NUDGE),
            // Cleared at the end of the user's turn, survives intermediate steps.
            timeToLive: 'userPrompt',
          }),
        )
        logger.debug(
          {
            runId,
            consecutiveNoProgressSteps,
            pendingTodos: latestTodos?.filter((t) => !t.completed).length,
          },
          'Auto-continuing agent turn: incomplete todos remain after a no-tool-call step',
        )
        shouldEndTurn = false
      } else {
        shouldEndTurn = llmShouldEndTurn
      }

      currentPrompt = undefined
      currentParams = undefined
    }

    if (clearUserPromptMessagesAfterResponse) {
      currentAgentState.messageHistory = expireMessages(
        currentAgentState.messageHistory,
        'userPrompt',
      )
    }

    await finishAgentRun({
      ...params,
      runId,
      status: 'completed',
      totalSteps,
      directCredits: currentAgentState.directCreditsUsed,
      totalCredits: currentAgentState.creditsUsed,
    })

    // Learning-loop capture (Hermes-style): record the completed conversation
    // as a ShareGPT trajectory. No-op unless CODEBUFF_SAVE_TRAJECTORIES is set,
    // and internally exception-safe so it can never affect the run's result.
    captureTrajectory({
      messages: currentAgentState.messageHistory,
      userQuery: prompt,
      model: agentTemplate.model,
      completed: true,
      logger,
    })

    return {
      agentState: currentAgentState,
      output: getAgentOutput(currentAgentState, agentTemplate),
    }
  } catch (error) {
    // Handle user-initiated aborts separately - don't log as errors
    if (isAbortError(error)) {
      if (clearUserPromptMessagesAfterResponse) {
        currentAgentState.messageHistory = expireMessages(
          currentAgentState.messageHistory,
          'userPrompt',
        )
      }

      currentAgentState.messageHistory = [
        ...currentAgentState.messageHistory,
        userMessage(
          withSystemTags(
            "User interrupted the response. The assistant's previous work has been preserved.",
          ),
        ),
      ]

      logger.info(
        {
          agentType,
          agentId: currentAgentState.agentId,
          runId,
          totalSteps,
          messageHistory: currentAgentState.messageHistory,
        },
        'Agent run cancelled by user (abort error)',
      )

      await finishAgentRun({
        ...params,
        runId,
        status: 'cancelled',
        totalSteps,
        directCredits: currentAgentState.directCreditsUsed,
        totalCredits: currentAgentState.creditsUsed,
      })

      // Capture the interrupted run as a failed trajectory (learning signal).
      captureTrajectory({
        messages: currentAgentState.messageHistory,
        userQuery: prompt,
        model: agentTemplate.model,
        completed: false,
        logger,
      })

      return {
        agentState: currentAgentState,
        output: {
          type: 'error',
          message: 'Run cancelled by user',
        },
      }
    }

    logger.error(
      {
        error: getErrorObject(error),
        agentType,
        agentId: currentAgentState.agentId,
        runId,
        totalSteps,
        directCreditsUsed: currentAgentState.directCreditsUsed,
        creditsUsed: currentAgentState.creditsUsed,
        messageHistory: currentAgentState.messageHistory,
        systemPrompt: system,
      },
      'Agent execution failed',
    )

    const apiErrorDetails = extractApiErrorDetails(error)
    const hasServerMessage = apiErrorDetails.message !== undefined
    const rawErrorMessage =
      error instanceof Error ? error.message : String(error)
    const isProviderRateLimit =
      apiErrorDetails.statusCode === 429
    // A dropped/closed connection ("The socket connection was closed
    // unexpectedly") is surfaced as the same friendly usage line instead of a
    // raw stack trace — these failures are effectively usage/rate-limit related
    // from the user's perspective. Kept narrow on purpose so a genuine bug is
    // never masked (see isConnectionClosedError).
    const showUsageRateLimitMessage =
      isProviderRateLimit || isConnectionClosedError(error)
    const fallbackMessage = showUsageRateLimitMessage
      ? USAGE_RATE_LIMIT_MESSAGE
      : error instanceof Error
        ? error.message +
          (apiErrorDetails.statusCode === undefined && error.stack
            ? `\n\n${error.stack}`
            : '')
        : String(error)
    const errorMessage = showUsageRateLimitMessage
      ? USAGE_RATE_LIMIT_MESSAGE
      : (apiErrorDetails.message ?? fallbackMessage)
    const statusCode = apiErrorDetails.statusCode

    const status = signal.aborted ? 'cancelled' : 'failed'
    await finishAgentRun({
      ...params,
      runId,
      status,
      totalSteps,
      directCredits: currentAgentState.directCreditsUsed,
      totalCredits: currentAgentState.creditsUsed,
      errorMessage,
    })

    // Payment required errors (402) should propagate
    if (statusCode === 402) {
      throw error
    }

    // Capture the failed run as a failed trajectory (learning signal).
    captureTrajectory({
      messages: currentAgentState.messageHistory,
      userQuery: prompt,
      model: agentTemplate.model,
      completed: false,
      logger,
    })

    return {
      agentState: currentAgentState,
      output: {
        type: 'error',
        message: showUsageRateLimitMessage
          ? USAGE_RATE_LIMIT_MESSAGE
          : hasServerMessage
            ? errorMessage
            : 'Agent run error: ' + errorMessage,
        ...(statusCode !== undefined && { statusCode }),
        ...(apiErrorDetails.errorCode !== undefined && {
          error: apiErrorDetails.errorCode,
        }),
        ...(apiErrorDetails.countryCode !== undefined && {
          countryCode: apiErrorDetails.countryCode,
        }),
        ...(apiErrorDetails.countryBlockReason !== undefined && {
          countryBlockReason: apiErrorDetails.countryBlockReason,
        }),
        ...(apiErrorDetails.ipPrivacySignals !== undefined && {
          ipPrivacySignals: apiErrorDetails.ipPrivacySignals,
        }),
      },
    }
  }
}

const STEP_WARNING_MESSAGE = [
  "I've made quite a few responses in a row.",
  "Let me pause here to make sure we're still on the right track.",
  "Please let me know if you'd like me to continue or if you'd like to guide me in a different direction.",
].join(' ')

// Hidden marker used to dedupe the auto-continue nudge in message history.
const AUTO_CONTINUE_NUDGE_MARKER = 'cb-auto-continue-nudge'

// Forward-looking, first-person "I'm about to do X" narration — the phase
// announcement ("سأبدأ بالتحليل", "I'll run the tests now", "let me implement")
// the model emits right before prematurely stopping. Used only before a todo
// list exists, to catch the first stop in a multi-phase task. Conclusive output
// ("هذا الكود يقوم بـ", "Done", "🎯 تم …", "The answer is …") deliberately does
// NOT match, so simple questions still end normally; a non-match is safe (it
// just falls back to ending the turn, i.e. today's behavior).
const FORWARD_INTENT_REGEX =
  /\bi(?:'|’)?ll\b|\bi\s+will\b|\bi(?:'|’)?m\s+going\s+to\b|\bi\s+am\s+going\s+to\b|\blet\s+me\b|\blet(?:'|’)?s\b|\bnow\s+i\b|\bgoing\s+to\s+(?:start|begin|implement|run|test|write|create|add|fix|continue)\b|سوف\s*[أا]|راح\s+[أا]|سأبدأ|سأقوم|سأنفّ?ذ|سأكتب|سأعمل|سأراجع|سأختبر|سأستخدم|سأضيف|سأصلح|سأحدّ?ث|سأنشئ|سأتابع|الآن\s*سأ|دعني|الخطوة\s+التالية/iu

// Injected when the model stops mid-task (narration with no tool call) while
// todos are still incomplete. Tells the model to keep going on its own instead
// of waiting for the user to type "continue".
const AUTO_CONTINUE_NUDGE = `<!-- ${AUTO_CONTINUE_NUDGE_MARKER} -->
لا تتوقف. لديك مهام غير مكتملة في قائمة todos. تابع تنفيذ الخطوة التالية الآن مباشرةً باستخدام الأداة المناسبة (تحليل ثم تنفيذ ثم اختبار) دون أن تطلب الإذن للمتابعة. عندما تكتمل جميع المهام فعليًا، علّمها كلها completed: true ثم اكتب ملخصك النهائي.

Do not stop. There are still incomplete todos. Continue the next step right now by calling the appropriate tool — keep going through analysis, implementation, and testing without pausing to ask whether to continue. Only when every todo is genuinely done should you mark them all completed: true and write your final summary.`

// How many no-tool-call steps in a row the auto-continue guard tolerates before
// it lets the turn end, so a model that only narrates can't loop forever. Resets
// on any step that does real tool work. Override via env for tuning.
const MAX_CONSECUTIVE_NO_PROGRESS_STEPS = (() => {
  const envValue =
    typeof process !== 'undefined'
      ? Number(process.env?.CODEBUFF_AGENT_MAX_NO_PROGRESS_STEPS)
      : NaN
  return Number.isFinite(envValue) && envValue > 0 ? envValue : 3
})()

// Hard cap on how many times the auto-continue guard may resurrect a turn the
// model tried to end, per user turn, regardless of interleaved tool progress.
// MAX_CONSECUTIVE_NO_PROGRESS_STEPS resets on ANY tool work, so a model that
// alternates real tool calls with narration could otherwise be nudged onward
// until the 200-step cap (~hours). This is the streak-independent bound. Read
// lazily so it can be overridden per process/test via env.
function getMaxTotalAutoContinues(): number {
  const envValue =
    typeof process !== 'undefined'
      ? Number(process.env?.CODEBUFF_AGENT_MAX_AUTO_CONTINUES)
      : NaN
  return Number.isFinite(envValue) && envValue > 0 ? envValue : 12
}

// Wall-clock budget for a single user turn. Read lazily (not a module-load
// constant) so the value can be overridden per process/test via env. Without
// this the only governor is the 200-step cap with no time bound, which let a
// large plan in MAX mode run for ~2 hours and fill the context window.
function getMaxAgentTurnDurationMs(): number {
  const envValue =
    typeof process !== 'undefined'
      ? Number(process.env?.CODEBUFF_AGENT_MAX_TURN_MS)
      : NaN
  return Number.isFinite(envValue) && envValue > 0 ? envValue : 30 * 60 * 1000
}

// Shown to the user (and recorded in history) when a turn is auto-ended for
// exceeding the wall-clock budget. Bilingual to match the auto-continue nudge.
const TURN_BUDGET_MESSAGE = [
  '⏸️ أوقفت هذه الجولة مؤقتًا لأنها تجاوزت حدّ الوقت المسموح للجولة الواحدة.',
  'تم حفظ كل العمل المنجز. راجِع النتيجة واكتب «تابع» (أو continue) إذا أردت أن أكمل.',
  '',
  "I've paused this turn because it exceeded the per-turn time budget.",
  'All in-progress work has been preserved — review it and type "continue" if you want me to keep going.',
].join('\n')

/**
 * One-line message shown (instead of a raw stack trace) when a run fails due to
 * provider rate limiting or a dropped connection. Single source of truth — used
 * by every usage/rate-limit branch in the fatal error handler above.
 */
const USAGE_RATE_LIMIT_MESSAGE = 'usage: your usage rate limit'

/**
 * SPECIFIC matcher for "the connection dropped mid-stream" failures (socket
 * closed / hung up). Deliberately narrow — it does NOT match generic network
 * problems like "Unable to connect" (those keep their real message) and never
 * keys off an undefined status code, so a real bug (e.g. a TypeError) is never
 * masked as a usage message.
 */
const isConnectionClosedError = (error: unknown): boolean => {
  if (!error || isAbortError(error)) return false
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase()
  return (
    message.includes('socket connection was closed') ||
    message.includes('socket hang up') ||
    message.includes('econnreset') ||
    message.includes('connection closed')
  )
}

// Errors we treat as transient: network/idle/socket timeouts, fetch failures,
// DNS hiccups, gateway errors. The agent retries with backoff instead of
// crashing the whole run. User aborts and 402 propagate untouched.
const isTransientStepError = (error: unknown): boolean => {
  if (!error) return false
  if (isAbortError(error)) return false
  const apiDetails = extractApiErrorDetails(error)
  if (apiDetails.statusCode === 402) return false

  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase()
  const name = (error instanceof Error ? error.name : '').toLowerCase()

  if (name === 'timeouterror') return true

  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('etimedout') ||
    message.includes('socket hang up') ||
    message.includes('network error') ||
    message.includes('fetch failed') ||
    message.includes('the operation timed out') ||
    message.includes('unable to connect') ||
    apiDetails.statusCode === 408 ||
    apiDetails.statusCode === 502 ||
    apiDetails.statusCode === 503 ||
    apiDetails.statusCode === 504
  )
}

// Read lazily (not a module-load constant) so it can be overridden per
// process/test via env — matches getMaxAgentTurnDurationMs above.
function getMaxTransientRetries(): number {
  const envValue =
    typeof process !== 'undefined'
      ? Number(process.env?.CODEBUFF_AGENT_STEP_MAX_RETRIES)
      : NaN
  return Number.isFinite(envValue) && envValue >= 0 ? envValue : 8
}

const TRANSIENT_BASE_DELAY_MS = 1000
const TRANSIENT_MAX_DELAY_MS = 30_000

async function runAgentStepWithTransientRetry<T>(params: {
  runStep: () => Promise<T>
  signal: AbortSignal
  logger: Logger
  // Surfaced to the user so a network retry is never a silent "working" stall.
  onResponseChunk?: (chunk: string | PrintModeEvent) => void
}): Promise<T> {
  const { runStep, signal, logger, onResponseChunk } = params
  const maxRetries = getMaxTransientRetries()
  let attempt = 0
  // First attempt is not counted as a "retry" — total tries = retries + 1.
  while (true) {
    try {
      return await runStep()
    } catch (error) {
      if (signal.aborted) throw error
      if (attempt >= maxRetries || !isTransientStepError(error)) {
        throw error
      }
      attempt += 1
      const delayMs = Math.min(
        TRANSIENT_BASE_DELAY_MS * 2 ** (attempt - 1),
        TRANSIENT_MAX_DELAY_MS,
      )
      const jitter = Math.round(delayMs * (0.8 + Math.random() * 0.4))
      logger.warn(
        {
          attempt,
          maxRetries,
          delayMs: jitter,
          error: getErrorObject(error),
        },
        'Transient agent-step error, retrying',
      )
      // Make the wait visible — otherwise the agent looks frozen in "working".
      onResponseChunk?.(
        `\n⏳ تعذّر الاتصال مؤقتًا — إعادة المحاولة ${attempt}/${maxRetries} خلال ${Math.round(
          jitter / 1000,
        )}s… (Network hiccup — retrying ${attempt}/${maxRetries})\n`,
      )
      await new Promise((resolve) => setTimeout(resolve, jitter))
    }
  }
}
