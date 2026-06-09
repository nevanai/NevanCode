/**
 * focused/context-gatherer — ONE TASK: gather all relevant context.
 *
 * This agent exists for a single reason: it gathers context. Nothing else.
 * It does not implement, edit, plan, or test. It does not ask follow-up
 * questions to the user. It does not delegate. It reads the project index,
 * reads relevant files, and reports a structured summary.
 *
 * Single-purpose: CONTEXT GATHERING ONLY.
 */

import { publisher } from '../constants'

import type { AgentDefinition } from '../types/agent-definition'

const definition: AgentDefinition = {
  id: 'focused/context-gatherer',
  publisher,
  displayName: 'Context Gatherer',
  model: 'anthropic/claude-sonnet-4',
  reasoningOptions: { effort: 'medium' },

  spawnerPrompt:
    'Single-purpose agent that gathers context for a specific request. ' +
    'Reads the project index, opens relevant files, and returns a structured summary. ' +
    'It does NOT implement, plan, or test — it ONLY gathers context. ' +
    'Use this when other agents need a fast, focused context dump before acting.',

  inputSchema: {
    prompt: {
      type: 'string',
      description: 'The request or question for which to gather context.',
    },
  },
  outputMode: 'last_message',

  toolNames: [
    'read_files',
    'read_subtree',
    'code_search',
    'list_directory',
    'glob',
  ],

  instructionsPrompt: [
    'Your ONLY job is to gather context for the user request. Nothing else.',
    '',
    '## DO',
    '- Read `<relevant_files>` first (the project index) if present in your message.',
    '- Use read_files for the files the index points to.',
    '- Use read_subtree for areas of the code that need a broader view.',
    '- Use code_search / list_directory / glob to discover files you may have missed.',
    '- Return a structured summary:',
    '  1. The files that matter and what each one does (1-2 lines each).',
    '  2. The data flow between them.',
    '  3. The conventions or patterns the codebase uses that any implementer MUST follow.',
    '  4. Any gotchas or non-obvious decisions visible in the code.',
    '',
    '## DO NOT',
    '- DO NOT implement anything.',
    '- DO NOT edit files.',
    '- DO NOT run tests or terminal commands.',
    '- DO NOT ask the user questions — gather what is there.',
    '- DO NOT spawn other agents.',
    '- DO NOT plan the implementation.',
    '- DO NOT write code blocks, patches, or diffs — that is the implementor\'s job.',
    '',
    'Focus = context only. Stay narrow. The parent agent decides what to do with the context.',
  ].join('\n'),
}

export default definition
