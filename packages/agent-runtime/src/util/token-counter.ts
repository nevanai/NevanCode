import { LRUCache } from '@codebuff/common/util/lru-cache'
import { encode } from 'gpt-tokenizer/esm/model/gpt-4o'

const ANTHROPIC_TOKEN_FUDGE_FACTOR = 1.35

const TOKEN_COUNT_CACHE = new LRUCache<string, number>(1000)

/**
 * Flat token cost charged for one image, matching what vision providers
 * actually bill (Anthropic caps a resized image at ~1600 tokens).
 *
 * Critically, this is what we charge INSTEAD of feeding the image's base64
 * payload to the BPE tokenizer. Tokenizing raw base64 as text is both wildly
 * wrong (a single Retina screenshot counts as ~4,000,000 "tokens" vs. the
 * provider's real ~1,600) and pathologically slow (~35s for one screenshot).
 * That phantom count blows past the context-pruner threshold and triggers a
 * spurious mid-turn prune that buries the user's request — the root cause of
 * both the screenshot "hang" and the agent losing track of the task.
 */
const IMAGE_TOKEN_COST = 1600

/**
 * Returns a structural clone of `value` with base64 image/media/file payloads
 * replaced by empty strings, plus a flat token cost for each image stripped.
 *
 * The base64 lives in three content-part shapes:
 *  - `{ type: 'image', image: <base64|url> }`        (ImagePart)
 *  - `{ type: 'media', data:  <base64> }`            (tool-result media)
 *  - `{ type: 'file',  data:  <base64|url> }`        (FilePart)
 *
 * The original object is never mutated — it's the live message history.
 */
function stripMediaForCounting(value: unknown): {
  value: unknown
  imageTokens: number
} {
  let imageTokens = 0

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(walk)
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>
      if (obj.type === 'image' && typeof obj.image === 'string') {
        imageTokens += IMAGE_TOKEN_COST
        return { ...obj, image: '' }
      }
      if (
        (obj.type === 'media' || obj.type === 'file') &&
        typeof obj.data === 'string'
      ) {
        imageTokens += IMAGE_TOKEN_COST
        return { ...obj, data: '' }
      }
      const out: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(obj)) {
        out[key] = walk(val)
      }
      return out
    }
    return node
  }

  return { value: walk(value), imageTokens }
}

export function countTokens(text: string): number {
  try {
    const cached = TOKEN_COUNT_CACHE.get(text)
    if (cached !== undefined) {
      return cached
    }
    const count = Math.floor(
      encode(text, { allowedSpecial: 'all' }).length *
        ANTHROPIC_TOKEN_FUDGE_FACTOR,
    )

    if (text.length > 100) {
      // Cache only if the text is long enough to be worth it.
      TOKEN_COUNT_CACHE.set(text, count)
    }
    return count
  } catch (e) {
    console.error('Error counting tokens', e)
    return Math.ceil(text.length / 3)
  }
}

export function countTokensJson(text: string | object): number {
  if (typeof text === 'string') {
    return countTokens(JSON.stringify(text))
  }
  // Strip base64 image payloads before tokenizing so they're charged a flat
  // per-image cost instead of being run through the BPE tokenizer as text.
  const { value, imageTokens } = stripMediaForCounting(text)
  return countTokens(JSON.stringify(value)) + imageTokens
}

export function countTokensForFiles(
  files: Record<string, string | null>,
): Record<string, number> {
  const tokenCounts: Record<string, number> = {}
  for (const [filePath, content] of Object.entries(files)) {
    tokenCounts[filePath] = content ? countTokens(content) : 0
  }
  return tokenCounts
}
