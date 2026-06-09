import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

import {
  getPlugins,
  getInstalled,
  checkInstalled,
  __resetPluginRegistryForTests,
} from '../plugin-registry'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeMarketplaceJson(root: string, plugins: unknown[]): void {
  const cacheDir = path.join(root, '.codebuff', 'plugins-cache')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(
    path.join(cacheDir, 'marketplace.json'),
    JSON.stringify({ name: 'test', description: 'test', plugins }),
    'utf8',
  )
}

function writeInstalledRegistry(root: string, registry: unknown): void {
  const pluginsDir = path.join(root, '.codebuff', 'plugins')
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

describe('plugin-registry', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'codebuff-plugin-registry-test-'))
    spyOn(os, 'homedir').mockReturnValue(tempRoot)
    __resetPluginRegistryForTests()
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  describe('getPlugins', () => {
    test('returns empty array when no cache exists', () => {
      expect(getPlugins()).toEqual([])
    })
  })

  describe('getInstalled', () => {
    test('returns empty array when nothing installed', () => {
      expect(getInstalled()).toEqual([])
    })

    test('returns installed plugins from registry', () => {
      writeInstalledRegistry(tempRoot, {
        version: 1,
        plugins: {
          'test-plugin': {
            name: 'test-plugin',
            description: 'A test',
            installedAt: '2024-01-01T00:00:00.000Z',
            source: './plugins/test-plugin',
            skills: [],
            mcpServers: [],
          },
        },
      })

      const installed = getInstalled()
      expect(installed).toHaveLength(1)
      expect(installed[0]?.name).toBe('test-plugin')
    })
  })

  describe('checkInstalled', () => {
    test('returns false for plugin that is not installed', () => {
      expect(checkInstalled('nonexistent')).toBe(false)
    })

    test('returns true for plugin that is installed', () => {
      writeInstalledRegistry(tempRoot, {
        version: 1,
        plugins: {
          'installed-one': {
            name: 'installed-one',
            description: 'Installed',
            installedAt: '2024-01-01T00:00:00.000Z',
            source: './plugins/installed-one',
            skills: [],
            mcpServers: [],
          },
        },
      })

      expect(checkInstalled('installed-one')).toBe(true)
      expect(checkInstalled('not-installed')).toBe(false)
    })
  })
})
