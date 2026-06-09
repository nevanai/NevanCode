import { describe, test, expect } from 'bun:test'

import type { ChatMessage } from '../../types/chat'
import {
  DANGER_THRESHOLD,
  WARNING_THRESHOLD,
  colorForPercentage,
  estimateConversationTokens,
  estimateTokensFromText,
  extractMessageText,
  formatTokenCount,
  getContextWindowSize,
  resolveBaselineTokens,
} from '../context-window'

const msg = (m: Partial<ChatMessage>): ChatMessage => ({
  id: Math.random().toString(36).slice(2),
  variant: 'user',
  content: '',
  timestamp: '',
  ...m,
})

describe('getContextWindowSize', () => {
  test('resolves known models, longest-prefix first', () => {
    expect(getContextWindowSize('claude-opus-4-8')).toBe(200_000)
    expect(getContextWindowSize('gpt-4-turbo-2024')).toBe(128_000)
    expect(getContextWindowSize('gpt-4')).toBe(8_192)
    expect(getContextWindowSize('gemini-2.0-flash')).toBe(1_000_000)
  })

  test('falls back to default for unknown / missing labels', () => {
    expect(getContextWindowSize()).toBe(200_000)
    expect(getContextWindowSize('some-future-model')).toBe(200_000)
  })
})

describe('colorForPercentage', () => {
  const hexToRgb = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]

  test('anchors at green / amber / red', () => {
    expect(colorForPercentage(0)).toBe('#3fb950')
    expect(colorForPercentage(WARNING_THRESHOLD)).toBe('#e3b341')
    expect(colorForPercentage(100)).toBe('#f85149')
  })

  test('clamps out-of-range input', () => {
    expect(colorForPercentage(-20)).toBe('#3fb950')
    expect(colorForPercentage(250)).toBe('#f85149')
  })

  test('the danger zone reads visibly red (R dominant, G low)', () => {
    const [r, g, b] = hexToRgb(colorForPercentage(90))
    expect(r).toBeGreaterThan(200)
    expect(g).toBeLessThan(130)
    expect(r).toBeGreaterThan(b)
  })

  test('transition is monotonic toward red as usage climbs', () => {
    const greens = [0, 25, 50, 75, 100].map((p) => hexToRgb(colorForPercentage(p))[1])
    for (let i = 1; i < greens.length; i++) {
      expect(greens[i]).toBeLessThanOrEqual(greens[i - 1])
    }
  })
})

describe('estimateTokensFromText', () => {
  test('roughly 4 chars per token, zero for empty', () => {
    expect(estimateTokensFromText('')).toBe(0)
    expect(estimateTokensFromText('a'.repeat(400))).toBe(100)
  })
})

describe('extractMessageText', () => {
  test('uses flat content when there are no blocks', () => {
    expect(extractMessageText(msg({ content: 'hello world' }))).toBe('hello world')
  })

  test('prefers blocks over content to avoid double-counting', () => {
    const text = extractMessageText(
      msg({
        content: 'DUPLICATE',
        blocks: [
          { type: 'text', content: 'assistant reply' },
          { type: 'tool', toolCallId: 't1', toolName: 'read_files' as any, input: { path: 'a.ts' }, output: 'file body' },
        ],
      }),
    )
    expect(text).not.toContain('DUPLICATE')
    expect(text).toContain('assistant reply')
    expect(text).toContain('a.ts') // serialized tool input
    expect(text).toContain('file body') // tool output
  })

  test('includes text attachments', () => {
    const text = extractMessageText(
      msg({
        content: 'see attached',
        textAttachments: [{ id: '1', content: 'PASTED', preview: 'P', charCount: 6 }],
      }),
    )
    expect(text).toContain('see attached')
    expect(text).toContain('PASTED')
  })
})

describe('estimateConversationTokens', () => {
  test('sums per-message estimates and is cached by reference', () => {
    const a = msg({ content: 'a'.repeat(400) }) // 100 tokens
    const b = msg({ content: 'b'.repeat(800) }) // 200 tokens
    expect(estimateConversationTokens([a, b])).toBe(300)
    // Same references again — cache path returns the identical total.
    expect(estimateConversationTokens([a, b])).toBe(300)
  })

  test('empty conversation is zero', () => {
    expect(estimateConversationTokens([])).toBe(0)
  })
})

describe('resolveBaselineTokens', () => {
  const a = msg({ content: 'a'.repeat(400) }) // 100 tokens
  const b = msg({ content: 'b'.repeat(800) }) // 200 tokens

  test('prefers the runtime count when available', () => {
    // Real post-compaction context wins over the (larger) transcript estimate,
    // so the bar drops after the agent auto-compacts.
    expect(resolveBaselineTokens(50_000, [a, b])).toBe(50_000)
  })

  test('falls back to the transcript estimate before the first run reports', () => {
    expect(resolveBaselineTokens(undefined, [a, b])).toBe(300)
    expect(resolveBaselineTokens(null, [a, b])).toBe(300)
  })

  test('ignores a zero / non-positive runtime count', () => {
    // contextTokenCount starts at 0 in a fresh session — don't show an empty bar.
    expect(resolveBaselineTokens(0, [a, b])).toBe(300)
    expect(resolveBaselineTokens(-5, [a, b])).toBe(300)
  })
})

describe('thresholds', () => {
  test('danger sits above warning', () => {
    expect(DANGER_THRESHOLD).toBeGreaterThan(WARNING_THRESHOLD)
    expect(DANGER_THRESHOLD).toBe(80)
  })
})

describe('formatTokenCount', () => {
  test('returns "0" for non-positive / non-finite', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(-100)).toBe('0')
    expect(formatTokenCount(NaN)).toBe('0')
    expect(formatTokenCount(Infinity)).toBe('0')
  })

  test('keeps small numbers as integers', () => {
    expect(formatTokenCount(1)).toBe('1')
    expect(formatTokenCount(500)).toBe('500')
    expect(formatTokenCount(999)).toBe('999')
  })

  test('formats thousands with K suffix', () => {
    expect(formatTokenCount(1_500)).toBe('1.5K')
    expect(formatTokenCount(15_000)).toBe('15K')
    expect(formatTokenCount(150_000)).toBe('150K')
    expect(formatTokenCount(200_000)).toBe('200K')
    expect(formatTokenCount(256_000)).toBe('256K')
  })

  test('formats millions with M suffix', () => {
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(1_500_000)).toBe('1.5M')
  })
})
