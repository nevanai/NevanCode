import {
  ANTHROPIC_OAUTH_DISPLAY_MODELS,
  ANTHROPIC_OAUTH_ENABLED,
  isAnthropicProviderModel,
} from '@codebuff/common/constants/anthropic-oauth'
import { CHATGPT_OAUTH_ENABLED } from '@codebuff/common/constants/chatgpt-oauth'
import {
  GEMINI_OAUTH_DISPLAY_MODELS,
  GEMINI_OAUTH_ENABLED,
  isGeminiProviderModel,
} from '@codebuff/common/constants/gemini-oauth'
import { install, uninstall, refreshPlugins } from '../utils/plugin-registry'

import { handleGoalCommand } from './goal'
import { handleHelpCommand } from './help'
import { handleImageCommand } from './image'
import { handleInitializationFlowLocally } from './init'
import {
  buildInterviewPrompt,
  buildPlanPrompt,
  buildReviewPromptFromArgs,
} from './prompt-builders'
import { buildUltrareviewPrompt, isUltrareviewEnabled } from './ultrareview'
import { runBashCommand } from './router'
import { handleUsageCommand } from './usage'
import { returnToFreebuffLanding } from '../hooks/use-freebuff-session'
import { useThemeStore } from '../hooks/use-theme'
import { useChatStore } from '../state/chat-store'
import { useGoalStore } from '../state/goal-store'
import { useLoginStore } from '../state/login-store'
import { getChatGptOAuthStatus } from '../utils/chatgpt-oauth'
import {
  getFireworksApiKey,
  getOpenRouterApiKey,
  clearFireworksApiKey,
  clearOpenRouterApiKey,
  getAnthropicOAuthCredentials,
  getGeminiOAuthCredentials,
  isAnyByokProviderLinked,
} from '@codebuff/sdk'
import {
  loadFireworksDiscoveredModels,
  loadOpenRouterDiscoveredModels,
  loadByokSelectedModel,
  saveByokSelectedModel,
} from '../utils/settings'
import { KNOWN_FIREWORKS_MODEL_IDS } from '../utils/fireworks-models'
import {
  AGENT_MODES,
  END_SESSION_MESSAGE,
  IS_FREEBUFF,
} from '../utils/constants'
import { getSystemMessage, getUserMessage } from '../utils/message-history'
import {
  findOpenAiModelOption,
  OPENAI_MODEL_OPTIONS,
  getSelectedOpenAiModel,
  saveOpenAiModelPreference,
} from '../utils/openai-models'
import { capturePendingAttachments } from '../utils/pending-attachments'
import { getSkillByName } from '../utils/skill-registry'

import type { MultilineInputHandle } from '../components/multiline-input'
import type { InputValue, PendingAttachment } from '../types/store'
import type { ChatMessage } from '../types/chat'
import type { SendMessageFn } from '../types/contracts/send-message'
import type { User } from '../utils/auth'
import type { AgentMode } from '../utils/constants'
import type { UseMutationResult } from '@tanstack/react-query'

export type RouterParams = {
  abortControllerRef: React.MutableRefObject<AbortController | null>
  agentMode: AgentMode
  inputRef: React.MutableRefObject<MultilineInputHandle | null>
  inputValue: string
  isChainInProgressRef: React.MutableRefObject<boolean>
  isStreaming: boolean
  logoutMutation: UseMutationResult<boolean, Error, void, unknown>
  streamMessageIdRef: React.MutableRefObject<string | null>
  addToQueue: (message: string, attachments?: PendingAttachment[]) => void
  clearMessages: () => void
  saveToHistory: (message: string) => void
  scrollToLatest: () => void
  sendMessage: SendMessageFn
  setCanProcessQueue: (value: React.SetStateAction<boolean>) => void
  setInputFocused: (focused: boolean) => void
  setInputValue: (
    value: InputValue | ((prev: InputValue) => InputValue),
  ) => void
  setIsAuthenticated: (value: React.SetStateAction<boolean | null>) => void
  setMessages: (
    value: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
  ) => void
  setUser: (value: React.SetStateAction<User | null>) => void
  stopStreaming: () => void
}

export type CommandResult = {
  openFeedbackMode?: boolean
  openPublishMode?: boolean
  openChatHistory?: boolean
  openReviewScreen?: boolean
  openPluginMode?: boolean
  openMcpMode?: boolean
  preSelectAgents?: string[]
} | void

export type CommandHandler = (
  params: RouterParams,
  args: string,
) => Promise<CommandResult> | CommandResult

export type CommandDefinition = {
  name: string
  aliases: string[]
  handler: CommandHandler
  /** Whether this command accepts arguments. Set automatically by the factory functions. */
  acceptsArgs: boolean
}

/**
 * Handler type for commands that don't accept arguments.
 */
type CommandHandlerNoArgs = (
  params: RouterParams,
) => Promise<CommandResult> | CommandResult

