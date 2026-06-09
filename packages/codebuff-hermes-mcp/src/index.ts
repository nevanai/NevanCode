#!/usr/bin/env bun
/**
 * codebuff-hermes-mcp
 *
 * A local MCP server providing three tool groups inspired by Hermes Agent:
 *   - Computer Use  : screenshot, mouse, keyboard control
 *   - Browser       : Playwright headless Chromium + persistent memory
 *   - File Manager  : OS-level file and directory operations
 *
 * Run standalone:
 *   bun packages/codebuff-hermes-mcp/src/index.ts
 *
 * The server communicates over stdio — the MCP client (Codebuff SDK) spawns it
 * automatically when `codebuff-hermes-mcp` appears in .agents/mcp.json.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'

import { computerUseTools, handleComputerUseTool } from './tools/computer-use.ts'
import { browserTools, handleBrowserTool } from './tools/browser.ts'
import { fileManagerTools, handleFileManagerTool } from './tools/file-manager.ts'

// ── All registered tools ──────────────────────────────────────────────────────

const ALL_TOOLS = [...computerUseTools, ...browserTools, ...fileManagerTools]

// Build a fast lookup set for dispatching
const computerUseToolNames = new Set(computerUseTools.map((t) => t.name))
const browserToolNames = new Set(browserTools.map((t) => t.name))
const fileManagerToolNames = new Set(fileManagerTools.map((t) => t.name))

// ── Server setup ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'codebuff-hermes-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

// ── List tools handler ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: ALL_TOOLS }
})

// ── Call tool handler ─────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params
  const args = (rawArgs ?? {}) as Record<string, unknown>

  try {
    if (computerUseToolNames.has(name)) {
      return await handleComputerUseTool(name, args)
    }
    if (browserToolNames.has(name)) {
      return await handleBrowserTool(name, args)
    }
    if (fileManagerToolNames.has(name)) {
      return await handleFileManagerTool(name, args)
    }

    throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`)
  } catch (err) {
    if (err instanceof McpError) throw err

    const message = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true,
    }
  }
})

// ── Start stdio transport ─────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
