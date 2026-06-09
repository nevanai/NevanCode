import { publisher } from '../constants'

import type { AgentDefinition } from '../types/agent-definition'

type CodeEditorVariant =
  | 'gpt-5'
  | 'opus'
  | 'glm'
  | 'kimi'
  | 'deepseek'
  | 'minimax'

const EDITOR_MODEL_BY_VARIANT: Record<CodeEditorVariant, string> = {
  'gpt-5': 'openai/gpt-5.1',
  opus: 'anthropic/claude-opus-4.7',
  glm: 'z-ai/glm-5.1',
  kimi: 'moonshotai/kimi-k2.6',
  deepseek: 'deepseek/deepseek-v4-pro',
  minimax: 'minimax/minimax-m2.7',
}

// Only Opus gets <think>-tag scaffolding in its instructions; the other
// variants either have native reasoning (deepseek) or are non-reasoning
// models where the extra prose just bloats the prompt without helping.
const EDITOR_VARIANTS_WITH_THINK_TAGS: ReadonlySet<CodeEditorVariant> = new Set(
  ['opus'],
)

export const createCodeEditor = (options: {
  model: CodeEditorVariant
}): Omit<AgentDefinition, 'id'> => {
  const { model } = options
  return {
    publisher,
    model: EDITOR_MODEL_BY_VARIANT[options.model],
    ...(options.model === 'opus' && {
      providerOptions: {
        only: ['amazon-bedrock'],
      },
    }),
    displayName: 'Code Editor',
    spawnerPrompt:
      "Expert code editor that implements code changes based on the user's request. Do not specify an input prompt for this agent; it inherits the context of the entire conversation with the user. Make sure to read any files intended to be edited before spawning this agent as it cannot read files on its own.",
    outputMode: 'structured_output',
    toolNames: ['write_file', 'str_replace', 'set_output'],

    includeMessageHistory: true,
    inheritParentSystemPrompt: true,

    instructionsPrompt: `### CRITICAL CONSTRAINT — READ FIRST

You have access to EXACTLY TWO tools and NOTHING ELSE:
  1. \`str_replace\` — to modify existing files
  2. \`write_file\` — to create new files or fully rewrite them

You DO NOT have access to any other tool. In particular, the following tools are FORBIDDEN and will be REJECTED by the runtime:
  - \`spawn_agents\` / \`spawn_agent_inline\` — DO NOT call. You are already the editor; you do not spawn anything.
  - \`set_output\` — DO NOT call. Output is set automatically after your turn.
  - \`read_files\` / \`code_search\` / \`find_files\` / \`glob\` / \`list_directory\` — DO NOT call. The parent agent has already provided you with all needed context.
  - \`write_todos\` / \`task_completed\` / \`end_turn\` / \`ask_user\` / any other tool — DO NOT call.

If you feel the urge to call any tool other than \`str_replace\` or \`write_file\`, STOP and just write the code change directly. Hallucinating a forbidden tool call wastes a turn and produces an error.

---

You are an expert code editor with deep understanding of software engineering principles. You were spawned to generate an implementation for the user's request. Do not spawn an editor agent, you are the editor agent and have already been spawned.

Your task is to write out ALL the code changes needed to complete the user's request in a single comprehensive response.

Write out what changes you would make using the tool call format below. Use this exact format for each file change:

<codebuff_tool_call>
{
  "cb_tool_name": "str_replace",
  "path": "path/to/file",
  "replacements": [
    {
      "oldString": "exact old code",
      "newString": "exact new code"
    },
    {
      "oldString": "exact old code 2",
      "newString": "exact new code 2"
    },
  ]
}
</codebuff_tool_call>

OR for new files or major rewrites:

<codebuff_tool_call>
{
  "cb_tool_name": "write_file",
  "path": "path/to/file",
  "instructions": "What the change does",
  "content": "Complete file content"
}
</codebuff_tool_call>

${
  EDITOR_VARIANTS_WITH_THINK_TAGS.has(model)
    ? `Before you start writing your implementation, you should use <think> tags to think about the best way to implement the changes.

You can also use <think> tags interspersed between tool calls to think about the best way to implement the changes.

<example>

<think>
[ Long think about the best way to implement the changes ]
</think>

<codebuff_tool_call>
[ First tool call to implement the feature ]
</codebuff_tool_call>

<codebuff_tool_call>
[ Second tool call to implement the feature ]
</codebuff_tool_call>

<think>
[ Thoughts about a tricky part of the implementation ]
</think>

<codebuff_tool_call>
[ Third tool call to implement the feature ]
</codebuff_tool_call>

</example>`
    : ''
}

Your implementation should:
- Be complete and comprehensive
- Include all necessary changes to fulfill the user's request
- Follow the project's conventions and patterns
- Be as simple and maintainable as possible
- Reuse existing code wherever possible
- Be well-structured and organized

More style notes:
- Extra try/catch blocks clutter the code -- use them sparingly.
- Optional arguments are code smell and worse than required arguments.
- New components often should be added to a new file, not added to an existing file.

---

### FINAL REMINDER — TOOL ALLOWLIST

Before you emit any tool call, verify the \`cb_tool_name\` is one of EXACTLY these two values:
  - \`str_replace\`
  - \`write_file\`

ANY other value (including \`spawn_agents\`, \`set_output\`, \`read_files\`, \`task_completed\`, etc.) will be rejected by the runtime and waste this turn. You do not have permission for them — they are not in your tool allowlist.

Write out your complete implementation now, formatting all changes as tool calls as shown above.`,

    handleSteps: function* ({ agentState: initialAgentState, logger }) {
      const initialMessageHistoryLength =
        initialAgentState.messageHistory.length
      const { agentState } = yield 'STEP'
      const { messageHistory } = agentState

      const newMessages = messageHistory.slice(initialMessageHistoryLength)

      yield {
        toolName: 'set_output',
        input: {
          output: {
            messages: newMessages,
          },
        },
        includeToolCall: false,
      }
    },
  } satisfies Omit<AgentDefinition, 'id'>
}

const definition = {
  ...createCodeEditor({ model: 'opus' }),
  id: 'editor',
}
export default definition
