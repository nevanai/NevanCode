import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import { getMCPToolData, __resetMcpWarningsForTests } from '../mcp'

import type { MCPConfig } from '@codebuff/common/types/mcp'

const stdio = (command: string): MCPConfig => ({
  type: 'stdio',
  command,
  args: [],
  env: {},
})

describe('getMCPToolData per-server isolation', () => {
  let warnings: string[] = []
  let originalWarn: typeof console.warn

  beforeEach(() => {
    __resetMcpWarningsForTests()
    warnings = []
    originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(' '))
    }
  })

  afterEach(() => {
    console.warn = originalWarn
    mock.restore()
  })

  it('returns tools from healthy servers when another server fails', async () => {
    const requestMcpToolData = mock(
      async ({ mcpConfig }: { mcpConfig: MCPConfig }) => {
        if ('command' in mcpConfig && mcpConfig.command === 'broken') {
          throw new Error('MCP error -32000: Connection closed')
        }
        return [
          {
            name: 'echo',
            description: 'Echo a string back',
            inputSchema: { type: 'object' as const, properties: {} },
          },
        ]
      },
    )

    const result = await getMCPToolData({
      toolNames: [],
      mcpServers: {
        broken: stdio('broken'),
        healthy: stdio('healthy'),
      },
      writeTo: {},
      requestMcpToolData: requestMcpToolData as any,
    })

    const keys = Object.keys(result)
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(/^healthy/)
    expect(warnings.some((w) => w.includes("'broken'"))).toBe(true)
  })

  it('does not warn twice for the same broken server', async () => {
    const requestMcpToolData = mock(async () => {
      throw new Error('boom')
    })

    await getMCPToolData({
      toolNames: [],
      mcpServers: { broken: stdio('broken') },
      writeTo: {},
      requestMcpToolData: requestMcpToolData as any,
    })
    await getMCPToolData({
      toolNames: [],
      mcpServers: { broken: stdio('broken') },
      writeTo: {},
      requestMcpToolData: requestMcpToolData as any,
    })

    const brokenWarnings = warnings.filter((w) => w.includes("'broken'"))
    expect(brokenWarnings).toHaveLength(1)
  })

  it('continues when ALL servers fail (degrades to no MCP tools, no throw)', async () => {
    const requestMcpToolData = mock(async () => {
      throw new Error('all broken')
    })

    const result = await getMCPToolData({
      toolNames: [],
      mcpServers: { a: stdio('a'), b: stdio('b') },
      writeTo: {},
      requestMcpToolData: requestMcpToolData as any,
    })

    expect(Object.keys(result)).toHaveLength(0)
  })

  it('forwards logger.warn instead of console.warn when a logger is provided', async () => {
    const logger = {
      debug: mock(() => {}),
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    }
    const requestMcpToolData = mock(async () => {
      throw new Error('boom')
    })

    await getMCPToolData({
      toolNames: [],
      mcpServers: { broken: stdio('broken') },
      writeTo: {},
      requestMcpToolData: requestMcpToolData as any,
      logger,
    })

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(warnings).toHaveLength(0)
  })
})
