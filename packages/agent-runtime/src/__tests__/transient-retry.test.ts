import * as analytics from '@codebuff/common/analytics'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import { clearMockedModules } from '@codebuff/common/testing/mock-modules'
import { setupDbSpies } from '@codebuff/common/testing/mocks/database'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { promptSuccess } from '@codebuff/common/util/error'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import db from '@codebuff/internal/db'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import { loopAgentSteps } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import { createToolCallChunk, mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { DbSpies } from '@codebuff/common/testing/mocks/database'
import type { AgentState } from '@codebuff/common/types/session-state'

describe('loopAgentSteps - transient timeout retry', () => {
  let mockTemplate: AgentTemplate
  let mockAgentState: AgentState
  let agentRuntimeImpl: Omit<
    ReturnType<typeof createTestAgentRuntimeParams>,
    'agentTemplate' | 'localAgentTemplates'
  > & {
    promptAiSdkStream?: ReturnType<typeof mock>
  }
  let loopAgentStepsBaseParams: Parameters<typeof loopAgentSteps>[0]
  let dbSpies: DbSpies

  beforeEach(() => {
    process.env.CODEBUFF_AGENT_STEP_MAX_RETRIES = '5'

    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()

    agentRuntimeImpl = { ...baseRuntimeParams }
    dbSpies = setupDbSpies(db)

    spyOn(analytics, 'trackEvent').mockImplementation(() => {})
    spyOn(crypto, 'randomUUID').mockImplementation(
      () => 'mock-uuid-0000-0000-0000-000000000000' as const,
    )

    mockTemplate = {
      id: 'test-agent',
      displayName: 'Test Agent',
      spawnerPrompt: 'Testing',
      model: 'claude-3-5-sonnet-20241022',
      inputSchema: {},
      outputMode: 'structured_output',
      includeMessageHistory: true,
      inheritParentSystemPrompt: false,
      mcpServers: {},
      toolNames: ['end_turn'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test user prompt',
      stepPrompt: 'Test agent step prompt',
      handleSteps: undefined,
    } satisfies AgentTemplate as AgentTemplate

    const sessionState = getInitialSessionState(mockFileContext)
    mockAgentState = {
      ...sessionState.mainAgentState,
      agentId: 'test-agent-id',
      messageHistory: [
        userMessage('Initial'),
        assistantMessage('Response'),
      ],
      output: undefined,
      stepsRemaining: 10,
    }

    loopAgentStepsBaseParams = {
      ...agentRuntimeImpl,
      agentType: 'test-agent',
      localAgentTemplates: { 'test-agent': mockTemplate },
      repoId: undefined,
      repoUrl: undefined,
      userInputId: 'test-user-input',
      agentState: mockAgentState,
      prompt: 'Test prompt',
      spawnParams: undefined,
      fingerprintId: 'test-fingerprint',
      fileContext: mockFileContext,
      userId: TEST_USER_ID,
      clientSessionId: 'test-session',
      ancestorRunIds: [],
      onResponseChunk: () => {},
      signal: new AbortController().signal,
    }
  })

  afterEach(() => {
    clearAgentGeneratorCache(agentRuntimeImpl)
    dbSpies.restore()
    mock.restore()
    delete process.env.CODEBUFF_AGENT_STEP_MAX_RETRIES
  })

  afterAll(() => {
    clearMockedModules()
  })

  it('retries a step after a transient "The operation timed out." error and succeeds', async () => {
    let calls = 0
    loopAgentStepsBaseParams.promptAiSdkStream = mock(async function* () {
      calls++
      if (calls === 1) {
        throw new Error('The operation timed out.')
      }
      yield { type: 'text' as const, text: 'recovered\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('msg-id')
    })

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates: { 'test-agent': mockTemplate },
    })

    expect(calls).toBeGreaterThanOrEqual(2)
    expect(result.output.type).not.toBe('error')
  }, 30_000)

  it('retries on ECONNRESET network blip', async () => {
    let calls = 0
    loopAgentStepsBaseParams.promptAiSdkStream = mock(async function* () {
      calls++
      if (calls === 1) {
        const err = new Error('socket hang up')
        ;(err as any).code = 'ECONNRESET'
        throw err
      }
      yield { type: 'text' as const, text: 'ok\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('msg-id')
    })

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates: { 'test-agent': mockTemplate },
    })

    expect(calls).toBeGreaterThanOrEqual(2)
    expect(result.output.type).not.toBe('error')
  }, 30_000)

  it('does NOT retry on a 402 payment-required error', async () => {
    let calls = 0
    loopAgentStepsBaseParams.promptAiSdkStream = mock(async function* () {
      calls++
      const err = new Error('Payment required') as Error & {
        statusCode?: number
      }
      err.statusCode = 402
      throw err
    })

    try {
      await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates: { 'test-agent': mockTemplate },
      })
    } catch {
      // 402 propagates per documented behavior; that's fine.
    }

    expect(calls).toBe(1)
  })

  it('retries on a 503 backend gateway error', async () => {
    let calls = 0
    loopAgentStepsBaseParams.promptAiSdkStream = mock(async function* () {
      calls++
      if (calls === 1) {
        const err = new Error('Service Unavailable') as Error & {
          statusCode?: number
        }
        err.statusCode = 503
        throw err
      }
      yield { type: 'text' as const, text: 'ok\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('msg-id')
    })

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates: { 'test-agent': mockTemplate },
    })

    expect(calls).toBeGreaterThanOrEqual(2)
    expect(result.output.type).not.toBe('error')
  }, 30_000)
})