/**
 * Handler type for commands that accept arguments.
 */
type CommandHandlerWithArgs = (
  params: RouterParams,
  args: string,
) => Promise<CommandResult> | CommandResult

/**
 * Configuration for defining a command that does NOT accept arguments.
 */
type CommandConfig = {
  name: string
  aliases?: string[]
  handler: CommandHandlerNoArgs
}

/**
 * Configuration for defining a command that accepts arguments.
 */
type CommandWithArgsConfig = {
  name: string
  aliases?: string[]
  handler: CommandHandlerWithArgs
}

/**
 * Factory for commands that do NOT accept arguments.
 * Any args passed are gracefully ignored.
 *
 * @example
 * defineCommand({
 *   name: 'new',
 *   aliases: ['n', 'clear'],
 *   handler: (params) => {
 *     params.setMessages(() => [])
 *   },
 * })
 */
export function defineCommand(config: CommandConfig): CommandDefinition {
  return {
    name: config.name,
    aliases: config.aliases ?? [],
    acceptsArgs: false,
    handler: (params) => {
      // Args are gracefully ignored for commands that don't accept them
      return config.handler(params)
    },
  }
}

/**
 * Factory for commands that accept arguments.
 * The handler receives both params and args.
 *
 * @example
 * defineCommandWithArgs({
 *   name: 'bash',
 *   aliases: ['!'],
 *   handler: (params, args) => {
 *     if (args.trim()) {
 *       runBashCommand(args.trim())
 *     }
 *   },
 * })
 */
export function defineCommandWithArgs(
  config: CommandWithArgsConfig,
): CommandDefinition {
  return {
    name: config.name,
    aliases: config.aliases ?? [],
    acceptsArgs: true,
    handler: config.handler,
  }
}

const clearInput = (params: RouterParams) => {
  params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
}

/**
 * Resolve a user-typed BYOK model id against the provider's discovered models.
 *
 * Fireworks discovered ids already carry the `fireworks/` prefix (added at
 * discovery time) and the router strips it before calling the API, so the id
 * we persist must include that prefix. OpenRouter ids are used verbatim.
 *
 * Returns the resolved id plus whether it matched a known model — an exact id,
 * a prefix-equivalent id, or a unique suffix (the model name alone) all count
 * as a match; otherwise we best-effort normalize and flag matched=false.
 */
const resolveByokModel = (
  input: string,
  discovered: string[],
  isFireworks: boolean,
): { model: string; matched: boolean } => {
  // 1. Exact match against a discovered id
  if (discovered.includes(input)) {
    return { model: input, matched: true }
  }

  if (isFireworks) {
    // 2. Prefix-equivalent match (user dropped the fireworks/ prefix)
    const withPrefix = input.startsWith('fireworks/') ? input : `fireworks/${input}`
    if (discovered.includes(withPrefix)) {
      return { model: withPrefix, matched: true }
    }
    // 3. Unique suffix match (user typed just the model name)
    const suffixMatches = discovered.filter((m) => m.endsWith(`/${input}`))
    if (suffixMatches.length === 1) {
      return { model: suffixMatches[0], matched: true }
    }
    // 4. Best-effort: ensure the routing prefix is present
    return { model: withPrefix, matched: false }
  }

  // OpenRouter accepts any valid id verbatim
  return { model: input, matched: false }
}

const FREEBUFF_REMOVED_COMMANDS = new Set([
  'usage',
  'image',
  'publish',
  'gpt-5-agent',
  'model',
  'plugin',
])

const FREEBUFF_ONLY_COMMANDS = new Set(['plan', 'end-session'])

