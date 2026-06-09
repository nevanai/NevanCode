import React, { useEffect, useState } from 'react'

import { Button } from './button'
import { useTheme } from '../hooks/use-theme'
import { useChatStore } from '../state/chat-store'
import { ensureDefaultOpenAiModelForChatGptSession } from '../utils/chatgpt-default-model'
import {
  type ChatGptOAuthConnectionState,
  connectChatGptOAuth,
  disconnectChatGptOAuth,
  exchangeChatGptCodeForTokens,
  getChatGptOAuthStatus,
  stopChatGptOAuthServer,
} from '../utils/chatgpt-oauth'
import { getSelectedOpenAiModel } from '../utils/openai-models'
import { BORDER_CHARS } from '../utils/ui-constants'

type FlowState =
  | 'checking'
  | 'not-connected'
  | 'waiting-for-code'
  | 'connected'
  | 'error'

export const ChatGptConnectBanner = () => {
  const theme = useTheme()
  const setInputMode = useChatStore((state) => state.setInputMode)
  const selectedOpenAiModel = getSelectedOpenAiModel()
  const [flowState, setFlowState] = useState<FlowState>('checking')
  const [connectionState, setConnectionState] =
    useState<ChatGptOAuthConnectionState>('not-connected')
  const [error, setError] = useState<string | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [hovered, setHovered] = useState(false)
  const [isCloseHovered, setIsCloseHovered] = useState(false)

  const beginConnection = (state: ChatGptOAuthConnectionState) => {
    setConnectionState(state === 'connected' ? 'not-connected' : state)
    setFlowState('waiting-for-code')
    setError(null)
    const result = connectChatGptOAuth()
    setAuthUrl(result.authUrl)
    result.credentials
      .then(() => {
        // Auto-pick a default OpenAI model so the very next message routes
        // directly to the user's ChatGPT account instead of falling through
        // to the Codebuff backend.
        ensureDefaultOpenAiModelForChatGptSession()
        setConnectionState('connected')
        setFlowState('connected')
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to connect')
        setFlowState('error')
      })
  }

  useEffect(() => {
    const status = getChatGptOAuthStatus()
    setConnectionState(status.state)
    if (!status.connected) {
      beginConnection(status.state)
    } else {
      setFlowState('connected')
    }

    return () => {
      stopChatGptOAuthServer()
    }
  }, [])

  const handleConnect = () => {
    beginConnection(getChatGptOAuthStatus().state)
  }

  const handleDisconnect = () => {
    disconnectChatGptOAuth()
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
          <text style={{ fg: theme.foreground }}>✓ ChatGPT connected</text>
          <text style={{ fg: theme.muted }}>
            {selectedOpenAiModel
              ? `${selectedOpenAiModel.label} is ready for new messages.`
              : 'Supported OpenAI models can use this connection.'}
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
          {selectedOpenAiModel ? (
            <text style={{ fg: theme.muted }}>
              Reconnect to use {selectedOpenAiModel.label}.
            </text>
          ) : null}
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
        ? 'Reconnecting to ChatGPT...'
        : 'Connecting to ChatGPT...'
    const body =
      connectionState === 'expired'
        ? selectedOpenAiModel
          ? `Your previous ChatGPT session expired. Sign in again to use ${selectedOpenAiModel.label}.`
          : 'Your previous ChatGPT session expired. Sign in again in your browser.'
        : selectedOpenAiModel
          ? `Sign in via your browser to use ${selectedOpenAiModel.label}.`
          : 'Sign in via your browser to connect.'

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
        <text style={{ fg: theme.muted }}>{body}</text>
        {authUrl ? <text style={{ fg: theme.muted }}>{authUrl}</text> : null}
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
          {selectedOpenAiModel ? (
            <text style={{ fg: theme.muted }}>
              {selectedOpenAiModel.label} is selected. Connect ChatGPT to use
              it.
            </text>
          ) : null}
          <Button
            style={actionButtonStyle}
            onClick={handleConnect}
            onMouseOver={() => setHovered(true)}
            onMouseOut={() => setHovered(false)}
          >
            <text wrapMode="none">
              <span fg={theme.link}>Connect to ChatGPT</span>
            </text>
          </Button>
        </box>
        {closeButton}
      </box>
    )
  }

  return null
}

export async function handleChatGptAuthCode(code: string): Promise<{
  success: boolean
  message: string
}> {
  try {
    await exchangeChatGptCodeForTokens(code)
    stopChatGptOAuthServer()
    // Auto-pick a default OpenAI model so the user's next message routes
    // directly to their ChatGPT account instead of the Codebuff backend.
    ensureDefaultOpenAiModelForChatGptSession()
    return {
      success: true,
      message:
        'Successfully connected your ChatGPT subscription! NevanCode will use it for supported OpenAI streaming requests.',
    }
  } catch (err) {
    return {
      success: false,
      message:
        err instanceof Error
          ? err.message
          : 'Failed to exchange ChatGPT authorization code',
    }
  }
}
