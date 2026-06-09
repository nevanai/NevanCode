import { TextAttributes } from '@opentui/core'
import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { MultilineInput } from './multiline-input'
import { SelectableList } from './selectable-list'
import { useSearchableList } from '../hooks/use-searchable-list'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import {
  getPlugins,
  getInstalled,
  install,
  uninstall,
  refreshPlugins,
} from '../utils/plugin-registry'

import type { SelectableListItem } from './selectable-list'

const LAYOUT = {
  CONTENT_PADDING: 4,
  COMPACT_MODE_THRESHOLD: 20,
  MAX_RENDERED_PLUGINS: 150,
  DESC_MAX_LEN: 60,
} as const

type TabId = 'discover' | 'installed' | 'errors'

interface PluginDiscoverScreenProps {
  onCancel: () => void
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

export const PluginDiscoverScreen: React.FC<PluginDiscoverScreenProps> = ({ onCancel }) => {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalLayout()

  const contentWidth = terminalWidth - LAYOUT.CONTENT_PADDING
  const isCompactMode = terminalHeight < LAYOUT.COMPACT_MODE_THRESHOLD

  const [activeTab, setActiveTab] = useState<TabId>('discover')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [loadingPlugin, setLoadingPlugin] = useState<string | null>(null)
  const [errors, setErrors] = useState<{ plugin: string; message: string }[]>([])
  const [installedNames, setInstalledNames] = useState<Set<string>>(() => {
    return new Set(getInstalled().map((p) => p.name))
  })
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Items the user has marked with Space (pending install/uninstall)
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set())

  const allPlugins = useMemo(() => getPlugins(), [])
  const installedPlugins = useMemo(() => getInstalled(), [installedNames])

  // ---------------------------------------------------------------------------
  // Build list items — icon encodes installed + selected state
  // ---------------------------------------------------------------------------

  const discoverItems: SelectableListItem[] = useMemo(
    () =>
      allPlugins.map((plugin) => {
        const installed = installedNames.has(plugin.name)
        const selected = selectedNames.has(plugin.name)
        // ○ = not installed  ◉ = selected for install  ● = installed  ◎ = selected for uninstall
        const icon = installed ? (selected ? '◎' : '●') : (selected ? '◉' : '○')
        const author = plugin.author?.name ?? 'community'
        const category = plugin.category ?? ''
        const desc = truncate(plugin.description, LAYOUT.DESC_MAX_LEN)
        return {
          id: plugin.name,
          label: `${icon} ${plugin.name} · ${author}${category ? ` · ${category}` : ''}`,
          secondary: desc,
          accent: installed || selected,
        }
      }),
    [allPlugins, installedNames, selectedNames],
  )

  const installedItems: SelectableListItem[] = useMemo(
    () =>
      installedPlugins.map((plugin) => {
        const selected = selectedNames.has(plugin.name)
        const icon = selected ? '◎' : '●'
        const desc = truncate(plugin.description, LAYOUT.DESC_MAX_LEN)
        return {
          id: plugin.name,
          label: `${icon} ${plugin.name}`,
          secondary: desc,
          accent: true,
        }
      }),
    [installedPlugins, selectedNames],
  )

  const errorItems: SelectableListItem[] = useMemo(
    () =>
      errors.map((e, i) => ({
        id: `error-${i}`,
        label: `✗ ${e.plugin}`,
        secondary: e.message,
      })),
    [errors],
  )

  const activeItems =
    activeTab === 'discover'
      ? discoverItems
      : activeTab === 'installed'
        ? installedItems
        : errorItems

  // ---------------------------------------------------------------------------
  // Search + focus
  // ---------------------------------------------------------------------------

  const filterPlugin = useCallback(
    (item: SelectableListItem, query: string) => {
      const q = query.toLowerCase()
      return item.label.toLowerCase().includes(q) || (item.secondary ?? '').toLowerCase().includes(q)
    },
    [],
  )

  const {
    searchQuery,
    setSearchQuery,
    focusedIndex,
    setFocusedIndex,
    filteredItems,
    handleFocusChange,
  } = useSearchableList({ items: activeItems, filterFn: filterPlugin })

  // Reset focus and selection when tab changes
  useEffect(() => {
    setFocusedIndex(0)
    setSearchQuery('')
    setSelectedNames(new Set())
  }, [activeTab, setFocusedIndex, setSearchQuery])

  // ---------------------------------------------------------------------------
  // Selection (Space)
  // ---------------------------------------------------------------------------

