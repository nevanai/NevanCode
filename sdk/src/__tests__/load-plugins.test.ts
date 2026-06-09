import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import {
  getMarketplacePluginsFromCache,
  getInstalledPlugins,
  isPluginInstalled,
  readInstalledRegistry,
  uninstallPlugin,
} from '../plugins/load-plugins'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeMarketplaceJson(cacheDir: string, plugins: unknown[]): void {
  const claudePluginDir = path.join(cacheDir, 'plugins-cache')
  mkdirSync(claudePluginDir, { recursive: true })
  writeFileSync(
    path.join(claudePluginDir, 'marketplace.json'),
    JSON.stringify({
      $schema: 'https://example.com/schema.json',
      name: 'test-marketplace',
      description: 'Test',
      plugins,
    }),
    'utf8',
  )
}

function writeInstalledRegistry(pluginsDir: string, registry: unknown): void {
  mkdirSync(pluginsDir, { recursive: true })
  writeFileSync(
    path.join(pluginsDir, 'installed.json'),
    JSON.stringify(registry),
    'utf8',
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getMarketplacePluginsFromCache', () => {
  let tempRoot: string
  let codebuffDir: string

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'codebuff-plugins-test-'))
    codebuffDir = path.join(tempRoot, '.codebuff')
    spyOn(os, 'homedir').mockReturnValue(tempRoot)
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('returns empty array when cache file does not exist', () => {
    const plugins = getMarketplacePluginsFromCache()
    expect(plugins).toEqual([])
  })

  test('returns plugins from cache file', () => {
    writeMarketplaceJson(codebuffDir, [
      {
        name: 'test-plugin',
        description: 'A test plugin',
        category: 'development',
        source: './plugins/test-plugin',
      },
    ])

    const plugins = getMarketplacePluginsFromCache()
    expect(plugins).toHaveLength(1)
    expect(plugins[0]?.name).toBe('test-plugin')
    expect(plugins[0]?.description).toBe('A test plugin')
  })

  test('returns empty array on malformed JSON', () => {
    const cacheDir = path.join(codebuffDir, 'plugins-cache')
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(path.join(cacheDir, 'marketplace.json'), 'not json', 'utf8')

    const plugins = getMarketplacePluginsFromCache()
    expect(plugins).toEqual([])
  })
})

describe('readInstalledRegistry', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'codebuff-plugins-test-'))
    spyOn(os, 'homedir').mockReturnValue(tempRoot)
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('returns empty registry when file does not exist', () => {
    const registry = readInstalledRegistry()
    expect(registry.version).toBe(1)
    expect(registry.plugins).toEqual({})
  })

  test('reads existing registry', () => {
    const pluginsDir = path.join(tempRoot, '.codebuff', 'plugins')
    writeInstalledRegistry(pluginsDir, {
      version: 1,
      plugins: {
        'my-plugin': {
          name: 'my-plugin',
          description: 'A plugin',
          installedAt: '2024-01-01T00:00:00.000Z',
          source: './plugins/my-plugin',
          skills: ['my-skill'],
          mcpServers: [],
        },
      },
    })

    const registry = readInstalledRegistry()
    expect(registry.version).toBe(1)
    expect(Object.keys(registry.plugins)).toHaveLength(1)
    expect(registry.plugins['my-plugin']?.name).toBe('my-plugin')
  })
})

describe('isPluginInstalled', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'codebuff-plugins-test-'))
    spyOn(os, 'homedir').mockReturnValue(tempRoot)
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('returns false when plugin is not installed', () => {
    expect(isPluginInstalled('nonexistent-plugin')).toBe(false)
  })

  test('returns true when plugin is installed', () => {
    const pluginsDir = path.join(tempRoot, '.codebuff', 'plugins')
    writeInstalledRegistry(pluginsDir, {
      version: 1,
      plugins: {
        'installed-plugin': {
          name: 'installed-plugin',
          description: 'An installed plugin',
          installedAt: '2024-01-01T00:00:00.000Z',
          source: './plugins/installed-plugin',
          skills: [],
          mcpServers: [],
        },
      },
    })

    expect(isPluginInstalled('installed-plugin')).toBe(true)
    expect(isPluginInstalled('not-installed')).toBe(false)
  })
})

describe('getInstalledPlugins', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'codebuff-plugins-test-'))
    spyOn(os, 'homedir').mockReturnValue(tempRoot)
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('returns empty array when no plugins installed', () => {
    expect(getInstalledPlugins()).toEqual([])
  })

  test('returns all installed plugins', () => {
    const pluginsDir = path.join(tempRoot, '.codebuff', 'plugins')
    writeInstalledRegistry(pluginsDir, {
      version: 1,
      plugins: {
        'plugin-a': {
          name: 'plugin-a',
          description: 'Plugin A',
          installedAt: '2024-01-01T00:00:00.000Z',
          source: './plugins/plugin-a',
          skills: ['skill-a'],
          mcpServers: ['server-a'],
        },
        'plugin-b': {
          name: 'plugin-b',
          description: 'Plugin B',
          installedAt: '2024-01-02T00:00:00.000Z',
          source: './plugins/plugin-b',
          skills: [],
          mcpServers: [],
        },
      },
    })

    const plugins = getInstalledPlugins()
    expect(plugins).toHaveLength(2)
    const names = plugins.map((p) => p.name).sort()
    expect(names).toEqual(['plugin-a', 'plugin-b'])
  })
})

describe('uninstallPlugin', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'codebuff-plugins-test-'))
    spyOn(os, 'homedir').mockReturnValue(tempRoot)
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('returns error when plugin not installed', () => {
    const result = uninstallPlugin('nonexistent')
    expect(result.success).toBe(false)
    expect(result.error).toContain('not installed')
  })

  test('removes plugin from registry', () => {
    const pluginsDir = path.join(tempRoot, '.codebuff', 'plugins')
    writeInstalledRegistry(pluginsDir, {
      version: 1,
      plugins: {
        'removable-plugin': {
          name: 'removable-plugin',
          description: 'To be removed',
          installedAt: '2024-01-01T00:00:00.000Z',
          source: './plugins/removable-plugin',
          skills: [],
          mcpServers: [],
        },
      },
    })

    const result = uninstallPlugin('removable-plugin')
    expect(result.success).toBe(true)
    expect(isPluginInstalled('removable-plugin')).toBe(false)
  })
})