const ALL_COMMANDS: CommandDefinition[] = [
  defineCommand({
    name: 'help',
    aliases: ['h', '?'],
    handler: async (params) => {
      const { postUserMessage } = await handleHelpCommand()
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommandWithArgs({
    name: 'bash',
    aliases: ['!'],
    handler: (params, args) => {
      const trimmedArgs = args.trim()

      // If user provided a command directly, execute it immediately
      if (trimmedArgs) {
        const commandWithBang = '!' + trimmedArgs
        params.saveToHistory(commandWithBang)
        clearInput(params)
        runBashCommand(trimmedArgs)
        return
      }

      // Otherwise enter bash mode
      useChatStore.getState().setInputMode('bash')
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'login',
    aliases: ['signin'],
    handler: (params) => {
      params.setMessages((prev) => [
        ...prev,
        getSystemMessage(
          "You're already in the app. Use /logout to switch accounts.",
        ),
      ])
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'logout',
    aliases: ['signout'],
    handler: (params) => {
      params.abortControllerRef.current?.abort()
      params.stopStreaming()
      params.setCanProcessQueue(false)

      const { resetLoginState } = useLoginStore.getState()
      params.logoutMutation.mutate(undefined, {
        onSettled: () => {
          resetLoginState()
          params.setMessages((prev) => [
            ...prev,
            getSystemMessage('Logged out.'),
          ])
          clearInput(params)
          setTimeout(() => {
            params.setUser(null)
            params.setIsAuthenticated(false)
          }, 300)
        },
      })
    },
  }),
  defineCommand({
    name: 'exit',
    aliases: ['quit', 'q'],
    handler: () => {
      process.kill(process.pid, 'SIGINT')
    },
  }),
  defineCommandWithArgs({
    name: 'new',
    aliases: ['n', 'clear', 'c', 'reset'],
    handler: (params, args) => {
      const trimmedArgs = args.trim()

      // Clear the conversation
      params.setMessages(() => [])
      params.clearMessages()
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
      params.stopStreaming()

      // Starting a fresh chat session (a new thread): drop an auto-created goal
      // from the previous thread so it can't hijack the next request, and re-arm
      // the auto-create latch so the next user message seeds its own goal. An
      // explicit user-set goal (`/goal <objective>`) is deliberate and survives.
      useGoalStore.getState().startNewThread()

      // If user provided a message, send it as the first message in the new chat
      if (trimmedArgs) {
        // Re-enable queue processing so the message can be sent
        params.setCanProcessQueue(true)
        params.sendMessage({
          content: trimmedArgs,
          agentMode: params.agentMode,
        })
        setTimeout(() => {
          params.scrollToLatest()
        }, 0)
      } else {
        // Only disable queue if we're not sending a message
        params.setCanProcessQueue(false)
      }
    },
  }),
  defineCommandWithArgs({
    name: 'goal',
    handler: (params, args) => {
      const trimmed = params.inputValue.trim()
      const { postUserMessage } = handleGoalCommand(trimmed, args)
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(trimmed)
      clearInput(params)
    },
  }),
  defineCommand({
    name: 'init',
    handler: async (params) => {
      const { postUserMessage } = handleInitializationFlowLocally()
      const trimmed = params.inputValue.trim()

      params.saveToHistory(trimmed)
      clearInput(params)

      // Check streaming/queue state
      if (
        params.isStreaming ||
        params.streamMessageIdRef.current ||
        params.isChainInProgressRef.current
      ) {
        const pendingAttachments = capturePendingAttachments()
        params.addToQueue(trimmed, pendingAttachments)
        params.setInputFocused(true)
        params.inputRef.current?.focus()
        return
      }

      params.sendMessage({
        content: trimmed,
        agentMode: params.agentMode,
        postUserMessage,
      })
      setTimeout(() => {
        params.scrollToLatest()
      }, 0)
    },
  }),
  defineCommand({
    name: 'usage',
    aliases: ['credits'],
    handler: async (params) => {
      const { postUserMessage } = await handleUsageCommand()
      params.setMessages((prev) => postUserMessage(prev))
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  defineCommandWithArgs({
    name: 'image',
    aliases: ['img', 'attach'],
    handler: async (params, args) => {
      const trimmedArgs = args.trim()

      // If user provided a path directly, process it immediately
      if (trimmedArgs) {
        await handleImageCommand(trimmedArgs)
        params.saveToHistory(params.inputValue.trim())
        clearInput(params)
        return
      }

      // Otherwise enter image mode
      useChatStore.getState().setInputMode('image')
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
    },
  }),
  // Mode commands generated from AGENT_MODES (excluded in Freebuff)
  ...(IS_FREEBUFF ? [] : AGENT_MODES).map((mode) =>
    defineCommandWithArgs({
      name: `mode:${mode.toLowerCase()}`,
      aliases: [`model:${mode.toLowerCase()}`],
      handler: (params, args) => {
        const trimmedArgs = args.trim()

        useChatStore.getState().setAgentMode(mode)
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage(`Switched to ${mode} mode.`),
        ])
        params.saveToHistory(params.inputValue.trim())
        clearInput(params)

        // If user provided a message, send it in the new mode
        if (trimmedArgs) {
          params.setCanProcessQueue(true)
          params.sendMessage({
            content: trimmedArgs,
            agentMode: mode,
          })
          setTimeout(() => {
            params.scrollToLatest()
          }, 0)
        }
      },
    }),
  ),
  defineCommandWithArgs({
    name: 'publish',
    handler: (params, args) => {
      const trimmedArgs = args.trim()
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)

      // If user provided agent ids directly, skip to confirmation step
      if (trimmedArgs) {
        const agentIds = trimmedArgs.split(/\s+/).filter(Boolean)
        return { openPublishMode: true, preSelectAgents: agentIds }
      }

      // Otherwise open selection UI
      return { openPublishMode: true }
    },
  }),
  defineCommand({
    name: 'gpt-5-agent',
    handler: (params) => {
      // Insert @ GPT-5 Agent into the input field (UI shortcut, not a real command)
      params.setInputValue({
        text: '@GPT-5 Agent ',
        cursorPosition: '@GPT-5 Agent '.length,
        lastEditDueToNav: false,
      })
      params.inputRef.current?.focus()
      // Don't save to history - this is just a UI shortcut
    },
  }),
  ...(CHATGPT_OAUTH_ENABLED
    ? [
        defineCommand({
          name: 'connect',
          aliases: ['connect:chatgpt', 'chatgpt'],
          handler: (params) => {
            useChatStore.getState().setInputMode('connect:chatgpt')
            params.saveToHistory(params.inputValue.trim())
            clearInput(params)
          },
        }),
      ]
    : []),
  ...(ANTHROPIC_OAUTH_ENABLED
    ? [
        defineCommand({
          name: 'connect:claude',
          aliases: ['claude'],
          handler: (params) => {
            useChatStore.getState().setInputMode('connect:claude')
            params.saveToHistory(params.inputValue.trim())
            clearInput(params)
          },
        }),
      ]
    : []),
  ...(GEMINI_OAUTH_ENABLED
    ? [
        defineCommand({
          name: 'connect:gemini',
          aliases: ['gemini'],
          handler: (params) => {
            useChatStore.getState().setInputMode('connect:gemini')
            params.saveToHistory(params.inputValue.trim())
            clearInput(params)
          },
        }),
      ]
    : []),
  defineCommand({
    name: 'history',
    aliases: ['chats'],
    handler: (params) => {
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
      return { openChatHistory: true }
    },
  }),
  defineCommandWithArgs({
    name: 'interview',
    handler: (params, args) => {
      const trimmedArgs = args.trim()

      params.saveToHistory(params.inputValue.trim())
      clearInput(params)

      // If user provided text directly, send it immediately
      if (trimmedArgs) {
        params.sendMessage({
          content: buildInterviewPrompt(trimmedArgs),
          agentMode: params.agentMode,
          userIntent: trimmedArgs,
        })
        setTimeout(() => {
          params.scrollToLatest()
        }, 0)
        return
      }

      // Otherwise enter interview mode
      useChatStore.getState().setInputMode('interview')
    },
  }),
  defineCommandWithArgs({
    name: 'plan',
    handler: (params, args) => {
      // In freebuff mode, require ChatGPT connection
      if (IS_FREEBUFF && !getChatGptOAuthStatus().connected) {
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage(
            'Connect your ChatGPT account to use /plan. Use /connect to get started.',
          ),
        ])
        params.saveToHistory(params.inputValue.trim())
        clearInput(params)
        useChatStore.getState().setInputMode('connect:chatgpt')
        return
      }

      const trimmedArgs = args.trim()

      params.saveToHistory(params.inputValue.trim())
      clearInput(params)

      // If user provided plan text directly, send it immediately
      if (trimmedArgs) {
        params.sendMessage({
          content: buildPlanPrompt(trimmedArgs),
          agentMode: params.agentMode,
          userIntent: trimmedArgs,
        })
        setTimeout(() => {
          params.scrollToLatest()
        }, 0)
        return
      }

      // Otherwise enter plan mode
      useChatStore.getState().setInputMode('plan')
    },
  }),
  defineCommandWithArgs({
    name: 'review',
    handler: (params, args) => {
      // In freebuff mode, require ChatGPT connection
      if (IS_FREEBUFF && !getChatGptOAuthStatus().connected) {
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage(
            'Connect your ChatGPT account to use /review. Use /connect to get started.',
          ),
        ])
        params.saveToHistory(params.inputValue.trim())
        clearInput(params)
        useChatStore.getState().setInputMode('connect:chatgpt')
        return
      }

      const trimmedArgs = args.trim()

      params.saveToHistory(params.inputValue.trim())
      clearInput(params)

      // If user provided review text directly, send it immediately without showing the screen
      if (trimmedArgs) {
        params.sendMessage({
          content: buildReviewPromptFromArgs(trimmedArgs),
          agentMode: params.agentMode,
          userIntent: trimmedArgs,
        })
        setTimeout(() => {
          params.scrollToLatest()
        }, 0)
        return
      }

      // Otherwise open the selection UI
      return { openReviewScreen: true }
    },
  }),
  // /ultrareview — advanced deep review. With args, runs immediately; without
  // args, enters ultraReview input mode (mirrors /review). The `mode:ultrareview`
  // alias matches the literal mode name users may type.
  defineCommandWithArgs({
    name: 'ultrareview',
    aliases: ['mode:ultrareview'],
    handler: (params, args) => {
      const trimmedArgs = args.trim()

      params.saveToHistory(params.inputValue.trim())
      clearInput(params)

      // Local ultrareview has no remote gate; the guard documents the
      // integration point and stays correct if that ever changes.
      if (!isUltrareviewEnabled()) {
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage('Ultrareview is not available right now.'),
        ])
        return
      }

      // If the user provided a focus directly, send it immediately.
      if (trimmedArgs) {
        params.sendMessage({
          content: buildUltrareviewPrompt(trimmedArgs),
          agentMode: params.agentMode,
          userIntent: trimmedArgs,
        })
        setTimeout(() => {
          params.scrollToLatest()
        }, 0)
        return
      }

      // Otherwise enter ultrareview mode.
      useChatStore.getState().setInputMode('ultraReview')
    },
  }),
  defineCommand({
    name: 'theme:toggle',
    handler: (params) => {
      const { theme, setThemeName } = useThemeStore.getState()
      const newTheme = theme.name === 'dark' ? 'light' : 'dark'
      setThemeName(newTheme)
      params.setMessages((prev) => [
        ...prev,
        getUserMessage(params.inputValue.trim()),
        getSystemMessage(`Switched to ${newTheme} theme.`),
      ])
      clearInput(params)
    },
  }),
  // /model — show the model catalogue and set the active model.
  // When a BYOK provider is connected, shows and accepts provider models instead of OpenAI models.
  defineCommandWithArgs({
    name: 'model',
    handler: (params, args) => {
      const trimmedArgs = args.trim()
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)

      const fireworksCreds = getFireworksApiKey()
      const openRouterCreds = getOpenRouterApiKey()
      const byokConnected = isAnyByokProviderLinked()

      // ── Claude Pro/Max account is connected ───────────────────────────────
      // Checked before BYOK: Claude has no API key / discovery endpoint, so it
      // would otherwise be mislabelled by the fireworks-vs-openrouter logic.
      if (!byokConnected && getAnthropicOAuthCredentials()) {
        const currentModel = loadByokSelectedModel()

        if (trimmedArgs) {
          // Accept a listed model or any anthropic/* id the user types.
          const picked = isAnthropicProviderModel(trimmedArgs)
            ? trimmedArgs
            : `anthropic/${trimmedArgs.replace(/^anthropic\//, '')}`
          saveByokSelectedModel(picked)
          params.setMessages((prev) => [
            ...prev,
            getUserMessage(params.inputValue.trim()),
            getSystemMessage(
              `✓ Active model set to **${picked}** (via your Claude account)\n\nNew messages will use this model.`,
            ),
          ])
          return
        }

        const rows = ANTHROPIC_OAUTH_DISPLAY_MODELS.map((m, i) => {
          const selected = currentModel === m ? '  [selected]' : ''
          return `  ${String(i + 1).padStart(2)}. ${m}${selected}`
        }).join('\n')
        const statusLine = currentModel
          ? `Current selection: **${currentModel}**`
          : 'No model selected yet — agents use their per-tier defaults (all routed to your Claude account).'

        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage(
            `**Claude Models**\n\n${rows}\n\n${statusLine}\nUsage: /model <model-id> — e.g. /model anthropic/claude-opus-4.8`,
          ),
        ])
        return
      }

      // ── Gemini (Google account) is connected ──────────────────────────────
      // Like Claude: no API key / discovery endpoint, so it would otherwise be
      // mislabelled by the fireworks-vs-openrouter logic.
      if (!byokConnected && getGeminiOAuthCredentials()) {
        const currentModel = loadByokSelectedModel()

        if (trimmedArgs) {
          // Accept a listed model or any google/* id the user types.
          const picked = isGeminiProviderModel(trimmedArgs)
            ? trimmedArgs
            : `google/${trimmedArgs.replace(/^google\//, '')}`
          saveByokSelectedModel(picked)
          params.setMessages((prev) => [
            ...prev,
            getUserMessage(params.inputValue.trim()),
            getSystemMessage(
              `✓ Active model set to **${picked}** (via your Gemini account)\n\nNew messages will use this model.`,
            ),
          ])
          return
        }

        const rows = GEMINI_OAUTH_DISPLAY_MODELS.map((m, i) => {
          const selected = currentModel === m ? '  [selected]' : ''
          return `  ${String(i + 1).padStart(2)}. ${m}${selected}`
        }).join('\n')
        const statusLine = currentModel
          ? `Current selection: **${currentModel}**`
          : 'No model selected yet — agents use their per-tier defaults (all routed to your Gemini account).'

        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage(
            `**Gemini Models**\n\n${rows}\n\n${statusLine}\nUsage: /model <model-id> — e.g. /model google/gemini-3.1-pro`,
          ),
        ])
        return
      }

      // ── BYOK provider is connected ────────────────────────────────────────
      if (byokConnected) {
        const isFireworks = !!fireworksCreds && !openRouterCreds
        const providerName = isFireworks ? 'Fireworks' : 'OpenRouter'
        const discoveredModels = isFireworks
          ? loadFireworksDiscoveredModels()
          : loadOpenRouterDiscoveredModels()

        // Merge static known models with discovered ones (deduplicated, discovered first)
        const allModels = isFireworks
          ? [...new Set([...discoveredModels, ...KNOWN_FIREWORKS_MODEL_IDS])]
          : discoveredModels

        if (trimmedArgs) {
          const resolved = resolveByokModel(trimmedArgs, allModels, isFireworks)
          saveByokSelectedModel(resolved.model)
          const note = resolved.matched
            ? 'New messages will use this model.'
            : `Note: this model isn't in the known list — if requests fail, run /model to see valid ${providerName} models.`
          params.setMessages((prev) => [
            ...prev,
            getUserMessage(params.inputValue.trim()),
            getSystemMessage(
              `✓ Active model set to **${resolved.model}** (via ${providerName} BYOK)\n\n${note}`,
            ),
          ])
          return
        }

        // List available provider models (discovered IDs are stored ready to use)
        const currentByokModel = loadByokSelectedModel()
        let catalogueText: string

        if (allModels.length > 0) {
          const rows = allModels
            .slice(0, 20)
            .map((m, i) => {
              const selected = currentByokModel === m ? '  [selected]' : ''
              return `  ${String(i + 1).padStart(2)}. ${m}${selected}`
            })
            .join('\n')
          const more =
            discoveredModels.length > 20
              ? `\n  … and ${discoveredModels.length - 20} more`
              : ''
          catalogueText = `**${providerName} Models** (${discoveredModels.length} discovered)\n\n${rows}${more}`
        } else {
          const example = isFireworks
            ? '/model accounts/fireworks/models/deepseek-r1'
            : '/model anthropic/claude-opus-4.7'
          catalogueText = `**${providerName} Models**\n\n  Model list is loading — try again in a moment.\n  Or specify a model ID directly: ${example}`
        }

        const statusLine = currentByokModel
          ? `Current selection: **${currentByokModel}**`
          : 'No model selected yet. Pick one below or specify a model ID.'

        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage(
            `${catalogueText}\n\n${statusLine}\nUsage: /model <model-id> — copy a full id from the list above`,
          ),
        ])
        return
      }

      // ── No BYOK — show OpenAI model catalogue (existing behavior) ─────────
      const oauthStatus = getChatGptOAuthStatus()

      if (trimmedArgs) {
        const match = findOpenAiModelOption(trimmedArgs)
        if (match) {
          saveOpenAiModelPreference(match.id)
          const connectionNote =
            oauthStatus.state === 'connected'
              ? 'ChatGPT is connected. New messages will use this model.'
              : oauthStatus.state === 'expired'
                ? 'Your ChatGPT connection expired. Reconnect via /connect before sending.'
                : 'Connect via /connect before sending with this model.'

          params.setMessages((prev) => [
            ...prev,
            getUserMessage(params.inputValue.trim()),
            getSystemMessage(
              `✓ Active OpenAI model set to **${match.label}**\n\n${match.note}.\n${connectionNote}`,
            ),
          ])
          return
        }

        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage(
            `Model "${trimmedArgs}" not found. Run /model to see available models.`,
          ),
        ])
        return
      }

      const selectedModel = getSelectedOpenAiModel()
      const catalogueRows = OPENAI_MODEL_OPTIONS.map(
        (model, index) =>
          `  ${String(index + 1).padStart(2)}. ${model.label.padEnd(22)} ${model.note}${
            selectedModel?.id === model.id ? '  [selected]' : ''
          }`,
      ).join('\n')

      const statusLine = selectedModel
        ? oauthStatus.state === 'connected'
          ? `Current selection: **${selectedModel.label}** (ChatGPT connected)`
          : oauthStatus.state === 'expired'
            ? `Current selection: **${selectedModel.label}** (connection expired, run /connect)`
            : `Current selection: **${selectedModel.label}** (not connected, run /connect)`
        : 'No OpenAI model selected yet.'

      params.setMessages((prev) => [
        ...prev,
        getUserMessage(params.inputValue.trim()),
        getSystemMessage(
          `📋 **Available OpenAI Models**\n\n${catalogueRows}\n\n${statusLine}\nUsage: /model <name>  — e.g. /model gpt-5.5`,
        ),
      ])
    },
  }),

  // /plugin — browse and install plugins (MCP servers + skills)
  defineCommandWithArgs({
    name: 'plugin',
    aliases: ['plugins'],
    handler: async (params, args) => {
      const trimmedArgs = args.trim()
      params.saveToHistory(params.inputValue.trim())
      params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })

      // Non-interactive subcommands for agent/scripted use:
      //   /plugin install <name>
      //   /plugin remove <name> | /plugin uninstall <name>
      //   /plugin refresh
      if (trimmedArgs.startsWith('install ')) {
        const pluginName = trimmedArgs.slice('install '.length).trim()
        if (!pluginName) {
          params.setMessages((prev) => [
            ...prev,
            getSystemMessage('Usage: /plugin install <plugin-name>'),
          ])
          return
        }
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage(`Installing plugin "${pluginName}"…`),
        ])
        const result = await install(pluginName)
        if (result.success) {
          params.setMessages((prev) => [
            ...prev,
            getSystemMessage(
              `✓ Installed "${pluginName}" · ${result.skillCount} skill${result.skillCount !== 1 ? 's' : ''}, ${result.mcpCount} MCP server${result.mcpCount !== 1 ? 's' : ''}`,
            ),
          ])
        } else {
          params.setMessages((prev) => [
            ...prev,
            getSystemMessage(`✗ Failed to install "${pluginName}": ${result.error}`),
          ])
        }
        return
      }

      if (trimmedArgs.startsWith('remove ') || trimmedArgs.startsWith('uninstall ')) {
        const pluginName = trimmedArgs.startsWith('remove ')
          ? trimmedArgs.slice('remove '.length).trim()
          : trimmedArgs.slice('uninstall '.length).trim()
        if (!pluginName) {
          params.setMessages((prev) => [
            ...prev,
            getSystemMessage('Usage: /plugin remove <plugin-name>'),
          ])
          return
        }
        const result = await uninstall(pluginName)
        if (result.success) {
          params.setMessages((prev) => [
            ...prev,
            getUserMessage(params.inputValue.trim()),
            getSystemMessage(`✓ Removed plugin "${pluginName}"`),
          ])
        } else {
          params.setMessages((prev) => [
            ...prev,
            getUserMessage(params.inputValue.trim()),
            getSystemMessage(`✗ Failed to remove "${pluginName}": ${result.error}`),
          ])
        }
        return
      }

      if (trimmedArgs === 'refresh') {
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage('Refreshing plugin marketplace…'),
        ])
        const plugins = await refreshPlugins()
        params.setMessages((prev) => [
          ...prev,
          getSystemMessage(`✓ Marketplace updated · ${plugins.length} plugins available`),
        ])
        return
      }

      // No args or unrecognized subcommand → open the interactive TUI
      return { openPluginMode: true }
    },
  }),

  // /mcp — manage configured MCP servers (view, disable, clear auth)
  // /provider — show BYOK provider connection status and discovered models
  defineCommandWithArgs({
    name: 'provider',
    aliases: ['providers'],
    handler: (params, args) => {
      const trimmedArgs = args.trim().toLowerCase()
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)

      // /provider disconnect fireworks | openrouter
      if (trimmedArgs.startsWith('disconnect ')) {
        const name = trimmedArgs.slice('disconnect '.length).trim()
        if (name === 'fireworks') {
          clearFireworksApiKey()
          params.setMessages((prev) => [
            ...prev,
            getUserMessage(params.inputValue.trim()),
            getSystemMessage('✓ Fireworks.ai disconnected.'),
          ])
        } else if (name === 'openrouter') {
          clearOpenRouterApiKey()
          params.setMessages((prev) => [
            ...prev,
            getUserMessage(params.inputValue.trim()),
            getSystemMessage('✓ OpenRouter disconnected.'),
          ])
        } else {
          params.setMessages((prev) => [
            ...prev,
            getUserMessage(params.inputValue.trim()),
            getSystemMessage(`Unknown provider: ${name}. Available: fireworks, openrouter`),
          ])
        }
        return
      }

      const fireworksCreds = getFireworksApiKey()
      const openRouterCreds = getOpenRouterApiKey()
      const fireworksModels = loadFireworksDiscoveredModels()
      const openRouterModels = loadOpenRouterDiscoveredModels()

      const lines: string[] = ['📡 **BYOK Provider Status**\n']

      const fwStatus = fireworksCreds
        ? `✓ Connected (${new Date(fireworksCreds.connectedAt).toLocaleDateString()})`
        : '✗ Not connected'
      lines.push(`**Fireworks.ai** — ${fwStatus}`)
      if (fireworksCreds && fireworksModels.length > 0) {
        const preview = fireworksModels.slice(0, 8).join('\n  - ')
        lines.push(`  Models (${fireworksModels.length} discovered):\n  - ${preview}`)
        if (fireworksModels.length > 8) lines.push(`  … and ${fireworksModels.length - 8} more`)
        lines.push(`  Usage: type the model id prefixed with fireworks/\n  e.g. /model ${fireworksModels[0] ?? 'fireworks/accounts/fireworks/models/deepseek-r1'}`)
      } else if (fireworksCreds) {
        lines.push('  Model list loading in background — check again in a moment.')
      } else {
        lines.push('  Login via: press Enter on the main screen → Fireworks.ai API Key')
      }

      lines.push('')

      const orStatus = openRouterCreds
        ? `✓ Connected (${new Date(openRouterCreds.connectedAt).toLocaleDateString()})`
        : '✗ Not connected'
      lines.push(`**OpenRouter** — ${orStatus}`)
      if (openRouterCreds && openRouterModels.length > 0) {
        const preview = openRouterModels.slice(0, 5).join('\n  - ')
        lines.push(`  Models (${openRouterModels.length} discovered):\n  - ${preview}`)
        if (openRouterModels.length > 5) lines.push(`  … and ${openRouterModels.length - 5} more`)
        lines.push('  Usage: select any OpenRouter model id, e.g. /model anthropic/claude-opus-4.7')
      } else if (openRouterCreds) {
        lines.push('  Model list loading in background — check again in a moment.')
      } else {
        lines.push('  Login via: press Enter on the main screen → OpenRouter API Key')
      }

      lines.push('')
      lines.push('To disconnect: /provider disconnect fireworks|openrouter')

      params.setMessages((prev) => [
        ...prev,
        getUserMessage(params.inputValue.trim()),
        getSystemMessage(lines.join('\n')),
      ])
    },
  }),

  defineCommand({
    name: 'mcp',
    aliases: ['mcps'],
    handler: (params) => {
      params.saveToHistory(params.inputValue.trim())
      params.setInputValue({ text: '', cursorPosition: 0, lastEditDueToNav: false })
      return { openMcpMode: true }
    },
  }),

  // /end-session (freebuff-only) — end the active session early and drop back
  // to the model picker. The hook flips status to 'none', which unmounts
  // <Chat> and mounts <WaitingRoomScreen> on the landing view, where the
  // user picks a model and hits Enter to rejoin the queue.
  defineCommand({
    name: 'end-session',
    aliases: ['end-session-model', 'model'],
    handler: (params) => {
      params.setMessages((prev) => [
        ...prev,
        getUserMessage(params.inputValue.trim()),
        getSystemMessage(END_SESSION_MESSAGE),
      ])
      params.saveToHistory(params.inputValue.trim())
      clearInput(params)
      returnToFreebuffLanding({ resetChat: true }).catch(() => {
        // The hook surfaces poll errors via the session store; nothing to do
        // here beyond letting the chat history reflect the attempt.
      })
    },
  }),
]

