import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import { useCallback, useEffect, useState } from 'react'

import {
  getAnthropicOAuthCredentials,
  getChatGptOAuthCredentials,
  getGeminiOAuthCredentials,
  isAnyByokProviderLinked,
} from '@codebuff/sdk'

import { useAuthQuery, useLogoutMutation } from './use-auth-query'
import { useLoginStore } from '../state/login-store'
import { identifyUser, trackEvent } from '../utils/analytics'
import { getUserCredentials } from '../utils/auth'
import { resetCodebuffClient } from '../utils/codebuff-client'
import { IS_FREEBUFF } from '../utils/constants'
import { loggerContext } from '../utils/logger'

import type { MultilineInputHandle } from '../components/multiline-input'
import type { User } from '../utils/auth'

const setAuthLoggerContext = (params: { userId: string; email: string }) => {
  loggerContext.userId = params.userId
  loggerContext.userEmail = params.email
  identifyUser(params.userId, { email: params.email, freebuff: IS_FREEBUFF })
}

const clearAuthLoggerContext = () => {
  delete loggerContext.userId
  delete loggerContext.userEmail
}

interface UseAuthStateOptions {
  requireAuth: boolean | null
  inputRef: React.MutableRefObject<MultilineInputHandle | null>
  setInputFocused: (focused: boolean) => void
  resetChatStore: () => void
}

export const useAuthState = ({
  requireAuth,
  inputRef,
  setInputFocused,
  resetChatStore,
}: UseAuthStateOptions) => {
  const authQuery = useAuthQuery()
  const logoutMutation = useLogoutMutation()
  const { resetLoginState } = useLoginStore()

  const initialAuthState = requireAuth === null ? null : !requireAuth
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(
    initialAuthState,
  )
  const [user, setUser] = useState<User | null>(null)

  // Update authentication state when requireAuth changes
  useEffect(() => {
    if (requireAuth === null) {
      return
    }
    setIsAuthenticated(!requireAuth)
  }, [requireAuth])

  // When ChatGPT OAuth is linked, populate user from stored credentials without
  // requiring Codebuff backend validation — the auth query is disabled in this case.
  // We only check for the presence of credentials (not their momentary validity)
  // to keep the auth surface stable while the SDK auto-refreshes the token in the
  // background; otherwise a 5-minute-pre-expiry blip would briefly clear the user.
  useEffect(() => {
    if (user) return
    if (!getChatGptOAuthCredentials()) return
    const storedCreds = getUserCredentials()
    if (!storedCreds) return
    setUser(storedCreds)
    if (storedCreds.id && storedCreds.email) {
      setAuthLoggerContext({ userId: storedCreds.id, email: storedCreds.email })
    }
  }, [user])

  // Populate user from stored credentials when any BYOK provider is linked,
  // same pattern as ChatGPT OAuth — no Codebuff backend validation needed.
  useEffect(() => {
    if (user) return
    if (!isAnyByokProviderLinked()) return
    const storedCreds = getUserCredentials()
    if (!storedCreds) return
    setUser(storedCreds)
    if (storedCreds.id && storedCreds.email) {
      setAuthLoggerContext({ userId: storedCreds.id, email: storedCreds.email })
    }
  }, [user])

  // Same for a connected Claude Pro/Max account — requests route directly to
  // the native Anthropic API, so no Codebuff backend validation is needed.
  useEffect(() => {
    if (user) return
    if (!getAnthropicOAuthCredentials()) return
    const storedCreds = getUserCredentials()
    if (!storedCreds) return
    setUser(storedCreds)
    if (storedCreds.id && storedCreds.email) {
      setAuthLoggerContext({ userId: storedCreds.id, email: storedCreds.email })
    }
  }, [user])

  // Same for a connected Gemini (Google) account — requests route directly to
  // the Code Assist API, so no Codebuff backend validation is needed.
  useEffect(() => {
    if (user) return
    if (!getGeminiOAuthCredentials()) return
    const storedCreds = getUserCredentials()
    if (!storedCreds) return
    setUser(storedCreds)
    if (storedCreds.id && storedCreds.email) {
      setAuthLoggerContext({ userId: storedCreds.id, email: storedCreds.email })
    }
  }, [user])

  // Update authentication state based on query results
  useEffect(() => {
    if (authQuery.isSuccess && authQuery.data) {
      setIsAuthenticated(true)
      if (!user) {
        const userCredentials = getUserCredentials()
        const userData: User = {
          id: authQuery.data.id,
          name: userCredentials?.name || '',
          email: authQuery.data.email || '',
          authToken: userCredentials?.authToken || '',
        }
        setUser(userData)
        setAuthLoggerContext({
          userId: authQuery.data.id,
          email: authQuery.data.email || '',
        })
      }
    } else if (authQuery.isError) {
      // Don't clear auth when ChatGPT OAuth is linked — backend outage is fine
      // because we route directly to OpenAI.
      if (getChatGptOAuthCredentials()) return
      // Same: don't clear auth when a BYOK provider is linked.
      if (isAnyByokProviderLinked()) return
      // Same: don't clear auth when a Claude account is linked.
      if (getAnthropicOAuthCredentials()) return
      // Same: don't clear auth when a Gemini account is linked.
      if (getGeminiOAuthCredentials()) return
      setIsAuthenticated(false)
      setUser(null)
      clearAuthLoggerContext()
    }
  }, [authQuery.isSuccess, authQuery.isError, authQuery.data, user])

  // Handle successful login
  const handleLoginSuccess = useCallback(
    (loggedInUser: User) => {
      // Track successful login
      trackEvent(AnalyticsEvent.LOGIN, {
        userId: loggedInUser.id,
        hasEmail: Boolean(loggedInUser.email),
        hasName: Boolean(loggedInUser.name),
      })

      // Reset the SDK client to pick up new credentials
      resetCodebuffClient()
      resetChatStore()
      resetLoginState()
      setInputFocused(true)
      setUser(loggedInUser)
      setIsAuthenticated(true)

      if (loggedInUser.id && loggedInUser.email) {
        setAuthLoggerContext({
          userId: loggedInUser.id,
          email: loggedInUser.email,
        })
      }
    },
    [resetChatStore, resetLoginState, setInputFocused],
  )

  // Auto-focus input after authentication
  useEffect(() => {
    if (isAuthenticated !== true) return

    setInputFocused(true)

    const focusNow = () => {
      const handle = inputRef.current
      if (handle && typeof handle.focus === 'function') {
        handle.focus()
      }
    }

    focusNow()
    const timeoutId = setTimeout(focusNow, 0)

    return () => clearTimeout(timeoutId)
  }, [isAuthenticated, setInputFocused, inputRef])

  return {
    isAuthenticated,
    setIsAuthenticated,
    user,
    setUser,
    handleLoginSuccess,
    logoutMutation,
  }
}
