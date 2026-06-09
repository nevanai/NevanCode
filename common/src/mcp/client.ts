import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import type { MCPConfig } from '../types/mcp'
import type { ToolResultOutput } from '../types/messages/content-part'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  BlobResourceContents,
  CallToolResult,
  TextResourceContents,
} from '@modelcontextprotocol/sdk/types.js'

const runningClients: Record<string, Client> = {}
const listToolsCache: Record<
  string,
  ReturnType<typeof Client.prototype.listTools>
> = {}

/**
 * Cache of configs that previously failed to connect. We don't want to keep
 * retrying broken servers on every agent step — each retry can wait several
 * seconds for the failing process to exit (e.g. an npx command that can't
 * write its npm cache). The stored error is replayed for subsequent callers
 * so they see the same diagnostic as the first failure.
 */
const failedConnections: Map<string, Error> = new Map()

/**
 * In-flight connection promises keyed by config hash. Multiple concurrent
 * agent steps that all start at once would otherwise each spawn their own
 * child process for the same server — fine for working servers (cheap), but
 * catastrophic for a broken server (we'd spawn N stuck npx processes before
 * any of them populates failedConnections). Sharing a single promise per key
 * collapses the stampede.
 */
const pendingConnections: Map<string, Promise<string>> = new Map()

const STDERR_TAIL_BYTES = 4096

/**
 * Suggestions appended to stdio MCP errors when the captured stderr matches
 * a known recoverable failure mode (e.g. npm cache permissions). Keeps the
 * user-visible error actionable instead of just "Connection closed".
 */
function suggestionForStderr(stderr: string): string | null {
  if (/EACCES/.test(stderr) && /\.npm/.test(stderr)) {
    return 'Hint: npm cache appears to have root-owned files. Try: sudo chown -R "$(id -u):$(id -g)" ~/.npm'
  }
  if (/ENOENT/.test(stderr) && /command not found/i.test(stderr)) {
    return 'Hint: the command was not found on PATH. Install it or use an absolute path in mcp.json.'
  }
  return null
}

/**
 * Substitutes environment variable references ($VAR_NAME) in a string with their values.
 * Supports both simple replacement ("$VAR_NAME") and interpolation ("Bearer $VAR_NAME").
 */
function substituteEnvInValue(value: string): string {
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, varName) => {
    const envValue = process.env[varName]
    if (envValue === undefined) {
      // Return original if env var not found
      return match
    }
    return envValue
  })
}

/**
 * Substitutes environment variable references in all values of a record.
 */
function substituteEnvInRecord(
  record: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    result[key] = substituteEnvInValue(value)
  }
  return result
}

function hashConfig(config: MCPConfig): string {
  if (config.type === 'stdio') {
    return JSON.stringify({
      command: config.command,
      args: config.args,
      env: config.env,
    })
  }
  if (config.type === 'http') {
    return JSON.stringify({
      type: 'http',
      url: config.url,
      params: config.params,
    })
  }
  if (config.type === 'sse') {
    return JSON.stringify({
      type: 'sse',
      url: config.url,
      params: config.params,
    })
  }
  config.type satisfies never
  throw new Error(
    `Internal error in hashConfig: invalid MCP config type ${config.type}`,
  )
}

export async function getMCPClient(config: MCPConfig): Promise<string> {
  const key = hashConfig(config)
  if (key in runningClients) {
    return key
  }
  // Replay a prior failure for this exact config — avoids hammering a broken
  // server on every agent step. Cleared automatically on session restart and
  // can be invalidated explicitly via resetMCPConnectionFailures().
  const priorFailure = failedConnections.get(key)
  if (priorFailure) {
    throw priorFailure
  }
  // Coalesce concurrent connection attempts to the same server. Without this,
  // 50 agent steps starting in parallel would each spawn their own child for
  // the same broken server, blocking until each one independently times out.
  const inFlight = pendingConnections.get(key)
  if (inFlight) {
    return inFlight
  }

  const connectPromise = connectMCPClient(config, key).finally(() => {
    pendingConnections.delete(key)
  })
  pendingConnections.set(key, connectPromise)
  return connectPromise
}

