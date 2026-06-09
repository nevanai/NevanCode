import { describe, expect, it } from 'bun:test'
import { z } from 'zod/v4'
import { convertJsonSchemaToZod } from 'zod-from-json-schema'

import { getToolSet } from '../tools/prompts'

import type { CustomToolDefinitions } from '@codebuff/common/util/file'

/**
 * Regression guard for the MCP "empty properties" bug.
 *
 * MCP tools arrive with their `inputSchema` as a Zod (v4) schema (produced by
 * convertJsonSchemaToZod). getToolSet used to `cloneDeep` each definition, which
 * mangled the Zod schema's internal `_zod.def`; z.toJSONSchema then threw and the
 * code silently fell back to an empty `z.object({})`. The model received tools
 * with `properties: {}`, couldn't tell what arguments to pass, called them empty,
 * got validation errors, and retried for minutes.
 *
 * These tests assert the schema's properties survive getToolSet so the model can
 * actually call MCP tools with the right arguments.
 */
describe('getToolSet preserves MCP tool schemas (no empty properties)', () => {
  const mcpDefs: CustomToolDefinitions = {
    'nevancode-mcp__browser_navigate': {
      inputSchema: convertJsonSchemaToZod({
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full URL to navigate to.' },
          wait_until: {
            type: 'string',
            enum: ['load', 'domcontentloaded', 'networkidle'],
          },
        },
        required: ['url'],
      } as any) as any,
      endsAgentStep: true,
      description: 'Open a URL in the browser.',
    },
    'nevancode-mcp__computer_press_keys': {
      inputSchema: convertJsonSchemaToZod({
        type: 'object',
        properties: {
          keys: { type: 'array', items: { type: 'string' } },
        },
        required: ['keys'],
      } as any) as any,
      endsAgentStep: true,
      description: 'Press a combination of keys.',
    },
  }

  it('exposes the real properties of each MCP tool to the model', async () => {
    const toolSet = await getToolSet({
      toolNames: [],
      additionalToolDefinitions: async () => mcpDefs,
      agentTools: {},
      skills: {},
    })

    // browser_navigate must keep url + wait_until and require url.
    const nav = z.toJSONSchema(
      (toolSet['nevancode-mcp__browser_navigate'] as any).inputSchema,
      { io: 'input' },
    ) as any
    expect(Object.keys(nav.properties ?? {})).toContain('url')
    expect(Object.keys(nav.properties ?? {})).toContain('wait_until')
    expect(nav.required ?? []).toContain('url')

    // computer_press_keys must keep its required `keys` array.
    const keys = z.toJSONSchema(
      (toolSet['nevancode-mcp__computer_press_keys'] as any).inputSchema,
      { io: 'input' },
    ) as any
    expect(Object.keys(keys.properties ?? {})).toContain('keys')
    expect(keys.required ?? []).toContain('keys')
  })

  it('does not collapse any MCP tool to an empty object schema', async () => {
    const toolSet = await getToolSet({
      toolNames: [],
      additionalToolDefinitions: async () => mcpDefs,
      agentTools: {},
      skills: {},
    })

    for (const name of Object.keys(mcpDefs)) {
      const json = z.toJSONSchema((toolSet[name] as any).inputSchema, {
        io: 'input',
      }) as any
      expect(Object.keys(json.properties ?? {}).length).toBeGreaterThan(0)
    }
  })

  it('still converts SDK JSON-Schema tools correctly', async () => {
    // SDK custom tools arrive with a plain JSON-Schema object (not Zod).
    const sdkDefs: CustomToolDefinitions = {
      my_sdk_tool: {
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        } as any,
        endsAgentStep: true,
        description: 'An SDK tool.',
      },
    }
    const toolSet = await getToolSet({
      toolNames: [],
      additionalToolDefinitions: async () => sdkDefs,
      agentTools: {},
      skills: {},
    })
    const json = z.toJSONSchema((toolSet.my_sdk_tool as any).inputSchema, {
      io: 'input',
    }) as any
    expect(Object.keys(json.properties ?? {})).toContain('query')
  })
})