  const handleToggleSelection = useCallback(
    (pluginName: string) => {
      if (activeTab === 'errors') return
      setSelectedNames((prev) => {
        const next = new Set(prev)
        if (next.has(pluginName)) {
          next.delete(pluginName)
        } else {
          next.add(pluginName)
        }
        return next
      })
    },
    [activeTab],
  )

  // ---------------------------------------------------------------------------
  // Install / uninstall selected (Enter)
  // ---------------------------------------------------------------------------

  const handleInstallSelected = useCallback(async () => {
    if (loadingPlugin) return
    if (activeTab === 'errors') return

    // If nothing selected, operate on the focused item only
    const targets =
      selectedNames.size > 0
        ? [...selectedNames]
        : (() => {
            const item = filteredItems[focusedIndex]
            return item ? [item.id] : []
          })()

    if (targets.length === 0) return

    const installed: string[] = []
    const removed: string[] = []

    for (const pluginName of targets) {
      const isInstalled = installedNames.has(pluginName)
      setLoadingPlugin(pluginName)
      setStatusMessage(isInstalled ? `Removing ${pluginName}…` : `Installing ${pluginName}…`)

      if (isInstalled) {
        const result = await uninstall(pluginName)
        if (result.success) {
          setInstalledNames((prev) => {
            const next = new Set(prev)
            next.delete(pluginName)
            return next
          })
          removed.push(pluginName)
        } else {
          setErrors((prev) => [...prev, { plugin: pluginName, message: result.error }])
        }
      } else {
        const result = await install(pluginName)
        if (result.success) {
          setInstalledNames((prev) => new Set([...prev, pluginName]))
          installed.push(
            `${pluginName} (${result.skillCount} skill${result.skillCount !== 1 ? 's' : ''}, ${result.mcpCount} MCP)`,
          )
        } else {
          setErrors((prev) => [...prev, { plugin: pluginName, message: result.error }])
        }
      }
    }

    setLoadingPlugin(null)
    setSelectedNames(new Set())

    if (installed.length > 0 && removed.length === 0) {
      setStatusMessage(`✓ Installed: ${installed.join(', ')}`)
    } else if (removed.length > 0 && installed.length === 0) {
      setStatusMessage(`✓ Removed: ${removed.join(', ')}`)
    } else if (installed.length > 0 || removed.length > 0) {
      const parts = []
      if (installed.length > 0) parts.push(`installed: ${installed.join(', ')}`)
      if (removed.length > 0) parts.push(`removed: ${removed.join(', ')}`)
      setStatusMessage(`✓ ${parts.join(' · ')}`)
    }
  }, [loadingPlugin, activeTab, selectedNames, filteredItems, focusedIndex, installedNames])

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    setStatusMessage('Refreshing marketplace…')
    try {
      await refreshPlugins()
      setStatusMessage('Marketplace updated')
    } catch {
      setStatusMessage('Refresh failed')
    } finally {
      setIsRefreshing(false)
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  const handleKeyIntercept = useCallback(
    (key: { name?: string; shift?: boolean; ctrl?: boolean }) => {
      if (key.name === 'escape') {
        if (selectedNames.size > 0) {
          setSelectedNames(new Set())
        } else if (searchQuery.length > 0) {
          setSearchQuery('')
        } else {
          onCancel()
        }
        return true
      }

      if (key.name === 'up') {
        setFocusedIndex((prev) => Math.max(0, prev - 1))
        return true
      }

      if (key.name === 'down') {
        const maxIndex = Math.min(filteredItems.length, LAYOUT.MAX_RENDERED_PLUGINS) - 1
        setFocusedIndex((prev) => Math.min(maxIndex, prev + 1))
        return true
      }

      if (key.name === 'space') {
        const item = filteredItems[focusedIndex]
        if (item) handleToggleSelection(item.id)
        return true
      }

      if (key.name === 'return' || key.name === 'enter') {
        handleInstallSelected()
        return true
      }

      if (key.name === 'tab') {
        const tabs: TabId[] = ['discover', 'installed', 'errors']
        const currentIndex = tabs.indexOf(activeTab)
        setActiveTab(tabs[(currentIndex + 1) % tabs.length])
        return true
      }

      if (key.name === 'r' && key.ctrl) {
        handleRefresh()
        return true
      }

      if (key.name === 'c' && key.ctrl) {
        onCancel()
        return true
      }

      return false
    },
    [
      selectedNames,
      searchQuery,
      setSearchQuery,
      onCancel,
      setFocusedIndex,
      filteredItems,
      focusedIndex,
      activeTab,
      handleToggleSelection,
      handleInstallSelected,
      handleRefresh,
    ],
  )

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const tabColor = (tab: TabId) =>
    activeTab === tab ? theme.primary : theme.muted

  const tabLabel = (tab: TabId) => {
    if (tab === 'discover') return `Discover (${allPlugins.length})`
    if (tab === 'installed') return `Installed (${installedNames.size})`
    return `Errors (${errors.length})`
  }

  const pendingCount = selectedNames.size

  return (
    <box
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: theme.surface,
        padding: 0,
        flexDirection: 'column',
      }}
    >
      {/* Header + tabs */}
      <box
        style={{
          flexDirection: 'column',
          alignItems: 'flex-start',
          width: '100%',
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: isCompactMode ? 0 : 1,
          paddingBottom: 0,
          flexShrink: 0,
        }}
      >
        {!isCompactMode && (
          <box style={{ marginBottom: 1 }}>
            <text style={{ fg: theme.foreground, attributes: TextAttributes.BOLD }}>
              Plugins
            </text>
            <text style={{ fg: theme.muted }}>{' · '}</text>
            {(['discover', 'installed', 'errors'] as TabId[]).map((tab, i) => (
              <React.Fragment key={tab}>
                {i > 0 && <text style={{ fg: theme.muted }}>  </text>}
                <text
                  style={{
                    fg: tabColor(tab),
                    attributes: activeTab === tab ? TextAttributes.BOLD : TextAttributes.NONE,
                  }}
                >
                  {tabLabel(tab)}
                </text>
              </React.Fragment>
            ))}
          </box>
        )}