async function connectMCPClient(
  config: MCPConfig,
  key: string,
): Promise<string> {
  let transport: Transport
  // Capture stderr for stdio transports so that startup failures (which
  // surface to the protocol as a generic "Connection closed") can be
  // explained to the user with the actual error text from the child.
  let stderrTailRef: { value: string } | null = null
  if (config.type === 'stdio') {
    const stdioTransport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: substituteEnvInRecord(config.env),
      stderr: 'pipe',
    })
    stderrTailRef = { value: '' }
    stdioTransport.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const combined = stderrTailRef!.value + text
      stderrTailRef!.value =
        combined.length > STDERR_TAIL_BYTES
          ? combined.slice(combined.length - STDERR_TAIL_BYTES)
          : combined
    })
    transport = stdioTransport
  } else {
    const url = new URL(config.url)
    for (const [key, value] of Object.entries(config.params)) {
      url.searchParams.set(key, value)
    }
    const headers = substituteEnvInRecord(config.headers)
    if (config.type === 'http') {
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers,
        },
      })
    } else if (config.type === 'sse') {
      transport = new SSEClientTransport(url, {
        requestInit: {
          headers,
        },
      })
    } else {
      config.type satisfies never
      throw new Error(`Internal error: invalid MCP config type ${config.type}`)
    }
  }

  const client = new Client({
    name: 'codebuff',
    version: '1.0.0',
  })

  // Install onclose BEFORE connect() — the server can die in the microseconds
  // between connect resolving and us assigning the handler, and we'd otherwise
  // store a dead client in runningClients forever. The identity guard makes
  // this a no-op if it fires before runningClients[key] is set.
  client.onclose = () => {
    if (runningClients[key] === client) {
      delete runningClients[key]
      delete listToolsCache[key]
    }
  }

  try {
    await client.connect(transport)
  } catch (err) {
    const baseMessage = err instanceof Error ? err.message : String(err)
    const stderrTail = stderrTailRef?.value?.trim() ?? ''
    const suggestion = stderrTail ? suggestionForStderr(stderrTail) : null
    const parts = [baseMessage]
    if (stderrTail) parts.push(`stderr: ${stderrTail}`)
    if (suggestion) parts.push(suggestion)
    const enriched = new Error(parts.join('\n'))
    if (err instanceof Error && err.stack) enriched.stack = err.stack
    failedConnections.set(key, enriched)
    throw enriched
  }

  runningClients[key] = client
  return key
}

/**
 * Forget any cached connection failures so the next getMCPClient() call
 * retries the underlying server. Intended for explicit user-driven retries
 * (e.g. a UI "reconnect" action) and for tests.
 */
export function resetMCPConnectionFailures(): void {
  failedConnections.clear()
  pendingConnections.clear()
}

export function listMCPTools(
  clientId: string,
  ...args: Parameters<typeof Client.prototype.listTools>
): ReturnType<typeof Client.prototype.listTools> {
  const client = runningClients[clientId]
  if (!client) {
    throw new Error(`listTools: client not found with id: ${clientId}`)
  }
  if (!listToolsCache[clientId]) {
    listToolsCache[clientId] = client.listTools(...args)
  }
  return listToolsCache[clientId]
}

function getResourceData(
  resource: TextResourceContents | BlobResourceContents,
): string {
  if ('text' in resource) return resource.text as string
  if ('blob' in resource) return resource.blob as string
  return ''
}

export async function callMCPTool(
  clientId: string,
  ...args: Parameters<typeof Client.prototype.callTool>
): Promise<ToolResultOutput[]> {
  const client = runningClients[clientId]
  if (!client) {
    throw new Error(`callTool: client not found with id: ${clientId}`)
  }
  const callResult = await client.callTool(...args)
  const result = callResult as CallToolResult
  const content = result.content

  return content.map((c: (typeof content)[number]) => {
    if (c.type === 'text') {
      return {
        type: 'json',
        value: c.text,
      } satisfies ToolResultOutput
    }
    if (c.type === 'audio') {
      return {
        type: 'media',
        data: c.data,
        mediaType: c.mimeType,
      } satisfies ToolResultOutput
    }
    if (c.type === 'image') {
      return {
        type: 'media',
        data: c.data,
        mediaType: c.mimeType,
      } satisfies ToolResultOutput
    }
    if (c.type === 'resource') {
      return {
        type: 'media',
        data: getResourceData(c.resource),
        mediaType: c.resource.mimeType ?? 'text/plain',
      } satisfies ToolResultOutput
    }
    const fallbackValue =
      'uri' in c && typeof (c as { uri: unknown }).uri === 'string'
        ? (c as { uri: string }).uri
        : JSON.stringify(c)
    return {
      type: 'json',
      value: fallbackValue,
    } satisfies ToolResultOutput
  })
}
