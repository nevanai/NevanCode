/**
 * Context window size mappings and utilities.
 *
 * Maps known model patterns to their maximum context window token limits and
 * provides the helpers behind the context-window progress indicator: a smooth
 * green→yellow→red color gradient, a cheap token estimator, and conversation
 * text extraction for the standing-usage baseline.
 */

import type { ChatMessage, ContentBlock } from '../types/chat'

// Manually ordered to prevent substring collisions — longer/more-specific
// keys listed first (e.g., 'gpt-4-turbo' before 'gpt-4', 'claude-3.5' before 'claude-3')
export const CONTEXT_WINDOW_SIZES: Record<string, number> = {
  // Claude models — 200K tokens (1M for Claude 4 with extended context beta)
  'claude-sonnet-4': 200_000,
  'claude-opus-4': 200_000,
  'claude-haiku': 200_000,
  'claude-3.5': 200_000,
  'claude-3': 200_000,
  // GPT-4 models — mostly 128K (base GPT-4: 8K, GPT-4.1: 1M)
  'gpt-4-turbo': 128_000,
  'gpt-4.1': 1_000_000,
  'gpt-4o': 128_000,
  'gpt-4': 8_192,
  'gpt-5': 256_000,
  'gpt-5.1': 256_000,
  // Gemini models — 1M+
  'gemini-1.5': 1_000_000,
  'gemini-2': 1_000_000,
  'gemini-2.5': 1_000_000,
  'gemini-3': 1_000_000,
}

export const DEFAULT_CONTEXT_WINDOW = 200_000

/** Usage threshold (percent) at which the indicator enters the danger zone. */
export const DANGER_THRESHOLD = 80
/** Usage threshold (percent) at which the indicator enters the caution zone. */
export const WARNING_THRESHOLD = 50

/**
 * Resolve the context window size for a given model label.
 * Falls back to DEFAULT_CONTEXT_WINDOW if the model is unrecognized.
 */
export function getContextWindowSize(modelLabel?: string): number {
  if (!modelLabel) return DEFAULT_CONTEXT_WINDOW
  const lower = modelLabel.toLowerCase()
  for (const [key, size] of Object.entries(CONTEXT_WINDOW_SIZES)) {
    if (lower.includes(key)) return size
  }
  return DEFAULT_CONTEXT_WINDOW
}

/**
 * Format a token count for compact display.
 *   formatTokenCount(500)        => "500"
 *   formatTokenCount(1_500)      => "1.5K"
 *   formatTokenCount(15_000)     => "15K"
 *   formatTokenCount(150_000)    => "150K"
 *   formatTokenCount(1_500_000)  => "1.5M"
 *   formatTokenCount(256_000)    => "256K"
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1_000) return Math.round(n).toString()
  if (n < 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K'
  if (n < 1_000_000) return Math.round(n / 1_000) + 'K'
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
}

// ============================================================================
// COLOR GRADIENT
// ============================================================================

// The themes ship a pure black & white palette, so the indicator deliberately
// breaks out of the monochrome chrome with real RGB stops: green when there's
// plenty of room, amber through the caution zone, red as the window fills.
const GRADIENT_GREEN = [63, 185, 80] as const // #3fb950
const GRADIENT_AMBER = [227, 179, 65] as const // #e3b341
const GRADIENT_RED = [248, 81, 73] as const // #f85149

/** Fixed danger red for the "approaching limit" warning text. */
export const CONTEXT_DANGER_COLOR = '#f85149'

const lerp = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t)

const toHex = (rgb: readonly [number, number, number] | number[]): string =>
  '#' + rgb.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('')

/**
 * Map a usage percentage (0–100) to a color along a green→amber→red gradient.
 * The transition is continuous so the bar shifts hue smoothly as text grows.
 */
