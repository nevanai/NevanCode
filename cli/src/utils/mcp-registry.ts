import fs from 'fs'
import os from 'os'
import path from 'path'

import type { MCPConfig } from '@codebuff/common/types/mcp'

const GLOBAL_MCP_FILE = path.join(os.homedir(), '.agents', 'mcp.json')

const MCP_SEARCH_DIRS = [
  path.join(process.cwd(), '.agents'),
  path.join(process.cwd(), '..', '.agents'),
  path.join(os.homedir(), '.agents'),
]

export type McpSource = 'builtin' | 'plugin' | 'user'

export type McpServerEntry = {
  /** The key used in the config file (may be a container key for nested plugin MCPs) */
  containerKey: string
  /** Human-readable server name */
  name: string
  config: MCPConfig
  source: McpSource
  pluginName?: string
  /** Path to the config file this came from (empty for built-ins) */
  configFile: string
}

// ── Built-in MCP descriptions ─────────────────────────────────────────────────

const BUILTIN_MCP_NAME = 'nevancode-mcp'

const BUILTIN_TOOL_DESCRIPTIONS: Record<string, string> = {
  [BUILTIN_MCP_NAME]: 'Computer Use · Browser (Playwright) · File Manager',
}

// ── Raw file reading ──────────────────────────────────────────────────────────

type RawMcpFile = {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

function readRawMcpFile(filePath: string): RawMcpFile {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as RawMcpFile
  } catch {
    return {}
  }
}

function writeMcpFile(filePath: string, data: RawMcpFile): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n')
}