export const COMMAND_REGISTRY: CommandDefinition[] = IS_FREEBUFF
  ? ALL_COMMANDS.filter((cmd) => !FREEBUFF_REMOVED_COMMANDS.has(cmd.name))
  : ALL_COMMANDS.filter((cmd) => !FREEBUFF_ONLY_COMMANDS.has(cmd.name))

export function findCommand(cmd: string): CommandDefinition | undefined {
  const lowerCmd = cmd.toLowerCase()

  // First check the static command registry
  const staticCommand = COMMAND_REGISTRY.find(
    (def) => def.name === lowerCmd || def.aliases.includes(lowerCmd),
  )
  if (staticCommand) {
    return staticCommand
  }

  // Check if this is a skill command (prefixed with "skill:")
  if (lowerCmd.startsWith('skill:')) {
    const skillName = lowerCmd.slice('skill:'.length)
    const skill = getSkillByName(skillName)
    if (skill) {
      return createSkillCommand(skill.name)
    }
  }

  return undefined
}

/**
 * Creates a dynamic command definition for a skill.
 * When invoked, the skill's content is sent to the agent.
 */
function createSkillCommand(skillName: string): CommandDefinition {
  return defineCommandWithArgs({
    name: skillName,
    handler: (params, args) => {
      const skill = getSkillByName(skillName)
      if (!skill) {
        params.setMessages((prev) => [
          ...prev,
          getUserMessage(params.inputValue.trim()),
          getSystemMessage(`Skill not found: ${skillName}`),
        ])
        params.saveToHistory(params.inputValue.trim())
        params.setInputValue({
          text: '',
          cursorPosition: 0,
          lastEditDueToNav: false,
        })
        return
      }

      const trimmed = params.inputValue.trim()
      params.saveToHistory(trimmed)
      params.setInputValue({
        text: '',
        cursorPosition: 0,
        lastEditDueToNav: false,
      })

      // Build the message content with skill context and optional user args
      const skillContext = `<skill name="${skill.name}">
${skill.content}
</skill>`

      const userPrompt =
        `I invoke the following skill:\n\n${skillContext}\n\n` +
        (args.trim() ? `User request: ${args.trim()}` : '')

      // Check streaming/queue state
      if (
        params.isStreaming ||
        params.streamMessageIdRef.current ||
        params.isChainInProgressRef.current
      ) {
        const pendingAttachments = capturePendingAttachments()
        params.addToQueue(userPrompt, pendingAttachments)
        params.setInputFocused(true)
        params.inputRef.current?.focus()
        return
      }

      params.sendMessage({
        content: userPrompt,
        agentMode: params.agentMode,
      })
      setTimeout(() => {
        params.scrollToLatest()
      }, 0)
    },
  })
}
