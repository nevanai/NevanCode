/**
 * Real coding-task harness. Drives base2 in a fresh empty project directory
 * and asks it to actually build software, so we can see whether the file
 * tools / subagent spawning / multi-step paths work end to end — not just
 * conversational Q&A.
 *
 * Run: bun scripts/test-coding-task.ts
 * Env: AGENT=base2|base2-max  PROJECT_DIR=/path  TASK_SET=1|2
 */
import fs from 'fs'
import path from 'path'
import os from 'os'

import { CodebuffClient } from '../sdk/src/client'
import { loadAgentDefinitions } from '../cli/src/utils/local-agent-registry'

import type { RunState } from '../sdk/src/run-state'

const credsPath = path.join(
  os.homedir(),
  '.config',
  'manicode-dev',
  'credentials.json',
)
const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
const apiKey: string | undefined = creds?.default?.authToken
if (!apiKey) {
  console.error('No authToken in', credsPath)
  process.exit(1)
}

const AGENT_ID = process.env.AGENT ?? 'base2'
const PROJECT_DIR = process.env.PROJECT_DIR ?? '/tmp/codebuff-readiness-test'

const TASK_SETS: Record<string, string[]> = {
  // A small but real multi-file build, then an iteration on it.
  '1': [
    'Build a working todo-list web app in this directory. Create a single self-contained index.html with inline CSS and JavaScript. Features: add a todo, toggle complete, delete, and persist to localStorage. Keep it clean and modern.',
    'Now add a dark-mode toggle button to the same index.html, persisting the choice to localStorage.',
  ],
  // A different stack: a small Node script + verify it runs.
  '2': [
    'Create a Node.js script named fizzbuzz.js in this directory that prints FizzBuzz from 1 to 30. Then run it with the run_terminal_command tool and show me the output.',
  ],
}

const tasks = TASK_SETS[process.env.TASK_SET ?? '1']

fs.mkdirSync(PROJECT_DIR, { recursive: true })

function listFiles(dir: string, depth = 0): string[] {
  if (depth > 3) return []
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      out.push(`${'  '.repeat(depth)}${e.name}/`)
      out.push(...listFiles(full, depth + 1))
    } else {
      const size = fs.statSync(full).size
      out.push(`${'  '.repeat(depth)}${e.name} (${size} bytes)`)
    }
  }
  return out
}

async function main() {
  console.log(`agent=${AGENT_ID}  projectDir=${PROJECT_DIR}`)
  const agentDefinitions = loadAgentDefinitions()
  const client = new CodebuffClient({
    apiKey,
    cwd: PROJECT_DIR,
    agentDefinitions,
  })

  let previousRun: RunState | null = null

  for (let i = 0; i < tasks.length; i++) {
    const prompt = tasks[i]
    console.log(`\n${'═'.repeat(70)}\n── Task ${i + 1}: ${prompt.slice(0, 90)}…\n${'═'.repeat(70)}`)

    let collectedText = ''
    const toolCounts: Record<string, number> = {}
    const subagents = new Set<string>()
    const errors: string[] = []
    const started = Date.now()

    try {
      const result = await client.run({
        agent: AGENT_ID,
        prompt,
        previousRun: previousRun ?? undefined,
        handleEvent: (event: any) => {
          const t = event?.type ?? 'unknown'
          if (t === 'text' && typeof event.text === 'string') collectedText += event.text
          if (event.chunk?.type === 'text') collectedText += event.chunk.text ?? ''
          if (t === 'tool_call' || t === 'tool-call') {
            const name = event.toolName ?? event.chunk?.toolName ?? 'unknown'
            toolCounts[name] = (toolCounts[name] ?? 0) + 1
          }
          if (t === 'subagent_start' || t === 'subagent-response-chunk') {
            if (event.agentType) subagents.add(event.agentType)
          }
          if (t === 'error' || event.chunk?.type === 'error') {
            errors.push(String(event.message ?? event.chunk?.message ?? 'error'))
          }
        },
      })
      const elapsed = Date.now() - started
      previousRun = result
      const out: any = result.output
      console.log(`  elapsed: ${(elapsed / 1000).toFixed(1)}s`)
      console.log(`  output.type: ${out?.type}`)
      console.log(`  streamed text len: ${collectedText.length}`)
      if (collectedText) console.log(`  text (last 300): …${collectedText.slice(-300)}`)
      console.log(`  tool calls:`, toolCounts)
      console.log(`  subagents seen:`, [...subagents])
      if (errors.length) console.log(`  ⚠️ errors during run:`, errors.slice(0, 5))
      if (out?.type === 'error') console.log(`  ⚠️ output ERROR: ${out.message}`)
    } catch (e: any) {
      console.log(`  elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s (THREW)`)
      console.log(`  ⚠️ exception: ${e?.message ?? e}`)
    }

    console.log(`  files in project now:`)
    for (const line of listFiles(PROJECT_DIR)) console.log(`    ${line}`)
  }

  process.exit(0)
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
