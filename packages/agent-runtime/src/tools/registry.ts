
export interface ToolSchema {
  name: string;
  description: string;
  parameters: any;
}

export interface ToolResult {
  output: string;
  exitCode?: number;
  success: boolean;
}

export const TOOL_DEFINITIONS: Record<string, ToolSchema> = {
  'read_files': {
    name: 'read_files',
    description: 'Read contents of specified files.',
    parameters: { files: 'string[]' }
  },
  'str_replace': {
    name: 'str_replace',
    description: 'Targeted string replacement in a file.',
    parameters: { path: 'string', oldString: 'string', newString: 'string' }
  },
  'write_file': {
    name: 'write_file',
    description: 'Fully rewrite or create a file.',
    parameters: { path: 'string', content: 'string' }
  },
  'spawn_agents': {
    name: 'spawn_agents',
    description: 'Spawn specialized sub-agents for parallel tasks.',
    parameters: { requests: 'SpawnRequest[]' }
  },
  'write_todos': {
    name: 'write_todos',
    description: 'Manage the stepped task list.',
    parameters: { todos: 'TodoItem[]' }
  },
  'ask_user': {
    name: 'ask_user',
    description: 'Ask user for clarification or decision.',
    parameters: { question: 'string', choices?: 'string[]' }
  },
  'run_terminal_command': {
    name: 'run_terminal_command',
    description: 'Execute a shell command on the user system.',
    parameters: { command: 'string' }
  },
  'web_search': {
    name: 'web_search',
    description: 'Search web for current info using Linkup API.',
    parameters: { query: 'string', depth: 'quick|deep' }
  },
};

export class ToolRegistry {
  private availableTools = new Map<string, Function>();

  registerTool(name: string, fn: Function) {
    this.availableTools.set(name, fn);
  }

  async callTool(name: string, args: any): Promise<ToolResult> {
    const tool = this.availableTools.get(name);
    if (!tool) throw new Error(`Tool ${name} not found`);
    
    try {
      const result = await tool(args);
      return { output: result, success: true };
    } catch (e: any) {
      return { output: e.message, success: false };
    }
  }
}

export const globalToolRegistry = new ToolRegistry();
