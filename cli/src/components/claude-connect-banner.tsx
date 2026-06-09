import React, { useEffect, useState } from 'react'

import { Button } from './button'
import { useTheme } from '../hooks/use-theme'
import { useChatStore } from '../state/chat-store'
import {
  type AnthropicOAuthConnectionState,
  connectAnthropicOAuth,
  disconnectAnthropicOAuth,
  exchangeAnthropicCodeForTokens,
  getAnthropicOAuthStatus,
} from '../utils/anthropic-oauth'
import { BORDER_CHARS } from '../utils/ui-constants'

type FlowState =
  | 'checking'
  | 'not-connected'
  | 'waiting-for-code'
  | 'connected'
  | 'error'

export const ClaudeConnectBanner = () => {
  const theme = useTheme()
  const setInputMode = useChatStore((state) => state.setInputMode)
  const [flowState, setFlowState] = useState<FlowState>('checking')
  const [connectionState, setConnectionState] =
    useState<AnthropicOAuthConnectionState>('not-connected')
  const [error, setError] = useState<string | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [hovered, setHovered] = useState(false)
  const [isCloseHovered, setIsCloseHovered] = useState(false)

  const beginConnection = (state: AnthropicOAuthConnectionState) => {
    setConnectionState(state === 'connected' ? 'not-connected' : state)
    setFlowState('waiting-for-code')
    setError(null)
    const result = connectAnthropicOAuth()
    setAuthUrl(result.authUrl)
  }

  useEffect(() => {
    const status = getAnthropicOAuthStatus()
    setConnectionState(status.state)
    if (!status.connected) {
      beginConnection(status.state)
    } else {
      setFlowState('connected')
    }
  }, [])

  const handleConnect = () => {
    beginConnection(getAnthropicOAuthStatus().state)
  }

  const handleDisconnect = () => {
    disconnectAnthropicOAuth()
    setConnectionState('not-connected')
    setFlowState('not-connected')
  }

  const panelStyle = {
    width: '100%' as const,
    borderStyle: 'single' as const,
    borderColor: theme.border,
    customBorderChars: BORDER_CHARS,
    paddingLeft: 1,
    paddingRight: 1,
  }

  const actionButtonStyle = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingLeft: 1,
    paddingRight: 1,
    borderStyle: 'single' as const,
    borderColor: hovered ? theme.foreground : theme.border,
    customBorderChars: BORDER_CHARS,
  }

  const handleClose = () => {
    setInputMode('default')
  }

  const closeButton = (
    <Button
      onClick={handleClose}
      onMouseOver={() => setIsCloseHovered(true)}
      onMouseOut={() => setIsCloseHovered(false)}
    >
      <text style={{ fg: isCloseHovered ? theme.error : theme.muted }}>x</text>
    </Button>
  )

  if (flowState === 'connected') {
    return (
      <box
        style={{
          ...panelStyle,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <box style={{ flexDirection: 'column', flexShrink: 1 }}>
          <text style={{ fg: theme.foreground }}>✓ Claude connected</text>
          <text style={{ fg: theme.muted }}>
            Your Claude subscription now answers every request.
          </text>
        </box>
        <box style={{ flexDirection: 'row', gap: 1, alignItems: 'center' }}>
          <Button
            style={actionButtonStyle}
            onClick={handleDisconnect}
            onMouseOver={() => setHovered(true)}
            onMouseOut={() => setHovered(false)}
          >
            <text wrapMode="none">
              <span fg={theme.muted}>Disconnect</span>
            </text>
          </Button>
          {closeButton}
        </box>
      </box>
    )
  }

  if (flowState === 'error') {
    return (
      <box
        style={{
          ...panelStyle,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <box style={{ flexDirection: 'column', flexShrink: 1 }}>
          <text style={{ fg: theme.error, flexShrink: 1 }}>
            {error ?? 'Unknown error'}
          </text>
          <text style={{ fg: theme.muted }}>
            Reconnect to use your Claude subscription.
          </text>
        </box>
        <box style={{ flexDirection: 'row', gap: 1, alignItems: 'center' }}>
          <Button
            style={actionButtonStyle}
            onClick={handleConnect}
            onMouseOver={() => setHovered(true)}
            onMouseOut={() => setHovered(false)}
          >
            <text wrapMode="none">
              <span fg={theme.foreground}>Retry</span>
            </text>
          </Button>
          {closeButton}
        </box>
      </box>
    )
  }

  if (flowState === 'waiting-for-code') {
    const heading =
      connectionState === 'expired'
        ? 'Reconnecting to Claude...'
        : 'Connecting to Claude...'

    return (
      <box style={{ ...panelStyle, flexDirection: 'column' }}>
        <box
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <text style={{ fg: theme.foreground }}>{heading}</text>
          {closeButton}
        </box>
        <text style={{ fg: theme.muted }}>
          1. Authorize in your browser (Claude Pro/Max account).
        </text>
        <text style={{ fg: theme.muted }}>
          2. Copy the code shown after approving, then paste it below and press
          Enter.
        </text>
        {authUrl ? <text style={{ fg: theme.link }}>{authUrl}</text> : null}
      </box>
    )
  }

  if (flowState === 'not-connected') {
    return (
      <box
        style={{
          ...panelStyle,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <box style={{ flexDirection: 'column', gap: 1 }}>
          <text style={{ fg: theme.muted }}>
            Connect your Claude Pro/Max account to run every model on your
            subscription.
          </text>
          <Button
            style={actionButtonStyle}
            onClick={handleConnect}
            onMouseOver={() => setHovered(true)}
            onMouseOut={() => setHovered(false)}
          >
            <text wrapMode="none">
              <span fg={theme.link}>Connect to Claude</span>
            </text>
          </Button>
        </box>
        {closeButton}
      </box>
    )
  }

  return null
}

export async function handleClaudeAuthCode(code: string): Promise<{
  success: boolean
  message: string
}> {
  try {
    await exchangeAnthropicCodeForTokens(code)
    return {
      success: true,
      message:
        'Successfully connected your Claude subscription! NevanCode will route every model through your Claude account.',
    }
  } catch (err) {
    return {
      success: false,
      message:
        err instanceof Error
          ? err.message
          : 'Failed to exchange Claude authorization code',
    }
  }
}
