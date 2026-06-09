/**
 * Token estimation.
 *
 * We deliberately do NOT pull in a real tokenizer (tiktoken / the model's BPE)
 * here: the curator runs on the hot path of every user turn and a heavy
 * tokenizer load would defeat the purpose. Instead we use the well-known
 * "~4 characters per token" heuristic that holds up well for source code and
 * English prose with GPT/Claude-family BPEs. It is an *estimate*; every number
 * the curator reports as "tokens" is this heuristic, and the token-reduction
 * ratio is therefore a ratio of two consistently-estimated quantities (so the
 * heuristic's bias cancels in the ratio).
 */

const CHARS_PER_TOKEN = 4

/** Estimate the token count of a string. Never returns a negative number. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Estimate tokens for a file given only its byte size (no read). For ASCII /
 * UTF-8 source, byte length ≈ character length, so this matches estimateTokens
 * closely enough to be compared against it. Used for the "inject every
 * candidate whole" baseline without paying to read every candidate file.
 */
export function estimateTokensFromBytes(sizeBytes: number): number {
  if (sizeBytes <= 0) return 0
  return Math.ceil(sizeBytes / CHARS_PER_TOKEN)
}
