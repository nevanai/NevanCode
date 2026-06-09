import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { mkdtempSync } from 'fs'
import os from 'os'
import path from 'path'

import { setProjectRoot } from '../../project-files'
import { useChatStore } from '../../state/chat-store'
import { useGoalStore } from '../../state/goal-store'
import {
  CLEAR_AND_IMPLEMENT_IMPLEMENTATION_PREFIX,
  CLEAR_AND_IMPLEMENT_PROMPT_PREFIX,
} from '../clear-and-implement-constants'
import {
  executeClearAndImplement,
  getLatestPlanFromMessages,
} from '../clear-and-implement'

import type { ChatMessage, ContentBlock } from '../../types/chat'

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'codebuff-clear-impl-'))
setProjectRoot(path.join(TMP_ROOT, 'fake-project'))

const buildMessage = (
  id: string,
  blocks: ContentBlock[],
  variant: 'ai' | 'user' = 'ai',
): ChatMessage => ({
  id,
  variant,
  blocks,
  content: '',
  timestamp: new Date().toISOString(),
})

describe('getLatestPlanFromMessages', () => {
  test('returns null when no messages exist', () => {
    expect(getLatestPlanFromMessages([])).toBeNull()
  })

  test('finds a plan inside a PlanContentBlock', () => {
    const messages: ChatMessage[] = [
      buildMessage('m1', [
        { type: 'plan', content: '1. step\n2. another step' },
      ]),
    ]
    expect(getLatestPlanFromMessages(messages)).toBe('1. step\n2. another step')
  })

  test('falls back to <PLAN>...</PLAN> tags inside a text block', () => {
    const messages: ChatMessage[] = [
      buildMessage('m1', [
        {
          type: 'text',
          content: 'preamble <PLAN>\nstep A\nstep B\n</PLAN> trailing',
        },
      ]),
    ]
    expect(getLatestPlanFromMessages(messages)).toBe('step A\nstep B')
  })

  test('prefers the most recent plan when several exist', () => {
    const messages: ChatMessage[] = [
      buildMessage('m1', [{ type: 'plan', content: 'old plan' }]),
      buildMessage('m2', [{ type: 'plan', content: 'newer plan' }]),
    ]
    expect(getLatestPlanFromMessages(messages)).toBe('newer plan')
  })

  test('walks into nested agent blocks', () => {
    const messages: ChatMessage[] = [
      buildMessage('m1', [
        {
          type: 'agent',
          agentId: 'thinker-1',
          agentName: 'Thinker',
          agentType: 'thinker-gpt',
          content: 'nested',
          status: 'complete',
          blocks: [{ type: 'plan', content: 'nested-plan' }],
        },
      ]),
    ]
    expect(getLatestPlanFromMessages(messages)).toBe('nested-plan')
  })

  test('returns null when no plan or PLAN tags are present', () => {
    const messages: ChatMessage[] = [
      buildMessage('m1', [{ type: 'text', content: 'just chat, no plan tags' }]),
    ]
    expect(getLatestPlanFromMessages(messages)).toBeNull()
  })
})

