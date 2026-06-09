
import { Orchestrator } from './orchestrator';
import { getModeConfiguration, AgentMode } from './modes';
import { globalToolRegistry } from './tools/registry';

export class AgentRunner {
  async runTurn(mode: AgentMode, userPrompt: string) {
    const config = getModeConfiguration(mode);
    const orchestrator = new Orchestrator();
    
    console.log(`Running turn in ${mode} mode using model ${config.model}...`);
    
    // 1. Processing user prompt based on mode
    const augmentedPrompt = `${config.promptModifier}\n\nUser Request: ${userPrompt}`;
    
    // 2. Simulate the orchestration loop
    // In real flow: LLM -> Tool Call -> Tool Registry -> LLM
    const result = await orchestrator.spawnAgent({
      name: 'MainAgent',
      model: config.model,
      systemPrompt: augmentedPrompt,
      tools: Object.keys(globalToolRegistry.availableTools || {}), // hypothetical
    }, 'Initiating task execution...');

    return {
      status: 'success',
      agentId: result.id,
      configUsed: config
    };
  }
}
