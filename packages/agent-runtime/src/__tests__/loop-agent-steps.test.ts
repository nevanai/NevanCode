import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import * as analytics from '@codebuff/common/analytics'
import { TEST_USER_ID } from '@codebuff/common/old-constants'
import { createTestAgentRuntimeParams } from '@codebuff/common/testing/fixtures/agent-runtime'
import { clearMockedModules } from '@codebuff/common/testing/mock-modules'
import { setupDbSpies } from '@codebuff/common/testing/mocks/database'
import { getInitialSessionState } from '@codebuff/common/types/session-state'
import { AbortError, promptSuccess } from '@codebuff/common/util/error'
import { assistantMessage, userMessage } from '@codebuff/common/util/messages'
import db from '@codebuff/internal/db'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { APICallError, RetryError } from 'ai'
import { z } from 'zod/v4'

import { loopAgentSteps } from '../run-agent-step'
import { clearAgentGeneratorCache } from '../run-programmatic-step'
import { createToolCallChunk, mockFileContext } from './test-utils'

import type { AgentTemplate } from '../templates/types'
import type { DbSpies } from '@codebuff/common/testing/mocks/database'
import type { StepGenerator } from '@codebuff/common/types/agent-template'
import type { AgentState } from '@codebuff/common/types/session-state'

