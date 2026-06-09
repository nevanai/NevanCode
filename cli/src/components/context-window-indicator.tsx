/**
 * Context Window Progress Indicator.
 *
 * Renders a real-time progress bar below the chat input showing how much of
 * the model's context window is consumed — the standing conversation usage
 * plus whatever is currently typed in the box. Updates live as the user types.
 *
 * Layout mirrors the familiar terminal style: an uppercase "CONTEXT WINDOW"
 * label on the left, the live "X / Y" token count on the right (e.g.
 * "32K / 200K" for Claude, "320K / 1M" for Gemini), a full-width two-tone
 * bar beneath it, and an English warning once the danger zone is reached.
 *
 * The bar color follows a continuous gradient:
 *   - Green   (low usage): plenty of room
 *   - Amber   (mid usage): approaching the caution zone
 *   - Red     (high usage): danger zone, risk of hitting the context limit
 */

import React from 'react'

import { useTheme } from '../hooks/use-theme'
import {
  useContextWindowIndicator,
  useConversationTokens,
  useLiveContextWindowSize,
} from '../hooks/use-context-window-indicator'
import {
  CONTEXT_DANGER_COLOR,
  colorForPercentage,
  formatTokenCount,
} from '../utils/context-window'

interface ContextWindowIndicatorProps {
  /** Raw text currently in the input box. */
  inputValue: string
  /** Maximum tokens for the active model. */
  contextWindowSize: number
  /** Available terminal width in columns. */
  width: number
}

// Left-aligned partial blocks (1/8 … 7/8) give the bar a smooth leading edge
// so it advances sub-character as text grows, not in whole-cell jumps.
const PARTIAL_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

function formatPercent(percentage: number): string {
  if (percentage >= 1) return `${Math.round(percentage)}%`
  return percentage > 0 ? '<1%' : '0%'
}

export const ContextWindowIndicator: React.FC<ContextWindowIndicatorProps> = ({
  inputValue,
  contextWindowSize,
  width,
}) => {
  const theme = useTheme()
  const baselineTokens = useConversationTokens()
  // During a run the runtime reports the actual operational window; prefer it so
  // the bar's denominator matches where auto-compaction fires. Before the first
  // step, fall back to the model's window resolved from its label.
  const liveSize = useLiveContextWindowSize()
  const effectiveSize = liveSize ?? contextWindowSize
  const state = useContextWindowIndicator(
    inputValue,
    effectiveSize,
    baselineTokens,
  )
  const { percentage, tokenCount, remainingTokens, isDanger, contextWindowSize: size } = state

  // Nothing to show on a fresh session with an empty input box.
  if (tokenCount === 0) return null

  const barColor = colorForPercentage(percentage)
  const trackColor = theme.border

  // Reserve 2 columns of left padding so the bar aligns under the input box.
  const barChars = Math.max(10, width - 2)
  const fillRatio = Math.max(0, Math.min(1, percentage / 100))

  // Eighth-block precision: 8 sub-cells per character cell.
  const filledSubs = Math.round(fillRatio * barChars * 8)
  const fullChars = Math.floor(filledSubs / 8)
  const remainder = filledSubs % 8
  const partial = remainder > 0 ? PARTIAL_BLOCKS[remainder] : ''
  const emptyChars = Math.max(0, barChars - fullChars - (partial ? 1 : 0))

  // "32K / 200K" style — shows the real model max instead of a hardcoded "100%".
  const usedStr = formatTokenCount(tokenCount)
  const maxStr = formatTokenCount(size)

  return (
    <box
      style={{
        flexDirection: 'column',
        paddingLeft: 2,
        gap: 0,
      }}
    >
      <box
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          width: barChars,
        }}
      >
        <text style={{ fg: theme.muted }}>CONTEXT WINDOW</text>
        <text style={{ fg: barColor }}>
          {usedStr} / {maxStr} ({formatPercent(percentage)})
        </text>
      </box>

      <text style={{ wrapMode: 'none' }}>
        {fullChars > 0 ? <span fg={barColor}>{'█'.repeat(fullChars)}</span> : null}
        {partial ? (
          <span fg={barColor} bg={trackColor}>
            {partial}
          </span>
        ) : null}
        {emptyChars > 0 ? (
          <span fg={trackColor}>{'█'.repeat(emptyChars)}</span>
        ) : null}
      </text>

      {isDanger && (
        <text style={{ fg: CONTEXT_DANGER_COLOR }}>
          ⚠ Approaching context limit — {Math.round(percentage)}% used,{' '}
          {remainingTokens.toLocaleString()} tokens left
        </text>
      )}
    </box>
  )
}
