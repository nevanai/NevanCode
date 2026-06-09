import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import type {
  MarketplacePlugin,
  PluginManifest,
  InstalledPlugin,
  InstalledPluginsRegistry,
  PluginSource,
} from '@codebuff/common/types/plugin'

// ---------------------------------------------------------------------------
// Paths (computed dynamically so os.homedir() spy works in tests)
// ---------------------------------------------------------------------------

const MARKETPLACE_REPO_URL = 'https://github.com/anthropics/claude-plugins-official.git'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

const paths = {
  codebuffDir: () => path.join(os.homedir(), '.codebuff'),
  pluginsCacheDir: () => path.join(paths.codebuffDir(), 'plugins-cache'),
  marketplaceCacheFile: () => path.join(paths.pluginsCacheDir(), 'marketplace.json'),
  marketplaceMetaFile: () => path.join(paths.pluginsCacheDir(), 'marketplace.meta.json'),
  marketplaceRepoDir: () => path.join(paths.pluginsCacheDir(), 'marketplace'),
  installedPluginsDir: () => path.join(paths.codebuffDir(), 'plugins'),
  installedRegistryFile: () => path.join(paths.installedPluginsDir(), 'installed.json'),
  agentsSkillsDir: () => path.join(os.homedir(), '.agents', 'skills'),
  agentsMcpFile: () => path.join(os.homedir(), '.agents', 'mcp.json'),
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
}

function isCacheStale(): boolean {
  const meta = readJson<{ updatedAt: string }>(paths.marketplaceMetaFile())
  if (!meta) return true
  return Date.now() - new Date(meta.updatedAt).getTime() > CACHE_TTL_MS
}

// ---------------------------------------------------------------------------
// Marketplace fetching
// ---------------------------------------------------------------------------

/**
 * Clone or pull the marketplace repo to the local cache dir.
 * Uses git shallow clone for speed.
 */
export function refreshMarketplaceRepo(): void {
  ensureDir(paths.pluginsCacheDir())

  const repoDir = paths.marketplaceRepoDir()

  if (fs.existsSync(path.join(repoDir, '.git'))) {
    // Pull latest
    spawnSync('git', ['-C', repoDir, 'pull', '--ff-only', '--depth=1'], {
      stdio: 'pipe',
    })
  } else {
    // Fresh clone
    ensureDir(repoDir)
    spawnSync(
      'git',
      ['clone', '--depth=1', MARKETPLACE_REPO_URL, repoDir],
      { stdio: 'pipe' },
    )
  }

  // Copy marketplace.json to the flat cache
  const marketplaceJsonPath = path.join(repoDir, '.claude-plugin', 'marketplace.json')
  if (fs.existsSync(marketplaceJsonPath)) {
    fs.copyFileSync(marketplaceJsonPath, paths.marketplaceCacheFile())
    writeJson(paths.marketplaceMetaFile(), { updatedAt: new Date().toISOString() })
  }
}

/**
 * Fetch marketplace plugins, refreshing cache if stale.
 * @param forceRefresh - Force a cache refresh even if TTL hasn't expired
 */
export async function getMarketplacePlugins(forceRefresh = false): Promise<MarketplacePlugin[]> {
  const cacheFile = paths.marketplaceCacheFile()
  if (forceRefresh || isCacheStale() || !fs.existsSync(cacheFile)) {
    refreshMarketplaceRepo()
  }

  const manifest = readJson<PluginManifest>(cacheFile)
  if (!manifest) return []

  return manifest.plugins
}

/**
 * Get plugins from cache only (no network call).
 * Returns empty array if cache doesn't exist.
 */
export function getMarketplacePluginsFromCache(): MarketplacePlugin[] {
  const manifest = readJson<PluginManifest>(paths.marketplaceCacheFile())
  return manifest?.plugins ?? []
}

// ---------------------------------------------------------------------------
// Installed plugins registry
// ---------------------------------------------------------------------------

