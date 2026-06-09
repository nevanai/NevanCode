import { afterEach, describe, expect, mock, test } from 'bun:test'

import {
  GEMINI_FLASH_LITE_MODEL,
  GEMINI_FLASH_MODEL,
  GEMINI_OAUTH_DEFAULT_MODEL,
  GEMINI_PRO_MODEL,
  GEMINI_SKIP_THOUGHT_SIGNATURE,
  isGeminiProviderModel,
  toGeminiModelId,
} from '@codebuff/common/constants/gemini-oauth'

import {
  injectGeminiThoughtSignatures,
  parseCodeAssist429,
  parseGeminiAction,
  resolveGeminiProject,
  unwrapCodeAssistResponse,
  unwrapCodeAssistStreamLine,
  wrapCodeAssistRequestBody,
} from '../model-provider'

describe('toGeminiModelId / isGeminiProviderModel', () => {
  test('maps the display models to their wire ids', () => {
    expect(toGeminiModelId('google/gemini-3-flash-preview')).toBe('gemini-3-flash-preview')
    expect(toGeminiModelId('google/gemini-3.1-flash-lite-preview')).toBe('gemini-3.1-flash-lite-preview')
    expect(toGeminiModelId('google/gemini-2.5-flash')).toBe(GEMINI_FLASH_MODEL)
    expect(toGeminiModelId('google/gemini-2.5-flash-lite')).toBe(GEMINI_FLASH_LITE_MODEL)
    expect(toGeminiModelId('google/gemma-4-31b-it')).toBe('gemma-4-31b-it')
    expect(toGeminiModelId('google/gemma-4-26b-a4b-it')).toBe('gemma-4-26b-a4b-it')
    // legacy labels still resolve
    expect(toGeminiModelId('google/gemini-3.1-pro')).toBe(GEMINI_PRO_MODEL)
    expect(toGeminiModelId('google/gemini-3.5-flash')).toBe(GEMINI_FLASH_MODEL)
  })

  test('falls back by tier keyword for unknown google ids', () => {
    expect(toGeminiModelId('google/gemini-9-pro')).toBe(GEMINI_PRO_MODEL)
    expect(toGeminiModelId('google/gemini-9-flash')).toBe(GEMINI_FLASH_MODEL)
  })

  test('non-Gemini models routed to the OAuth path use the default model', () => {
    expect(toGeminiModelId('anthropic/claude-opus-4.5')).toBe(
      GEMINI_OAUTH_DEFAULT_MODEL,
    )
  })

  test('already-native ids pass through untouched', () => {
    expect(toGeminiModelId('gemini-2.5-pro')).toBe('gemini-2.5-pro')
  })

  test('isGeminiProviderModel detects the google/ prefix', () => {
    expect(isGeminiProviderModel('google/gemini-3.1-pro')).toBe(true)
    expect(isGeminiProviderModel('anthropic/claude-opus-4.5')).toBe(false)
  })
})

describe('wrapCodeAssistRequestBody', () => {
  test('wraps a native Gemini request in the {model, project, request} envelope', () => {
    const inner = {
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      generationConfig: { temperature: 0.5 },
    }
    const out = JSON.parse(
      wrapCodeAssistRequestBody(JSON.stringify(inner), 'gemini-2.5-pro', 'proj-1'),
    )
    expect(out.model).toBe('gemini-2.5-pro')
    expect(out.project).toBe('proj-1')
    expect(out.request).toEqual(inner)
  })

  test('omits the project field when no project is resolved', () => {
    const out = JSON.parse(
      wrapCodeAssistRequestBody(JSON.stringify({ contents: [] }), 'gemini-2.5-flash'),
    )
    expect('project' in out).toBe(false)
    expect(out.model).toBe('gemini-2.5-flash')
  })

  test('returns non-JSON input unchanged', () => {
    expect(wrapCodeAssistRequestBody('not json', 'gemini-2.5-pro')).toBe(
      'not json',
    )
  })
})

