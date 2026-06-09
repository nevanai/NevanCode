import { useGoalStore } from '../state/goal-store'
import { getSystemMessage, getUserMessage } from '../utils/message-history'

import type { ChatMessage } from '../types/chat'
import type { GoalStatus, ThreadGoal } from '../state/goal-store'

const MAX_OBJECTIVE_LENGTH = 4000

const STATUS_LABEL: Record<GoalStatus, string> = {
  active: 'active',
  paused: 'paused',
  blocked: 'blocked',
  budget_limited: 'budget-limited',
  complete: 'complete',
}

const formatGoal = (goal: ThreadGoal): string => {
  const lines: string[] = []
  lines.push(`Status: ${STATUS_LABEL[goal.status]}`)
  lines.push(`Objective: ${goal.objective}`)
  if (goal.tokenBudget !== null) {
    lines.push(`Token budget: ${goal.tokensUsed} / ${goal.tokenBudget}`)
  } else {
    lines.push(`Tokens used: ${goal.tokensUsed}`)
  }
  if (goal.timeUsedSeconds > 0) {
    lines.push(`Time used: ${goal.timeUsedSeconds}s`)
  }
  if (goal.autoCreated) {
    lines.push('(auto-created from your first message)')
  }
  return lines.join('\n')
}

export interface GoalCommandResult {
  postUserMessage: (prev: ChatMessage[]) => ChatMessage[]
}

const reply = (userInput: string, body: string): GoalCommandResult => ({
  postUserMessage: (prev) => [
    ...prev,
    getUserMessage(userInput),
    getSystemMessage(body),
  ],
})

export const handleGoalCommand = (
  userInput: string,
  rawArgs: string,
): GoalCommandResult => {
  const store = useGoalStore.getState()
  const trimmed = rawArgs.trim()
  const lower = trimmed.toLowerCase()

  if (!trimmed) {
    if (!store.currentGoal) {
      return reply(
        userInput,
        '🎯 No active goal.\n\nUsage:\n  /goal <objective>            Set the active goal\n  /goal pause                  Pause the active goal\n  /goal resume                 Resume a paused goal\n  /goal clear                  Remove the goal\n  /goal status                 Show this status block',
      )
    }
    return reply(userInput, `🎯 Active thread goal\n\n${formatGoal(store.currentGoal)}`)
  }

  if (lower === 'status' || lower === 'show') {
    if (!store.currentGoal) {
      return reply(userInput, '🎯 No active goal.')
    }
    return reply(userInput, `🎯 Active thread goal\n\n${formatGoal(store.currentGoal)}`)
  }

  if (lower === 'clear' || lower === 'remove' || lower === 'delete') {
    if (!store.currentGoal) {
      return reply(userInput, '🎯 No active goal to clear.')
    }
    store.clearGoal()
    return reply(userInput, '🎯 Goal cleared.')
  }

  if (lower === 'pause') {
    if (!store.currentGoal) {
      return reply(userInput, '🎯 No active goal to pause.')
    }
    if (store.currentGoal.status === 'paused') {
      return reply(userInput, '🎯 Goal is already paused.')
    }
    store.updateStatus('paused')
    return reply(userInput, '🎯 Goal paused. The agent will stop pursuing it until you resume.')
  }

  if (lower === 'resume') {
    if (!store.currentGoal) {
      return reply(userInput, '🎯 No goal to resume.')
    }
    if (store.currentGoal.status === 'active') {
      return reply(userInput, '🎯 Goal is already active.')
    }
    store.updateStatus('active')
    return reply(userInput, '🎯 Goal resumed.')
  }

  if (lower === 'complete' || lower === 'done') {
    if (!store.currentGoal) {
      return reply(userInput, '🎯 No goal to complete.')
    }
    store.updateStatus('complete')
    return reply(
      userInput,
      `🎯 Goal marked complete.\n\n${formatGoal(store.currentGoal!)}`,
    )
  }

  // Anything else is treated as setting a new objective
  if (trimmed.length > MAX_OBJECTIVE_LENGTH) {
    return reply(
      userInput,
      `🎯 Objective too long (${trimmed.length} chars). Max is ${MAX_OBJECTIVE_LENGTH}.`,
    )
  }

  if (store.currentGoal) {
    store.updateObjective(trimmed)
    return reply(
      userInput,
      `🎯 Goal objective updated.\n\n${formatGoal(useGoalStore.getState().currentGoal!)}`,
    )
  }

  const goal = store.createGoal({ objective: trimmed, autoCreated: false })
  return reply(userInput, `🎯 Goal set.\n\n${formatGoal(goal)}`)
}

/**
 * Auto-create a goal from the first non-empty user message in a session if no
 * goal already exists. Returns the goal that was created, or null when no
 * auto-creation occurred (already attempted, content was empty, etc).
 */
export const maybeAutoCreateGoalFromFirstMessage = (
  rawContent: string,
): ThreadGoal | null => {
  const content = rawContent.trim()
  if (!content) return null

  const store = useGoalStore.getState()
  if (store.currentGoal) return null
  if (store.hasAttemptedAutoCreate) return null

  const objective =
    content.length > MAX_OBJECTIVE_LENGTH
      ? content.slice(0, MAX_OBJECTIVE_LENGTH)
      : content

  const goal = store.createGoal({ objective, autoCreated: true })
  return goal
}