describe('loopAgentSteps - runAgentStep vs runProgrammaticStep behavior', () => {
  let mockTemplate: AgentTemplate
  let mockAgentState: AgentState
  let llmCallCount: number
  let agentRuntimeImpl: Omit<
    ReturnType<typeof createTestAgentRuntimeParams>,
    'agentTemplate' | 'localAgentTemplates'
  > & {
    promptAiSdkStream?: ReturnType<typeof mock>
  }
  let loopAgentStepsBaseParams: Parameters<typeof loopAgentSteps>[0]
  let dbSpies: DbSpies

  beforeAll(async () => {
    // Set up mocks.
  })

  beforeEach(() => {
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()

    agentRuntimeImpl = {
      ...baseRuntimeParams,
    }

    llmCallCount = 0

    // Setup spies for database operations using typed helper
    dbSpies = setupDbSpies(db)

    agentRuntimeImpl.promptAiSdkStream = mock(async function* ({}) {
      llmCallCount++
      yield { type: 'text' as const, text: 'LLM response\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    })

    // Mock analytics
    spyOn(analytics, 'trackEvent').mockImplementation(() => {})

    // Mock crypto.randomUUID
    spyOn(crypto, 'randomUUID').mockImplementation(
      () => 'mock-uuid-0000-0000-0000-000000000000' as const,
    )

    // Create mock template with programmatic agent
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
      toolNames: ['read_files', 'write_file', 'end_turn'],
      spawnableAgents: [],
      systemPrompt: 'Test system prompt',
      instructionsPrompt: 'Test user prompt',
      stepPrompt: 'Test agent step prompt',
      handleSteps: undefined, // Will be set in individual tests
    } satisfies AgentTemplate as AgentTemplate

    // Create mock agent state
    const sessionState = getInitialSessionState(mockFileContext)
    mockAgentState = {
      ...sessionState.mainAgentState,
      agentId: 'test-agent-id',
      messageHistory: [
        userMessage('Initial message'),
        assistantMessage('Initial response'),
      ],
      output: undefined,
      stepsRemaining: 10, // Ensure we don't hit the limit
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
    const {
      agentTemplate: _,
      localAgentTemplates: __,
      ...baseRuntimeParams
    } = createTestAgentRuntimeParams()
    agentRuntimeImpl = {
      ...baseRuntimeParams,
    }
  })

  afterAll(() => {
    clearMockedModules()
  })

  it('should verify correct STEP behavior - LLM called once after STEP', async () => {
    // This test verifies that when a programmatic agent yields STEP,
    // the LLM should be called once in the next iteration

    let stepCount = 0
    const mockGeneratorFunction = function* () {
      stepCount++
      // Execute a tool, then STEP
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield 'STEP' // Should pause here and let LLM run
      // Continue after LLM runs (this won't be reached in this test since LLM ends turn)
      yield {
        toolName: 'write_file',
        input: { path: 'output.txt', content: 'test' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    console.log(`LLM calls made: ${llmCallCount}`)
    console.log(`Step count: ${stepCount}`)

    // CORRECT BEHAVIOR: After STEP, LLM should be called once
    // The programmatic agent yields STEP, then LLM runs once and ends turn
    expect(llmCallCount).toBe(1) // LLM called once after STEP

    // The programmatic agent should have been called once (yielded STEP)
    expect(stepCount).toBe(1)
  })

  it('should demonstrate correct behavior when programmatic agent completes without STEP', async () => {
    // This test shows that when a programmatic agent doesn't yield STEP,
    // it should complete without calling the LLM at all (since it ends with end_turn)

    const mockGeneratorFunction = function* () {
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield {
        toolName: 'write_file',
        input: { path: 'output.txt', content: 'test' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should NOT call LLM since the programmatic agent ended with end_turn
    expect(llmCallCount).toBe(0)
    // The result should have agentState
    expect(result.agentState).toBeDefined()
  })

  it('should run programmatic step first, then LLM step, then continue', async () => {
    // This test verifies the correct execution order in loopAgentSteps:
    // 1. Programmatic step runs first and yields STEP
    // 2. LLM step runs once
    // 3. Loop continues but generator is complete after first STEP

    let stepCount = 0
    const mockGeneratorFunction = function* () {
      stepCount++
      // First execution: do some work, then STEP
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield 'STEP' // Hand control to LLM
      // After LLM runs, continue (this happens in the same generator instance)
      yield {
        toolName: 'write_file',
        input: { path: 'output.txt', content: 'updated by LLM' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Verify execution order:
    // 1. Programmatic step function was called once (creates generator)
    // 2. LLM was called once after STEP
    // 3. Generator continued after LLM step
    expect(stepCount).toBe(1) // Generator function called once
    expect(llmCallCount).toBe(1) // LLM called once after first STEP
    expect(result.agentState).toBeDefined()
  })

  it('should handle programmatic agent that yields STEP_ALL', async () => {
    // Test STEP_ALL behavior - should run LLM then continue with programmatic step

    let stepCount = 0
    const mockGeneratorFunction = function* () {
      stepCount++
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      yield 'STEP_ALL' // Hand all remaining control to LLM
      // Should continue after LLM completes all its steps
      yield {
        toolName: 'write_file',
        input: { path: 'final.txt', content: 'done' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(stepCount).toBe(1) // Generator function called once
    expect(llmCallCount).toBe(1) // LLM should be called once
    expect(result.agentState).toBeDefined()
  })

  it('should not call LLM when programmatic agent returns without STEP', async () => {
    // Test that programmatic agents that don't yield STEP don't trigger LLM

    const mockGeneratorFunction = function* () {
      yield { toolName: 'read_files', input: { paths: ['test.txt'] } }
      yield {
        toolName: 'write_file',
        input: { path: 'result.txt', content: 'processed' },
      }
      // No STEP - agent completes without LLM involvement
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(llmCallCount).toBe(0) // No LLM calls should be made
    expect(result.agentState).toBeDefined()
  })

  it('should handle LLM-only agent (no handleSteps)', async () => {
    // Test traditional LLM-based agents that don't have handleSteps

    const llmOnlyTemplate = {
      ...mockTemplate,
      handleSteps: undefined, // No programmatic step function
    }

    const localAgentTemplates = {
      'test-agent': llmOnlyTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(llmCallCount).toBe(1) // LLM should be called once
    expect(result.agentState).toBeDefined()
  })

  it('should handle programmatic agent error and still call LLM', async () => {
    // Test error handling in programmatic step - should still allow LLM to run

    const mockGeneratorFunction = function* () {
      yield { toolName: 'read_files', input: { paths: ['file1.txt'] } }
      throw new Error('Programmatic step failed')
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // After programmatic step error, should end turn and not call LLM
    expect(llmCallCount).toBe(0)
    expect(result.agentState).toBeDefined()
    expect(result.agentState.output?.error).toContain(
      'Error executing handleSteps for agent test-agent',
    )
  })

  it('should handle mixed execution with multiple STEP yields', async () => {
    // Test complex scenario with multiple STEP yields and LLM interactions
    // Note: In current implementation, LLM typically ends turn after running,
    // so this tests the first STEP interaction

    let stepCount = 0
    const mockGeneratorFunction = function* () {
      stepCount++
      yield { toolName: 'read_files', input: { paths: ['input.txt'] } }
      yield 'STEP' // First LLM interaction
      yield {
        toolName: 'write_file',
        input: { path: 'temp.txt', content: 'intermediate' },
      }
      yield {
        toolName: 'write_file',
        input: { path: 'final.txt', content: 'complete' },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(stepCount).toBe(1) // Generator function called once
    expect(llmCallCount).toBe(1) // LLM called once after STEP
    expect(result.agentState).toBeDefined()
  })

  it('should pass shouldEndTurn: true as stepsComplete when end_turn tool is called', async () => {
    // Test that when LLM calls end_turn, shouldEndTurn (stepsComplete) is correctly passed
    // to the handleSteps generator via the step result.
    //
    // Flow:
    // 1. Generator yields 'STEP', runProgrammaticStep returns
    // 2. loopAgentSteps calls runAgentStep (LLM), which calls end_turn -> shouldEndTurn = true
    // 3. loopAgentSteps calls runProgrammaticStep again with stepsComplete: true
    // 4. Generator resumes from yield 'STEP' and receives { stepsComplete: true }

    let stepsCompleteValues: boolean[] = []

    const mockGeneratorFunction = function* () {
      // First STEP - after LLM runs and calls end_turn, we receive stepsComplete: true
      const result1 = yield 'STEP'
      stepsCompleteValues.push(result1.stepsComplete)

      // Since stepsComplete was true, we should end gracefully
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Verify that stepsComplete was passed correctly:
    // After yielding STEP and LLM running (which calls end_turn),
    // the generator receives stepsComplete: true
    expect(stepsCompleteValues).toHaveLength(1)
    expect(stepsCompleteValues[0]).toBe(true)
  })

  it('should continue loop when handleSteps returns endTurn: false even if LLM calls end_turn', async () => {
    // Test that handleSteps endTurn: false takes precedence over LLM end_turn tool call

    let programmaticStepCount = 0
    let llmStepCount = 0

    const mockGeneratorFunction = function* () {
      // First iteration: return endTurn: false
      programmaticStepCount++
      yield 'STEP'

      // Second iteration: also return endTurn: false
      programmaticStepCount++
      yield 'STEP'

      // Third iteration: finally return endTurn: true to end the loop
      programmaticStepCount++
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    // Mock LLM to always call end_turn, but handleSteps should override it
    let promptCallCount = 0
    loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
      promptCallCount++
      llmStepCount++

      // LLM always tries to end turn
      yield { type: 'text' as const, text: 'LLM response\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess(`mock-message-id-${promptCallCount}`)
    }

    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Verify handleSteps ran 3 times (yielded STEP twice, then end_turn)
    expect(programmaticStepCount).toBe(3)

    // Verify LLM was called 2 times (once per STEP yield)
    expect(llmStepCount).toBe(2)

    // This confirms that even though LLM called end_turn every time,
    // the loop continued because handleSteps kept yielding STEP before finally ending
  })

  it('should restart loop when agent finishes without setting required output', async () => {
    // Test that when an agent has outputSchema but finishes without calling set_output,
    // the loop restarts with a system message

    const outputSchema = z.object({
      result: z.string(),
      status: z.string(),
    })

    const templateWithOutputSchema = {
      ...mockTemplate,
      outputSchema,
      toolNames: ['set_output', 'end_turn'], // Add set_output to available tools
      handleSteps: undefined, // LLM-only agent
    }

    const localAgentTemplates = {
      'test-agent': templateWithOutputSchema,
    }

    let llmCallNumber = 0
    let capturedAgentState: AgentState | null = null

    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({}) {
      llmCallNumber++
      if (llmCallNumber === 1) {
        // First call: agent tries to end turn without setting output
        yield {
          type: 'text' as const,
          text: 'First response without output\n\n',
        }
        yield createToolCallChunk('end_turn', {})
      } else if (llmCallNumber === 2) {
        // Second call: agent sets output after being reminded
        // Manually set the output to simulate the set_output tool execution
        if (capturedAgentState) {
          capturedAgentState.output = {
            result: 'test result',
            status: 'success',
          }
        }
        yield { type: 'text' as const, text: 'Setting output now\n\n' }
        yield createToolCallChunk('set_output', {
          result: 'test result',
          status: 'success',
        })
        yield { type: 'text' as const, text: '\n\n' }
        yield createToolCallChunk('end_turn', {})
      } else {
        // Safety: if called more than twice, just end
        yield { type: 'text' as const, text: 'Ending\n\n' }
        yield createToolCallChunk('end_turn', {})
      }
      return promptSuccess('mock-message-id')
    }

    mockAgentState.output = undefined
    capturedAgentState = mockAgentState

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should call LLM twice: once to try ending without output, once after reminder
    expect(llmCallNumber).toBe(2)

    // Should have output set after the second attempt
    expect(result.agentState.output).toEqual({
      result: 'test result',
      status: 'success',
    })

    // Check that a system message was added to message history
    const systemMessages = result.agentState.messageHistory.filter(
      (msg) =>
        msg.role === 'user' &&
        msg.content[0].type === 'text' &&
        msg.content[0].text.includes('set_output'),
    )
    expect(systemMessages.length).toBeGreaterThan(0)
  })

  it('should not restart loop if output is set correctly', async () => {
    // Test that when an agent has outputSchema and sets output correctly,
    // the loop ends normally without restarting

    const outputSchema = z.object({
      result: z.string(),
    })

    const templateWithOutputSchema = {
      ...mockTemplate,
      outputSchema,
      toolNames: ['set_output', 'end_turn'],
      handleSteps: undefined,
    }

    const localAgentTemplates = {
      'test-agent': templateWithOutputSchema,
    }

    let llmCallNumber = 0
    let capturedAgentState: AgentState | null = null

    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({}) {
      llmCallNumber++
      // Agent sets output correctly on first call
      if (capturedAgentState) {
        capturedAgentState.output = { result: 'success' }
      }
      yield { type: 'text' as const, text: 'Setting output\n\n' }
      yield createToolCallChunk('set_output', { result: 'success' })
      yield { type: 'text' as const, text: '\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    }

    mockAgentState.output = undefined
    capturedAgentState = mockAgentState

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should only call LLM once since output was set correctly
    expect(llmCallNumber).toBe(1)

    // Should have output set
    expect(result.agentState.output).toEqual({ result: 'success' })
  })

  it('should pass generateN from programmatic step to runAgentStep as n parameter', async () => {
    // Test that when programmatic step returns generateN, it's passed to runAgentStep

    let agentStepN: number | undefined

    const mockGeneratorFunction = function* () {
      // Yield GENERATE_N to trigger n parameter
      yield { type: 'GENERATE_N', n: 5 }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    // Mock promptAiSdk to capture the n parameter
    loopAgentStepsBaseParams.promptAiSdk = async (params: any) => {
      agentStepN = params.n
      return promptSuccess(
        JSON.stringify([
          'Response 1',
          'Response 2',
          'Response 3',
          'Response 4',
          'Response 5',
        ]),
      )
    }

    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Verify generateN was passed to runAgentStep as n
    expect(agentStepN).toBe(5)
  })

  it('should pass nResponses from runAgentStep back to programmatic step', async () => {
    // Test that nResponses returned by runAgentStep are passed to next programmatic step

    let receivedNResponses: string[] | undefined

    const mockGeneratorFunction = function* () {
      const { nResponses } = yield { type: 'GENERATE_N', n: 3 }
      receivedNResponses = nResponses
      const step = yield {
        toolName: 'read_files',
        input: { paths: ['test.txt'] },
      }
      yield { toolName: 'end_turn', input: {} }
    } as () => StepGenerator

    mockTemplate.handleSteps = mockGeneratorFunction

    const localAgentTemplates = {
      'test-agent': mockTemplate,
    }

    const expectedResponses = [
      'Implementation A',
      'Implementation B',
      'Implementation C',
    ]
    loopAgentStepsBaseParams.promptAiSdk = async () => {
      return promptSuccess(JSON.stringify(expectedResponses))
    }

    await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    expect(receivedNResponses).toEqual(expectedResponses)
  })

  it('should allow agents without outputSchema to end normally', async () => {
    // Test that agents without outputSchema can end without setting output

    const templateWithoutOutputSchema = {
      ...mockTemplate,
      outputSchema: undefined,
      handleSteps: undefined,
    }

    const localAgentTemplates = {
      'test-agent': templateWithoutOutputSchema,
    }

    let llmCallNumber = 0
    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({}) {
      llmCallNumber++
      yield { type: 'text' as const, text: 'Response without output\n\n' }
      yield createToolCallChunk('end_turn', {})
      return promptSuccess('mock-message-id')
    }

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should only call LLM once and end normally
    expect(llmCallNumber).toBe(1)

    // Output should be undefined since no outputSchema required
    expect(result.agentState.output).toBeUndefined()
  })

  it('should continue loop if agent does not end turn (has more work)', async () => {
    // Test that validation only triggers when shouldEndTurn is true

    const outputSchema = z.object({
      result: z.string(),
    })

    const templateWithOutputSchema = {
      ...mockTemplate,
      outputSchema,
      toolNames: ['read_files', 'set_output', 'end_turn'],
      handleSteps: undefined,
    }

    const localAgentTemplates = {
      'test-agent': templateWithOutputSchema,
    }

    let llmCallNumber = 0
    let capturedAgentState: AgentState | null = null

    loopAgentStepsBaseParams.promptAiSdkStream = async function* ({}) {
      llmCallNumber++
      if (llmCallNumber === 1) {
        // First call: agent does some work but doesn't end turn
        yield { type: 'text' as const, text: 'Doing work\n\n' }
        yield createToolCallChunk('read_files', { paths: ['test.txt'] })
      } else {
        // Second call: agent sets output and ends
        if (capturedAgentState) {
          capturedAgentState.output = { result: 'done' }
        }
        yield { type: 'text' as const, text: 'Finishing\n\n' }
        yield createToolCallChunk('set_output', { result: 'done' })
        yield { type: 'text' as const, text: '\n\n' }
        yield createToolCallChunk('end_turn', {})
      }
      return promptSuccess('mock-message-id')
    }

    mockAgentState.output = undefined
    capturedAgentState = mockAgentState

    const result = await loopAgentSteps({
      ...loopAgentStepsBaseParams,
      agentType: 'test-agent',
      localAgentTemplates,
    })

    // Should call LLM twice: once for work, once to set output and end
    expect(llmCallNumber).toBe(2)

    // Should have output set
    expect(result.agentState.output).toEqual({ result: 'done' })
  })

  describe('abort handling', () => {
    it('should handle AbortError and finish with cancelled status', async () => {
      // Test that when an AbortError is thrown (e.g., from a tool handler),
      // loopAgentSteps catches it, finishes with 'cancelled' status, and returns
      // an error output indicating the run was cancelled.

      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Track finishAgentRun calls
      let finishAgentRunStatus: string | undefined
      const mockFinishAgentRun = mock(async (params: { status: string }) => {
        finishAgentRunStatus = params.status
      })

      // Mock promptAiSdkStream to throw an AbortError (simulating user cancellation mid-stream)
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        // Yield some content first
        yield { type: 'text' as const, text: 'Starting work...\n' }
        // Then throw AbortError to simulate user cancellation
        throw new AbortError('User pressed Ctrl+C')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        finishAgentRun: mockFinishAgentRun,
      })

      // Verify the output indicates cancellation
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toBe('Run cancelled by user')
      }

      // Verify finishAgentRun was called with 'cancelled' status
      expect(mockFinishAgentRun).toHaveBeenCalled()
      expect(finishAgentRunStatus).toBe('cancelled')
    })

    it('should distinguish AbortError from other errors', async () => {
      // Test that non-abort errors are NOT treated as cancellations

      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Track finishAgentRun calls
      let finishAgentRunStatus: string | undefined
      const mockFinishAgentRun = mock(async (params: { status: string }) => {
        finishAgentRunStatus = params.status
      })

      // Mock promptAiSdkStream to throw a regular error (not AbortError)
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        yield { type: 'text' as const, text: 'Starting...\n' }
        throw new Error('Network connection failed')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        finishAgentRun: mockFinishAgentRun,
      })

      // Verify the output indicates an error (not cancellation)
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toContain('Network connection failed')
        expect(result.output.message).not.toBe('Run cancelled by user')
      }

      // Verify finishAgentRun was called with 'failed' status (not 'cancelled')
      expect(mockFinishAgentRun).toHaveBeenCalled()
      expect(finishAgentRunStatus).toBe('failed')
    })

    it('should handle signal.aborted before loop starts', async () => {
      // Test that if signal is already aborted when loopAgentSteps is called,
      // it returns immediately with a cancelled message

      const abortController = new AbortController()
      abortController.abort() // Abort immediately

      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
        signal: abortController.signal,
      })

      // Verify the output indicates cancellation
      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toBe('Run cancelled by user')
      }

      // LLM should not have been called since we aborted before starting
      expect(llmCallCount).toBe(0)
    })
  })

  describe('API error handling', () => {
    it('should propagate error code and server message from 403 APICallError responseBody', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Mock promptAiSdkStream to throw an APICallError with a 403 status
      // and a responseBody containing the server's structured error
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        throw new APICallError({
          statusCode: 403,
          message: 'Forbidden',
          url: 'https://api.codebuff.com/v1/chat/completions',
          requestBodyValues: {},
          responseBody: JSON.stringify({
            error: 'free_mode_unavailable',
            message: 'Free mode is not available in your country.',
            countryCode: 'US',
            countryBlockReason: 'anonymous_network',
            ipPrivacySignals: ['vpn', 'hosting'],
          }),
          isRetryable: false,
        })
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        // Should use the server's message, NOT the generic "Forbidden"
        expect(result.output.message).toBe(
          'Free mode is not available in your country.',
        )
        // Should NOT have the 'Agent run error: ' prefix since message came from responseBody
        expect(result.output.message).not.toContain('Agent run error:')
        // Should propagate the error code so the CLI can match on it
        expect(result.output.error).toBe('free_mode_unavailable')
        // Should propagate the status code
        expect(result.output.statusCode).toBe(403)
        expect(result.output.countryCode).toBe('US')
        expect(result.output.countryBlockReason).toBe('anonymous_network')
        expect(result.output.ipPrivacySignals).toEqual(['vpn', 'hosting'])
      }
    })

    it('should prefix with "Agent run error:" when responseBody has no parseable message', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // APICallError with no responseBody
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        throw new APICallError({
          statusCode: 500,
          message: 'Internal Server Error',
          url: 'https://api.codebuff.com/v1/chat/completions',
          requestBodyValues: {},
          responseBody: undefined,
          isRetryable: true,
        })
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        // Should have the prefix since there's no server message
        expect(result.output.message).toContain('Agent run error:')
        expect(result.output.message).toContain('Internal Server Error')
        // No error code since responseBody wasn't parseable
        expect(result.output.error).toBeUndefined()
      }
    })

    it('should unwrap retry errors to propagate underlying 409 gate errors', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      const apiError = new APICallError({
        statusCode: 409,
        message: 'Conflict',
        url: 'https://api.codebuff.com/v1/chat/completions',
        requestBodyValues: {},
        responseBody: JSON.stringify({
          error: 'session_superseded',
          message:
            'Another instance of freebuff has taken over this session. Only one instance per account is allowed.',
        }),
        isRetryable: true,
      })

      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        throw new RetryError({
          message: 'Failed after 4 attempts. Last error: Conflict',
          reason: 'maxRetriesExceeded',
          errors: [apiError],
        })
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toBe(
          'Another instance of freebuff has taken over this session. Only one instance per account is allowed.',
        )
        expect(result.output.message).not.toContain('Agent run error:')
        expect(result.output.error).toBe('session_superseded')
        expect(result.output.statusCode).toBe(409)
      }
    })

    it('should surface "usage: your usage rate limit" when provider returns 429', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        throw new APICallError({
          statusCode: 429,
          message: 'Too Many Requests',
          url: 'https://api.example.com/v1/chat/completions',
          requestBodyValues: {},
          responseBody: undefined,
          isRetryable: true,
        })
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        expect(result.output.message).toBe('usage: your usage rate limit')
        expect(result.output.message).not.toContain('Agent run error:')
        expect(result.output.statusCode).toBe(429)
      }
    })

    it('should surface "usage: your usage rate limit" (no stack) when the socket connection is closed', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        throw new Error('The socket connection was closed unexpectedly.')
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates,
      })

      expect(result.output.type).toBe('error')
      if (result.output.type === 'error') {
        // The raw stack trace and "Agent run error:" prefix must be gone.
        expect(result.output.message).toBe('usage: your usage rate limit')
        expect(result.output.message).not.toContain('Agent run error:')
        expect(result.output.message).not.toContain('at async')
      }
    })

    it('should surface the actual error message for Bun "Unable to connect" fetch errors (not a rate limit)', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }

      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        throw new Error(
          'Unable to connect. Is the computer able to access the url?',
        )
      }

      // This test is about error-message correctness, not the transient-retry
      // backoff. "Unable to connect" is classified transient, so with the
      // default retry budget it would retry ~8x over ~90s before surfacing.
      // Disable retries here so we assert the surfacing logic directly and fast.
      const prevMaxRetries = process.env.CODEBUFF_AGENT_STEP_MAX_RETRIES
      process.env.CODEBUFF_AGENT_STEP_MAX_RETRIES = '0'
      try {
        const result = await loopAgentSteps({
          ...loopAgentStepsBaseParams,
          agentType: 'test-agent',
          localAgentTemplates,
        })

        expect(result.output.type).toBe('error')
        if (result.output.type === 'error') {
          // Should show the actual error, not falsely claim rate limit
          expect(result.output.message).toContain('Unable to connect')
          expect(result.output.message).not.toContain('usage: your usage rate limit')
        }
      } finally {
        if (prevMaxRetries === undefined)
          delete process.env.CODEBUFF_AGENT_STEP_MAX_RETRIES
        else process.env.CODEBUFF_AGENT_STEP_MAX_RETRIES = prevMaxRetries
      }
    })

    it('retries transient errors and surfaces a visible retry notice (never a silent stall)', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }
      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // Fail once with a transient error, then succeed — verifies the retry
      // path emits a user-visible chunk so the wait is never a silent "working".
      let attempts = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        attempts++
        if (attempts === 1) {
          throw new Error('fetch failed: socket hang up')
        }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('mock-message-id')
      }

      const chunks: Array<string> = []
      const prevMaxRetries = process.env.CODEBUFF_AGENT_STEP_MAX_RETRIES
      // Keep the backoff tiny so the test stays fast.
      process.env.CODEBUFF_AGENT_STEP_MAX_RETRIES = '3'
      try {
        await loopAgentSteps({
          ...loopAgentStepsBaseParams,
          agentType: 'test-agent',
          localAgentTemplates,
          onResponseChunk: (chunk: string | object) => {
            if (typeof chunk === 'string') chunks.push(chunk)
          },
        })
      } finally {
        if (prevMaxRetries === undefined)
          delete process.env.CODEBUFF_AGENT_STEP_MAX_RETRIES
        else process.env.CODEBUFF_AGENT_STEP_MAX_RETRIES = prevMaxRetries
      }

      expect(attempts).toBeGreaterThanOrEqual(2)
      expect(chunks.some((c) => c.includes('retrying'))).toBe(true)
    }, 15000)

    it('does not block the step when the token-count backend hangs (tool adds no latency)', async () => {
      const llmOnlyTemplate = {
        ...mockTemplate,
        handleSteps: undefined,
      }
      const localAgentTemplates = {
        'test-agent': llmOnlyTemplate,
      }

      // LLM responds instantly and ends the turn.
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        yield { type: 'text' as const, text: 'done\n\n' }
        yield createToolCallChunk('end_turn', {})
        return promptSuccess('mock-message-id')
      }

      // Make the token-count endpoint hang forever (dead/slow backend). Before
      // the fix this was awaited on the step's hot path (24h timeout) and the
      // whole turn would hang here with no output. Now it runs in the
      // background, so the turn must complete on LLM time alone.
      const realFetch = globalThis.fetch
      let tokenCountHit = false
      const hangFetch = mock((input: unknown, init?: { signal?: AbortSignal }) => {
        const url =
          typeof input === 'string'
            ? input
            : ((input as { url?: string })?.url ?? '')
        if (url.includes('/api/v1/token-count')) {
          tokenCountHit = true
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            )
          })
        }
        return Promise.reject(new Error(`unexpected fetch in test: ${url}`))
      })
      globalThis.fetch = hangFetch as unknown as typeof globalThis.fetch

      const ac = new AbortController()
      try {
        const start = Date.now()
        const result = await loopAgentSteps({
          ...loopAgentStepsBaseParams,
          agentType: 'test-agent',
          localAgentTemplates,
          signal: ac.signal,
        })
        const elapsed = Date.now() - start

        expect(result.output.type).not.toBe('error')
        expect(tokenCountHit).toBe(true)
        // The turn must NOT wait on the hung backend.
        expect(elapsed).toBeLessThan(2000)
      } finally {
        // Settle the lingering background request (clears its timeout) and
        // restore the real fetch.
        ac.abort()
        globalThis.fetch = realFetch
      }
    }, 10000)
  })

  describe('auto-continue guard (do not stop between phases)', () => {
    // The agent must keep going through analysis → implementation → testing
    // without the user typing "continue". A narration-only step (text, no tool
    // call) ends the turn ONLY when there is no incomplete work left.
    let todosTemplate: AgentTemplate

    beforeEach(() => {
      // write_todos persists to tasks.md via fs.writeFileSync; stub it so the
      // real repo file is never touched while exercising the handler.
      spyOn(fs, 'writeFileSync').mockImplementation(() => {})

      todosTemplate = {
        ...mockTemplate,
        toolNames: ['write_todos', 'read_files', 'end_turn'],
        handleSteps: undefined, // LLM-only: drive shouldEndTurn straight from the stream
      } satisfies AgentTemplate as AgentTemplate
    })

    const todoCall = (todos: Array<{ task: string; completed: boolean }>) =>
      createToolCallChunk('write_todos', { todos })

    it('continues past a narration-only step while todos are incomplete, then ends once they are all complete', async () => {
      let call = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        call++
        if (call === 1) {
          // Plan: two incomplete todos.
          yield { type: 'text' as const, text: 'Planning the work.\n\n' }
          yield todoCall([
            { task: 'Implement feature', completed: false },
            { task: 'Run tests', completed: false },
          ])
        } else if (call === 2) {
          // Narration only, NO tool call. Previously this ended the turn.
          yield {
            type: 'text' as const,
            text: 'سأبدأ الآن في التنفيذ.\n\n',
          }
        } else if (call === 3) {
          // Mark everything complete.
          yield { type: 'text' as const, text: 'Done implementing and testing.\n\n' }
          yield todoCall([
            { task: 'Implement feature', completed: true },
            { task: 'Run tests', completed: true },
          ])
        } else {
          // Final narration with all todos complete → should end here.
          yield {
            type: 'text' as const,
            text: '🎯 تم إكمال المهمة بالكامل.\n\n',
          }
        }
        return promptSuccess(`mock-message-id-${call}`)
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates: { 'test-agent': todosTemplate },
      })

      // The narration-only step (call 2) did NOT end the turn — the loop ran
      // all four steps and only stopped after todos were complete (call 4).
      expect(call).toBe(4)
      expect(result.agentState).toBeDefined()
    })

    it('ends after a narration-only step when all todos are already complete', async () => {
      let call = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        call++
        if (call === 1) {
          yield { type: 'text' as const, text: 'All set.\n\n' }
          yield todoCall([{ task: 'Single task', completed: true }])
        } else {
          // Narration only with no pending work → must end the turn.
          yield { type: 'text' as const, text: 'Finished.\n\n' }
        }
        return promptSuccess(`mock-message-id-${call}`)
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates: { 'test-agent': todosTemplate },
      })

      // Exactly two steps: plan, then the bare-text turn that legitimately ends.
      expect(call).toBe(2)
      expect(result.agentState).toBeDefined()
    })

    it('stops via the no-progress cap when the model only narrates without finishing todos', async () => {
      let call = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        call++
        if (call === 1) {
          yield todoCall([{ task: 'Never finished', completed: false }])
        } else {
          // Endless narration, never completing the todo and never calling a tool.
          yield {
            type: 'text' as const,
            text: `Still thinking, step ${call}.\n\n`,
          }
        }
        return promptSuccess(`mock-message-id-${call}`)
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates: { 'test-agent': todosTemplate },
      })

      // call 1: write_todos (progress, resets streak)
      // call 2: narration  (streak 1 < 3 → continue)
      // call 3: narration  (streak 2 < 3 → continue)
      // call 4: narration  (streak 3, not < 3 → end)
      // The cap stops the runaway well before the 10-step stepsRemaining limit.
      expect(call).toBe(4)
      expect(result.agentState).toBeDefined()
    })

    it('does not auto-continue an agent that never writes todos (simple Q&A ends normally)', async () => {
      const noTodoTemplate = {
        ...mockTemplate,
        toolNames: ['read_files', 'end_turn'],
        handleSteps: undefined,
      } satisfies AgentTemplate as AgentTemplate

      let call = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        call++
        // A single narration-only answer with no todos in play → ends at once.
        yield { type: 'text' as const, text: 'Here is the answer.\n\n' }
        return promptSuccess(`mock-message-id-${call}`)
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates: { 'test-agent': noTodoTemplate },
      })

      expect(call).toBe(1)
      expect(result.agentState).toBeDefined()
    })

    it('feeds the continuation back through a handleSteps generator (the real base2 path)', async () => {
      // base2 runs a `while(true){ yield 'STEP'; if(stepsComplete) break }`
      // generator. The guard must drive `stepsComplete` so the generator keeps
      // looping through a narration-only step instead of breaking early.
      const stepsCompleteSeen: boolean[] = []
      const generatorTemplate = {
        ...mockTemplate,
        toolNames: ['write_todos', 'read_files', 'end_turn'],
        handleSteps: function* () {
          while (true) {
            const { stepsComplete } = yield 'STEP'
            stepsCompleteSeen.push(stepsComplete)
            if (stepsComplete) break
          }
        } as () => StepGenerator,
      } satisfies AgentTemplate as AgentTemplate

      let call = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        call++
        if (call === 1) {
          yield todoCall([{ task: 'Build it', completed: false }])
        } else if (call === 2) {
          yield { type: 'text' as const, text: 'سأكمل الآن.\n\n' } // narration only
        } else if (call === 3) {
          yield todoCall([{ task: 'Build it', completed: true }])
        } else {
          yield { type: 'text' as const, text: '🎯 خلصت.\n\n' } // final, todos complete
        }
        return promptSuccess(`mock-message-id-${call}`)
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates: { 'test-agent': generatorTemplate },
      })

      // The narration step (call 2) was reported to the generator as NOT
      // complete, so it kept looping; only the final all-todos-complete step
      // ended it.
      expect(call).toBe(4)
      expect(stepsCompleteSeen.filter((c) => c === true).length).toBe(1)
      expect(stepsCompleteSeen[stepsCompleteSeen.length - 1]).toBe(true)
      expect(result.agentState).toBeDefined()
    })

    it('continues past the FIRST phase announcement, before any todos exist', async () => {
      // The user's first symptom: the model says "راح أبدأ بالتحليل" and stops
      // BEFORE writing a todo list. latestTodos is still undefined here, so the
      // incomplete-todos signal cannot catch it — the forward-intent narration
      // must keep the turn going until the plan (write_todos) appears.
      let call = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        call++
        if (call === 1) {
          // Forward-looking announcement, NO tool call, NO todos yet.
          yield { type: 'text' as const, text: 'سأبدأ بالتحليل الآن.\n\n' }
        } else if (call === 2) {
          yield todoCall([{ task: 'Do the work', completed: false }])
        } else if (call === 3) {
          yield todoCall([{ task: 'Do the work', completed: true }])
        } else {
          yield { type: 'text' as const, text: '🎯 تم.\n\n' }
        }
        return promptSuccess(`mock-message-id-${call}`)
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates: { 'test-agent': todosTemplate },
      })

      // Did NOT end at call 1: the loop pushed on to write the plan and finish.
      expect(call).toBe(4)
      expect(result.agentState).toBeDefined()
    })

    it('does NOT continue a conclusive answer that has no todos (no over-triggering)', async () => {
      // A planning-capable agent that simply answers a question (conclusive,
      // no forward intent, no todos) must still end at once — the forward-intent
      // discriminator must not fire on ordinary answers.
      let call = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        call++
        yield {
          type: 'text' as const,
          text: 'هذا الكود يقوم بمعالجة المدخلات ويعيد النتيجة.\n\n',
        }
        return promptSuccess(`mock-message-id-${call}`)
      }

      const result = await loopAgentSteps({
        ...loopAgentStepsBaseParams,
        agentType: 'test-agent',
        localAgentTemplates: { 'test-agent': todosTemplate },
      })

      expect(call).toBe(1)
      expect(result.agentState).toBeDefined()
    })

    it('stops via the total-auto-continue cap when tool work keeps resetting the no-progress streak', async () => {
      // The reset-on-progress hole: a model that ALTERNATES a real tool call
      // with a narration-only stop never lets consecutiveNoProgressSteps reach
      // its cap (it resets every other step), so the streak guard alone would
      // nudge it onward until the 200-step limit. The streak-independent total
      // cap must stop it. Set the cap to 2 via env.
      const prev = process.env.CODEBUFF_AGENT_MAX_AUTO_CONTINUES
      process.env.CODEBUFF_AGENT_MAX_AUTO_CONTINUES = '2'

      let call = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        call++
        if (call % 2 === 1) {
          // Odd step: real tool work with an incomplete todo (resets streak).
          yield todoCall([{ task: 'Never finished', completed: false }])
        } else {
          // Even step: narration only → would end, but todos are incomplete.
          yield { type: 'text' as const, text: `Pausing, step ${call}.\n\n` }
        }
        return promptSuccess(`mock-message-id-${call}`)
      }

      try {
        const result = await loopAgentSteps({
          ...loopAgentStepsBaseParams,
          agentType: 'test-agent',
          localAgentTemplates: { 'test-agent': todosTemplate },
          agentState: { ...mockAgentState, stepsRemaining: 100 },
        })

        // calls 2 and 4 auto-continue (total→2); call 6 narration hits the cap
        // (2, not < 2) and ends. Far below stepsRemaining(100).
        expect(call).toBe(6)
        expect(result.agentState).toBeDefined()
      } finally {
        if (prev === undefined)
          delete process.env.CODEBUFF_AGENT_MAX_AUTO_CONTINUES
        else process.env.CODEBUFF_AGENT_MAX_AUTO_CONTINUES = prev
      }
    })
  })

  describe('wall-clock turn budget (bounds runaway multi-hour turns)', () => {
    // The user's actual failure: a plan executed in MAX mode ran ~2 hours and
    // filled the context window. A tool-heavy turn keeps shouldEndTurn=false and
    // loops to the 200-step cap with no time bound. The budget must end the turn
    // at the next step boundary even while the model is still calling tools.
    beforeEach(() => {
      // write_todos persists to tasks.md via fs.writeFileSync; stub it.
      spyOn(fs, 'writeFileSync').mockImplementation(() => {})
    })

    it('ends a tool-heavy turn once the per-turn time budget is exceeded, even with the model still calling tools', async () => {
      const prev = process.env.CODEBUFF_AGENT_MAX_TURN_MS
      // 1ms budget: the first step runs, then the next boundary check trips.
      process.env.CODEBUFF_AGENT_MAX_TURN_MS = '1'

      const toolHeavyTemplate = {
        ...mockTemplate,
        toolNames: ['write_todos', 'read_files', 'end_turn'],
        handleSteps: undefined,
      } satisfies AgentTemplate as AgentTemplate

      let call = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        call++
        // Always a real tool call → shouldEndTurn stays false → would loop to
        // the step cap (100) absent a governor. The budget must break it.
        yield createToolCallChunk('write_todos', {
          todos: [{ task: 'Grind forever', completed: false }],
        })
        return promptSuccess(`mock-message-id-${call}`)
      }

      // Capture what the user actually sees so we verify the full UX contract:
      // a visible pause message, not a silent stop.
      const chunks: string[] = []
      loopAgentStepsBaseParams.onResponseChunk = (c) => {
        if (typeof c === 'string') chunks.push(c)
      }

      try {
        const result = await loopAgentSteps({
          ...loopAgentStepsBaseParams,
          agentType: 'test-agent',
          localAgentTemplates: { 'test-agent': toolHeavyTemplate },
          agentState: { ...mockAgentState, stepsRemaining: 100 },
        })

        // Without the budget this runs to stepsRemaining (100). With it, the
        // turn ends after the first boundary trip — a handful of steps at most.
        expect(call).toBeGreaterThanOrEqual(1)
        expect(call).toBeLessThanOrEqual(5)
        expect(result.agentState).toBeDefined()

        // The user is told the turn paused (bilingual), and the history keeps a
        // preserved-work note so a later "continue" resumes with full context.
        const shown = chunks.join('')
        expect(shown).toContain('paused this turn')
        const preserved = result.agentState.messageHistory.some(
          (m) =>
            JSON.stringify(m.content).includes('automatically ended') &&
            JSON.stringify(m.content).includes('preserved'),
        )
        expect(preserved).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.CODEBUFF_AGENT_MAX_TURN_MS
        else process.env.CODEBUFF_AGENT_MAX_TURN_MS = prev
      }
    })

    it('ends cleanly on base2\'s real handleSteps generator path when the budget trips mid-generator', async () => {
      // base2 runs `while(true){ yield spawn-pruner; const {stepsComplete} =
      // yield 'STEP'; if(stepsComplete) break }`. The budget breaks the OUTER
      // loop while this generator is suspended at `yield 'STEP'` (never told
      // stepsComplete). This proves that early break finalizes the run without
      // throwing or hanging — the suspended generator is simply abandoned (the
      // next turn gets a fresh runId, so it's never resumed).
      const prev = process.env.CODEBUFF_AGENT_MAX_TURN_MS
      process.env.CODEBUFF_AGENT_MAX_TURN_MS = '1'

      const stepsCompleteSeen: boolean[] = []
      const generatorTemplate = {
        ...mockTemplate,
        toolNames: ['write_todos', 'read_files', 'end_turn'],
        handleSteps: function* () {
          while (true) {
            const { stepsComplete } = yield 'STEP'
            stepsCompleteSeen.push(stepsComplete)
            if (stepsComplete) break
          }
        } as () => StepGenerator,
      } satisfies AgentTemplate as AgentTemplate

      let call = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        call++
        // Never completes → without the budget this generator loops forever.
        yield createToolCallChunk('write_todos', {
          todos: [{ task: 'Endless', completed: false }],
        })
        return promptSuccess(`mock-message-id-${call}`)
      }

      try {
        const result = await loopAgentSteps({
          ...loopAgentStepsBaseParams,
          agentType: 'test-agent',
          localAgentTemplates: { 'test-agent': generatorTemplate },
          agentState: { ...mockAgentState, stepsRemaining: 100 },
        })

        // Bounded, returned cleanly, and the generator was never told to
        // complete (the outer budget ended the turn, not the generator).
        expect(call).toBeGreaterThanOrEqual(1)
        expect(call).toBeLessThanOrEqual(5)
        expect(stepsCompleteSeen.every((c) => c === false)).toBe(true)
        expect(result.agentState).toBeDefined()
        expect(result.output).toBeDefined()
      } finally {
        if (prev === undefined) delete process.env.CODEBUFF_AGENT_MAX_TURN_MS
        else process.env.CODEBUFF_AGENT_MAX_TURN_MS = prev
      }
    })

    it('does not interfere with a normal short turn when the budget is generous', async () => {
      const prev = process.env.CODEBUFF_AGENT_MAX_TURN_MS
      process.env.CODEBUFF_AGENT_MAX_TURN_MS = String(30 * 60 * 1000)

      const template = {
        ...mockTemplate,
        toolNames: ['read_files', 'end_turn'],
        handleSteps: undefined,
      } satisfies AgentTemplate as AgentTemplate

      let call = 0
      loopAgentStepsBaseParams.promptAiSdkStream = async function* () {
        call++
        yield { type: 'text' as const, text: 'Here is the answer.\n\n' }
        return promptSuccess(`mock-message-id-${call}`)
      }

      try {
        const result = await loopAgentSteps({
          ...loopAgentStepsBaseParams,
          agentType: 'test-agent',
          localAgentTemplates: { 'test-agent': template },
        })
        // Narration with no pending work ends at once; the budget is untouched.
        expect(call).toBe(1)
        expect(result.agentState).toBeDefined()
      } finally {
        if (prev === undefined) delete process.env.CODEBUFF_AGENT_MAX_TURN_MS
        else process.env.CODEBUFF_AGENT_MAX_TURN_MS = prev
      }
    })
  })

  // Integration coverage for the Hermes-style trajectory-capture hook wired
  // into loopAgentSteps. The unit tests exercise the conversion/persistence in
  // isolation; this drives a real run to a success return and confirms the
  // wiring fires (enabled) and is a no-op (disabled, the default).
  describe('trajectory capture (CODEBUFF_SAVE_TRAJECTORIES)', () => {
    it('writes a ShareGPT trajectory on a completed run only when enabled', async () => {
      const prevEnabled = process.env.CODEBUFF_SAVE_TRAJECTORIES
      const prevDir = process.env.CODEBUFF_TRAJECTORY_DIR
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traj-loop-'))
      const file = path.join(tmp, 'trajectory_samples.jsonl')

      const template = {
        ...mockTemplate,
        handleSteps: function* () {
          yield { toolName: 'end_turn', input: {} }
        } as () => StepGenerator,
      } satisfies AgentTemplate as AgentTemplate

      try {
        process.env.CODEBUFF_TRAJECTORY_DIR = tmp

        // Disabled (default): a completed run writes nothing.
        delete process.env.CODEBUFF_SAVE_TRAJECTORIES
        await loopAgentSteps({
          ...loopAgentStepsBaseParams,
          agentType: 'test-agent',
          localAgentTemplates: { 'test-agent': template },
        })
        expect(fs.existsSync(file)).toBe(false)

        // Enabled: the same run appends a ShareGPT entry.
        process.env.CODEBUFF_SAVE_TRAJECTORIES = '1'
        await loopAgentSteps({
          ...loopAgentStepsBaseParams,
          agentType: 'test-agent',
          localAgentTemplates: { 'test-agent': template },
        })
        expect(fs.existsSync(file)).toBe(true)
        const entry = JSON.parse(fs.readFileSync(file, 'utf-8').trim())
        expect(entry.completed).toBe(true)
        expect(entry.model).toBe(mockTemplate.model)
        expect(entry.conversations[0].from).toBe('system')
        expect(
          entry.conversations.some((c: { from: string }) => c.from === 'human'),
        ).toBe(true)
      } finally {
        if (prevEnabled === undefined)
          delete process.env.CODEBUFF_SAVE_TRAJECTORIES
        else process.env.CODEBUFF_SAVE_TRAJECTORIES = prevEnabled
        if (prevDir === undefined) delete process.env.CODEBUFF_TRAJECTORY_DIR
        else process.env.CODEBUFF_TRAJECTORY_DIR = prevDir
        fs.rmSync(tmp, { recursive: true, force: true })
      }
    })
  })
})