describe('executeClearAndImplement', () => {
  beforeEach(() => {
    useGoalStore.getState().clearGoal()
    useChatStore.setState((state) => {
      state.messages = []
    })
  })

  test('returns `no-plan-found` when the chat has no plan blocks', () => {
    const result = executeClearAndImplement({
      mode: 'DEFAULT',
      setAgentMode: mock(),
      setMessages: mock(),
      clearMessages: mock(),
      stopStreaming: mock(),
      setCanProcessQueue: mock(),
      sendMessage: mock(),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no-plan-found')
  })

  test('clears messages, switches mode, and resends plan with prefix', () => {
    useChatStore.setState((state) => {
      state.messages = [
        buildMessage('m1', [{ type: 'plan', content: 'do A then B' }]),
      ]
    })

    const setAgentMode = mock()
    const setMessages = mock()
    const clearMessages = mock()
    const stopStreaming = mock()
    const setCanProcessQueue = mock()
    const sendMessage = mock()

    const result = executeClearAndImplement({
      mode: 'MAX',
      setAgentMode,
      setMessages,
      clearMessages,
      stopStreaming,
      setCanProcessQueue,
      sendMessage,
    })

    expect(result.ok).toBe(true)
    expect(stopStreaming).toHaveBeenCalledTimes(1)
    expect(clearMessages).toHaveBeenCalledTimes(1)
    expect(setAgentMode).toHaveBeenCalledWith('MAX')
    expect(setCanProcessQueue).toHaveBeenCalledWith(true)

    // setMessages was called with a function that returns []
    expect(setMessages).toHaveBeenCalledTimes(1)
    const reducer = (setMessages.mock.calls[0]?.[0] ?? (() => []))
    expect(reducer([])).toEqual([])

    // sendMessage was called with the plan + implementation prefix + empty intent
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const sendArgs = sendMessage.mock.calls[0]?.[0]
    expect(sendArgs).toBeDefined()
    expect(sendArgs.agentMode).toBe('MAX')
    expect(sendArgs.userIntent).toBe('')
    expect(sendArgs.content).toContain(CLEAR_AND_IMPLEMENT_IMPLEMENTATION_PREFIX)
    expect(sendArgs.content).toContain('do A then B')
  })

  test('does NOT re-arm the auto-goal latch (Bug 2 fix)', () => {
    useChatStore.setState((state) => {
      state.messages = [
        buildMessage('m1', [{ type: 'plan', content: 'plan content' }]),
      ]
    })

    // Pretend a goal was already auto-created in the original session.
    useGoalStore.getState().createGoal({
      objective: 'original user intent',
      autoCreated: true,
    })
    expect(useGoalStore.getState().hasAttemptedAutoCreate).toBe(true)

    executeClearAndImplement({
      mode: 'LITE',
      setAgentMode: mock(),
      setMessages: mock(),
      clearMessages: mock(),
      stopStreaming: mock(),
      setCanProcessQueue: mock(),
      sendMessage: mock(),
    })

    // Critical invariant: the latch must remain set so the implementation
    // prefix doesn't become a new auto-goal.
    expect(useGoalStore.getState().hasAttemptedAutoCreate).toBe(true)
    expect(useGoalStore.getState().currentGoal?.objective).toBe(
      'original user intent',
    )
  })

  test('marks sendMessage with userIntent: "" to suppress auto-goal seeding', () => {
    useChatStore.setState((state) => {
      state.messages = [
        buildMessage('m1', [{ type: 'plan', content: 'plan' }]),
      ]
    })

    const sendMessage = mock()
    executeClearAndImplement({
      mode: 'DEFAULT',
      setAgentMode: mock(),
      setMessages: mock(),
      clearMessages: mock(),
      stopStreaming: mock(),
      setCanProcessQueue: mock(),
      sendMessage,
    })
    expect(sendMessage.mock.calls[0]?.[0]?.userIntent).toBe('')
  })

  test('uses the implementation-prefix sentinel symmetry', () => {
    // Sanity: agent-side prompts use CLEAR_AND_IMPLEMENT_PROMPT_PREFIX;
    // implementation-side seed message uses CLEAR_AND_IMPLEMENT_IMPLEMENTATION_PREFIX.
    // They must be distinct so the agent doesn't conflate them.
    expect(CLEAR_AND_IMPLEMENT_PROMPT_PREFIX).not.toContain(
      CLEAR_AND_IMPLEMENT_IMPLEMENTATION_PREFIX,
    )
    expect(CLEAR_AND_IMPLEMENT_IMPLEMENTATION_PREFIX).not.toContain(
      CLEAR_AND_IMPLEMENT_PROMPT_PREFIX,
    )
  })
})
