/**
 * /ultrareview — advanced, deep code review mode.
 *
 * Ported from the standalone ultrareview command and adapted to Codebuff. The
 * original built a background-launch query and guarded itself behind remote
 * feature gates and quota; Codebuff's native equivalent is to spawn the
 * @thinker-gpt sub-agent inline (exactly how /review works), so the deep review
 * runs locally, returns concise actionable findings, and never edits files
 * unless the user explicitly asks for fixes afterwards.
 *
 * Local ultrareview is always enabled and never metered — see
 * {@link isUltrareviewEnabled} and {@link fetchUltrareviewQuota}.
 */
import { isUltrareviewEnabled } from './ultrareview-enabled'

export { isUltrareviewEnabled }

/**
 * Review dimensions, carried verbatim from the original ultrareview so the
 * "ultra" pass stays meaningfully broader than the generic /review.
 */
export const ULTRAREVIEW_INSTRUCTIONS = [
  'Gather ALL relevant context first, then spawn @thinker-gpt to perform an in-depth ultra review of the request below.',
  'Focus on correctness, bugs, regressions, security issues, edge cases, maintainability, and test coverage.',
  'For each finding, give a concise, actionable note: the file/location, why it matters, and a concrete fix suggestion.',
  'Prioritize findings by severity (blocking → high → medium → low).',
  'Return concise, actionable findings directly in this terminal.',
  'This is review ONLY — do NOT edit any files unless the user explicitly asks for fixes after the review.',
].join('\n')

/**
 * Assemble the full ultrareview prompt sent to the agent.
 *
 * @param input - What to review (e.g. "the uncommitted changes" or a focus area).
 * @returns The deep-review prompt.
 */
export function buildUltrareviewPrompt(input: string): string {
  const trimmed = input.trim()
  const target = trimmed || 'the current local workspace changes'
  return `${ULTRAREVIEW_INSTRUCTIONS}\n\nReview target: ${target}`
}
