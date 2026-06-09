/**
 * Trajectory capture — a from-scratch port of Hermes Agent's learning-loop
 * primitive (NousResearch/hermes-agent: `agent/trajectory.py` plus
 * `agent.agent_runtime_helpers.convert_to_trajectory_format`).
 *
 * Hermes is a self-improving agent: every completed conversation is serialised
 * into the ShareGPT function-calling format and appended to a JSONL file so the
 * run can later be used as fine-tuning / self-improvement data. Successful runs
 * go to `trajectory_samples.jsonl`, failed runs to `failed_trajectories.jsonl`.
 * That capture step is the foundation of its "closed learning loop" and had no
 * equivalent in this codebase — this module adds it.
 *
 * The conversion *logic* is reimplemented here against Codebuff's own message
 * model (structured `content` parts) — nothing is imported from, or depends on,
 * Hermes. Capture is OFF by default and only runs when CODEBUFF_SAVE_TRAJECTORIES
 * is set, so it never changes default agent behaviour.
 *
 * Upstream references (read, not copied):
 *   - agent/trajectory.py                       -> save_trajectory, convert_scratchpad_to_think
 *   - agent/agent_runtime_helpers.py            -> convert_to_trajectory_format
 */

import { appendFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

import type {
  AssistantMessage,
  Message,
  ToolMessage,
  UserMessage,
} from '@codebuff/common/types/messages/codebuff-message'
import type {
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolResultOutput,
} from '@codebuff/common/types/messages/content-part'

/** A single turn in the ShareGPT conversation format Hermes saves. */
export interface ShareGptTurn {
  from: 'system' | 'human' | 'gpt' | 'tool'
  value: string
}

/** One JSONL record as written to the trajectory file. */
export interface TrajectoryEntry {
  conversations: ShareGptTurn[]
  timestamp: string
  model: string
  completed: boolean
}

/** Minimal structural logger so this module stays dependency-light. */
type TrajectoryLogger = {
  info?: (obj: unknown, msg?: string) => void
  warn?: (obj: unknown, msg?: string) => void
}

// Cap any single tool-call argument blob / tool result we may stringify. Not a
// hard Hermes parallel, but keeps a runaway tool result from writing megabytes
// of base64 into the trajectory file.
const MEDIA_PLACEHOLDER = (mediaType: string) => `[media omitted: ${mediaType}]`

/**
 * Port of Hermes `convert_scratchpad_to_think`: when native thinking is off the
 * model reasons inside `<REASONING_SCRATCHPAD>` tags; trajectories normalise
 * those to `<think>` tags so the training format is consistent.
 */
export function convertScratchpadToThink(content: string): string {
  if (!content || !content.includes('<REASONING_SCRATCHPAD>')) {
    return content
  }
  return content
    .replaceAll('<REASONING_SCRATCHPAD>', '<think>')
    .replaceAll('</REASONING_SCRATCHPAD>', '</think>')
}

/** Port of Hermes `has_incomplete_scratchpad`. */
export function hasIncompleteScratchpad(content: string): boolean {
  if (!content) {
    return false
  }
  return (
    content.includes('<REASONING_SCRATCHPAD>') &&
    !content.includes('</REASONING_SCRATCHPAD>')
  )
}

/**
 * The fixed function-calling system preamble Hermes prepends to every saved
 * trajectory, with the agent's available tools spliced into the `<tools>` block.
 * Reproduced (not imported) so saved trajectories stay valid tool-use training
 * data. `toolsDescription` is the JSON/text description of the tool signatures;
 * an empty string yields an empty `<tools>` block, which is still well-formed.
 */
export function buildTrajectorySystemMessage(toolsDescription: string): string {
  return (
    'You are a function calling AI model. You are provided with function signatures within <tools> </tools> XML tags. ' +
    'You may call one or more functions to assist with the user query. If available tools are not relevant in assisting ' +
    'with user query, just respond in natural conversational language. Don\'t make assumptions about what values to plug ' +
    'into functions. After calling & executing the functions, you will be provided with function results within ' +
    '<tool_response> </tool_response> XML tags. Here are the available tools:\n' +
    `<tools>\n${toolsDescription}\n</tools>\n` +
    'For each function call return a JSON object, with the following pydantic model json schema for each:\n' +
    "{'title': 'FunctionCall', 'type': 'object', 'properties': {'name': {'title': 'Name', 'type': 'string'}, " +
    "'arguments': {'title': 'Arguments', 'type': 'object'}}, 'required': ['name', 'arguments']}\n" +
    'Each function call should be enclosed within <tool_call> </tool_call> XML tags.\n' +
    'Example:\n<tool_call>\n{\'name\': <function-name>,\'arguments\': <args-dict>}\n</tool_call>'
  )
}

/** Join the text-bearing parts of a user message; non-text parts become markers. */
function userTextFromParts(content: UserMessage['content']): string {
  return content
    .map((part) => {
      if (part.type === 'text') {
        return part.text
      }
      if (part.type === 'image') {
        return '[image omitted]'
      }
      // file
      return `[file omitted${part.filename ? `: ${part.filename}` : ''}]`
    })
    .join('')
}

/**
 * Map a tool message's structured outputs to the `content` value embedded in a
 * `<tool_response>`. Codebuff already stores tool results as structured JSON (or
 * media), so unlike Hermes — which tries to JSON.parse a string — we use the
 * value directly. Media is replaced with a short marker to keep trajectories
 * text-only (Hermes does the same via `_trajectory_normalize_msg`).
 */
function toolResultContentToValue(outputs: ToolResultOutput[]): unknown {
  const mapped = outputs.map((out) =>
    out.type === 'json' ? out.value : MEDIA_PLACEHOLDER(out.mediaType),
  )
  if (mapped.length === 1) {
    return mapped[0]
  }
  return mapped
}

/** Render one assistant message (with its tool calls) into ShareGPT turns. */
function assistantTurns(
  msg: AssistantMessage,
  followingToolMessages: ToolMessage[],
): ShareGptTurn[] {
  const turns: ShareGptTurn[] = []

  const reasoning = msg.content
    .filter((p): p is ReasoningPart => p.type === 'reasoning')
    .map((p) => p.text)
    .join('')
    .trim()
  const text = msg.content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('')
  const toolCalls = msg.content.filter(
    (p): p is ToolCallPart => p.type === 'tool-call',
  )

  // Prepend reasoning in <think> tags if present (native thinking tokens).
  let value = reasoning ? `<think>\n${reasoning}\n</think>\n` : ''

  if (toolCalls.length > 0) {
    if (text.trim()) {
      value += `${convertScratchpadToThink(text)}\n`
    }
    for (const tc of toolCalls) {
      const toolCallJson = JSON.stringify({
        name: tc.toolName,
        arguments: tc.input,
      })
      value += `<tool_call>\n${toolCallJson}\n</tool_call>\n`
    }
    // Every gpt turn must carry a <think> block for a consistent training format.
    if (!value.includes('<think>')) {
      value = `<think>\n</think>\n${value}`
    }
    turns.push({ from: 'gpt', value: rstrip(value) })

    if (followingToolMessages.length > 0) {
      const toolResponses = followingToolMessages.map((toolMsg) => {
        const responseJson = JSON.stringify({
          tool_call_id: toolMsg.toolCallId ?? '',
          name: toolMsg.toolName ?? 'unknown',
          content: toolResultContentToValue(toolMsg.content),
        })
        return `<tool_response>\n${responseJson}\n</tool_response>`
      })
      turns.push({ from: 'tool', value: toolResponses.join('\n') })
    }
  } else {
    value += convertScratchpadToThink(text)
    if (!value.includes('<think>')) {
      value = `<think>\n</think>\n${value}`
    }
    turns.push({ from: 'gpt', value: value.trim() })
  }

  return turns
}

/** Trailing-whitespace strip, the JS analogue of Python `str.rstrip()`. */
function rstrip(s: string): string {
  return s.replace(/\s+$/, '')
}

/**
 * Port of Hermes `convert_to_trajectory_format`: turn an internal message
 * history into the ShareGPT turn list (system / human / gpt / tool).
 *
 * Adapted for Codebuff:
 *   - Hermes' OpenAI-style messages (role + `tool_calls` with stringified JSON
 *     arguments, separate `tool` messages) become Codebuff's structured content
 *     parts. The emitted XML shape (`<think>`, `<tool_call>`, `<tool_response>`)
 *     and turn roles are identical.
 *   - The original query is supplied separately as `userQuery` and emitted as
 *     the first `human` turn; the first user message in `messages` is then
 *     skipped to avoid duplicating it (Hermes skips `messages[0]` for the same
 *     reason — we skip the first user-role message so a leading system message
 *     doesn't shift the offset).
 *   - `system`-role messages are represented by the synthesised system turn and
 *     skipped during iteration.
 */
export function convertToTrajectoryFormat(opts: {
  messages: Message[]
  userQuery: string
  toolsDescription?: string
}): ShareGptTurn[] {
  const { messages, userQuery, toolsDescription = '' } = opts
  const trajectory: ShareGptTurn[] = []

  trajectory.push({
    from: 'system',
    value: buildTrajectorySystemMessage(toolsDescription),
  })
  trajectory.push({ from: 'human', value: userQuery })

  let skippedFirstUser = false

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    if (msg.role === 'system') {
      continue
    }

    if (msg.role === 'user') {
      if (!skippedFirstUser) {
        skippedFirstUser = true
        continue
      }
      trajectory.push({ from: 'human', value: userTextFromParts(msg.content) })
      continue
    }

    if (msg.role === 'assistant') {
      const hasToolCalls = msg.content.some((p) => p.type === 'tool-call')

      // Gather the contiguous run of tool messages that answer these calls.
      const followingToolMessages: ToolMessage[] = []
      if (hasToolCalls) {
        let j = i + 1
        while (j < messages.length && messages[j].role === 'tool') {
          followingToolMessages.push(messages[j] as ToolMessage)
          j++
        }
      }

      trajectory.push(...assistantTurns(msg, followingToolMessages))

      // Skip the tool messages we just folded into this turn.
      i += followingToolMessages.length
      continue
    }

    // A `tool` message not immediately preceded by an assistant tool-call turn.
    // Hermes only collects tool messages that follow such a turn, so a stray
    // tool message is dropped here for the same reason.
  }

  return trajectory
}

