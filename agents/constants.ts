export const publisher = 'codebuff'

/**
 * IDs of the single-purpose focused agents under `agents/focused/`.
 *
 * Each one is built to do ONE thing with full focus. They are designed to
 * be spawned by the base agent (or by `spawn_agents` from any other agent)
 * for a single, well-scoped sub-task. Spawning them with a clear, narrow
 * prompt gives a tighter result than asking a general-purpose agent to
 * "do everything".
 */
export const FOCUSED_AGENT_IDS = [
  'focused/context-gatherer',
  'focused/file-analyzer',
  'focused/test-runner',
  'focused/implementor',
  'focused/verifier',
] as const

export type FocusedAgentId = (typeof FOCUSED_AGENT_IDS)[number]
