import { useRenderer } from '@opentui/react'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import { useLoginKeyboardHandlers } from '../hooks/use-login-keyboard-handlers'
import { useLogo } from '../hooks/use-logo'
import { useSheenAnimation } from '../hooks/use-sheen-animation'
import { useTheme } from '../hooks/use-theme'
import { calculateResponsiveLayout } from '../login/utils'
import {
  startOpenAIOAuth,
  stopOpenAICallbackServer,
  type OpenAIAuthProvider,
} from '../login/openai-oauth-login'
import { useLoginStore } from '../state/login-store'
import { getLogoBlockColor, getLogoAccentColor } from '../utils/theme-system'
import { saveUserCredentials } from '../utils/auth'
import {
  saveFireworksApiKey,
  saveOpenRouterApiKey,
} from '@codebuff/sdk'
import {
  connectAnthropicOAuth,
  exchangeAnthropicCodeForTokens,
} from '../utils/anthropic-oauth'
import {
  connectGeminiOAuth,
  exchangeGeminiCodeForTokens,
} from '../utils/gemini-oauth'
import {
  discoverFireworksModels,
  discoverOpenRouterModels,
} from '../utils/byok-model-discovery'
import { readFromClipboard } from '../utils/clipboard'

import type { User } from '../utils/auth'

// ── Provider definitions ──────────────────────────────────────────────────────

type ProviderType = 'oauth' | 'apikey'

interface OAuthProvider {
  id: OpenAIAuthProvider
  type: 'oauth'
  label: string
  description: string
  badge: string
}

interface ApiKeyProvider {
  id: 'fireworks' | 'openrouter'
  type: 'apikey'
  label: string
  description: string
  badge: string
  placeholder: string
  saveKey: (apiKey: string) => void
  syntheticAuthToken: string
  syntheticName: string
}

// Claude Pro/Max subscription OAuth (paste flow — the client only allows the
// console callback, so the user pastes a code rather than auto-capturing it).
interface ClaudeOAuthProvider {
  id: 'claude'
  type: 'claude-oauth'
  label: string
  description: string
  badge: string
}

// Gemini (Google account) OAuth — same paste flow as Claude: authorize in the
// browser, then paste the code shown on the Google authcode page.
interface GeminiOAuthProvider {
  id: 'gemini'
  type: 'gemini-oauth'
  label: string
  description: string
  badge: string
}

type Provider =
  | OAuthProvider
  | ApiKeyProvider
  | ClaudeOAuthProvider
  | GeminiOAuthProvider

const PROVIDERS: Provider[] = [
  {
    id: 'chatgpt',
    type: 'oauth',
    label: 'OpenAI ChatGPT OAuth',
    description: 'Login with your ChatGPT / OpenAI account',
    badge: 'GPT-5.5 · GPT-5.4 · GPT-5.3-Codex',
  },
  {
    id: 'codex',
    type: 'oauth',
    label: 'Codex CLI OAuth',
    description: 'Login via Codex CLI simplified flow',
    badge: 'GPT-5.5 · GPT-5.4 · GPT-5.4-mini',
  },
  {
    id: 'claude',
    type: 'claude-oauth',
    label: 'Claude Pro/Max OAuth',
    description: 'Login with your Claude subscription',
    badge: 'Claude Opus 4.8 · Opus 4.7 · Sonnet 4.6 · Haiku 4.5',
  },
  {
    id: 'gemini',
    type: 'gemini-oauth',
    label: 'Gemini (Google) OAuth',
    description: 'Login with your Google account',
    badge: 'Gemini 3.1 Pro · Gemini 3.5 Flash',
  },
  {
    id: 'openrouter',
    type: 'apikey',
    label: 'OpenRouter API Key',
    description: 'Use your OpenRouter account directly',
    badge: 'Claude · GPT · Gemini · Grok · 200+ models',
    placeholder: 'Paste your OpenRouter API key (sk-or-…)',
    saveKey: saveOpenRouterApiKey,
    syntheticAuthToken: 'byok:openrouter',
    syntheticName: 'OpenRouter',
  },
  {
    id: 'fireworks',
    type: 'apikey',
    label: 'Fireworks.ai API Key',
    description: 'Use your Fireworks.ai account directly',
    badge: 'DeepSeek · Llama · Qwen · Fireworks models',
    placeholder: 'Paste your Fireworks API key (fw-…)',
    saveKey: saveFireworksApiKey,
    syntheticAuthToken: 'byok:fireworks',
    syntheticName: 'Fireworks.ai',
  },
]

// ── Component ─────────────────────────────────────────────────────────────────

