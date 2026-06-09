import { CHATGPT_OAUTH_ENABLED } from '@codebuff/common/constants/chatgpt-oauth'
import {
  getChatGptOAuthCredentials,
  getValidChatGptOAuthCredentials,
} from '@codebuff/sdk'
import { enableMapSet } from 'immer'

import { initializeThemeStore } from '../hooks/use-theme'
import { setProjectRoot } from '../project-files'
import { initTimestampFormatter } from '../utils/helpers'
import { enableManualThemeRefresh } from '../utils/theme-system'
import { initAnalytics } from '../utils/analytics'
import { ensureDefaultOpenAiModelForChatGptSession } from '../utils/chatgpt-default-model'
import { getFingerprintId } from '../utils/fingerprint'
import { startSemanticContext } from '../utils/semantic-context'
import { initializeDirenv } from './init-direnv'

export async function initializeApp(params: { cwd?: string }): Promise<void> {
  if (params.cwd) {
    process.chdir(params.cwd)
  }
  const baseCwd = process.cwd()
  setProjectRoot(baseCwd)

  // Initialize analytics before direnv, because direnv uses the logger
  // which calls trackEvent — analytics must be ready first.
  try {
    initAnalytics()
  } catch (error) {
    console.debug('Failed to initialize analytics:', error)
  }

  // Initialize direnv environment before anything else
  initializeDirenv()

  enableMapSet()
  initializeThemeStore()
  enableManualThemeRefresh()
  initTimestampFormatter()

  // Compute the hardware-based fingerprint in the background so it's ready
  // by the time the user finishes reading the login prompt.
  void getFingerprintId()

  // Start the semantic context engine in the background. Indexing runs
  // without blocking startup; progress is published via useIndexingStore so
  // the chat UI can render a status line. Failures are swallowed — the CLI
  // must remain usable even when indexing breaks.
  startSemanticContext(baseCwd).catch(() => {
    // Errors already routed through logger + useIndexingStore.setError.
  })

  // Refresh ChatGPT OAuth credentials in the background if they exist, and
  // auto-pick a sensible OpenAI model so the user's first message is routed
  // directly to their ChatGPT account instead of falling through to the
  // Codebuff backend. Without an OpenAI model selected, the agent runs on
  // the default Claude model which would require a Codebuff API key.
  if (CHATGPT_OAUTH_ENABLED) {
    const chatGptCredentials = getChatGptOAuthCredentials()
    if (chatGptCredentials) {
      ensureDefaultOpenAiModelForChatGptSession()
      getValidChatGptOAuthCredentials().catch(() => {
        // Best-effort background refresh.
      })
    }
  }
}