/** Whether trajectory capture is switched on for this process. */
export function isTrajectoryCaptureEnabled(): boolean {
  const v =
    typeof process !== 'undefined'
      ? process.env?.CODEBUFF_SAVE_TRAJECTORIES
      : undefined
  return v === '1' || v === 'true' || v === 'yes'
}

/** Directory trajectories are written to (CODEBUFF_TRAJECTORY_DIR, else cwd). */
export function getTrajectoryDir(): string {
  const v =
    typeof process !== 'undefined'
      ? process.env?.CODEBUFF_TRAJECTORY_DIR
      : undefined
  if (v && v.trim()) {
    return v
  }
  return typeof process !== 'undefined' && typeof process.cwd === 'function'
    ? process.cwd()
    : '.'
}

/**
 * Port of Hermes `save_trajectory`: append one JSONL entry to the per-outcome
 * file. Failures are logged and swallowed (never thrown) so saving a trajectory
 * can't break an agent run — matching upstream's best-effort behaviour. Returns
 * the file path written, or undefined on failure.
 */
export function saveTrajectory(opts: {
  trajectory: ShareGptTurn[]
  model: string
  completed: boolean
  dir?: string
  filename?: string
  logger?: TrajectoryLogger
}): string | undefined {
  const { trajectory, model, completed, logger } = opts
  const dir = opts.dir ?? getTrajectoryDir()
  const filename =
    opts.filename ??
    (completed ? 'trajectory_samples.jsonl' : 'failed_trajectories.jsonl')
  const filePath = join(dir, filename)

  const entry: TrajectoryEntry = {
    conversations: trajectory,
    timestamp: new Date().toISOString(),
    model,
    completed,
  }

  try {
    mkdirSync(dirname(filePath), { recursive: true })
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8')
    logger?.info?.({ filePath }, 'Trajectory saved')
    return filePath
  } catch (e) {
    logger?.warn?.({ error: e }, 'Failed to save trajectory')
    return undefined
  }
}

/**
 * Convenience orchestrator used at agent-run boundaries: gate on the env flag,
 * convert, and save — all wrapped so an unexpected error can never escape into
 * the run. Returns the written path, or undefined when disabled / on failure.
 */
export function captureTrajectory(opts: {
  messages: Message[]
  userQuery: string | undefined
  model: string
  toolsDescription?: string
  completed: boolean
  logger?: TrajectoryLogger
}): string | undefined {
  try {
    if (!isTrajectoryCaptureEnabled()) {
      return undefined
    }
    const trajectory = convertToTrajectoryFormat({
      messages: opts.messages,
      userQuery: opts.userQuery ?? '',
      toolsDescription: opts.toolsDescription,
    })
    return saveTrajectory({
      trajectory,
      model: opts.model,
      completed: opts.completed,
      logger: opts.logger,
    })
  } catch (e) {
    opts.logger?.warn?.({ error: e }, 'Trajectory capture failed (non-fatal)')
    return undefined
  }
}
