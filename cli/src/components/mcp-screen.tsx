import { TextAttributes } from '@opentui/core'
import React, { useCallback, useMemo, useState } from 'react'

import { MultilineInput } from './multiline-input'
import { SelectableList } from './selectable-list'
import { useTerminalLayout } from '../hooks/use-terminal-layout'
import { useTheme } from '../hooks/use-theme'
import {
  getMcpServers,
  getMcpEntryKey,
  disableMcpServer,
  clearMcpAuth,
  getMcpTypeLabel,
  getMcpConnectionInfo,
  getMcpBuiltinDescription,
  getMcpDisplayName,
  formatMcpConfigPath,
  type McpServerEntry,
} from '../utils/mcp-registry'

import type { SelectableListItem } from './selectable-list'
import type { KeyEvent } from '@opentui/core'

const CONTENT_PADDING = 4

type ViewMode = 'list' | 'detail'

const DETAIL_ACTIONS: Array<{ id: string; label: string }> = [
  { id: 'view-tools', label: 'View tools' },
  { id: 'clear-auth', label: 'Clear authentication' },
  { id: 'reconnect', label: 'Reconnect' },
  { id: 'disable', label: 'Disable' },
]

interface McpScreenProps {
  onCancel: () => void
}

export const McpScreen: React.FC<McpScreenProps> = ({ onCancel }) => {
  const theme = useTheme()
  const { terminalWidth, terminalHeight } = useTerminalLayout()
  const contentWidth = terminalWidth - CONTENT_PADDING
  const isCompactMode = terminalHeight < 20

  const [view, setView] = useState<ViewMode>('list')
  const [selectedEntry, setSelectedEntry] = useState<McpServerEntry | null>(null)
  const [listFocusedIndex, setListFocusedIndex] = useState(0)
  const [detailFocusedIndex, setDetailFocusedIndex] = useState(0)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [servers, setServers] = useState<McpServerEntry[]>(() => getMcpServers())

  const refreshServers = useCallback(() => {
    setServers(getMcpServers())
  }, [])

  const builtinServers = useMemo(() => servers.filter((s) => s.source === 'builtin'), [servers])
  const pluginServers = useMemo(() => servers.filter((s) => s.source === 'plugin'), [servers])
  const userServers = useMemo(() => servers.filter((s) => s.source === 'user'), [servers])

  // Build flat list with section headers
  const allListItems: SelectableListItem[] = useMemo(() => {
    const items: SelectableListItem[] = []

    if (builtinServers.length > 0) {
      items.push({
        id: '__header_builtin',
        label: `Built-in MCPs`,
        secondary: `(always available)`,
        accent: false,
      })
      for (const s of builtinServers) {
        const builtinDesc = getMcpBuiltinDescription(s)
        items.push({
          id: getMcpEntryKey(s),
          label: `  ${getMcpDisplayName(s)}`,
          secondary: builtinDesc ?? `✓ connected · ${getMcpTypeLabel(s)}`,
          accent: true,
        })
      }
    }

    if (pluginServers.length > 0) {
      items.push({
        id: '__header_plugin',
        label: `Plugin MCPs`,
        secondary: `(installed via /plugin)`,
        accent: false,
      })
      for (const s of pluginServers) {
        items.push({
          id: getMcpEntryKey(s),
          label: `  ${getMcpDisplayName(s)}`,
          secondary: `✓ configured · ${getMcpTypeLabel(s)} · ${s.pluginName ?? ''}`,
          accent: false,
        })
      }
    }

    if (userServers.length > 0) {
      items.push({
        id: '__header_user',
        label: `User MCPs`,
        secondary: `(~/.agents/mcp.json)`,
        accent: false,
      })
      for (const s of userServers) {
        items.push({
          id: getMcpEntryKey(s),
          label: `  ${getMcpDisplayName(s)}`,
          secondary: `✓ configured · ${getMcpTypeLabel(s)}`,
          accent: true,
        })
      }
    }

    if (items.length === 0) {
      items.push({
        id: '__empty',
        label: '  No MCP servers found',
        secondary: 'Install plugins with /plugin to add MCP servers',
        accent: false,
      })
    }

    return items
  }, [builtinServers, pluginServers, userServers])

  const selectableItems = useMemo(
    () => allListItems.filter((item) => !item.id.startsWith('__')),
    [allListItems],
  )

  const flatIndexOf = useCallback(
    (selectableIdx: number): number => {
      const target = selectableItems[selectableIdx]
      if (!target) return 0
      return Math.max(0, allListItems.findIndex((item) => item.id === target.id))
    },
    [selectableItems, allListItems],
  )

  const handleSelectServer = useCallback(
    (item: SelectableListItem) => {
      if (item.id.startsWith('__')) return
      const entry = servers.find((s) => getMcpEntryKey(s) === item.id)
      if (entry) {
        setSelectedEntry(entry)
        setDetailFocusedIndex(0)
        setStatusMessage(null)
        setView('detail')
      }
    },
    [servers],
  )

  const handleDetailAction = useCallback(
    (actionId: string) => {
      if (!selectedEntry) return

      if (actionId === 'view-tools') {
        const builtinDesc = getMcpBuiltinDescription(selectedEntry)
        if (builtinDesc) {
          setStatusMessage(`Tools: ${builtinDesc}`)
          return
        }
        const info = getMcpConnectionInfo(selectedEntry)
        const c = selectedEntry.config
        const envKeys =
          'command' in c ? Object.keys(c.env ?? {}) : Object.keys(c.headers ?? {})
        const extras = envKeys.length > 0 ? `  Vars: ${envKeys.join(', ')}` : ''
        setStatusMessage(`${getMcpTypeLabel(selectedEntry).toUpperCase()}: ${info}${extras}`)
      } else if (actionId === 'clear-auth') {
        if (selectedEntry.source === 'builtin') {
          setStatusMessage('Built-in MCPs have no stored credentials')
          return
        }
        const ok = clearMcpAuth(selectedEntry)
        setStatusMessage(ok ? '✓ Auth cleared' : '✗ No auth credentials found')
        refreshServers()
      } else if (actionId === 'reconnect') {
        setStatusMessage('Restart the CLI to reconnect MCP servers')
      } else if (actionId === 'disable') {
        const result = disableMcpServer(selectedEntry)
        if (result === 'builtin') {
          setStatusMessage('✗ Built-in MCPs cannot be disabled')
        } else if (result === 'ok') {
          refreshServers()
          setView('list')
          setSelectedEntry(null)
          setStatusMessage(`✓ ${getMcpDisplayName(selectedEntry)} removed`)
        } else {
          setStatusMessage('✗ Failed — check file permissions')
        }
      }
    },
    [selectedEntry, refreshServers],
  )

  const handleKeyInList = useCallback(
    (key: KeyEvent): boolean => {
      if (key.name === 'escape' || (key.name === 'c' && key.ctrl)) {
        onCancel()
        return true
      }
      if (key.name === 'up') {
        setListFocusedIndex((prev) => Math.max(0, prev - 1))
        return true
      }
      if (key.name === 'down') {
        setListFocusedIndex((prev) => Math.min(selectableItems.length - 1, prev + 1))
        return true
      }
      if (key.name === 'return') {
        const item = selectableItems[listFocusedIndex]
        if (item) handleSelectServer(item)
        return true
      }
      return false
    },
    [onCancel, selectableItems, listFocusedIndex, handleSelectServer],
  )

  const handleKeyInDetail = useCallback(
    (key: KeyEvent): boolean => {
      if (key.name === 'escape' || (key.name === 'c' && key.ctrl)) {
        setView('list')
        setStatusMessage(null)
        return true
      }
      if (key.name === 'up') {
        setDetailFocusedIndex((prev) => Math.max(0, prev - 1))
        return true
      }
      if (key.name === 'down') {
        setDetailFocusedIndex((prev) => Math.min(DETAIL_ACTIONS.length - 1, prev + 1))
        return true
      }
      if (key.name === 'return') {
        const action = DETAIL_ACTIONS[detailFocusedIndex]
        if (action) handleDetailAction(action.id)
        return true
      }
      return false
    },
    [detailFocusedIndex, handleDetailAction],
  )

  // ── Detail view ────────────────────────────────────────────────────────────

  if (view === 'detail' && selectedEntry) {
    const actionItems: SelectableListItem[] = DETAIL_ACTIONS.map((a, idx) => ({
      id: a.id,
      label: `  ${idx + 1}. ${a.label}`,
      accent: a.id === 'disable' && selectedEntry.source !== 'builtin',
    }))

    const builtinDesc = getMcpBuiltinDescription(selectedEntry)

    return (
      <box
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: theme.surface,
          flexDirection: 'column',
        }}
      >
        {/* MCP info header */}
        <box
          style={{
            flexDirection: 'column',
            paddingLeft: 2,
            paddingRight: 2,
            paddingTop: isCompactMode ? 0 : 1,
            paddingBottom: 1,
            flexShrink: 0,
          }}
        >
          <text style={{ fg: theme.foreground, attributes: TextAttributes.BOLD }}>
            {getMcpDisplayName(selectedEntry)}
          </text>
          <box style={{ flexDirection: 'column', marginTop: 1 }}>
            <InfoRow
              label="Status"
              value={selectedEntry.source === 'builtin' ? '✓ connected' : '✓ configured'}
              valueColor={theme.success}
              theme={theme}
            />
            <InfoRow
              label="Type"
              value={getMcpTypeLabel(selectedEntry).toUpperCase()}
              theme={theme}
            />
            {selectedEntry.source === 'builtin' ? (
              <InfoRow label="Source" value="built-in (always available)" theme={theme} />
            ) : (
              <>
                {'url' in selectedEntry.config && (
                  <InfoRow label="URL" value={selectedEntry.config.url} theme={theme} />
                )}
                {'command' in selectedEntry.config && (
                  <InfoRow label="Command" value={selectedEntry.config.command} theme={theme} />
                )}
                <InfoRow label="Config" value={formatMcpConfigPath(selectedEntry.configFile)} theme={theme} />
                {selectedEntry.pluginName && (
                  <InfoRow label="Plugin" value={selectedEntry.pluginName} theme={theme} />
                )}
              </>
            )}
            {builtinDesc && (
              <InfoRow label="Tools" value={builtinDesc} theme={theme} />
            )}
          </box>
        </box>

        {/* Actions */}
        <box
          style={{
            flexDirection: 'column',
            alignItems: 'center',
            width: '100%',
            paddingLeft: 2,
            paddingRight: 2,
            flexGrow: 1,
            flexShrink: 1,
          }}
        >
          <box
            style={{
              flexDirection: 'column',
              width: contentWidth,
              borderStyle: 'single',
              borderColor: theme.border,
              flexGrow: 1,
              flexShrink: 1,
              overflow: 'hidden',
            }}
            border={['top', 'bottom', 'left', 'right']}
          >
            <SelectableList
              items={actionItems}
              focusedIndex={detailFocusedIndex}
              onSelect={(item) => handleDetailAction(item.id)}
              emptyMessage=""
            />
          </box>
        </box>

        {/* Footer */}
        <box
          style={{
            flexDirection: 'column',
            width: '100%',
            flexShrink: 0,
            backgroundColor: theme.surface,
            borderStyle: 'single',
            borderColor: theme.border,
          }}
          border={['top']}
        >
          <box
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingLeft: 2,
              paddingRight: 2,
            }}
          >
            <text style={{ fg: theme.muted }}>
              ↑↓ navigate · Enter to confirm · Esc to go back
            </text>
            {statusMessage && (
              <text style={{ fg: theme.primary }}>{statusMessage}</text>
            )}
          </box>
          <box style={{ height: 0, overflow: 'hidden' }}>
            <MultilineInput
              value=""
              onChange={() => {}}
              onSubmit={() => {}}
              onPaste={() => {}}
              onKeyIntercept={handleKeyInDetail}
              focused={true}
              maxHeight={1}
              minHeight={1}
              cursorPosition={0}
            />
          </box>
        </box>
      </box>
    )
  }

  // ── List view ──────────────────────────────────────────────────────────────

  return (
    <box
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: theme.surface,
        flexDirection: 'column',
      }}
    >
      {!isCompactMode && (
        <box
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingLeft: 2,
            paddingRight: 2,
            paddingTop: 1,
            paddingBottom: 1,
            flexShrink: 0,
          }}
        >
          <text style={{ fg: theme.foreground, attributes: TextAttributes.BOLD }}>
            Manage MCP servers
          </text>
          <text style={{ fg: theme.muted }}>
            {'  '}{servers.length} server{servers.length !== 1 ? 's' : ''}
          </text>
        </box>
      )}

      <box
        style={{
          flexDirection: 'column',
          alignItems: 'center',
          width: '100%',
          paddingLeft: 2,
          paddingRight: 2,
          flexGrow: 1,
          flexShrink: 1,
        }}
      >
        <box
          style={{
            flexDirection: 'column',
            width: contentWidth,
            borderStyle: 'single',
            borderColor: theme.border,
            flexGrow: 1,
            flexShrink: 1,
            overflow: 'hidden',
          }}
          border={['top', 'bottom', 'left', 'right']}
        >
          <SelectableList
            items={allListItems}
            focusedIndex={flatIndexOf(listFocusedIndex)}
            onSelect={(item) => handleSelectServer(item)}
            emptyMessage="No MCP servers found"
          />
        </box>
      </box>

      <box
        style={{
          flexDirection: 'column',
          width: '100%',
          flexShrink: 0,
          backgroundColor: theme.surface,
          borderStyle: 'single',
          borderColor: theme.border,
        }}
        border={['top']}
      >
        <box
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingLeft: 2,
            paddingRight: 2,
          }}
        >
          <text style={{ fg: theme.muted }}>
            ↑↓ navigate · Enter to view · Esc to close
          </text>
          {statusMessage && (
            <text style={{ fg: theme.primary }}>{statusMessage}</text>
          )}
        </box>
        <box style={{ width: contentWidth, paddingLeft: 2, paddingRight: 2 }}>
          <MultilineInput
            value=""
            onChange={() => {}}
            onSubmit={() => {}}
            onPaste={() => {}}
            onKeyIntercept={handleKeyInList}
            placeholder={servers.length === 0 ? 'No servers found' : 'Press ↑↓ to navigate…'}
            focused={true}
            maxHeight={1}
            minHeight={1}
            cursorPosition={0}
          />
        </box>
      </box>
    </box>
  )
}

// ── InfoRow ────────────────────────────────────────────────────────────────────

interface InfoRowProps {
  label: string
  value: string
  valueColor?: string
  theme: ReturnType<typeof useTheme>
}

const LABEL_WIDTH = 10

const InfoRow: React.FC<InfoRowProps> = ({ label, value, valueColor, theme }) => (
  <box style={{ flexDirection: 'row' }}>
    <text style={{ fg: theme.muted, width: LABEL_WIDTH }}>
      {label.padEnd(LABEL_WIDTH)}
    </text>
    <text style={{ fg: valueColor ?? theme.foreground }}>{value}</text>
  </box>
)
