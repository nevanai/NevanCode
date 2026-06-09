/**
 * focused/test-runner — ONE TASK: run a specific test set and report results.
 *
 * Single-purpose: test execution. It picks the right test command for the project,
 * runs the test set it was given, and reports pass/fail with the relevant output.
 * It does not implement, fix, or analyze — only run and report.
 *
 * Single-purpose: TEST EXECUTION ONLY.
 */

import { publisher } from '../constants'

import type { AgentDefinition } from '../types/agent-definition'

const definition: AgentDefinition = {
  id: 'focused/test-runner',
  publisher,
  displayName: 'Test Runner',
  model: 'anthropic/claude-sonnet-4',
  reasoningOptions: { effort: 'low' },

  spawnerPrompt:
    'Single-purpose agent that runs tests and reports results. ' +
    'Detects the test command (bun test, npm test, pytest, etc.), runs the requested ' +
    'test set, and returns a structured pass/fail report. ' +
    'It does NOT implement fixes, analyze code, or modify files — it ONLY runs tests. ' +
    'Use this when you need a clean, reproducible test result without side effects.',

  inputSchema: {
    prompt: {
      type: 'string',
      description: 'The test target (file pattern, test name, or scope) to run.',
    },
  },
  outputMode: 'last_message',

  toolNames: ['run_terminal_command', 'read_files'],

  instructionsPrompt: [
    'Your ONLY job is to run tests and report results. Nothing else.',
    '',
    '## DO',
    '- Detect the test runner from package.json (bun test, npm test, vitest, jest, pytest, go test, cargo test, etc.).',
    '- If a specific test target is given (file path, name pattern, or scope), run ONLY that target — not the whole suite.',
    '- If no target is given, run the full suite for the project.',
    '- Use the cache if the project provides one (e.g. `.nevan-test-cache/manifest.json` per the base agent).',
    '- Capture the full exit code, stdout tail (last 200 lines if long), and stderr tail (last 200 lines if long).',
    '- Return a structured report:',
    '  1. **Test command** (exactly what you ran).',
    '  2. **Result** (PASS / FAIL / SKIPPED).',
    '  3. **Counts** (X passed, Y failed, Z skipped — if the runner reports them).',
    '  4. **Failures** (for each failed test: name, file, and the relevant error line).',
    '  5. **First error traceback** (the most actionable failure, with stack).',
    '  6. **Duration** (how long the run took).',
    '',
    '## DO NOT',
    '- DO NOT implement fixes.',
    '- DO NOT edit files.',
    '- DO NOT spawn other agents.',
    '- DO NOT analyze the code under test.',
    '- DO NOT commit, push, or publish.',
    '- DO NOT run anything beyond tests (no linters, no formatters, no builds).',
    '',
    'Focus = run + report. Stay narrow. The parent agent decides what to do with the result.',
  ].join('\n'),
}

export default definition