        {/* Search */}
        <box style={{ width: contentWidth, flexShrink: 0, marginBottom: 0 }}>
          <MultilineInput
            value={searchQuery}
            onChange={({ text }) => setSearchQuery(text)}
            onSubmit={() => {}}
            onPaste={() => {}}
            onKeyIntercept={handleKeyIntercept}
            placeholder={
              loadingPlugin
                ? `${loadingPlugin}…`
                : isRefreshing
                  ? 'Refreshing…'
                  : pendingCount > 0
                    ? `${pendingCount} selected — press Enter to install`
                    : 'Search plugins…'
            }
            focused={true}
            maxHeight={1}
            minHeight={1}
            cursorPosition={searchQuery.length}
          />
        </box>
      </box>

      {/* Plugin list */}
      <box
        style={{
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-start',
          width: '100%',
          paddingLeft: 2,
          paddingRight: 2,
          paddingTop: 0,
          paddingBottom: 0,
          flexGrow: 1,
          flexShrink: 1,
        }}
      >
        <box
          style={{
            flexDirection: 'column',
            width: contentWidth,
            borderStyle: 'single',
            borderColor: theme.muted,
            flexGrow: 1,
            flexShrink: 1,
            overflow: 'hidden',
          }}
          border={['top', 'bottom', 'left', 'right']}
        >
          <SelectableList
            items={filteredItems.slice(0, LAYOUT.MAX_RENDERED_PLUGINS)}
            focusedIndex={focusedIndex}
            onSelect={(item) => {
              if (activeTab !== 'errors') handleToggleSelection(item.id)
            }}
            onFocusChange={handleFocusChange}
            emptyMessage={
              activeTab === 'discover' && allPlugins.length === 0
                ? 'No plugins found (run /plugin refresh to update)'
                : activeTab === 'installed' && installedNames.size === 0
                  ? 'No plugins installed yet'
                  : activeTab === 'errors' && errors.length === 0
                    ? 'No errors'
                    : searchQuery
                      ? 'No matching plugins'
                      : 'No plugins found'
            }
          />
        </box>
      </box>

      {/* Footer */}
      <box
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          paddingTop: 0,
          paddingBottom: 0,
          borderStyle: 'single',
          borderColor: theme.border,
          flexShrink: 0,
          backgroundColor: theme.surface,
        }}
        border={['top']}
      >
        <box
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: contentWidth,
          }}
        >
          <box style={{ flexGrow: 1, flexShrink: 1 }}>
            <text style={{ fg: theme.muted }}>
              ↑↓ navigate · Space select · Enter install · Tab switch tab · Ctrl+R refresh · Esc cancel
            </text>
            {statusMessage && (
              <text style={{ fg: theme.primary }}>
                {' · '}
                {statusMessage}
              </text>
            )}
          </box>
        </box>
      </box>
    </box>
  )
}
