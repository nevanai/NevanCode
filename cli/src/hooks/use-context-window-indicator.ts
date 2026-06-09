/**
 * Hooks for the context-window progress indicator.
 *
 * The displayed usage is the standing conversation baseline plus whatever is
 * currently typed in the input box:
 *
 *   total = estimateConversationTokens(messages) + tokens(inputText)
 *
 * The conversation baseline is estimated cheaply (see context-window.ts) and
 * memoized on the message history, while the live input is tokenized precisely
 * with js-tiktoken (o200k_base) so the bar responds as the user types. Token
 * counts are approximate for non-OpenAI models (Claude may overcount ~10-20%);
 * a character-based fallback (length / 2, safer for Arabic/CJK) is used if
 * js-tiktoken is unavailable or throws.
 */

import { getEncoding, type Tiktoken } from 'js-tiktoken'
import { useMemo } from 'react'

import { useChatStore } from '../state/chat-store'
import {
  DANGER_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW,
  WARNING_THRESHOLD,
  resolveBaselineTokens,
} from '../utils/context-window'

// Cache the encoder instance to avoid recreating on every keystroke
let cachedEncoder: Tiktoken | null = null
let cachedEncoderError = false

function getEncoder(): Tiktoken | null {
  if (cachedEncoderError) return null
  if (cachedEncoder) return cachedEncoder

  try {
    cachedEncoder = getEncoding('o200k_base')
    return cachedEncoder
  } catch {
    cachedEncoderError = true
    return null
  }
}

/** Precisely count the tokens in the live input text. */
function countInputTokens(inputText: string): number {
  const encoder = getEncoder()
  if (encoder) {
    try {
      return encoder.encode(inputText).length
    } catch {
      // Encoder failed mid-use — invalidate cache so future calls use fallback
      cachedEncoder = null
      cachedEncoderError = true
      return Math.ceil(inputText.length / 2)
    }
  }
  return Math.ceil(inputText.length / 2)
}

export interface ContextWindowIndicatorState {
  /** Total tokens consumed (conversation baseline + live input). */
  tokenCount: number
  /** Tokens contributed by the conversation so far. */
  baselineTokens: number
  /** Tokens contributed by the current input text. */
  inputTokens: number
  /** Tokens remaining before the context window is full. */
  remainingTokens: number
  percentage: number
  isDanger: boolean // >= DANGER_THRESHOLD
  isWarning: boolean // >= WARNING_THRESHOLD && < DANGER_THRESHOLD
  contextWindowSize: number
}

/**
 * The standing conversation token baseline for the context-window bar.
 *
 * Priority, most real first:
 *   1. the LIVE per-step count streamed from the runtime (updates mid-run, so
 *      the bar rises and drops on auto-compaction as it actually happens),
 *   2. the last completed run's post-compaction count (accurate between turns),
 *   3. the on-screen transcript estimate (pre-run fallback, only ever grows).
 * Memoized so it only recomputes when an input changes, not on every keystroke.
 */
export function useConversationTokens(): number {
  const messages = useChatStore((state) => state.messages)
  const runtimeContextTokens = useChatStore(
    (state) => state.runState?.sessionState?.mainAgentState?.contextTokenCount,
  )
  const liveContextTokens = useChatStore(
    (state) => state.liveContextUsage?.tokenCount,
  )
  return useMemo(
    () =>
      typeof liveContextTokens === 'number' && liveContextTokens > 0
        ? liveContextTokens
        : resolveBaselineTokens(runtimeContextTokens, messages),
    [liveContextTokens, runtimeContextTokens, messages],
  )
}

/**
 * The live operational context window (max tokens) the runtime reported for the
 * current run, or undefined before the first step reports it. The bar uses this
 * as its denominator so it matches the window the pruner actually compacts
 * against — the bar fills to ~80% exactly when auto-compaction fires.
 */
export function useLiveContextWindowSize(): number | undefined {
  const max = useChatStore((state) => state.liveContextUsage?.maxTokens)
  return typeof max === 'number' && max > 0 ? max : undefined
}

/**
 * Combine the conversation baseline with the live input to produce the
 * indicator's usage state.
 *
 * @param inputText - The raw input string currently in the box
 * @param contextWindowSize - Maximum tokens for the current model (default 200K)
 * @param baselineTokens - Tokens already consumed by the conversation
 */
export function useContextWindowIndicator(
  inputText: string,
  contextWindowSize: number = DEFAULT_CONTEXT_WINDOW,
  baselineTokens: number = 0,
): ContextWindowIndicatorState {
  return useMemo(() => {
    const safeSize =
      contextWindowSize > 0 ? contextWindowSize : DEFAULT_CONTEXT_WINDOW
    const baseline = Math.max(0, baselineTokens)

    const inputTokens =
      inputText && inputText.trim().length > 0 ? countInputTokens(inputText) : 0

    const tokenCount = baseline + inputTokens
    const percentage = Math.min(100, (tokenCount / safeSize) * 100)

    return {
      tokenCount,
      baselineTokens: baseline,
      inputTokens,
      remainingTokens: Math.max(0, safeSize - tokenCount),
      percentage,
      isDanger: percentage >= DANGER_THRESHOLD,
      isWarning:
        percentage >= WARNING_THRESHOLD && percentage < DANGER_THRESHOLD,
      contextWindowSize: safeSize,
    }
  }, [inputText, contextWindowSize, baselineTokens])
}
