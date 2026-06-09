/**
 * focused/file-analyzer — ONE TASK: deep-analyze ONE specific file or function.
 *
 * Single-purpose: file analysis. No edits, no plans, no test runs.
 * It reads a file (or a specific function in it) and returns a focused report.
 *
 * Single-purpose: FILE/FUNCTION ANALYSIS ONLY.
 */

import { publisher } from '../constants'

import type { AgentDefinition } from '../types/agent-definition'

const definition: AgentDefinition = {
  id: 'focused/file-analyzer',
  publisher,
  displayName: 'File Analyzer',
  model: 'anthropic/claude-sonnet-4',
  reasoningOptions: { effort: 'medium' },

  spawnerPrompt:
    'Single-purpose agent that deep-analyzes ONE file or function. ' +
    'Reads the file, traces the data flow, identifies bugs/risks/edge cases, ' +
    'and returns a structured analysis. ' +
    'It does NOT implement, plan, or test — it ONLY analyzes. ' +
    'Use this when you need a focused review of one specific file before changing it.',

  inputSchema: {
    prompt: {
      type: 'string',
      description: 'The file path (and optional function name) to analyze.',
    },
  },
  outputMode: 'last_message',

  toolNames: ['read_files', 'read_subtree', 'code_search'],

  instructionsPrompt: [
    'Your ONLY job is to deep-analyze ONE file (or one function in a file). Nothing else.',
    '',
    '## DO',
    '- Read the file(s) at the path provided in the prompt.',
    '- If a specific function or symbol is named, focus on that symbol — its signature, callers, callees, edge cases, error handling, and side effects.',
    '- If no function is named, give a top-to-bottom analysis of the file.',
    '- Trace the data flow IN and OUT: where do inputs come from, where do outputs go?',
    '- Look for: bugs, edge cases, error paths, security issues, race conditions, type holes, and places where the code silently swallows errors.',
    '- Return a structured report:',
    '  1. **Purpose** (1-2 lines: what this code does).',
    '  2. **Inputs / Outputs** (what comes in, what goes out, what mutates state).',
    '  3. **Callers / Callees** (who calls it, what it calls).',
    '  4. **Edge cases handled** (what the code is robust against).',
    '  5. **Risks / bugs** (concrete issues with line numbers or function names).',
    '  6. **Suggested test cases** (3-5 high-leverage cases that would catch regressions).',
    '',
    '## DO NOT',
    '- DO NOT edit files.',
    '- DO NOT run tests or terminal commands.',
    '- DO NOT ask the user questions — analyze what is there.',
    '- DO NOT spawn other agents.',
    '- DO NOT propose code patches (that is the implementor\'s job).',
    '- DO NOT analyze multiple files — focus on the one specified.',
    '',
    'Focus = one file/function, full depth. Stay narrow.',
  ].join('\n'),
}

export default definition
