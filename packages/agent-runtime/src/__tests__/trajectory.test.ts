/**
 * Tests for the trajectory-capture learning-loop primitive ported from Hermes
 * Agent (see src/trajectory.ts). Covers the ShareGPT conversion logic, JSONL
 * persistence, env gating, and the exception-safe capture orchestrator.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildTrajectorySystemMessage,
  captureTrajectory,
  convertScratchpadToThink,
  convertToTrajectoryFormat,
  getTrajectoryDir,
  hasIncompleteScratchpad,
  isTrajectoryCaptureEnabled,
  saveTrajectory,
  type ShareGptTurn,
  type TrajectoryEntry,
} from '../trajectory'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'

// ---- helpers to build Codebuff messages ------------------------------------

const user = (text: string): Message => ({
  role: 'user',
  content: [{ type: 'text', text }],
})

const assistantText = (text: string, reasoning?: string): Message => ({
  role: 'assistant',
  content: [
    ...(reasoning ? [{ type: 'reasoning' as const, text: reasoning }] : []),
    { type: 'text' as const, text },
  ],
})

const assistantToolCall = (
  toolName: string,
  input: Record<string, unknown>,
  opts: { text?: string; reasoning?: string; toolCallId?: string } = {},
): Message => ({
  role: 'assistant',
  content: [
    ...(opts.reasoning
      ? [{ type: 'reasoning' as const, text: opts.reasoning }]
      : []),
    ...(opts.text ? [{ type: 'text' as const, text: opts.text }] : []),
    {
      type: 'tool-call' as const,
      toolCallId: opts.toolCallId ?? 'call_1',
      toolName,
      input,
    },
  ],
})

const toolResult = (
  toolName: string,
  value: unknown,
  toolCallId = 'call_1',
): Message => ({
  role: 'tool',
  toolCallId,
  toolName,
  content: [{ type: 'json', value: value as any }],
})

// ---- string helpers --------------------------------------------------------

describe('convertScratchpadToThink', () => {
  it('converts REASONING_SCRATCHPAD tags to think tags', () => {
    expect(
      convertScratchpadToThink('<REASONING_SCRATCHPAD>hi</REASONING_SCRATCHPAD>'),
    ).toBe('<think>hi</think>')
  })

  it('leaves content without scratchpad tags untouched', () => {
    expect(convertScratchpadToThink('plain text')).toBe('plain text')
    expect(convertScratchpadToThink('')).toBe('')
  })
})

describe('hasIncompleteScratchpad', () => {
  it('detects an unclosed scratchpad', () => {
    expect(hasIncompleteScratchpad('<REASONING_SCRATCHPAD>oops')).toBe(true)
  })
  it('returns false for closed or absent scratchpad', () => {
    expect(
      hasIncompleteScratchpad('<REASONING_SCRATCHPAD>x</REASONING_SCRATCHPAD>'),
    ).toBe(false)
    expect(hasIncompleteScratchpad('')).toBe(false)
  })
})

describe('buildTrajectorySystemMessage', () => {
  it('embeds the tools description inside a <tools> block', () => {
    const sys = buildTrajectorySystemMessage('TOOLDESC')
    expect(sys).toContain('<tools>\nTOOLDESC\n</tools>')
    expect(sys).toContain('function calling AI model')
    expect(sys).toContain('<tool_call>')
  })

  it('produces a well-formed (empty) tools block with no description', () => {
    expect(buildTrajectorySystemMessage('')).toContain('<tools>\n\n</tools>')
  })
})

// ---- conversion ------------------------------------------------------------

describe('convertToTrajectoryFormat', () => {
  it('emits system then human(userQuery) as the first two turns', () => {
    const t = convertToTrajectoryFormat({
      messages: [],
      userQuery: 'do the thing',
      toolsDescription: 'TOOLS',
    })
    expect(t[0].from).toBe('system')
    expect(t[0].value).toContain('<tools>\nTOOLS\n</tools>')
    expect(t[1]).toEqual({ from: 'human', value: 'do the thing' })
  })

  it('skips the first user message to avoid duplicating the query', () => {
    const t = convertToTrajectoryFormat({
      messages: [user('do the thing'), assistantText('done')],
      userQuery: 'do the thing',
    })
    const humans = t.filter((x) => x.from === 'human')
    expect(humans).toHaveLength(1)
    expect(humans[0].value).toBe('do the thing')
  })

  it('wraps a plain assistant turn in an empty think block', () => {
    const t = convertToTrajectoryFormat({
      messages: [user('q'), assistantText('the answer')],
      userQuery: 'q',
    })
    const gpt = t.find((x) => x.from === 'gpt')!
    expect(gpt.value).toBe('<think>\n</think>\nthe answer')
  })

  it('renders native reasoning inside a think block', () => {
    const t = convertToTrajectoryFormat({
      messages: [user('q'), assistantText('answer', 'let me think')],
      userQuery: 'q',
    })
    const gpt = t.find((x) => x.from === 'gpt')!
    expect(gpt.value).toBe('<think>\nlet me think\n</think>\nanswer')
  })

  it('converts REASONING_SCRATCHPAD inside assistant text', () => {
    const t = convertToTrajectoryFormat({
      messages: [
        user('q'),
        assistantText('<REASONING_SCRATCHPAD>plan</REASONING_SCRATCHPAD> ok'),
      ],
      userQuery: 'q',
    })
    const gpt = t.find((x) => x.from === 'gpt')!
    expect(gpt.value).toContain('<think>plan</think>')
  })

  it('serialises tool calls and the following tool response', () => {
    const t = convertToTrajectoryFormat({
      messages: [
        user('list files'),
        assistantToolCall('read_files', { paths: ['a.ts'] }, { text: 'reading' }),
        toolResult('read_files', { ok: true }),
      ],
      userQuery: 'list files',
    })
    const gpt = t.find((x) => x.from === 'gpt')!
    expect(gpt.value).toContain('<tool_call>')
    expect(gpt.value).toContain(
      JSON.stringify({ name: 'read_files', arguments: { paths: ['a.ts'] } }),
    )
    // text precedes the tool_call, wrapped think block present
    expect(gpt.value).toContain('<think>\n</think>')
    expect(gpt.value).toContain('reading')

    const tool = t.find((x) => x.from === 'tool')!
    expect(tool.value).toContain('<tool_response>')
    expect(tool.value).toContain(
      JSON.stringify({
        tool_call_id: 'call_1',
        name: 'read_files',
        content: { ok: true },
      }),
    )
  })

  it('uses think block from reasoning when tool calls are present', () => {
    const t = convertToTrajectoryFormat({
      messages: [
        user('q'),
        assistantToolCall('run', { cmd: 'ls' }, { reasoning: 'I will list' }),
        toolResult('run', 'output'),
      ],
      userQuery: 'q',
    })
    const gpt = t.find((x) => x.from === 'gpt')!
    expect(gpt.value.startsWith('<think>\nI will list\n</think>')).toBe(true)
  })

  it('folds multiple consecutive tool results into one tool turn', () => {
    const t = convertToTrajectoryFormat({
      messages: [
        user('q'),
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'a', input: {} },
            { type: 'tool-call', toolCallId: 'c2', toolName: 'b', input: {} },
          ],
        },
        toolResult('a', 1, 'c1'),
        toolResult('b', 2, 'c2'),
        assistantText('done'),
      ],
      userQuery: 'q',
    })
    const toolTurns = t.filter((x) => x.from === 'tool')
    expect(toolTurns).toHaveLength(1)
    expect(toolTurns[0].value.split('<tool_response>')).toHaveLength(3) // 2 responses
    // the trailing assistant turn is still emitted, not swallowed
    expect(t[t.length - 1]).toEqual({
      from: 'gpt',
      value: '<think>\n</think>\ndone',
    })
  })

  it('represents media tool results with a placeholder, not raw bytes', () => {
    const t = convertToTrajectoryFormat({
      messages: [
        user('screenshot'),
        assistantToolCall('shot', {}),
        {
          role: 'tool',
          toolCallId: 'call_1',
          toolName: 'shot',
          content: [{ type: 'media', data: 'AAAA', mediaType: 'image/png' }],
        },
      ],
      userQuery: 'screenshot',
    })
    const tool = t.find((x) => x.from === 'tool')!
    expect(tool.value).toContain('[media omitted: image/png]')
    expect(tool.value).not.toContain('AAAA')
  })

  it('emits later user messages as additional human turns', () => {
    const t = convertToTrajectoryFormat({
      messages: [user('first'), assistantText('a1'), user('second')],
      userQuery: 'first',
    })
    const humans = t.filter((x) => x.from === 'human').map((x) => x.value)
    expect(humans).toEqual(['first', 'second'])
  })

  it('ignores system-role messages in the history', () => {
    const t = convertToTrajectoryFormat({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        user('q'),
        assistantText('a'),
      ],
      userQuery: 'q',
    })
    expect(t.filter((x) => x.from === 'system')).toHaveLength(1) // only synthesised
    expect(t.filter((x) => x.from === 'human')).toHaveLength(1)
  })
})

// ---- persistence -----------------------------------------------------------

describe('saveTrajectory', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'traj-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const sample: ShareGptTurn[] = [
    { from: 'system', value: 's' },
    { from: 'human', value: 'h' },
    { from: 'gpt', value: 'g' },
  ]

  it('writes completed runs to trajectory_samples.jsonl', () => {
    const p = saveTrajectory({
      trajectory: sample,
      model: 'opus',
      completed: true,
      dir,
    })
    expect(p).toBe(join(dir, 'trajectory_samples.jsonl'))
    const line = readFileSync(p!, 'utf-8').trim()
    const entry = JSON.parse(line) as TrajectoryEntry
    expect(entry.conversations).toEqual(sample)
    expect(entry.model).toBe('opus')
    expect(entry.completed).toBe(true)
    expect(typeof entry.timestamp).toBe('string')
  })

  it('writes failed runs to failed_trajectories.jsonl', () => {
    const p = saveTrajectory({
      trajectory: sample,
      model: 'opus',
      completed: false,
      dir,
    })
    expect(p).toBe(join(dir, 'failed_trajectories.jsonl'))
  })

  it('appends (JSONL) rather than overwriting', () => {
    saveTrajectory({ trajectory: sample, model: 'm', completed: true, dir })
    saveTrajectory({ trajectory: sample, model: 'm', completed: true, dir })
    const lines = readFileSync(join(dir, 'trajectory_samples.jsonl'), 'utf-8')
      .trim()
      .split('\n')
    expect(lines).toHaveLength(2)
  })

  it('returns undefined and does not throw when the target dir is unwritable', () => {
    const p = saveTrajectory({
      trajectory: sample,
      model: 'm',
      completed: true,
      // a path under a regular file can't be created -> mkdir/appendFile fails
      dir: join(import.meta.dir, 'trajectory.test.ts', 'nested'),
    })
    expect(p).toBeUndefined()
  })
})

// ---- env gating ------------------------------------------------------------

describe('env gating', () => {
  const orig = { ...process.env }
  afterEach(() => {
    process.env = { ...orig }
  })

  it('isTrajectoryCaptureEnabled is false unless explicitly enabled', () => {
    delete process.env.CODEBUFF_SAVE_TRAJECTORIES
    expect(isTrajectoryCaptureEnabled()).toBe(false)
    process.env.CODEBUFF_SAVE_TRAJECTORIES = 'true'
    expect(isTrajectoryCaptureEnabled()).toBe(true)
    process.env.CODEBUFF_SAVE_TRAJECTORIES = '1'
    expect(isTrajectoryCaptureEnabled()).toBe(true)
    process.env.CODEBUFF_SAVE_TRAJECTORIES = 'no'
    expect(isTrajectoryCaptureEnabled()).toBe(false)
  })

  it('getTrajectoryDir honours CODEBUFF_TRAJECTORY_DIR, else cwd', () => {
    delete process.env.CODEBUFF_TRAJECTORY_DIR
    expect(getTrajectoryDir()).toBe(process.cwd())
    process.env.CODEBUFF_TRAJECTORY_DIR = '/tmp/some-traj-dir'
    expect(getTrajectoryDir()).toBe('/tmp/some-traj-dir')
  })
})

// ---- orchestrator ----------------------------------------------------------

describe('captureTrajectory', () => {
  const orig = { ...process.env }
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'traj-cap-'))
  })
  afterEach(() => {
    process.env = { ...orig }
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes nothing and returns undefined when disabled (default)', () => {
    delete process.env.CODEBUFF_SAVE_TRAJECTORIES
    const p = captureTrajectory({
      messages: [user('q'), assistantText('a')],
      userQuery: 'q',
      model: 'opus',
      completed: true,
    })
    expect(p).toBeUndefined()
  })

  it('captures and writes a file when enabled', () => {
    process.env.CODEBUFF_SAVE_TRAJECTORIES = '1'
    process.env.CODEBUFF_TRAJECTORY_DIR = dir
    const p = captureTrajectory({
      messages: [user('q'), assistantToolCall('run', { cmd: 'ls' }), toolResult('run', 'ok')],
      userQuery: 'q',
      model: 'opus',
      completed: true,
    })
    expect(p).toBe(join(dir, 'trajectory_samples.jsonl'))
    expect(existsSync(p!)).toBe(true)
    const entry = JSON.parse(
      readFileSync(p!, 'utf-8').trim(),
    ) as TrajectoryEntry
    expect(entry.conversations[0].from).toBe('system')
    expect(entry.conversations.some((c) => c.from === 'tool')).toBe(true)
  })

  it('never throws, even on malformed input', () => {
    process.env.CODEBUFF_SAVE_TRAJECTORIES = '1'
    process.env.CODEBUFF_TRAJECTORY_DIR = dir
    expect(() =>
      captureTrajectory({
        // intentionally malformed message to exercise the safety net
        messages: [{ role: 'assistant' } as unknown as Message],
        userQuery: undefined,
        model: 'opus',
        completed: false,
      }),
    ).not.toThrow()
  })
})
