import { useChatStore } from '../state/chat-store'
import { extractPlanFromBuffer } from '../utils/message-block-helpers'

import {
  CLEAR_AND_IMPLEMENT_IMPLEMENTATION_PREFIX,
  parseClearAndImplementSentinel,
} from './clear-and-implement-constants'

import type { ClearAndImplementMode } from './clear-and-implement-constants'
import type { AgentMode } from '../utils/constants'
import type { ChatMessage, ContentBlock } from '../types/chat'

const MODE_TO_AGENT_MODE: Record<ClearAndImplementMode, AgentMode> = {
  DEFAULT: 'DEFAULT',
  MAX: 'MAX',
  LITE: 'LITE',
}

/**
 * Walks the chat blocks (most-recent first) and returns the first plan
 * content found. Returns null when no plan content is present.
 */
const extractPlanFromBlocks = (blocks: ContentBlock[] | undefined): string | null => {
  if (!blocks) return null
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.type === 'plan' && block.content.trim().length > 0) {
      return block.content.trim()
    }
    if (block.type === 'text' && block.content.includes('</PLAN>')) {
      const fromTags = extractPlanFromBuffer(block.content)
      if (fromTags && fromTags.trim().length > 0) {
        return fromTags.trim()
      }
    }
    if (block.type === 'agent') {
      const nested = extractPlanFromBlocks(block.blocks)
      if (nested) return nested
    }
  }
  return null
}

/**
 * Finds the most recently produced plan in the current chat history.
 * Looks for explicit `PlanContentBlock`s first, then falls back to scanning
 * any `<PLAN>...</PLAN>` tags still present in raw text blocks.
 */
export const getLatestPlanFromMessages = (
  messages: ChatMessage[],
): string | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const found = extractPlanFromBlocks(messages[i]?.blocks)
    if (found) return found
  }
  return null
}

export interface ClearAndImplementExecuteParams {
  mode: ClearAndImplementMode
  /** Set the active CLI agent mode after clearing context. */
  setAgentMode: (mode: AgentMode) => void
  /** Reset displayed messages — typically `setMessages(() => [])`. */
  setMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void
  /** Clears the SDK previous-run state so the next turn starts fresh. */
  clearMessages: () => void
  /** Stops any in-progress streaming so the next send starts from idle. */
  stopStreaming: () => void
  /** Re-enables queue processing for the upcoming implementation send. */
  setCanProcessQueue: (can: boolean) => void
  /** Actual message dispatcher reused from useSendMessage. */
  sendMessage: (params: {
    content: string
    agentMode: AgentMode
    userIntent?: string
  }) => void
}

export interface ClearAndImplementResult {
  ok: boolean
  reason?: 'no-plan-found' | 'unknown-mode'
}

/**
 * Executes the "clear context and implement" flow:
 *   1. Looks up the latest plan from the chat history.
 *   2. Wipes the chat UI + SDK previous-run state.
 *   3. Switches the agent mode to the user's selection.
 *   4. Sends the saved plan (with the implementation prefix) as the seed
 *      message of the brand-new session.
 *   5. Resets the auto-goal latch so this fresh implementation session can
 *      seed a new `/goal` from the plan.
 *
 * Returns `{ok: false, reason}` when the flow cannot proceed (e.g. the agent
 * never produced a plan to implement); the caller surfaces a system message
 * in that case.
 */
export const executeClearAndImplement = (
  params: ClearAndImplementExecuteParams,
): ClearAndImplementResult => {
  const targetMode = MODE_TO_AGENT_MODE[params.mode]
  if (!targetMode) return { ok: false, reason: 'unknown-mode' }

  const messages = useChatStore.getState().messages
  const plan = getLatestPlanFromMessages(messages)
  if (!plan) return { ok: false, reason: 'no-plan-found' }

  const seedMessage = `${CLEAR_AND_IMPLEMENT_IMPLEMENTATION_PREFIX}\n\n<PLAN>\n${plan}\n</PLAN>`

  // Clear UI and previous-run state.
  params.stopStreaming()
  params.setMessages(() => [])
  params.clearMessages()

  // Switch into the user-chosen mode and allow queue processing.
  params.setAgentMode(targetMode)
  params.setCanProcessQueue(true)

  // NOTE: We deliberately do NOT call `useGoalStore.resetAutoCreateFlag()`
  // here. The seed message below is the implementation-prefix + plan, not
  // the user's typed intent — re-arming the auto-goal latch would seed the
  // goal with that boilerplate. The active goal (if any) carries through.

  // Send the plan as the seed message of the new implementation session.
  // We pass an empty userIntent so the auto-goal latch ignores this message
  // even if the latch was reset elsewhere.
  params.sendMessage({
    content: seedMessage,
    agentMode: targetMode,
    userIntent: '',
  })

  return { ok: true }
}

/**
 * Re-export the sentinel parser so callers only need one import.
 */
export { parseClearAndImplementSentinel }
