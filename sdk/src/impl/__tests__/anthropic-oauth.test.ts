import { describe, expect, test } from 'bun:test'

import {
  ANTHROPIC_CLAUDE_CODE_IDENTITY,
  ANTHROPIC_HAIKU_MODEL,
  ANTHROPIC_OAUTH_DEFAULT_MODEL,
  ANTHROPIC_OPUS_MODEL,
  ANTHROPIC_SONNET_MODEL,
  isAnthropicProviderModel,
  toAnthropicModelId,
} from '@codebuff/common/constants/anthropic-oauth'

import {
  stripMcpToolPrefixFromResponse,
  transformAnthropicOAuthBody,
} from '../model-provider'

const identity = ANTHROPIC_CLAUDE_CODE_IDENTITY

describe('toAnthropicModelId / isAnthropicProviderModel', () => {
  test('maps known OpenRouter-style ids to real native ids', () => {
    expect(toAnthropicModelId('anthropic/claude-opus-4.5')).toBe(
      ANTHROPIC_OPUS_MODEL,
    )
    expect(toAnthropicModelId('anthropic/claude-sonnet-4.5')).toBe(
      ANTHROPIC_SONNET_MODEL,
    )
    expect(toAnthropicModelId('anthropic/claude-haiku-4.5')).toBe(
      ANTHROPIC_HAIKU_MODEL,
    )
    expect(toAnthropicModelId('anthropic/claude-opus-4.1')).toBe(
      'claude-opus-4-1',
    )
  })

  test('collapses speculative future versions to the latest shipping tier', () => {
    expect(toAnthropicModelId('anthropic/claude-opus-4.7')).toBe(
      ANTHROPIC_OPUS_MODEL,
    )
    expect(toAnthropicModelId('anthropic/claude-sonnet-4.6')).toBe(
      ANTHROPIC_SONNET_MODEL,
    )
  })

  test('unknown anthropic ids fall back by tier keyword', () => {
    expect(toAnthropicModelId('anthropic/claude-opus-9')).toBe(
      ANTHROPIC_OPUS_MODEL,
    )
    expect(toAnthropicModelId('anthropic/claude-haiku-9')).toBe(
      ANTHROPIC_HAIKU_MODEL,
    )
  })

  test('non-Anthropic models routed to the OAuth path use the default model', () => {
    expect(toAnthropicModelId('openai/gpt-5.4')).toBe(
      ANTHROPIC_OAUTH_DEFAULT_MODEL,
    )
  })

  test('already-native ids pass through untouched', () => {
    expect(toAnthropicModelId('claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
  })

  test('isAnthropicProviderModel detects the anthropic/ prefix', () => {
    expect(isAnthropicProviderModel('anthropic/claude-opus-4.5')).toBe(true)
    expect(isAnthropicProviderModel('openai/gpt-5.4')).toBe(false)
  })
})

describe('transformAnthropicOAuthBody — system identity injection', () => {
  test('prepends identity to a string system prompt', () => {
    const out = JSON.parse(
      transformAnthropicOAuthBody(
        JSON.stringify({ system: 'You help with code.' }),
      ),
    )
    expect(out.system).toBe(`${identity}\n\nYou help with code.`)
  })

  test('sets identity when system is missing', () => {
    const out = JSON.parse(transformAnthropicOAuthBody(JSON.stringify({})))
    expect(out.system).toBe(identity)
  })

  test('unshifts identity as the first block for array system prompts', () => {
    const out = JSON.parse(
      transformAnthropicOAuthBody(
        JSON.stringify({
          system: [{ type: 'text', text: 'Big agent prompt' }],
        }),
      ),
    )
    expect(Array.isArray(out.system)).toBe(true)
    expect(out.system[0]).toEqual({ type: 'text', text: identity })
    expect(out.system[1]).toEqual({ type: 'text', text: 'Big agent prompt' })
  })

  test('does not double-inject when identity is already first', () => {
    const out = JSON.parse(
      transformAnthropicOAuthBody(
        JSON.stringify({
          system: [
            { type: 'text', text: identity },
            { type: 'text', text: 'rest' },
          ],
        }),
      ),
    )
    expect(out.system).toHaveLength(2)
    expect(out.system[0].text).toBe(identity)
  })
})

describe('transformAnthropicOAuthBody — tool name prefixing', () => {
  test('prefixes tool names, tool_choice, and history tool_use names', () => {
    const out = JSON.parse(
      transformAnthropicOAuthBody(
        JSON.stringify({
          tools: [{ name: 'read_files' }, { name: 'write_file' }],
          tool_choice: { type: 'tool', name: 'read_files' },
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'ok' },
                { type: 'tool_use', name: 'write_file', id: 't1', input: {} },
              ],
            },
          ],
        }),
      ),
    )
    expect(out.tools.map((t: any) => t.name)).toEqual([
      'mcp_read_files',
      'mcp_write_file',
    ])
    expect(out.tool_choice.name).toBe('mcp_read_files')
    expect(out.messages[0].content[1].name).toBe('mcp_write_file')
  })

  test('is idempotent (does not stack prefixes)', () => {
    const once = transformAnthropicOAuthBody(
      JSON.stringify({ tools: [{ name: 'read_files' }] }),
    )
    const twice = transformAnthropicOAuthBody(once)
    expect(JSON.parse(twice).tools[0].name).toBe('mcp_read_files')
  })

  test('returns non-JSON input unchanged', () => {
    expect(transformAnthropicOAuthBody('not json')).toBe('not json')
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

describe('stripMcpToolPrefixFromResponse', () => {
  test('strips mcp_ from a complete SSE line', async () => {
    const res = stripMcpToolPrefixFromResponse(
      responseFromChunks([
        'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_read_files"}}\n\n',
      ]),
    )
    const text = await res.text()
    expect(text).toContain('"name":"read_files"')
    expect(text).not.toContain('mcp_')
  })

  test('handles a tool name split across chunk boundaries', async () => {
    // The mcp_ name is split mid-token; line-buffering must reassemble it.
    const res = stripMcpToolPrefixFromResponse(
      responseFromChunks([
        'data: {"type":"tool_use","name":"mcp_re',
        'ad_files"}\n\n',
      ]),
    )
    const text = await res.text()
    expect(text).toContain('"name":"read_files"')
    expect(text).not.toContain('mcp_')
  })

  test('strips a non-streaming JSON body with no newline', async () => {
    const res = stripMcpToolPrefixFromResponse(
      responseFromChunks(['{"content":[{"type":"tool_use","name":"mcp_bash"}]}']),
    )
    const text = await res.text()
    expect(text).toContain('"name":"bash"')
    expect(text).not.toContain('mcp_')
  })

  test('drops content-length/encoding headers since the body is re-streamed', () => {
    const original = new Response('x', {
      status: 200,
      headers: { 'content-length': '1', 'content-encoding': 'gzip' },
    })
    const res = stripMcpToolPrefixFromResponse(original)
    expect(res.headers.get('content-length')).toBeNull()
    expect(res.headers.get('content-encoding')).toBeNull()
  })
})