describe('parseGeminiAction', () => {
  test('extracts model id + stream action from a streamGenerateContent URL', () => {
    const parsed = parseGeminiAction(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.modelId).toBe('gemini-2.5-pro')
    expect(parsed!.action).toBe('streamGenerateContent')
    expect(parsed!.isStream).toBe(true)
    expect(parsed!.search).toBe('?alt=sse')
  })

  test('marks non-streaming generateContent as isStream=false', () => {
    const parsed = parseGeminiAction(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    )
    expect(parsed!.action).toBe('generateContent')
    expect(parsed!.isStream).toBe(false)
  })

  test('returns null for a URL without a /models/ segment', () => {
    expect(parseGeminiAction('https://example.com/v1internal:loadCodeAssist')).toBeNull()
  })
})

describe('unwrapCodeAssistStreamLine', () => {
  test('lifts .response out of a wrapped SSE data line', () => {
    const wrapped =
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}}'
    const out = unwrapCodeAssistStreamLine(wrapped)
    expect(out).toBe(
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}',
    )
  })

  test('passes through [DONE] and non-data lines untouched', () => {
    expect(unwrapCodeAssistStreamLine('data: [DONE]')).toBe('data: [DONE]')
    expect(unwrapCodeAssistStreamLine('event: message')).toBe('event: message')
    expect(unwrapCodeAssistStreamLine('')).toBe('')
  })
})

// Helper: build a streamed Response from string chunks.
function responseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]))
      } else {
        controller.close()
      }
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('unwrapCodeAssistResponse', () => {
  test('unwraps a streamed SSE body, even across chunk boundaries', async () => {
    const res = await unwrapCodeAssistResponse(
      responseFromChunks([
        'data: {"response":{"candi',
        'dates":[{"index":0}]}}\n\n',
      ]),
      true,
    )
    const text = await res.text()
    expect(text).toContain('"candidates":[{"index":0}]')
    expect(text).not.toContain('"response"')
  })

  test('unwraps a non-streaming JSON body', async () => {
    const res = await unwrapCodeAssistResponse(
      new Response(JSON.stringify({ response: { candidates: [{ index: 0 }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      false,
    )
    const json = await res.json()
    expect(json).toEqual({ candidates: [{ index: 0 }] })
  })

  test('passes error responses through without unwrapping', async () => {
    const res = await unwrapCodeAssistResponse(
      new Response('{"error":{"code":500}}', { status: 500 }),
      false,
    )
    expect(res.status).toBe(500)
    expect(await res.text()).toBe('{"error":{"code":500}}')
  })
})

describe('thought-signature round-trip', () => {
  test('captures a signature from a response and re-injects it on the next request', async () => {
    // A response whose functionCall carries a thoughtSignature → captured.
    const resBody = JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'run_terminal_command',
                    args: { command: 'ls' },
                  },
                  thoughtSignature: 'SIG-123',
                },
              ],
            },
          },
        ],
      },
    })
    await unwrapCodeAssistResponse(new Response(resBody, { status: 200 }), false)

    // Next turn: the same functionCall replayed in history, signature dropped.
    const reqBody = JSON.stringify({
      contents: [
        { role: 'user', parts: [{ text: 'list files' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'run_terminal_command', args: { command: 'ls' } } },
          ],
        },
      ],
    })
    const out = JSON.parse(injectGeminiThoughtSignatures(reqBody))
    expect(out.contents[1].parts[0].thoughtSignature).toBe('SIG-123')
  })

  test('injects the documented skip token when no real signature is cached', () => {
    // A call we never captured (e.g. basher yields run_terminal_command itself,
    // so Gemini never signed it) must still get a signature, or Gemini 3 hard-
    // rejects the request with "missing a thought_signature".
    const reqBody = JSON.stringify({
      contents: [
        {
          role: 'model',
          parts: [{ functionCall: { name: 'unknown_tool_xyz', args: {} } }],
        },
      ],
    })
    const out = JSON.parse(injectGeminiThoughtSignatures(reqBody))
    expect(out.contents[0].parts[0].thoughtSignature).toBe(
      GEMINI_SKIP_THOUGHT_SIGNATURE,
    )
  })

  test('matches the captured signature even when arg key order differs', async () => {
    // The runtime can reorder arg keys (schema validation) between the captured
    // response and the replayed request. The canonical key must still match so
    // the real signature is preferred over the skip token.
    const resBody = JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'write_file',
                    args: { path: 'a.ts', content: 'x' },
                  },
                  thoughtSignature: 'SIG-REORDER',
                },
              ],
            },
          },
        ],
      },
    })
    await unwrapCodeAssistResponse(new Response(resBody, { status: 200 }), false)

    const reqBody = JSON.stringify({
      contents: [
        {
          role: 'model',
          parts: [
            // Same call, keys in a different order.
            { functionCall: { name: 'write_file', args: { content: 'x', path: 'a.ts' } } },
          ],
        },
      ],
    })
    const out = JSON.parse(injectGeminiThoughtSignatures(reqBody))
    expect(out.contents[0].parts[0].thoughtSignature).toBe('SIG-REORDER')
  })

  test('leaves a functionCall that already carries a signature untouched', () => {
    const reqBody = JSON.stringify({
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'some_tool', args: {} },
              thoughtSignature: 'REAL-SIG',
            },
          ],
        },
      ],
    })
    const out = JSON.parse(injectGeminiThoughtSignatures(reqBody))
    expect(out.contents[0].parts[0].thoughtSignature).toBe('REAL-SIG')
  })
})