export function colorForPercentage(percentage: number): string {
  const p = Math.max(0, Math.min(100, percentage))
  if (p <= WARNING_THRESHOLD) {
    const t = p / WARNING_THRESHOLD
    return toHex(GRADIENT_GREEN.map((c, i) => lerp(c, GRADIENT_AMBER[i], t)))
  }
  const t = (p - WARNING_THRESHOLD) / (100 - WARNING_THRESHOLD)
  return toHex(GRADIENT_AMBER.map((c, i) => lerp(c, GRADIENT_RED[i], t)))
}

// ============================================================================
// TOKEN ESTIMATION
// ============================================================================

/**
 * Cheap token estimate from raw text (~4 chars/token). Used for the standing
 * conversation baseline, where re-running a full tokenizer over the entire
 * history on every render would be wasteful. The live input box is counted
 * precisely with a real tokenizer (see use-context-window-indicator).
 */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/** Pull the context-consuming text out of a single content block. */
function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
    case 'plan':
      return block.content
    case 'agent':
      return [block.initialPrompt, block.content].filter(Boolean).join('\n')
    case 'tool': {
      const input =
        typeof block.input === 'string'
          ? block.input
          : block.input != null
            ? JSON.stringify(block.input)
            : ''
      return [input, block.output ?? ''].filter(Boolean).join('\n')
    }
    default:
      // image / agent-list / ask-user / html / mode-divider contribute little
      // (or non-serializable) text — skip for the estimate.
      return ''
  }
}

/**
 * Extract the text a message contributes to the model's context. Prefers
 * structured blocks when present (they carry tool outputs — the dominant
 * context cost) and otherwise falls back to the flat `content` string, which
 * avoids double-counting assistant text that lives in both.
 */
export function extractMessageText(message: ChatMessage): string {
  const parts: string[] = []
  const blocks = message.blocks ?? []
  if (blocks.length > 0) {
    for (const block of blocks) {
      const text = blockText(block)
      if (text) parts.push(text)
    }
  } else if (message.content) {
    parts.push(message.content)
  }

  for (const att of message.textAttachments ?? []) {
    if (att.content) parts.push(att.content)
  }
  for (const att of message.fileAttachments ?? []) {
    if (att.note) parts.push(att.note)
  }
  return parts.join('\n')
}

// Per-message token cache keyed by the message object reference. The chat
// store (immer) preserves references for unchanged messages and allocates a
// fresh object only for the one being mutated, so during streaming we re-count
// just the active message and hit the cache for the rest of the history.
const messageTokenCache = new WeakMap<ChatMessage, number>()

function messageTokens(message: ChatMessage): number {
  const cached = messageTokenCache.get(message)
  if (cached !== undefined) return cached
  const tokens = estimateTokensFromText(extractMessageText(message))
  messageTokenCache.set(message, tokens)
  return tokens
}

/**
 * Estimate the total tokens already consumed by the conversation so far. This
 * is the standing baseline the live input is added on top of.
 */
export function estimateConversationTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const message of messages) total += messageTokens(message)
  return total
}

/**
 * Choose the conversation baseline for the context-window bar.
 *
 * Prefers the runtime's accurate, post-compaction token count
 * (`runState.sessionState.mainAgentState.contextTokenCount`, reported by the SDK
 * after each run) when it is available. That number reflects the REAL model
 * context — system prompt + tool definitions + the possibly-summarized message
 * history — so the bar drops back down after the agent auto-compacts at 80%,
 * instead of climbing forever with the append-only on-screen transcript.
 *
 * Falls back to the cheap transcript estimate before the first run reports a
 * count (e.g. the very first turn, or a freshly continued chat), so the bar is
 * never blank.
 */
export function resolveBaselineTokens(
  runtimeContextTokens: number | undefined | null,
  messages: ChatMessage[],
): number {
  if (typeof runtimeContextTokens === 'number' && runtimeContextTokens > 0) {
    return runtimeContextTokens
  }
  return estimateConversationTokens(messages)
}
