import { describe, test, expect } from 'bun:test'

import {
  CLEAR_AND_IMPLEMENT_PROMPT_PREFIX,
  CLEAR_AND_IMPLEMENT_IMPLEMENTATION_PREFIX,
  isClearAndImplementMode,
  parseClearAndImplementSentinel,
} from '../clear-and-implement-constants'

describe('clear-and-implement-constants', () => {
  describe('CLEAR_AND_IMPLEMENT_PROMPT_PREFIX', () => {
    test('uses a stable sentinel prefix', () => {
      expect(CLEAR_AND_IMPLEMENT_PROMPT_PREFIX).toBe('__CB_CLEAR_IMPL__:')
    })
  })

  describe('CLEAR_AND_IMPLEMENT_IMPLEMENTATION_PREFIX', () => {
    test('mentions "fresh context" so the receiving agent understands the handoff', () => {
      expect(CLEAR_AND_IMPLEMENT_IMPLEMENTATION_PREFIX).toContain('fresh context')
    })

    test('treats the plan as source of user intent (mirrors Codex)', () => {
      expect(CLEAR_AND_IMPLEMENT_IMPLEMENTATION_PREFIX).toContain(
        'source of user intent',
      )
    })
  })

  describe('isClearAndImplementMode', () => {
    test('accepts the three supported modes', () => {
      expect(isClearAndImplementMode('DEFAULT')).toBe(true)
      expect(isClearAndImplementMode('MAX')).toBe(true)
      expect(isClearAndImplementMode('LITE')).toBe(true)
    })

    test('rejects unsupported and lowercase mode names', () => {
      expect(isClearAndImplementMode('default')).toBe(false)
      expect(isClearAndImplementMode('Default')).toBe(false)
      expect(isClearAndImplementMode('PLAN')).toBe(false)
      expect(isClearAndImplementMode('')).toBe(false)
      expect(isClearAndImplementMode('CYBERN')).toBe(false)
    })
  })

  describe('parseClearAndImplementSentinel', () => {
    test('parses each supported mode', () => {
      expect(parseClearAndImplementSentinel('__CB_CLEAR_IMPL__:DEFAULT')).toEqual({
        mode: 'DEFAULT',
      })
      expect(parseClearAndImplementSentinel('__CB_CLEAR_IMPL__:MAX')).toEqual({
        mode: 'MAX',
      })
      expect(parseClearAndImplementSentinel('__CB_CLEAR_IMPL__:LITE')).toEqual({
        mode: 'LITE',
      })
    })

    test('upper-cases the mode token before validating', () => {
      // The agent may emit lowercase by accident; we still salvage the intent.
      expect(parseClearAndImplementSentinel('__CB_CLEAR_IMPL__:default')).toEqual(
        { mode: 'DEFAULT' },
      )
    })

    test('returns null for unrelated prompts', () => {
      expect(parseClearAndImplementSentinel('Implement the plan')).toBeNull()
      expect(parseClearAndImplementSentinel('Stay in plan mode')).toBeNull()
      expect(parseClearAndImplementSentinel('')).toBeNull()
    })

    test('returns null when the prefix is present but the mode is unknown', () => {
      expect(
        parseClearAndImplementSentinel('__CB_CLEAR_IMPL__:NOT_A_MODE'),
      ).toBeNull()
      expect(parseClearAndImplementSentinel('__CB_CLEAR_IMPL__:')).toBeNull()
    })

    test('rejects prompts that paraphrase the sentinel', () => {
      // If the model rewrites the prefix, we MUST refuse to fire the side-effect.
      expect(
        parseClearAndImplementSentinel('CLEAR_AND_IMPLEMENT DEFAULT'),
      ).toBeNull()
      expect(
        parseClearAndImplementSentinel(' __CB_CLEAR_IMPL__:DEFAULT'),
      ).toBeNull()
    })

    test('tolerates trailing whitespace and punctuation after the mode token', () => {
      expect(
        parseClearAndImplementSentinel('__CB_CLEAR_IMPL__:DEFAULT  '),
      ).toEqual({ mode: 'DEFAULT' })
      expect(
        parseClearAndImplementSentinel('__CB_CLEAR_IMPL__:MAX extra text'),
      ).toEqual({ mode: 'MAX' })
    })
  })
})
