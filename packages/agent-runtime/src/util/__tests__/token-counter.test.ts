import { describe, expect, it } from 'bun:test'

import { countTokens, countTokensJson } from '../token-counter'

/**
 * Builds a high-entropy base64 string of roughly `bytes` length. Real image
 * payloads have near-random bytes, which is what makes the BPE tokenizer both
 * slow and wildly over-count when it's (incorrectly) fed image data as text.
 */
function fakeBase64(bytes: number): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  let seed = 123456789
  for (let i = 0; i < bytes; i++) {
    // Cheap deterministic PRNG so the test is stable but high-entropy.
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    out += chars[seed % chars.length]
  }
  return out
}

describe('countTokensJson — image payloads are charged a flat cost, not tokenized', () => {
  // A real Retina screenshot is ~6-9MB of base64. Tokenizing that as text counts
  // it as ~4M tokens and takes ~35s — which blows the context-pruner threshold
  // and hangs the agent. After the fix it must be a small flat cost, computed
  // near-instantly.
  const bigImage = fakeBase64(2_000_000)

  it('charges a media tool-result image a small flat cost', () => {
    const message = {
      role: 'tool',
      content: [{ type: 'media', data: bigImage, mediaType: 'image/jpeg' }],
    }
    const tokens = countTokensJson(message)
    // ~1600 flat + a few tokens of JSON scaffolding — nowhere near the ~2.6M
    // that tokenizing 2MB of base64 as text would produce.
    expect(tokens).toBeLessThan(3_000)
    expect(tokens).toBeGreaterThan(1_000)
  })

  it('charges a user image part a small flat cost', () => {
    const message = {
      role: 'user',
      content: [
        { type: 'image', image: bigImage, mediaType: 'image/png' },
        { type: 'text', text: 'what is in this screenshot?' },
      ],
    }
    const tokens = countTokensJson(message)
    expect(tokens).toBeLessThan(3_000)
    // The text part must still be counted on top of the flat image cost.
    expect(tokens).toBeGreaterThan(1_600)
  })

  it('charges a file part a small flat cost', () => {
    const message = {
      role: 'user',
      content: [{ type: 'file', data: bigImage, mediaType: 'application/pdf' }],
    }
    expect(countTokensJson(message)).toBeLessThan(3_000)
  })

  it('counts each image in a multi-image history independently', () => {
    const oneImage = {
      role: 'tool',
      content: [{ type: 'media', data: bigImage, mediaType: 'image/jpeg' }],
    }
    const history = Array.from({ length: 20 }, () => oneImage)
    const tokens = countTokensJson(history)
    // 20 images stay far under the 200k context-pruner threshold (before the fix
    // a single image alone exceeded it).
    expect(tokens).toBeLessThan(50_000)
    expect(tokens).toBeGreaterThan(20 * 1_000)
  })

  it('completes near-instantly for a large image (no tokenizer blowup)', () => {
    const message = {
      role: 'tool',
      content: [{ type: 'media', data: bigImage, mediaType: 'image/jpeg' }],
    }
    const start = Date.now()
    countTokensJson(message)
    // Tokenizing the raw base64 would take seconds; the flat-cost path is sub-100ms.
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('does not mutate the original message (live history must be preserved)', () => {
    const message = {
      role: 'tool',
      content: [{ type: 'media', data: bigImage, mediaType: 'image/jpeg' }],
    }
    countTokensJson(message)
    expect(message.content[0].data).toBe(bigImage)
  })

  it('still counts ordinary text content normally', () => {
    const text = 'hello world '.repeat(100)
    const message = { role: 'user', content: [{ type: 'text', text }] }
    const messageTokens = countTokensJson(message)
    const rawTokens = countTokens(text)
    // The text is genuinely tokenized (not zeroed out), within JSON scaffolding.
    expect(messageTokens).toBeGreaterThanOrEqual(rawTokens)
    expect(messageTokens).toBeGreaterThan(150)
  })
})