describe('parseCodeAssist429', () => {
  test('reads the RetryInfo retryDelay (+0.5s buffer)', async () => {
    const res = new Response(
      JSON.stringify({
        error: {
          code: 429,
          details: [
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '6s' },
          ],
        },
      }),
      { status: 429 },
    )
    const { delayMs } = await parseCodeAssist429(res)
    expect(delayMs).toBe(6500)
  })

  test('reads the human "reset after Ns" hint', async () => {
    const res = new Response(
      JSON.stringify({ error: { message: 'You have exhausted your capacity. Your quota will reset after 13s.' } }),
      { status: 429 },
    )
    const { delayMs } = await parseCodeAssist429(res)
    expect(delayMs).toBe(13_500)
  })

  test('caps the delay and returns null when there is no hint', async () => {
    const capped = await parseCodeAssist429(
      new Response('{"error":{"message":"reset after 999s"}}', { status: 429 }),
    )
    expect(capped.delayMs).toBe(30_000)
    const none = await parseCodeAssist429(
      new Response('{"error":{"message":"quota exceeded"}}', { status: 429 }),
    )
    expect(none.delayMs).toBeNull()
    expect(none.bodyText).toContain('quota exceeded')
  })
})

describe('resolveGeminiProject', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('uses the project loadCodeAssist returns directly (no onboarding)', async () => {
    const calls: string[] = []
    globalThis.fetch = mock(async (url: any) => {
      calls.push(String(url))
      return new Response(
        JSON.stringify({ cloudaicompanionProject: 'proj-from-load' }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const project = await resolveGeminiProject('access-token')
    expect(project).toBe('proj-from-load')
    // Only loadCodeAssist is called — onboarding is skipped.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('v1internal:loadCodeAssist')
  })

  test('onboards (and reads the minted project) when no project exists yet', async () => {
    const bodies: any[] = []
    globalThis.fetch = mock(async (url: any, init: any) => {
      const u = String(url)
      bodies.push({ url: u, body: JSON.parse(init.body) })
      if (u.includes('loadCodeAssist')) {
        return new Response(
          JSON.stringify({
            allowedTiers: [{ id: 'free-tier', isDefault: true }],
          }),
          { status: 200 },
        )
      }
      // onboardUser — completed long-running operation with the new project.
      return new Response(
        JSON.stringify({
          done: true,
          response: { cloudaicompanionProject: { id: 'minted-proj' } },
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const project = await resolveGeminiProject('access-token')
    expect(project).toBe('minted-proj')
    const onboard = bodies.find((b) => b.url.includes('onboardUser'))
    expect(onboard).toBeTruthy()
    // The default tier from loadCodeAssist drives the onboarding tierId.
    expect(onboard.body.tierId).toBe('free-tier')
  })
})
