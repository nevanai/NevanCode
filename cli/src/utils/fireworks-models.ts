/**
 * Known Fireworks serverless model IDs.
 *
 * These are used as a static supplement to the dynamically discovered models
 * from the Fireworks API. When a user runs /model with a Fireworks BYOK
 * connection, the CLI merges these known IDs with whatever the API returns,
 * so models that are newly added (or temporarily absent from the discovery
 * response) still appear in the catalogue.
 *
 * Every ID MUST carry the `fireworks/` prefix so the BYOK router recognises it.
 */
export const KNOWN_FIREWORKS_MODEL_IDS: readonly string[] = [
  'fireworks/accounts/fireworks/models/kimi-k2p5',
  'fireworks/accounts/fireworks/models/kimi-k2p6',
  'fireworks/accounts/fireworks/models/gemma-4-31b-it',
  'fireworks/accounts/fireworks/models/gemma-4-26b-a4b-it',
  'fireworks/accounts/fireworks/models/glm-5p1',
  'fireworks/accounts/fireworks/models/minimax-m2p5',
  'fireworks/accounts/fireworks/models/minimax-m2p7',
]