interface LoginModalProps {
  onLoginSuccess: (user: User) => void
  hasInvalidCredentials?: boolean | null
}

type OAuthStatus = 'idle' | 'opening' | 'waiting' | 'error'

export const LoginModal = ({
  onLoginSuccess,
  hasInvalidCredentials = false,
}: LoginModalProps) => {
  const renderer = useRenderer()
  const theme = useTheme()

  // ── Sheen / logo state ────────────────────────────────────────────────────
  const { sheenPosition, setSheenPosition } = useLoginStore()

  const terminalWidth = renderer?.width || 80
  const terminalHeight = renderer?.height || 24

  const {
    isVerySmall,
    isNarrow,
    containerPadding,
    headerMarginTop,
    headerMarginBottom,
    sectionMarginBottom,
    contentMaxWidth,
  } = calculateResponsiveLayout(terminalWidth, terminalHeight)

  const blockColor = getLogoBlockColor(theme.name)
  const accentColor = getLogoAccentColor(theme.name)
  const { applySheenToChar } = useSheenAnimation({
    logoColor: theme.foreground,
    accentColor,
    blockColor,
    terminalWidth: renderer?.width,
    sheenPosition,
    setSheenPosition,
  })

  const { component: logoComponent } = useLogo({
    availableWidth: contentMaxWidth,
    applySheenToChar,
    textColor: theme.foreground,
  })

  // ── Local UI state ────────────────────────────────────────────────────────
  const [showProviderMenu, setShowProviderMenu] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [oauthStatus, setOauthStatus] = useState<OAuthStatus>('idle')
  const [oauthAuthUrl, setOauthAuthUrl] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null)

  // API key input state
  const [showApiKeyInput, setShowApiKeyInput] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [apiKeyError, setApiKeyError] = useState<string | null>(null)
  const [apiKeyConnecting, setApiKeyConnecting] = useState(false)

  const onLoginSuccessRef = useRef(onLoginSuccess)
  useEffect(() => { onLoginSuccessRef.current = onLoginSuccess }, [onLoginSuccess])

  // Cancel any pending callback server on unmount
  useEffect(() => {
    return () => {
      stopOpenAICallbackServer()
    }
  }, [])

  // ── Provider selection ────────────────────────────────────────────────────
  const handleSelectProvider = useCallback(
    (index: number) => {
      const provider = PROVIDERS[index]
      if (!provider || oauthStatus === 'opening' || oauthStatus === 'waiting') return
      if (showApiKeyInput) return

      setSelectedProvider(provider)
      setErrorMessage(null)
      setApiKeyError(null)

      if (provider.type === 'oauth') {
        setOauthStatus('opening')
        const { authUrl, userPromise } = startOpenAIOAuth(provider.id)
        setOauthAuthUrl(authUrl)
        setOauthStatus('waiting')

        userPromise
          .then((user) => {
            setOauthStatus('idle')
            onLoginSuccessRef.current(user)
          })
          .catch((err) => {
            setOauthStatus('error')
            setErrorMessage(
              err instanceof Error ? err.message : 'OAuth failed. Please try again.',
            )
          })
      } else if (provider.type === 'claude-oauth') {
        // Claude paste flow: open the browser for authorization, then reuse the
        // text-input panel to collect the pasted `code#state` value.
        const { authUrl } = connectAnthropicOAuth()
        setOauthAuthUrl(authUrl)
        setApiKeyInput('')
        setApiKeyError(null)
        setShowApiKeyInput(true)
      } else if (provider.type === 'gemini-oauth') {
        // Gemini paste flow: same shape as Claude — open the Google consent page,
        // then collect the pasted authorization code in the text-input panel.
        const { authUrl } = connectGeminiOAuth()
        setOauthAuthUrl(authUrl)
        setApiKeyInput('')
        setApiKeyError(null)
        setShowApiKeyInput(true)
      } else {
        // API key provider: show text input panel
        setApiKeyInput('')
        setApiKeyError(null)
        setShowApiKeyInput(true)
      }
    },
    [oauthStatus, showApiKeyInput],
  )

  const handleApiKeyChar = useCallback((char: string) => {
    setApiKeyInput((prev) => prev + char)
  }, [])

  const handleApiKeyBackspace = useCallback(() => {
    setApiKeyInput((prev) => prev.slice(0, -1))
  }, [])

  const handleApiKeyPaste = useCallback((text: string) => {
    // '__READ_CLIPBOARD__' is the sentinel sent by Ctrl+V
    const content = text === '__READ_CLIPBOARD__' ? readFromClipboard() : text
    if (!content) return
    // Append to whatever is already typed (replace all if it looks like a full key)
    setApiKeyInput((prev) => {
      const combined = prev + content
      // If the pasted text alone already looks like a full key (length > 10),
      // replace any existing input so the user doesn't end up with garbage.
      return prev.trim().length === 0 || content.length > 10 ? content.trim() : combined
    })
  }, [])

  const handleApiKeySubmit = useCallback(() => {
    if (!selectedProvider) return
    const trimmed = apiKeyInput.trim()

    // Claude Pro/Max: exchange the pasted authorization code (async network
    // round-trip) and create a synthetic logged-in user, mirroring BYOK.
    if (selectedProvider.type === 'claude-oauth') {
      if (!trimmed) {
        setApiKeyError('Authorization code cannot be empty')
        return
      }
      setApiKeyConnecting(true)
      setApiKeyError(null)
      exchangeAnthropicCodeForTokens(trimmed)
        .then(() => {
          const syntheticUser: User = {
            id: 'claude-user',
            name: 'Claude',
            email: 'claude@connected',
            authToken: 'oauth:claude',
          }
          saveUserCredentials(syntheticUser)
          setApiKeyConnecting(false)
          onLoginSuccessRef.current(syntheticUser)
        })
        .catch((err) => {
          setApiKeyConnecting(false)
          setApiKeyError(
            err instanceof Error ? err.message : 'Failed to connect Claude',
          )
        })
      return
    }

    // Gemini Google account: exchange the pasted authorization code (async
    // network round-trip) and create a synthetic logged-in user, like Claude.
    if (selectedProvider.type === 'gemini-oauth') {
      if (!trimmed) {
        setApiKeyError('Authorization code cannot be empty')
        return
      }
      setApiKeyConnecting(true)
      setApiKeyError(null)
      exchangeGeminiCodeForTokens(trimmed)
        .then(() => {
          const syntheticUser: User = {
            id: 'gemini-user',
            name: 'Gemini',
            email: 'gemini@connected',
            authToken: 'oauth:gemini',
          }
          saveUserCredentials(syntheticUser)
          setApiKeyConnecting(false)
          onLoginSuccessRef.current(syntheticUser)
        })
        .catch((err) => {
          setApiKeyConnecting(false)
          setApiKeyError(
            err instanceof Error ? err.message : 'Failed to connect Gemini',
          )
        })
      return
    }

    if (selectedProvider.type !== 'apikey') return
    if (!trimmed) {
      setApiKeyError('API key cannot be empty')
      return
    }

    setApiKeyConnecting(true)
    setApiKeyError(null)

    try {
      selectedProvider.saveKey(trimmed)
      const syntheticUser: User = {
        id: `${selectedProvider.id}-user`,
        name: selectedProvider.syntheticName,
        email: `${selectedProvider.id}@connected`,
        authToken: selectedProvider.syntheticAuthToken,
      }
      saveUserCredentials(syntheticUser)

      // Kick off background model discovery — don't await, don't block UI.
      if (selectedProvider.id === 'fireworks') {
        void discoverFireworksModels(trimmed)
      } else if (selectedProvider.id === 'openrouter') {
        void discoverOpenRouterModels(trimmed)
      }

      setApiKeyConnecting(false)
      onLoginSuccessRef.current(syntheticUser)
    } catch (err) {
      setApiKeyConnecting(false)
      setApiKeyError(err instanceof Error ? err.message : 'Failed to save API key')
    }
  }, [selectedProvider, apiKeyInput])

  const handleApiKeyCancel = useCallback(() => {
    setShowApiKeyInput(false)
    setApiKeyInput('')
    setApiKeyError(null)
    setSelectedProvider(null)
  }, [])

  const handleNavigate = useCallback(
    (direction: 'up' | 'down') => {
      setSelectedIndex((prev) => {
        if (direction === 'up') return prev === 0 ? PROVIDERS.length - 1 : prev - 1
        return prev === PROVIDERS.length - 1 ? 0 : prev + 1
      })
    },
    [],
  )

  const handleRetry = useCallback(() => {
    setOauthStatus('idle')
    setErrorMessage(null)
    setOauthAuthUrl(null)
    setSelectedProvider(null)
  }, [])

  // ── Keyboard ──────────────────────────────────────────────────────────────
  useLoginKeyboardHandlers({
    showProviderMenu: showProviderMenu && oauthStatus !== 'error',
    selectedProviderIndex: selectedIndex,
    providerCount: PROVIDERS.length,
    oauthInProgress: oauthStatus === 'opening' || oauthStatus === 'waiting',
    showApiKeyInput,
    onShowProviderMenu: () => {
      if (oauthStatus === 'error') {
        handleRetry()
      } else {
        setShowProviderMenu(true)
      }
    },
    onNavigate: handleNavigate,
    onSelectProvider: handleSelectProvider,
    onApiKeyChar: handleApiKeyChar,
    onApiKeyPaste: handleApiKeyPaste,
    onApiKeyBackspace: handleApiKeyBackspace,
    onApiKeySubmit: handleApiKeySubmit,
    onApiKeyCancel: handleApiKeyCancel,
  })

  // ── Render ────────────────────────────────────────────────────────────────
  const oauthInProgress = oauthStatus === 'opening' || oauthStatus === 'waiting'

  // Masked display: show last 4 chars, rest as dots
  const maskedApiKey = apiKeyInput.length > 4
    ? '·'.repeat(Math.min(apiKeyInput.length - 4, 20)) + apiKeyInput.slice(-4)
    : apiKeyInput

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
      {/* Invalid-credentials banner */}
      {hasInvalidCredentials && (
        <box
          style={{
            width: '100%',
            padding: 1,
            backgroundColor: theme.surface,
            flexShrink: 0,
          }}
        >
          <text style={{ wrapMode: 'word' }}>
            <span fg={theme.secondary}>
              {isNarrow
                ? '⚠ Invalid credentials. Please log in again.'
                : '⚠ We found credentials but they appear invalid. Please log in again.'}
            </span>
          </text>
        </box>
      )}

      <box
        style={{
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          padding: containerPadding,
          gap: 0,
        }}
      >
        {/* Logo */}
        <box
          key="codebuff-logo"
          style={{
            flexDirection: 'column',
            alignItems: contentMaxWidth < 40 ? 'center' : 'flex-start',
            marginTop: headerMarginTop,
            marginBottom: headerMarginBottom,
            flexShrink: 0,
          }}
        >
          {logoComponent}
        </box>

        {/* ── State: OAuth in progress ── */}
        {oauthInProgress && (
          <box
            style={{
              flexDirection: 'column',
              alignItems: 'center',
              marginBottom: sectionMarginBottom,
              maxWidth: contentMaxWidth,
              flexShrink: 0,
              gap: 1,
            }}
          >
            <text style={{ wrapMode: 'none' }}>
              <span fg={theme.foreground}>
                {oauthStatus === 'opening'
                  ? 'Opening browser…'
                  : `Waiting for ${selectedProvider?.label ?? 'OpenAI'} login…`}
              </span>
            </text>
            {oauthAuthUrl && !isVerySmall && (
              <text style={{ wrapMode: 'word' }}>
                <span fg={theme.secondary}>
                  {isNarrow ? 'URL: ' : 'If the browser did not open, visit: '}
                </span>
              </text>
            )}
            {oauthAuthUrl && !isNarrow && (
              <text style={{ wrapMode: 'word' }}>
                <span fg={theme.primary}>{oauthAuthUrl.slice(0, contentMaxWidth - 4)}</span>
              </text>
            )}
          </box>
        )}

        {/* ── State: OAuth Error ── */}
        {oauthStatus === 'error' && errorMessage && (
          <box
            style={{
              flexDirection: 'column',
              alignItems: 'center',
              marginBottom: sectionMarginBottom,
              maxWidth: contentMaxWidth,
              flexShrink: 0,
              gap: 1,
            }}
          >
            <text style={{ wrapMode: 'word' }}>
              <span fg={theme.foreground}>Error: {errorMessage}</span>
            </text>
            <text style={{ wrapMode: 'none' }}>
              <span fg={theme.secondary}>Press ENTER to try again</span>
            </text>
          </box>
        )}

        {/* ── State: API Key / Claude code Input Panel ── */}
        {showApiKeyInput &&
          (selectedProvider?.type === 'apikey' ||
            selectedProvider?.type === 'claude-oauth' ||
            selectedProvider?.type === 'gemini-oauth') &&
          !apiKeyConnecting && (
          <box
            style={{
              flexDirection: 'column',
              alignItems: 'flex-start',
              marginBottom: sectionMarginBottom,
              maxWidth: contentMaxWidth,
              flexShrink: 0,
              gap: 1,
            }}
          >
            <text style={{ wrapMode: 'none' }}>
              <span fg={theme.foreground}>{selectedProvider.label}</span>
            </text>
            {/* Claude / Gemini: show the authorize URL to visit and the paste hint. */}
            {(selectedProvider.type === 'claude-oauth' ||
              selectedProvider.type === 'gemini-oauth') &&
              oauthAuthUrl &&
              !isNarrow && (
              <text style={{ wrapMode: 'word' }}>
                <span fg={theme.secondary}>Authorize in your browser, then paste the code below:</span>
                {'\n'}
                <span fg={theme.primary}>{oauthAuthUrl.slice(0, contentMaxWidth - 4)}</span>
              </text>
            )}
            {selectedProvider.type === 'apikey' && !isVerySmall && (
              <text style={{ wrapMode: 'word' }}>
                <span fg={theme.secondary}>{selectedProvider.placeholder}</span>
              </text>
            )}
            {/* Input box */}
            <box
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                marginTop: 1,
                gap: 0,
              }}
            >
              <text style={{ wrapMode: 'none' }}>
                <span fg={theme.secondary}>{'> '}</span>
                <span fg={theme.foreground}>{maskedApiKey}</span>
                <span fg={theme.primary}>{'█'}</span>
              </text>
            </box>
            {apiKeyError && (
              <text style={{ wrapMode: 'word' }}>
                <span fg={theme.error ?? theme.secondary}>{apiKeyError}</span>
              </text>
            )}
            {!isVerySmall && (
              <text style={{ wrapMode: 'none' }}>
                <span fg={theme.secondary}>
                  {isNarrow
                    ? 'Enter=connect · Esc=back · Ctrl+V=paste'
                    : 'Enter to connect · Escape to go back · Ctrl+V to paste from clipboard'}
                </span>
              </text>
            )}
          </box>
        )}

        {/* ── State: API Key Connecting ── */}
        {apiKeyConnecting && (
          <box
            style={{
              flexDirection: 'column',
              alignItems: 'center',
              marginBottom: sectionMarginBottom,
              maxWidth: contentMaxWidth,
              flexShrink: 0,
            }}
          >
            <text style={{ wrapMode: 'none' }}>
              <span fg={theme.foreground}>Connecting…</span>
            </text>
          </box>
        )}

        {/* ── State: Idle — prompt ── */}
        {!showProviderMenu && !oauthInProgress && !showApiKeyInput && !apiKeyConnecting && oauthStatus !== 'error' && (
          <box
            style={{
              flexDirection: 'column',
              alignItems: 'center',
              marginBottom: sectionMarginBottom,
              maxWidth: contentMaxWidth,
              flexShrink: 0,
            }}
          >
            <text style={{ wrapMode: 'none' }}>
              <span fg={theme.foreground}>Press ENTER to login…</span>
            </text>
          </box>
        )}

        {/* ── State: Provider menu ── */}
        {showProviderMenu && !oauthInProgress && !showApiKeyInput && oauthStatus !== 'error' && (
          <box
            style={{
              flexDirection: 'column',
              alignItems: 'flex-start',
              marginBottom: sectionMarginBottom,
              maxWidth: contentMaxWidth,
              flexShrink: 0,
              gap: 0,
            }}
          >
            {!isVerySmall && (
              <text style={{ wrapMode: 'none' }}>
                <span fg={theme.secondary}>
                  {isNarrow
                    ? 'Select provider (↑↓ + Enter):'
                    : 'Select a login provider  (↑ ↓ to navigate · Enter to confirm):'}
                </span>
              </text>
            )}
            <box
              style={{
                flexDirection: 'column',
                alignItems: 'flex-start',
                marginTop: 1,
                gap: 1,
              }}
            >
              {PROVIDERS.map((p, i) => {
                const isSelected = i === selectedIndex
                return (
                  <box key={p.id} style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
                    <text style={{ wrapMode: 'none' }}>
                      <span fg={isSelected ? theme.surface : theme.secondary}
                            bg={isSelected ? theme.primary : undefined}>
                        {` ${i + 1}. ${p.label} `}
                      </span>
                      {p.type === 'apikey' && (
                        <span fg={theme.secondary}>{' [API Key]'}</span>
                      )}
                    </text>
                    {!isNarrow && (
                      <text style={{ wrapMode: 'none' }}>
                        <span fg={theme.secondary}>{`   ${p.description}`}</span>
                      </text>
                    )}
                    {!isNarrow && !isVerySmall && (
                      <text style={{ wrapMode: 'none' }}>
                        <span fg={theme.info ?? theme.foreground}>{`   Models: ${p.badge}`}</span>
                      </text>
                    )}
                  </box>
                )
              })}
            </box>
          </box>
        )}

        {/* ── Retry after OAuth error ── */}
        {oauthStatus === 'error' && (
          <box
            style={{
              flexDirection: 'column',
              alignItems: 'center',
              maxWidth: contentMaxWidth,
              flexShrink: 0,
            }}
          >
            <text style={{ wrapMode: 'none' }}>
              <span fg={theme.primary}>[ Press ENTER to try again ]</span>
            </text>
          </box>
        )}
      </box>
    </box>
  )
}
