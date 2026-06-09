import {
  getMarketplacePlugins,
  getMarketplacePluginsFromCache,
  getInstalledPlugins,
  installPlugin as sdkInstallPlugin,
  uninstallPlugin as sdkUninstallPlugin,
  isPluginInstalled,
  refreshMarketplaceRepo,
  readInstalledRegistry,
} from '@codebuff/sdk'

import { initializeSkillRegistry } from './skill-registry'
import { usePluginStore } from '../state/plugin-store'
import { logger } from './logger'

import type { MarketplacePlugin, InstalledPlugin } from '@codebuff/common/types/plugin'

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let marketplaceCache: MarketplacePlugin[] = []
let registryInitialized = false

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the plugin registry.
 * Loads plugins from the local cache (fast path), then triggers a background
 * refresh if the cache is stale (> 24h).
 */
export async function initializePluginRegistry(): Promise<void> {
  if (registryInitialized) return

  // Load from cache synchronously (no network) — always fast
  marketplaceCache = getMarketplacePluginsFromCache()

  // Start background refresh if cache is empty (first run)
  if (marketplaceCache.length === 0) {
    refreshPluginsInBackground()
  }

  registryInitialized = true
}

// ---------------------------------------------------------------------------
// Background refresh
// ---------------------------------------------------------------------------

let backgroundRefreshPromise: Promise<void> | null = null

function refreshPluginsInBackground(): void {
  if (backgroundRefreshPromise) return

  backgroundRefreshPromise = getMarketplacePlugins(false)
    .then((plugins) => {
      marketplaceCache = plugins
    })
    .catch((error) => {
      logger.warn({ error }, '[plugin-registry] Background refresh failed')
    })
    .finally(() => {
      backgroundRefreshPromise = null
    })
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * Get all marketplace plugins.
 * Returns cached list immediately; triggers background refresh if stale.
 */
export function getPlugins(): MarketplacePlugin[] {
  return marketplaceCache
}

/**
 * Force-refresh the marketplace and return updated list.
 */
export async function refreshPlugins(): Promise<MarketplacePlugin[]> {
  try {
    refreshMarketplaceRepo()
    marketplaceCache = getMarketplacePluginsFromCache()
  } catch (error) {
    logger.warn({ error }, '[plugin-registry] Refresh failed')
  }
  return marketplaceCache
}

/**
 * Get all installed plugins.
 */
export function getInstalled(): InstalledPlugin[] {
  return getInstalledPlugins()
}

/**
 * Check if a plugin is installed.
 */
export function checkInstalled(name: string): boolean {
  return isPluginInstalled(name)
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

export type InstallResult =
  | { success: true; skillCount: number; mcpCount: number }
  | { success: false; error: string }

/**
 * Install a plugin by name.
 * Looks up the plugin in the marketplace, downloads it, and activates skills/MCP.
 * Safe to call from agent context (non-interactive).
 */
export async function install(pluginName: string): Promise<InstallResult> {
  // Find plugin in marketplace
  const plugin = marketplaceCache.find((p) => p.name === pluginName)
  if (!plugin) {
    return { success: false, error: `Plugin "${pluginName}" not found in marketplace` }
  }

  const result = await sdkInstallPlugin(plugin)

  if (!result.success) {
    return { success: false, error: result.error }
  }

  // Hot-reload skills so the agent can use them immediately
  try {
    await initializeSkillRegistry()
    usePluginStore.getState().bumpSkillsVersion()
  } catch {
    // Non-fatal — skills will be available on next restart
  }

  return {
    success: true,
    skillCount: result.skills.length,
    mcpCount: result.mcpServers.length,
  }
}

export type UninstallResult =
  | { success: true }
  | { success: false; error: string }

/**
 * Uninstall a plugin by name.
 */
export async function uninstall(pluginName: string): Promise<UninstallResult> {
  const result = sdkUninstallPlugin(pluginName)

  if (!result.success) {
    return { success: false, error: result.error ?? 'Unknown error' }
  }

  // Hot-reload skills
  try {
    await initializeSkillRegistry()
    usePluginStore.getState().bumpSkillsVersion()
  } catch {
    // Non-fatal
  }

  return { success: true }
}

// ---------------------------------------------------------------------------
// Testing utilities
// ---------------------------------------------------------------------------

export function __resetPluginRegistryForTests(): void {
  marketplaceCache = []
  registryInitialized = false
  backgroundRefreshPromise = null
}
