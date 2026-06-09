/**
 * Plugin type definitions for the Claude Plugins marketplace.
 * Based on the official Anthropic claude-plugins-official repo format.
 */

export type PluginSourceInternal = string // e.g. "./plugins/example-plugin"

export type PluginSourceGitSubdir = {
  source: 'git-subdir'
  url: string
  path: string
  ref: string
  sha: string
}

export type PluginSourceUrl = {
  source: 'url'
  url: string
  sha: string
}

export type PluginSource = PluginSourceInternal | PluginSourceGitSubdir | PluginSourceUrl

export type PluginAuthor = {
  name: string
  email?: string
}

/** A plugin entry as it appears in marketplace.json */
export type MarketplacePlugin = {
  name: string
  description: string
  author?: PluginAuthor
  category?: string
  source: PluginSource
  homepage?: string
}

/** marketplace.json root */
export type PluginManifest = {
  $schema?: string
  name: string
  description: string
  owner?: { name: string; email?: string }
  plugins: MarketplacePlugin[]
}

/** A plugin that has been installed locally */
export type InstalledPlugin = {
  name: string
  description: string
  author?: PluginAuthor
  category?: string
  homepage?: string
  installedAt: string // ISO timestamp
  source: PluginSource
  /** Skills activated from this plugin */
  skills: string[]
  /** MCP server names activated from this plugin */
  mcpServers: string[]
}

/** The installed.json registry file */
export type InstalledPluginsRegistry = {
  version: 1
  plugins: Record<string, InstalledPlugin>
}
