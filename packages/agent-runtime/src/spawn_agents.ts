
import { Orchestrator, AgentConfig } from './orchestrator';

export interface SpawnRequest {
  agentId: string;
  prompt: string;
  params?: any;
}

export interface SpawnResponse {
  agentId: string;
  output: string;
  status: 'success' | 'error';
}

export async function spawn_agents(requests: SpawnRequest[]): Promise<SpawnResponse[]> {
  const orchestrator = new Orchestrator();
  
  // Execute in parallel using Promise.all
  const executionPromises = requests.map(async (req) => {
    try {
      // In a real implementation, we would lookup agent config by agentId
      const config: AgentConfig = {
        name: req.agentId,
        model: 'claude-opus-4.7',
        systemPrompt: 'You are a specialized helper agent.',
        tools: [] 
      };
      
      const result = await orchestrator.spawnAgent(config, req.prompt);
      return {
        agentId: req.agentId,
        output: `Agent ${req.agentId} completed task: ${req.prompt}`, // Placeholder for actual LLM output
        status: 'success' as const
      };
    } catch (error: any) {
      return {
        agentId: req.agentId,
        output: error.message,
        status: 'error' as const
      };
    }
  });

  return Promise.all(executionPromises);
}
