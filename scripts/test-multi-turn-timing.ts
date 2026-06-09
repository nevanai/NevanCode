/**
 * Multi-turn timing harness for the telemetry-retry-storm fix.
 *
 * Reproduces the user's bug condition: web/ is intentionally NOT running
 * (localhost:3000 ECONNREFUSED on every telemetry call), and we send three
 * consecutive prompts via the SDK to confirm each one returns well under
 * the previous ~60s. Uses the user's existing ChatGPT OAuth credentials
 * (~/.config/manicode-dev/credentials.json) so the LLM call itself works.
 *
 * Run: bun scripts/test-multi-turn-timing.ts
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

const prompts = process.env.CONTEXT_TEST === '1'
  ? [
      // Context-retention set: turn 2 & 3 only answerable if history is kept.
      'اسمي عبدالله ورقمي المفضل هو 7. رد بسطر واحد.',
      'ما هو اسمي وما رقمي المفضل؟',
      'اضرب رقمي المفضل في 3 واذكر الناتج.',
    ]
  : [
      'مرحبا، ما اسمك؟ اجبني بسطر واحد فقط بدون اي ادوات.',
      'كم يساوي 2 + 2؟ اجبني بسطر واحد.',
      'وما هي عاصمة فرنسا؟ اجبني بسطر واحد.',
    ]

// Debug knob: ALL_EVENTS=1 dumps every event from the SDK so we can see what
// the model is actually emitting (text-delta, reasoning, tool-call, etc.).
const DUMP_ALL_EVENTS = process.env.ALL_EVENTS === '1'

// AGENT env var selects which agent to drive (default base2; the screenshot
// that reproduced the bug was in MAX mode → base2-max).
const AGENT_ID = process.env.AGENT ?? 'base2'

const projectRoot = path.resolve(__dirname, '..')

async function main() {
  const agentDefinitions = loadAgentDefinitions()
  const client = new CodebuffClient({
    apiKey,
    cwd: projectRoot,
    agentDefinitions,
  })

  let previousRun: RunState | null = null
  const timings: { turn: number; ms: number; text: string }[] = []

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i]
    console.log(`\n── Turn ${i + 1}: ${JSON.stringify(prompt)} ──`)

    let collectedText = ''
    let collectedReasoning = ''
    const toolCalls: { name: string; input: string }[] = []
    const eventTypes: Record<string, number> = {}
    const started = Date.now()
    try {
      const result = await client.run({
        agent: AGENT_ID,
        prompt,
        previousRun: previousRun ?? undefined,
        handleEvent: (event: any) => {
          const t = event?.type ?? 'unknown'
          eventTypes[t] = (eventTypes[t] ?? 0) + 1
          if (DUMP_ALL_EVENTS) {
            const dump = JSON.stringify(event)
            console.log(`    [evt ${t}]`, dump.length > 400 ? dump.slice(0, 400) + '…' : dump)
          }
          // Try every shape we've seen for text/reasoning chunks
          if (t === 'text' && typeof event.text === 'string') collectedText += event.text
          if (t === 'reasoning' && typeof event.text === 'string') collectedReasoning += event.text
          const c = event.chunk
          if (c?.type === 'text' && typeof c.text === 'string') collectedText += c.text
          if (c?.type === 'reasoning' && typeof c.text === 'string') collectedReasoning += c.text
          if (t === 'tool_call' || t === 'tool-call') {
            toolCalls.push({
              name: event.toolName ?? event.tool_name ?? c?.toolName ?? 'unknown',
              input: JSON.stringify(event.input ?? event.args ?? c?.input ?? {}).slice(0, 200),
            })
          }
        },
      })
      const elapsed = Date.now() - started
      previousRun = result
      const outValue = (result.output as any)?.value
      const lastMsgPreview = Array.isArray(outValue)
        ? JSON.stringify(outValue).slice(0, 200)
        : JSON.stringify(result.output).slice(0, 200)
      const fullHistory = (result as any)?.sessionState?.mainAgentState
        ?.messageHistory
      if (Array.isArray(fullHistory)) {
        // Find the most-recent slice of assistant messages added by THIS turn.
        // (Any messages added after the last user message that contains
        // <user_message>{thisPrompt}</user_message>.)
        const userIdx = (() => {
          for (let i = fullHistory.length - 1; i >= 0; i--) {
            const m = fullHistory[i]
            const c = m.content
            const str = typeof c === 'string' ? c : JSON.stringify(c ?? '')
            if (m.role === 'user' && str.includes(prompt)) return i
          }
          return -1
        })()
        const turnSlice = userIdx >= 0 ? fullHistory.slice(userIdx + 1) : []
        console.log(`  messages added this turn: ${turnSlice.length}`)
        for (const m of turnSlice) {
          const parts = Array.isArray(m.content)
            ? m.content
            : [{ type: 'text', text: m.content }]
          for (const p of parts) {
            const t = p.type ?? (p.toolName ? 'tool-call' : 'unknown')
            const desc =
              t === 'text'
                ? `text len=${(p.text ?? '').length}: "${(p.text ?? '').slice(0, 200)}"`
                : t === 'reasoning'
                  ? `reasoning len=${(p.text ?? '').length}: "${(p.text ?? '').slice(0, 200)}"`
                  : t === 'tool-call' || p.toolName
                    ? `tool=${p.toolName}`
                    : t
            console.log(`    [${m.role}] ${t}: ${desc}`)
          }
        }
      }
      console.log(`  elapsed: ${(elapsed / 1000).toFixed(2)}s`)
      console.log(`  event types:`, eventTypes)
      console.log(`  streamed text len: ${collectedText.length}`)
      if (collectedText) console.log(`  streamed text: ${collectedText.slice(0, 400)}`)
      console.log(`  reasoning len: ${collectedReasoning.length}`)
      if (collectedReasoning) console.log(`  reasoning preview: ${collectedReasoning.slice(0, 600)}`)
      console.log(`  tool calls:`, toolCalls)
      console.log(`  output preview: ${lastMsgPreview}`)
      timings.push({ turn: i + 1, ms: elapsed, text: collectedText })
    } catch (e: any) {
      const elapsed = Date.now() - started
      console.log(`  elapsed: ${(elapsed / 1000).toFixed(2)}s (ERROR)`)
      console.log(`  error: ${e?.message ?? e}`)
      timings.push({ turn: i + 1, ms: elapsed, text: `<error: ${e?.message}>` })
    }
  }

  console.log('\n══ SUMMARY ══')
  for (const t of timings) {
    console.log(
      `  Turn ${t.turn}: ${(t.ms / 1000).toFixed(2)}s | text=${t.text ? `"${t.text.slice(0, 80)}"` : '<empty>'}`,
    )
  }

  process.exit(0)
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