function isValidMcpConfig(obj: unknown): obj is MCPConfig {
  if (!obj || typeof obj !== 'object') return false
  const o = obj as Record<string, unknown>
  if ('command' in o && typeof o.command === 'string') return true
  if ('url' in o && typeof o.url === 'string') return true
  return false
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse a single top-level entry from mcpServers.
 *
 * Two formats exist in ~/.agents/mcp.json:
 *
 * 1. Direct MCPConfig:
 *    "my-server": { "command": "npx", "args": ["server"] }
 *
 * 2. Plugin nested container (installed by installPluginMcp when the plugin's
 *    .mcp.json has a top-level "mcpServers" key):
 *    "plugin:NAME:mcpServers": { "serverName": MCPConfig, ... }
 */
function parseRawEntry(
  topKey: string,
  value: unknown,
  filePath: string,
): McpServerEntry[] {
  // Direct MCPConfig
  if (isValidMcpConfig(value)) {
    const isPlugin = topKey.startsWith('plugin:')
    const pluginName = isPlugin ? topKey.split(':')[1] : undefined
    return [
      {
        containerKey: topKey,
        name: topKey,
        config: value,
        source: isPlugin ? 'plugin' : 'user',
        pluginName,
        configFile: filePath,
      },
    ]
  }

  // Plugin nested container: "plugin:NAME:mcpServers" → { serverName: MCPConfig }
  const PLUGIN_CONTAINER_RE = /^plugin:(.+):mcpServers$/
  const match = topKey.match(PLUGIN_CONTAINER_RE)
  if (match && value && typeof value === 'object') {
    const pluginName = match[1]!
    const entries: McpServerEntry[] = []
    for (const [serverName, serverConfig] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (isValidMcpConfig(serverConfig)) {
        entries.push({
          containerKey: topKey,
          name: serverName,
          config: serverConfig,
          source: 'plugin',
          pluginName,
          configFile: filePath,
        })
      }
    }
    return entries
  }

  return []
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Returns all MCP servers known to Nevan Code:
 *
 * 1. Built-in servers (auto-registered at startup, e.g. nevancode-mcp with
 *    Computer Use, Browser, and File Manager tools).
 * 2. Plugin servers (installed via /plugin, stored in ~/.agents/mcp.json in
 *    a nested "plugin:NAME:mcpServers" format).
 * 3. User servers (manually added directly to ~/.agents/mcp.json).
 *
 * Sources are read from:
 * - getLoadedMCPServers() from local-agent-registry (built-ins + validated entries)
 * - Raw ~/.agents/mcp.json parsing (plugin nested format)
 */
export function getMcpServers(): McpServerEntry[] {
  // Import here to avoid circular dep at module-init time
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getLoadedMCPServers } = require('./local-agent-registry') as {
    getLoadedMCPServers: () => Record<string, MCPConfig>
  }

  const result = new Map<string, McpServerEntry>()

  // 1. Registered MCPs (includes built-in nevancode-mcp + validated user entries)
  const loaded = getLoadedMCPServers()
  for (const [name, config] of Object.entries(loaded)) {
    const isBuiltin = name === BUILTIN_MCP_NAME
    const isPlugin = !isBuiltin && name.startsWith('plugin:')
    result.set(`${name}|${name}`, {
      containerKey: name,
      name,
      config,
      source: isBuiltin ? 'builtin' : isPlugin ? 'plugin' : 'user',
      pluginName: isPlugin ? name.split(':')[1] : undefined,
      configFile: '',
    })
  }

  // 2. Raw plugin MCPs from .agents/mcp.json (nested format ignored by loadMCPConfigSync)
  for (const dir of MCP_SEARCH_DIRS) {
    const filePath = path.join(dir, 'mcp.json')
    if (!fs.existsSync(filePath)) continue

    const raw = readRawMcpFile(filePath)
    if (!raw.mcpServers) continue

    for (const [topKey, value] of Object.entries(raw.mcpServers)) {
      const entries = parseRawEntry(topKey, value, filePath)
      for (const entry of entries) {
        const key = `${entry.containerKey}|${entry.name}`
        if (!result.has(key)) {
          result.set(key, entry)
        }
      }
    }
  }

  return Array.from(result.values())
}

/**
 * Returns a unique list key for an entry (used as React key and for lookup).
 */
export function getMcpEntryKey(entry: McpServerEntry): string {
  return `${entry.containerKey}|${entry.name}`
}

/**
 * Remove a plugin/user MCP from its config file.
 * Returns 'ok' on success, 'builtin' if the server is built-in (cannot remove),
 * or 'error' on failure.
 */
export function disableMcpServer(
  entry: McpServerEntry,
): 'ok' | 'builtin' | 'error' {
  if (entry.source === 'builtin') return 'builtin'
  if (!entry.configFile) return 'error'

  try {
    const raw = readRawMcpFile(entry.configFile)
    if (!raw.mcpServers) return 'error'

    const topValue = raw.mcpServers[entry.containerKey]

    if (isValidMcpConfig(topValue)) {
      // Direct entry
      delete raw.mcpServers[entry.containerKey]
    } else if (topValue && typeof topValue === 'object') {
      // Nested plugin container
      const container = topValue as Record<string, unknown>
      delete container[entry.name]
      if (Object.keys(container).length === 0) {
        delete raw.mcpServers[entry.containerKey]
      } else {
        raw.mcpServers[entry.containerKey] = container
      }
    } else {
      return 'error'
    }

    writeMcpFile(entry.configFile, raw)
    return 'ok'
  } catch {
    return 'error'
  }
}

/**
 * Clear auth credentials (env tokens / HTTP headers) from an MCP server config.
 * Returns true if anything was cleared.
 */
export function clearMcpAuth(entry: McpServerEntry): boolean {
  if (entry.source === 'builtin' || !entry.configFile) return false

  const AUTH_PATTERN = /token|key|secret|auth|credential|password/i
  try {
    const raw = readRawMcpFile(entry.configFile)
    if (!raw.mcpServers) return false

    const topValue = raw.mcpServers[entry.containerKey]
    let configObj: Record<string, unknown> | null = null

    if (isValidMcpConfig(topValue)) {
      configObj = topValue as Record<string, unknown>
    } else if (topValue && typeof topValue === 'object') {
      const nested = (topValue as Record<string, unknown>)[entry.name]
      if (nested && typeof nested === 'object') {
        configObj = nested as Record<string, unknown>
      }
    }

    if (!configObj) return false

    let changed = false

    if (configObj.env && typeof configObj.env === 'object') {
      const env = configObj.env as Record<string, string>
      for (const key of Object.keys(env)) {
        if (AUTH_PATTERN.test(key)) {
          delete env[key]
          changed = true
        }
      }
    }

    if (configObj.headers && typeof configObj.headers === 'object') {
      const headers = configObj.headers as Record<string, string>
      for (const key of Object.keys(headers)) {
        if (/authorization|x-api-key|bearer/i.test(key)) {
          delete headers[key]
          changed = true
        }
      }
    }

    if (changed) writeMcpFile(entry.configFile, raw)
    return changed
  } catch {
    return false
  }
}

// ── Display helpers ───────────────────────────────────────────────────────────

/** Transport type label */
export function getMcpTypeLabel(entry: McpServerEntry): string {
  const c = entry.config
  if ('command' in c) return 'stdio'
  return c.type ?? 'http'
}

/** Short connection endpoint description */
export function getMcpConnectionInfo(entry: McpServerEntry): string {
  const c = entry.config
  if ('command' in c) {
    const argSuffix =
      c.args && c.args.length > 0
        ? ' ' + c.args.slice(0, 2).join(' ') + (c.args.length > 2 ? '…' : '')
        : ''
    return c.command + argSuffix
  }
  return c.url
}

/** Built-in tool description if available */
export function getMcpBuiltinDescription(entry: McpServerEntry): string | null {
  return BUILTIN_TOOL_DESCRIPTIONS[entry.name] ?? null
}

/** Human-readable display name */
export function getMcpDisplayName(entry: McpServerEntry): string {
  return entry.name
}

/** Replace homedir with ~ for display */
export function formatMcpConfigPath(filePath: string): string {
  if (!filePath) return '(built-in)'
  const home = os.homedir()
  return filePath.startsWith(home) ? filePath.replace(home, '~') : filePath
}

export { GLOBAL_MCP_FILE, BUILTIN_MCP_NAME }
