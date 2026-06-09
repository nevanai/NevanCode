import { useKeyboard } from '@opentui/react'
import { useCallback } from 'react'

import type { KeyEvent } from '@opentui/core'

interface UseLoginKeyboardHandlersParams {
  /** Whether the provider-selection menu is visible */
  showProviderMenu: boolean
  /** Index of the currently highlighted provider */
  selectedProviderIndex: number
  /** Total number of providers in the menu */
  providerCount: number
  /** Whether an OAuth flow is currently in progress */
  oauthInProgress: boolean
  /** Whether the API key text input panel is shown */
  showApiKeyInput: boolean
  /** Show the provider-selection menu (first Enter press) */
  onShowProviderMenu: () => void
  /** Navigate the menu up or down */
  onNavigate: (direction: 'up' | 'down') => void
  /** Confirm the highlighted provider */
  onSelectProvider: (index: number) => void
  /** Append a printable character to the API key buffer */
  onApiKeyChar: (char: string) => void
  /** Paste a full string into the API key buffer (Ctrl+V or bracketed paste) */
  onApiKeyPaste: (text: string) => void
  /** Delete the last character from the API key buffer */
  onApiKeyBackspace: () => void
  /** Submit the API key */
  onApiKeySubmit: () => void
  /** Cancel API key entry and go back to provider menu */
  onApiKeyCancel: () => void
}

/**
 * Keyboard handler for the login modal.
 *
 * State machine:
 *   idle          → Enter          → show provider menu
 *   menu          → ↑/↓            → navigate provider list
 *   menu          → Enter          → start OAuth OR show API key input
 *   apikey-input  → printable      → append char
 *   apikey-input  → Backspace      → delete last char
 *   apikey-input  → Enter          → submit key
 *   apikey-input  → Escape         → cancel / back to menu
 *   in-flight     → (all blocked except Ctrl+C)
 *   any           → Ctrl+C         → exit
 */
export function useLoginKeyboardHandlers({
  showProviderMenu,
  selectedProviderIndex,
  providerCount,
  oauthInProgress,
  showApiKeyInput,
  onShowProviderMenu,
  onNavigate,
  onSelectProvider,
  onApiKeyChar,
  onApiKeyPaste,
  onApiKeyBackspace,
  onApiKeySubmit,
  onApiKeyCancel,
}: UseLoginKeyboardHandlersParams) {
  useKeyboard(
    useCallback(
      (key: KeyEvent) => {
        const prevent = () => {
          if ('preventDefault' in key && typeof key.preventDefault === 'function') {
            key.preventDefault()
          }
        }

        // Always: Ctrl+C → exit
        if (key.ctrl && key.name === 'c') {
          prevent()
          process.exit(0)
        }

        // Block all input while OAuth is in flight (except Ctrl+C above)
        if (oauthInProgress) return

        const isEnter =
          (key.name === 'return' || key.name === 'enter') && !key.ctrl && !key.meta && !key.shift
        const isEscape = key.name === 'escape' && !key.ctrl && !key.meta
        const isBackspace = key.name === 'backspace'
        const isUp = (key.name === 'up' || key.name === 'k') && !key.ctrl && !key.meta
        const isDown = (key.name === 'down' || key.name === 'j') && !key.ctrl && !key.meta

        // ── API key input panel ────────────────────────────────────────────
        if (showApiKeyInput) {
          if (isEnter) {
            prevent()
            onApiKeySubmit()
            return
          }
          if (isEscape) {
            prevent()
            onApiKeyCancel()
            return
          }
          if (isBackspace) {
            prevent()
            onApiKeyBackspace()
            return
          }
          // Ctrl+V → read from system clipboard
          if (key.ctrl && key.name === 'v') {
            prevent()
            onApiKeyPaste('__READ_CLIPBOARD__')
            return
          }
          // Bracketed paste — OpenTUI delivers the whole pasted text as a
          // multi-character sequence with no ctrl/meta flags.
          if (key.sequence && !key.ctrl && !key.meta && key.sequence.length > 1) {
            const printable = key.sequence.replace(/[^\x20-\x7E]/g, '')
            if (printable) {
              prevent()
              onApiKeyPaste(printable)
            }
            return
          }
          // Single printable character
          if (key.sequence && !key.ctrl && !key.meta && key.sequence.length === 1) {
            const code = key.sequence.charCodeAt(0)
            if (code >= 32 && code < 127) {
              prevent()
              onApiKeyChar(key.sequence)
            }
          }
          return
        }

        // ── Initial idle state ─────────────────────────────────────────────
        if (!showProviderMenu) {
          if (isEnter) {
            prevent()
            onShowProviderMenu()
          }
          return
        }

        // ── Provider menu open ─────────────────────────────────────────────
        if (isUp) {
          prevent()
          onNavigate('up')
          return
        }

        if (isDown) {
          prevent()
          onNavigate('down')
          return
        }

        // Numeric shortcut: '1', '2', … selects that provider directly
        if (key.name && /^[1-9]$/.test(key.name)) {
          const idx = parseInt(key.name, 10) - 1
          if (idx < providerCount) {
            prevent()
            onSelectProvider(idx)
          }
          return
        }

        if (isEnter) {
          prevent()
          onSelectProvider(selectedProviderIndex)
        }
      },
      [
        showProviderMenu,
        selectedProviderIndex,
        providerCount,
        oauthInProgress,
        showApiKeyInput,
        onShowProviderMenu,
        onNavigate,
        onSelectProvider,
        onApiKeyChar,
        onApiKeyPaste,
        onApiKeyBackspace,
        onApiKeySubmit,
        onApiKeyCancel,
      ],
    ),
  )
}
