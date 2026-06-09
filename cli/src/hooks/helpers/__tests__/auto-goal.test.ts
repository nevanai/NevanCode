import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync } from 'fs'
import os from 'os'
import path from 'path'

import {
  buildInterviewPrompt,
  buildPlanPrompt,
  buildReviewPromptFromArgs,
} from '../../../commands/prompt-builders'
import { setProjectRoot } from '../../../project-files'
import { useChatStore } from '../../../state/chat-store'
import { useGoalStore } from '../../../state/goal-store'
import { prepareUserMessage } from '../send-message'

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'codebuff-auto-goal-'))
setProjectRoot(path.join(TMP_ROOT, 'fake-project'))

const noopDeps = {
  setMessages: () => {},
  lastMessageMode: null,
  setLastMessageMode: () => {},
  scrollToLatest: () => {},
  setHasReceivedPlanResponse: () => {},
} as const

describe('prepareUserMessage auto-goal trigger', () => {
  beforeEach(() => {
    useGoalStore.getState().clearGoal()
    useChatStore.setState((state) => {
      state.pendingAttachments = []
      state.pendingBashMessages = []
    })
  })

  test('seeds a goal from a plain first message', async () => {
    await prepareUserMessage({
      content: 'Migrate the database to Postgres',
      agentMode: 'DEFAULT',
      deps: noopDeps,
    })
    const goal = useGoalStore.getState().currentGoal
    expect(goal).not.toBeNull()
    expect(goal?.objective).toBe('Migrate the database to Postgres')
    expect(goal?.autoCreated).toBe(true)
  })

  test('does NOT seed a goal from a /plan-wrapped content (Bug 1 fix)', async () => {
    // The agent-facing content is the prompt-builder wrapper; without the
    // userIntent passthrough this would have captured the boilerplate as
    // the goal objective.
    const wrapped = buildPlanPrompt('Add OAuth login')
    expect(wrapped).toContain('Gather all the relevant context')

    await prepareUserMessage({
      content: wrapped,
      agentMode: 'PLAN',
      userIntent: 'Add OAuth login',
      deps: noopDeps,
    })

    const goal = useGoalStore.getState().currentGoal
    expect(goal).not.toBeNull()
    expect(goal?.objective).toBe('Add OAuth login')
  })

  test('does NOT seed a goal when userIntent is empty (clear-and-implement seed)', async () => {
    // The clear-and-implement flow passes userIntent: '' so the auto-goal
    // latch does not fire on a system-generated seed message.
    await prepareUserMessage({
      content:
        'A previous agent produced the plan below to accomplish the user’s task. <PLAN>\nstep A\n</PLAN>',
      agentMode: 'DEFAULT',
      userIntent: '',
      deps: noopDeps,
    })

    expect(useGoalStore.getState().currentGoal).toBeNull()
    // The latch should not be flipped either — empty intent is a no-op.
    expect(useGoalStore.getState().hasAttemptedAutoCreate).toBe(false)
  })

  test('uses the user intent for /interview and /review wrappers', async () => {
    const wrapped = buildInterviewPrompt('design our auth flow')
    expect(wrapped).toContain('Interview me')

    await prepareUserMessage({
      content: wrapped,
      agentMode: 'DEFAULT',
      userIntent: 'design our auth flow',
      deps: noopDeps,
    })
    expect(useGoalStore.getState().currentGoal?.objective).toBe(
      'design our auth flow',
    )
  })

  test('uses the user intent for /review wrappers', async () => {
    useGoalStore.getState().clearGoal()
    const wrapped = buildReviewPromptFromArgs('the new login flow')
    expect(wrapped).toContain('gather all relevant context')

    await prepareUserMessage({
      content: wrapped,
      agentMode: 'DEFAULT',
      userIntent: 'the new login flow',
      deps: noopDeps,
    })
    expect(useGoalStore.getState().currentGoal?.objective).toBe(
      'the new login flow',
    )
  })

  test('subsequent messages in the same session do not create a second goal', async () => {
    await prepareUserMessage({
      content: 'first user message',
      agentMode: 'DEFAULT',
      deps: noopDeps,
    })
    const firstGoalId = useGoalStore.getState().currentGoal?.goalId

    await prepareUserMessage({
      content: 'follow-up message',
      agentMode: 'DEFAULT',
      deps: noopDeps,
    })
    expect(useGoalStore.getState().currentGoal?.goalId).toBe(firstGoalId!)
    expect(useGoalStore.getState().currentGoal?.objective).toBe(
      'first user message',
    )
  })
})

describe('prepareUserMessage goal context injection', () => {
  beforeEach(() => {
    useGoalStore.getState().clearGoal()
  })

  test('prepends <active_thread_goal> when a goal is active', async () => {
    const prepared = await prepareUserMessage({
      content: 'continue work',
      agentMode: 'DEFAULT',
      deps: noopDeps,
    })
    expect(prepared.finalContent).toContain('<active_thread_goal>')
    expect(prepared.finalContent).toContain('continue work')
    // The goal block must appear BEFORE the user content.
    const goalIdx = prepared.finalContent.indexOf('<active_thread_goal>')
    const userIdx = prepared.finalContent.indexOf('continue work')
    expect(goalIdx).toBeLessThan(userIdx)
  })

  test('does NOT prepend the goal block while the goal is paused', async () => {
    useGoalStore.getState().createGoal({ objective: 'paused goal' })
    useGoalStore.getState().updateStatus('paused')

    const prepared = await prepareUserMessage({
      content: 'a follow-up',
      agentMode: 'DEFAULT',
      deps: noopDeps,
    })
    expect(prepared.finalContent).not.toContain('<active_thread_goal>')
    expect(prepared.finalContent).toBe('a follow-up')
  })
})
