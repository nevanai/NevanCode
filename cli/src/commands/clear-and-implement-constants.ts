/**
 * Constants for the "clear context and implement" flow that runs after `/plan`.
 *
 * Kept in a tiny module so the plan-prompt builder and the click interceptor
 * can import the same source-of-truth without pulling in store/UI deps.
 */

/**
 * Sentinel prefix the agent uses inside `suggest_followups` after producing a
 * plan. Followups whose prompt starts with this prefix are intercepted on the
 * client and translated into a "clear chat → switch mode → resend plan"
 * action; they are never sent to the agent as-is.
 */
export const CLEAR_AND_IMPLEMENT_PROMPT_PREFIX = '__CB_CLEAR_IMPL__:'

/**
 * Prefix prepended to the saved plan when it is resent as the seed message of
 * the fresh implementation session.
 *
 * Mirrors OpenAI Codex's `PLAN_IMPLEMENTATION_CLEAR_CONTEXT_PREFIX` so the
 * receiving agent is told to treat the plan as authoritative user intent.
 */
export const CLEAR_AND_IMPLEMENT_IMPLEMENTATION_PREFIX =
  'A previous agent produced the plan below to accomplish the user’s task. ' +
  'Implement the plan in a fresh context. Treat the plan as the source of ' +
  'user intent, re-read files as needed, and carry the work through ' +
  'implementation and verification.'

export type ClearAndImplementMode = 'DEFAULT' | 'MAX' | 'LITE'

export const isClearAndImplementMode = (
  value: string,
): value is ClearAndImplementMode =>
  value === 'DEFAULT' || value === 'MAX' || value === 'LITE'

export interface ClearAndImplementSentinel {
  mode: ClearAndImplementMode
}

/**
 * Parses a followup prompt and returns the embedded mode when it is a
 * clear-and-implement sentinel, or null otherwise.
 */
export const parseClearAndImplementSentinel = (
  prompt: string,
): ClearAndImplementSentinel | null => {
  if (!prompt.startsWith(CLEAR_AND_IMPLEMENT_PROMPT_PREFIX)) return null
  const rest = prompt.slice(CLEAR_AND_IMPLEMENT_PROMPT_PREFIX.length).trim()
  const modeToken = rest.split(/\s+/, 1)[0]?.toUpperCase() ?? ''
  if (!isClearAndImplementMode(modeToken)) return null
  return { mode: modeToken }
}
