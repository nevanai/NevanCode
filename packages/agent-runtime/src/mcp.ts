import { convertJsonSchemaToZod } from 'zod-from-json-schema'

import { MCP_TOOL_SEPARATOR } from './mcp-constants'

import type { AgentTemplate } from './templates/types'
import type { RequestMcpToolDataFn } from '@codebuff/common/types/contracts/client'
import type { OptionalFields } from '@codebuff/common/types/function-params'
import type { Logger } from '@codebuff/common/types/contracts/logger'
import type {
  CustomToolDefinitions,
  ProjectFileContext,
} from '@codebuff/common/util/file'

/**
 * Tracks MCP servers we've already warned about this process so a single
 * broken server doesn't spam the logs on every agent step.
 */
const warnedMcpServers = new Set<string>()

export async function getMCPToolData(
  params: OptionalFields<
    {
      toolNames: AgentTemplate['toolNames']
      mcpServers: AgentTemplate['mcpServers']
      writeTo: ProjectFileContext['customToolDefinitions']
      requestMcpToolData: RequestMcpToolDataFn
      logger?: Logger
    },
    'writeTo' | 'logger'
  >,
): Promise<CustomToolDefinitions> {
  const withDefaults = { writeTo: {}, ...params }
  const { toolNames, mcpServers, writeTo, requestMcpToolData, logger } =
    withDefaults

  // User-facing toolNames use '/' as separator (e.g., 'supabase/list_tables')
  // but internally we use MCP_TOOL_SEPARATOR ('__') for LLM API compatibility
  const USER_INPUT_SEPARATOR = '/'
  const requestedToolsByMcp: Record<string, string[] | undefined> = {}
  for (const t of toolNames) {
    if (!t.includes(USER_INPUT_SEPARATOR)) {
      continue
    }
    const [mcpName, ...remaining] = t.split(USER_INPUT_SEPARATOR)
    const toolName = remaining.join(USER_INPUT_SEPARATOR)
    if (!requestedToolsByMcp[mcpName]) {
      requestedToolsByMcp[mcpName] = []
    }
    requestedToolsByMcp[mcpName].push(toolName)
  }

  // Per-server isolation: a single failing MCP server must not kill the
  // entire agent step. Using allSettled lets the agent continue with the
  // tools from healthy servers while degraded servers are skipped (and
  // their failure cached by the MCP client so we don't keep retrying).
  const entries = Object.entries(mcpServers)
  const results = await Promise.allSettled(
    entries.map(([mcpName, mcpConfig]) =>
      requestMcpToolData({
        mcpConfig,
        toolNames: requestedToolsByMcp[mcpName] ?? null,
      }).then((mcpData) => ({ mcpName, mcpData })),
    ),
  )

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const mcpName = entries[i][0]

    if (result.status === 'fulfilled') {
      for (const { name, description, inputSchema } of result.value.mcpData) {
        writeTo[mcpName + MCP_TOOL_SEPARATOR + name] = {
          inputSchema: convertJsonSchemaToZod(inputSchema as any) as any,
          endsAgentStep: true,
          description,
        }
      }
      continue
    }

    const reason = result.reason
    const message = reason instanceof Error ? reason.message : String(reason)
    if (!warnedMcpServers.has(mcpName)) {
      warnedMcpServers.add(mcpName)
      const logFn = logger?.warn
      const fullMessage = `[mcp] Server '${mcpName}' is unavailable; its tools will be skipped this session. ${message}`
      if (logFn) {
        logFn({ mcpName, error: message }, fullMessage)
      } else {
        // eslint-disable-next-line no-console
        console.warn(fullMessage)
      }
    }
  }

  return writeTo
}

/**
 * Clear the per-process "already warned" set so a broken server can warn
 * again. Exported for tests and explicit user-triggered retries.
 */
export function __resetMcpWarningsForTests(): void {
  warnedMcpServers.clear()
}