export function readInstalledRegistry(): InstalledPluginsRegistry {
  const registry = readJson<InstalledPluginsRegistry>(paths.installedRegistryFile())
  if (registry?.version === 1) return registry
  return { version: 1, plugins: {} }
}

function saveInstalledRegistry(registry: InstalledPluginsRegistry): void {
  writeJson(paths.installedRegistryFile(), registry)
}

export function getInstalledPlugins(): InstalledPlugin[] {
  const registry = readInstalledRegistry()
  return Object.values(registry.plugins)
}

export function isPluginInstalled(name: string): boolean {
  const registry = readInstalledRegistry()
  return name in registry.plugins
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

/**
 * Get the filesystem path where a plugin is installed.
 */
export function getPluginInstallPath(name: string): string {
  return path.join(paths.installedPluginsDir(), name)
}

/**
 * Resolve the source directory for a plugin.
 * Internal plugins: from marketplace repo clone. External: cloned repo.
 */
function resolvePluginSourceDir(source: PluginSource, pluginName: string): string {
  if (typeof source === 'string') {
    const relativePath = source.replace(/^\.\//, '')
    return path.join(paths.marketplaceRepoDir(), relativePath)
  }

  if (source.source === 'git-subdir') {
    return path.join(paths.installedPluginsDir(), pluginName, 'repo', source.path)
  }

  return path.join(paths.installedPluginsDir(), pluginName, 'repo')
}

function cloneExternalRepo(url: string, dest: string, ref?: string): boolean {
  ensureDir(dest)
  const refArgs = ref ? ['--branch', ref] : []
  const result = spawnSync(
    'git',
    ['clone', '--depth=1', ...refArgs, url, dest],
    { stdio: 'pipe' },
  )
  return result.status === 0
}

/**
 * Install skills from a plugin directory by creating symlinks in ~/.agents/skills/.
 * Returns the list of installed skill names.
 */
function installPluginSkills(pluginDir: string): string[] {
  const skillsDir = path.join(pluginDir, 'skills')
  if (!fs.existsSync(skillsDir)) return []

  const agentsSkillsDir = paths.agentsSkillsDir()
  ensureDir(agentsSkillsDir)

  const installedSkills: string[] = []

  for (const entry of fs.readdirSync(skillsDir)) {
    const skillSrcDir = path.join(skillsDir, entry)
    const skillFile = path.join(skillSrcDir, 'SKILL.md')

    if (!fs.statSync(skillSrcDir).isDirectory() || !fs.existsSync(skillFile)) continue

    const destLink = path.join(agentsSkillsDir, entry)

    // Remove existing symlink/dir if present (lstat handles dangling symlinks)
    try {
      fs.lstatSync(destLink) // throws only if path truly doesn't exist
      fs.rmSync(destLink, { recursive: true, force: true })
    } catch {
      // Path doesn't exist — nothing to remove
    }

    fs.symlinkSync(skillSrcDir, destLink)
    installedSkills.push(entry)
  }

  return installedSkills
}

function uninstallPluginSkills(skillNames: string[]): void {
  const agentsSkillsDir = paths.agentsSkillsDir()

  for (const skillName of skillNames) {
    const link = path.join(agentsSkillsDir, skillName)
    try {
      if (fs.lstatSync(link).isSymbolicLink()) {
        fs.unlinkSync(link)
      }
    } catch {
      // Symlink already gone — ignore
    }
  }
}

/**
 * Merge plugin's .mcp.json entries into ~/.agents/mcp.json.
 * Returns the list of server names added.
 */
function installPluginMcp(pluginDir: string, pluginName: string): string[] {
  const mcpFile = path.join(pluginDir, '.mcp.json')
  if (!fs.existsSync(mcpFile)) return []

  const pluginMcp = readJson<Record<string, unknown>>(mcpFile)
  if (!pluginMcp) return []

  const agentsMcpFile = paths.agentsMcpFile()
  const existingMcp = readJson<{ mcpServers?: Record<string, unknown> }>(agentsMcpFile) ?? {}
  const existingServers: Record<string, unknown> = existingMcp.mcpServers ?? {}

  const addedServers: string[] = []

  for (const [serverName, serverConfig] of Object.entries(pluginMcp)) {
    const key = `plugin:${pluginName}:${serverName}`
    existingServers[key] = serverConfig
    addedServers.push(key)
  }

  ensureDir(path.dirname(agentsMcpFile))
  writeJson(agentsMcpFile, { ...existingMcp, mcpServers: existingServers })

  return addedServers
}

function uninstallPluginMcp(mcpServerNames: string[]): void {
  const agentsMcpFile = paths.agentsMcpFile()
  const existingMcp = readJson<{ mcpServers?: Record<string, unknown> }>(agentsMcpFile)
  if (!existingMcp?.mcpServers) return

  for (const key of mcpServerNames) {
    delete existingMcp.mcpServers[key]
  }

  writeJson(agentsMcpFile, existingMcp)
}

export type InstallResult =
  | { success: true; skills: string[]; mcpServers: string[] }
  | { success: false; error: string }

/**
 * Install a plugin.
 * Downloads/clones its source, installs skills + MCP, and updates the registry.
 */
export async function installPlugin(plugin: MarketplacePlugin): Promise<InstallResult> {
  const { name, source } = plugin

  try {
    ensureDir(paths.installedPluginsDir())

    // Ensure marketplace repo is cloned (needed for internal plugins)
    if (!fs.existsSync(path.join(paths.marketplaceRepoDir(), '.git'))) {
      refreshMarketplaceRepo()
    }

    let pluginDir: string

    if (typeof source === 'string') {
      // Internal plugin: copy from marketplace repo clone
      const srcDir = resolvePluginSourceDir(source, name)

      if (!fs.existsSync(srcDir)) {
        return { success: false, error: `Plugin directory not found in marketplace repo: ${source}` }
      }

      const installDir = getPluginInstallPath(name)
      if (fs.existsSync(installDir)) {
        fs.rmSync(installDir, { recursive: true, force: true })
      }
      fs.cpSync(srcDir, installDir, { recursive: true })
      pluginDir = installDir
    } else if (source.source === 'git-subdir') {
      const repoDir = path.join(paths.installedPluginsDir(), name, 'repo')
      const cloned = cloneExternalRepo(source.url, repoDir, source.ref)
      if (!cloned) {
        return { success: false, error: `Failed to clone repository: ${source.url}` }
      }
      pluginDir = path.join(repoDir, source.path)
    } else {
      // url source
      const repoDir = path.join(paths.installedPluginsDir(), name, 'repo')
      const cloned = cloneExternalRepo(source.url, repoDir)
      if (!cloned) {
        return { success: false, error: `Failed to clone repository: ${source.url}` }
      }
      pluginDir = repoDir
    }

    const skills = installPluginSkills(pluginDir)
    const mcpServers = installPluginMcp(pluginDir, name)

    // Save to registry
    const registry = readInstalledRegistry()
    registry.plugins[name] = {
      name,
      description: plugin.description,
      author: plugin.author,
      category: plugin.category,
      homepage: plugin.homepage,
      installedAt: new Date().toISOString(),
      source,
      skills,
      mcpServers,
    }
    saveInstalledRegistry(registry)

    return { success: true, skills, mcpServers }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, error: message }
  }
}

/**
 * Uninstall a plugin by name.
 */
export function uninstallPlugin(name: string): { success: boolean; error?: string } {
  try {
    const registry = readInstalledRegistry()
    const installed = registry.plugins[name]

    if (!installed) {
      return { success: false, error: `Plugin "${name}" is not installed` }
    }

    uninstallPluginSkills(installed.skills)
    uninstallPluginMcp(installed.mcpServers)

    const installDir = getPluginInstallPath(name)
    if (fs.existsSync(installDir)) {
      fs.rmSync(installDir, { recursive: true, force: true })
    }

    delete registry.plugins[name]
    saveInstalledRegistry(registry)

    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { success: false, error: message }
  }
}
