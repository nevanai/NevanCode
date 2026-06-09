import { afterEach, describe, expect, mock, test } from 'bun:test'

import {
  addAgentStep,
  finishAgentRun,
  getUserInfoFromApiKey,
  startAgentRun,
} from '../impl/database'

import type { Logger } from '@codebuff/common/types/contracts/logger'

describe('getUserInfoFromApiKey', () => {
  const originalFetch = globalThis.fetch

  const createLoggerMocks = (): Logger =>
    ({
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    }) as unknown as Logger

  afterEach(() => {
    globalThis.fetch = originalFetch
    mock.restore()
  })

  test('requests only the requested fields (no implicit userColumns)', async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const urlString =
        input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : String(input)
      const url = new URL(urlString)

      expect(url.pathname).toContain('/api/v1/me')
      expect(url.searchParams.get('fields')).toBe('id')

      return new Response(JSON.stringify({ id: 'user-123' }), { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await getUserInfoFromApiKey({
      apiKey: 'test-api-key',
      fields: ['id'],
      logger: createLoggerMocks(),
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ id: 'user-123' })
  })

  test('merges cached fields and avoids refetching when present', async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const urlString =
        input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : String(input)
      const url = new URL(urlString)
      const fields = url.searchParams.get('fields')

      if (fields === 'id') {
        return new Response(JSON.stringify({ id: 'user-123' }), { status: 200 })
      }
      if (fields === 'email') {
        return new Response(JSON.stringify({ email: 'user@example.com' }), {
          status: 200,
        })
      }

      throw new Error(`Unexpected fields param: ${fields}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const logger = createLoggerMocks()

    const first = await getUserInfoFromApiKey({
      apiKey: 'cache-test-api-key',
      fields: ['id'],
      logger,
    })
    expect(first).toEqual({ id: 'user-123' })

    const second = await getUserInfoFromApiKey({
      apiKey: 'cache-test-api-key',
      fields: ['email'],
      logger,
    })
    expect(second).toEqual({ email: 'user@example.com' })

    const third = await getUserInfoFromApiKey({
      apiKey: 'cache-test-api-key',
      fields: ['id', 'email'],
      logger,
    })
    expect(third).toEqual({ id: 'user-123', email: 'user@example.com' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('telemetry calls fail fast when tracking server is unreachable', () => {
  // Regression: previously every telemetry call to /api/v1/agent-runs went
  // through fetchWithRetry with MAX_RETRIES_PER_MESSAGE=3 and 1s+2s+4s of
  // exponential backoff. With a down tracking server, ~7 calls per message
  // burned ~50s of blocked retries inside the agent loop. They should now
  // attempt at most once and fall back synchronously.
  const originalFetch = globalThis.fetch
  const FAIL_FAST_BUDGET_MS = 250

  const createLoggerMocks = (): Logger =>
    ({
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    }) as unknown as Logger

  const mockEconnRefused = () => {
    const fetchMock = mock(async () => {
      const err = new Error(
        'Unable to connect. Is the computer able to access the url?',
      ) as Error & { code?: string }
      err.code = 'ConnectionRefused'
      throw err
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
  }

  afterEach(() => {
    globalThis.fetch = originalFetch
    mock.restore()
  })

  test('startAgentRun returns a synthesized local runId in one attempt', async () => {
    const fetchMock = mockEconnRefused()
    const started = Date.now()

    const runId = await startAgentRun({
      apiKey: 'test-api-key',
      agentId: 'base2',
      ancestorRunIds: [],
      logger: createLoggerMocks(),
    })

    const elapsed = Date.now() - started
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(elapsed).toBeLessThan(FAIL_FAST_BUDGET_MS)
    expect(runId).not.toBeNull()
    expect((runId as string).startsWith('local-')).toBe(true)
  })

  test('addAgentStep returns null in one attempt', async () => {
    const fetchMock = mockEconnRefused()
    const started = Date.now()

    const result = await addAgentStep({
      apiKey: 'test-api-key',
      userId: undefined,
      agentRunId: 'local-test',
      stepNumber: 1,
      credits: 0,
      childRunIds: [],
      messageId: null,
      status: 'completed',
      startTime: new Date(),
      logger: createLoggerMocks(),
    })

    const elapsed = Date.now() - started
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(elapsed).toBeLessThan(FAIL_FAST_BUDGET_MS)
    expect(result).toBeNull()
  })

  test('finishAgentRun returns without throwing in one attempt', async () => {
    const fetchMock = mockEconnRefused()
    const started = Date.now()

    await finishAgentRun({
      apiKey: 'test-api-key',
      userId: undefined,
      runId: 'local-test',
      status: 'completed',
      totalSteps: 1,
      directCredits: 0,
      totalCredits: 0,
      logger: createLoggerMocks(),
    })

    const elapsed = Date.now() - started
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(elapsed).toBeLessThan(FAIL_FAST_BUDGET_MS)
  })
})

