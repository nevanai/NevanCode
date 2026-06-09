
export type AgentMode = 'DEFAULT' | 'MAX' | 'LITE' | 'FREE' | 'PLAN' | 'FAST';

export interface ModeConfig {
  model: string;
  promptModifier: string;
  useBestOfN: boolean;
  contextReadingLimit: number;
  allowDirectEditing: boolean;
}

export const MODE_REGISTRY: Record<AgentMode, ModeConfig> = {
  DEFAULT: {
    model: 'anthropic/claude-opus-4.7',
    promptModifier: 'Balanced precision and speed. Use specialized sub-agents.',
    useBestOfN: false,
    contextReadingLimit: 10,
    allowDirectEditing: false,
  },
  MAX: {
    model: 'anthropic/claude-opus-4.7',
    promptModifier: 'Maximum precision. Exhaustive analysis. Prioritize correctness over all.',
    useBestOfN: true,
    contextReadingLimit: 20,
    allowDirectEditing: false,
  },
  LITE: {
    model: 'kimi-latest',
    promptModifier: 'Economic a-la-carte coding. Fast and lean.',
    useBestOfN: false,
    contextReadingLimit: 5,
    allowDirectEditing: true,
  },
  FREE: {
    model: 'minimax-m2.7',
    promptModifier: 'Free tier execution. Maintain privacy and efficiency.',
    useBestOfN: false,
    contextReadingLimit: 5,
    allowDirectEditing: true,
  },
  PLAN: {
    model: 'anthropic/claude-opus-4.7',
    promptModifier: 'Thinker mode. Do NOT edit files. Produce a detailed <PLAN> spec.',
    useBestOfN: false,
    contextReadingLimit: 15,
    allowDirectEditing: false,
  },
  FAST: {
    model: 'anthropic/claude-haiku-3',
    promptModifier: 'Extreme brevity. Direct editing. Skip heavy validation.',
    useBestOfN: false,
    contextReadingLimit: 3,
    allowDirectEditing: true,
  },
};

export function getModeConfiguration(mode: AgentMode): ModeConfig {
  return MODE_REGISTRY[mode] || MODE_REGISTRY.DEFAULT;
}
