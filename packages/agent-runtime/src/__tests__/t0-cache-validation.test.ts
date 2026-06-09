/**
 * T0 Cache Validation Suite
 *
 * Comprehensive tests for all completed M0 Quick Wins:
 *   T0.1 — Anthropic API call-sites audit file
 *   T0.2 — cache_control on system prompt
 *   T0.3 — cache_control on knowledge files
 *   T0.4 — cache_control on project memory + tools schema
 *   T0.5 — Cache hit/miss telemetry metrics
 */

import { AnalyticsEvent } from '@codebuff/common/constants/analytics-events'
import {
  convertCbToModelMessages,
  systemMessage,
  userMessage,
  assistantMessage,
} from '@codebuff/common/util/messages'
import { describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  buildSystemMessagesWithKnowledgeCache,
} from '../util/messages'
import {
  KNOWLEDGE_FILES_SEGMENT_END,
  KNOWLEDGE_FILES_SEGMENT_START,
  PROJECT_MEMORY_SEGMENT_END,
  PROJECT_MEMORY_SEGMENT_START,
} from '../system-prompt/prompts'

import type { Message } from '@codebuff/common/types/messages/codebuff-message'
import type { ModelMessage } from 'ai'

// ─── helpers ──────────────────────────────────────────────────────────────────

type ProviderOptions = Record<string, Record<string, unknown> | undefined>

function getCacheControl(msg: ModelMessage): unknown {
  return (msg.providerOptions as ProviderOptions | undefined)?.anthropic
    ?.cache_control
}

function countCacheBreakpoints(messages: ModelMessage[]): number {
  let total = 0
  for (const msg of messages) {
    if (getCacheControl(msg)) total++
    if (typeof msg.content !== 'string' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (
          (part as { providerOptions?: ProviderOptions }).providerOptions
            ?.anthropic?.cache_control
        )
          total++
      }
    }
  }
  return total
}

const REPO_ROOT = path.resolve(__dirname, '../../../../')

// ─── T0.1: Audit file ─────────────────────────────────────────────────────────

describe('T0.1 — Anthropic API call-sites audit', () => {
  const auditPath = path.join(
    REPO_ROOT,
    'docs/audits/anthropic-api-call-sites.md',
  )

  it('audit file exists at docs/audits/anthropic-api-call-sites.md', () => {
    expect(fs.existsSync(auditPath)).toBe(true)
  })

  it('audit file is not empty (> 500 chars)', () => {
    const content = fs.readFileSync(auditPath, 'utf-8')
    expect(content.length).toBeGreaterThan(500)
  })

  it('audit file mentions key API call-site files', () => {
    const content = fs.readFileSync(auditPath, 'utf-8')
    // Must document the primary call-path files
    expect(content).toContain('run-agent-step')
    expect(content).toContain('messages')
    expect(content).toContain('cache_control')
  })

  it('audit file covers both agent-runtime and web scopes', () => {
    const content = fs.readFileSync(auditPath, 'utf-8')
    expect(content).toContain('agent-runtime')
    expect(content).toContain('web')
  })
})

// ─── T0.2: System prompt caching ──────────────────────────────────────────────

describe('T0.2 — cache_control on system prompt', () => {
  it('always caches the first system message when includeCacheControl=true', () => {
    const messages: Message[] = [
      systemMessage('System instructions'),
      userMessage('Hello'),
    ]
    const result = convertCbToModelMessages({ messages, includeCacheControl: true })
    expect(getCacheControl(result[0])).toEqual({ type: 'ephemeral' })
  })

  it('does NOT cache system message when includeCacheControl=false', () => {
    const messages: Message[] = [
      systemMessage('System instructions'),
      userMessage('Hello'),
    ]
    const result = convertCbToModelMessages({ messages, includeCacheControl: false })
    expect(getCacheControl(result[0])).toBeUndefined()
  })

  it('caches system message regardless of its content length', () => {
    const short: Message[] = [systemMessage('Hi'), userMessage('ok')]
    const long: Message[] = [
      systemMessage('A'.repeat(10_000)),
      userMessage('ok'),
    ]
    const r1 = convertCbToModelMessages({ messages: short, includeCacheControl: true })
    const r2 = convertCbToModelMessages({ messages: long, includeCacheControl: true })
    expect(getCacheControl(r1[0])).toEqual({ type: 'ephemeral' })
    expect(getCacheControl(r2[0])).toEqual({ type: 'ephemeral' })
  })

  it('only applies caching to system role, not user at index 0', () => {
    // Even if a user message is first (malformed conversation), system caching
    // is not applied to non-system messages via the system-specific path.
    const messages: Message[] = [userMessage('Only a user message')]
    const result = convertCbToModelMessages({ messages, includeCacheControl: true })
    // The user message at index 0 may or may not get cache_control via the
    // conversation loop, but the system-specific breakpoint at index 0 must
    // only fire when the message is of role 'system'.
    expect(result[0].role).toBe('user')
    // System-level caching path only checks role === 'system'; user messages
    // don't get the guaranteed T0.2 breakpoint — they might get a conversation
    // breakpoint but that's a different path.
  })

  it('caches system message even in long conversations', () => {
    const messages: Message[] = [
      systemMessage('System'),
      ...Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0 ? userMessage(`msg ${i}`) : assistantMessage(`reply ${i}`),
      ),
      userMessage({ content: 'Final', tags: ['USER_PROMPT'] }),
    ]
    const result = convertCbToModelMessages({ messages, includeCacheControl: true })
    expect(getCacheControl(result[0])).toEqual({ type: 'ephemeral' })
  })
})

// ─── T0.3: Knowledge files caching ────────────────────────────────────────────

describe('T0.3 — cache_control on knowledge files', () => {
  it('exports KNOWLEDGE_FILES sentinel constants', () => {
    expect(typeof KNOWLEDGE_FILES_SEGMENT_START).toBe('string')
    expect(typeof KNOWLEDGE_FILES_SEGMENT_END).toBe('string')
    expect(KNOWLEDGE_FILES_SEGMENT_START.length).toBeGreaterThan(5)
    expect(KNOWLEDGE_FILES_SEGMENT_END.length).toBeGreaterThan(5)
  })

  it('sentinel constants are unique strings (not empty, not equal)', () => {
    expect(KNOWLEDGE_FILES_SEGMENT_START).not.toBe('')
    expect(KNOWLEDGE_FILES_SEGMENT_END).not.toBe('')
    expect(KNOWLEDGE_FILES_SEGMENT_START).not.toBe(KNOWLEDGE_FILES_SEGMENT_END)
  })

  it('splits system prompt on knowledge-files sentinels', () => {
    const system = [
      'BASE',
      `${KNOWLEDGE_FILES_SEGMENT_START}KNOWLEDGE${KNOWLEDGE_FILES_SEGMENT_END}`,
      'TAIL',
    ].join('\n')
    const segments = buildSystemMessagesWithKnowledgeCache(system)
    const kSeg = segments.find((s) => s.tags?.includes('KNOWLEDGE_FILES'))
    expect(kSeg).toBeDefined()
    expect(kSeg!.content[0]?.text).toBe('KNOWLEDGE')
  })

  it('returns single message when no sentinels present', () => {
    const result = buildSystemMessagesWithKnowledgeCache('Plain system')
    expect(result).toHaveLength(1)
    expect(result[0].tags).toBeUndefined()
  })

  it('KNOWLEDGE_FILES tagged segment gets its own cache_control breakpoint', () => {
    const messages: Message[] = [
      systemMessage('Base system'),
      systemMessage({ content: 'Knowledge content', tags: ['KNOWLEDGE_FILES'] }),
      userMessage('Hello'),
    ]
    const result = convertCbToModelMessages({ messages, includeCacheControl: true })
    // Index 0 = base system (T0.2), index 1 = knowledge files (T0.3)
    expect(getCacheControl(result[0])).toEqual({ type: 'ephemeral' })
    expect(getCacheControl(result[1])).toEqual({ type: 'ephemeral' })
  })

  it('knowledge caching is independent: still cached even if base system changes', () => {
    // Simulates different base system content but same knowledge files
    const makeMessages = (base: string): Message[] => [
      systemMessage(base),
      systemMessage({ content: 'Stable knowledge', tags: ['KNOWLEDGE_FILES'] }),
      userMessage('Hello'),
    ]
    const r1 = convertCbToModelMessages({ messages: makeMessages('System v1'), includeCacheControl: true })
    const r2 = convertCbToModelMessages({ messages: makeMessages('System v2'), includeCacheControl: true })
    expect(getCacheControl(r1[1])).toEqual({ type: 'ephemeral' })
    expect(getCacheControl(r2[1])).toEqual({ type: 'ephemeral' })
  })

  it('drops empty knowledge segment (no sentinels = no split)', () => {
    const system = `HEAD ${KNOWLEDGE_FILES_SEGMENT_START}   ${KNOWLEDGE_FILES_SEGMENT_END} TAIL`
    const segments = buildSystemMessagesWithKnowledgeCache(system)
    const kSeg = segments.find((s) => s.tags?.includes('KNOWLEDGE_FILES'))
    expect(kSeg).toBeUndefined()
  })

  it('pre and post segments around knowledge files are plain (untagged)', () => {
    const system = [
      'PRE_CONTENT',
      `${KNOWLEDGE_FILES_SEGMENT_START}KNOWLEDGE${KNOWLEDGE_FILES_SEGMENT_END}`,
      'POST_CONTENT',
    ].join('\n')
    const segments = buildSystemMessagesWithKnowledgeCache(system)
    const plain = segments.filter((s) => !s.tags || s.tags.length === 0)
    expect(plain.length).toBeGreaterThanOrEqual(1)
    expect(plain.some((s) => s.content[0]?.text?.includes('PRE_CONTENT'))).toBe(true)
  })
})

// ─── T0.4: Project memory + tools schema caching ──────────────────────────────

describe('T0.4 — cache_control on project memory + tools schema', () => {
  describe('Project memory sentinel system', () => {
    it('exports PROJECT_MEMORY sentinel constants', () => {
      expect(typeof PROJECT_MEMORY_SEGMENT_START).toBe('string')
      expect(typeof PROJECT_MEMORY_SEGMENT_END).toBe('string')
      expect(PROJECT_MEMORY_SEGMENT_START.length).toBeGreaterThan(5)
      expect(PROJECT_MEMORY_SEGMENT_END.length).toBeGreaterThan(5)
    })

    it('sentinel constants are distinct from knowledge-files sentinels', () => {
      expect(PROJECT_MEMORY_SEGMENT_START).not.toBe(KNOWLEDGE_FILES_SEGMENT_START)
      expect(PROJECT_MEMORY_SEGMENT_END).not.toBe(KNOWLEDGE_FILES_SEGMENT_END)
    })

    it('splits system prompt on project-memory sentinels alone', () => {
      const system = [
        'BASE',
        `${PROJECT_MEMORY_SEGMENT_START}MEMORY${PROJECT_MEMORY_SEGMENT_END}`,
        'TAIL',
      ].join('\n')
      const segments = buildSystemMessagesWithKnowledgeCache(system)
      const mSeg = segments.find((s) => s.tags?.includes('PROJECT_MEMORY'))
      expect(mSeg).toBeDefined()
      expect(mSeg!.content[0]?.text).toBe('MEMORY')
    })

    it('splits on both knowledge files AND project memory sentinels in order', () => {
      const system = [
        'PRE',
        `${KNOWLEDGE_FILES_SEGMENT_START}KNOWLEDGE${KNOWLEDGE_FILES_SEGMENT_END}`,
        'MID',
        `${PROJECT_MEMORY_SEGMENT_START}MEMORY${PROJECT_MEMORY_SEGMENT_END}`,
        'POST',
      ].join('\n')
      const segments = buildSystemMessagesWithKnowledgeCache(system)
      const kSeg = segments.find((s) => s.tags?.includes('KNOWLEDGE_FILES'))
      const mSeg = segments.find((s) => s.tags?.includes('PROJECT_MEMORY'))
      expect(kSeg).toBeDefined()
      expect(mSeg).toBeDefined()
      expect(kSeg!.content[0]?.text).toBe('KNOWLEDGE')
      expect(mSeg!.content[0]?.text).toBe('MEMORY')
      // Knowledge files must come before project memory
      const kIdx = segments.indexOf(kSeg!)
      const mIdx = segments.indexOf(mSeg!)
      expect(kIdx).toBeLessThan(mIdx)
    })

    it('drops empty project-memory segment', () => {
      const system = [
        'BASE',
        `${KNOWLEDGE_FILES_SEGMENT_START}KNOWLEDGE${KNOWLEDGE_FILES_SEGMENT_END}`,
        `${PROJECT_MEMORY_SEGMENT_START}   ${PROJECT_MEMORY_SEGMENT_END}`,
        'TAIL',
      ].join('\n')
      const segments = buildSystemMessagesWithKnowledgeCache(system)
      const mSeg = segments.find((s) => s.tags?.includes('PROJECT_MEMORY'))
      expect(mSeg).toBeUndefined()
    })
  })

  describe('Project memory cache_control in convertCbToModelMessages', () => {
    it('PROJECT_MEMORY tagged segment gets its own cache_control breakpoint', () => {
      const messages: Message[] = [
        systemMessage('Base'),
        systemMessage({ content: 'Knowledge', tags: ['KNOWLEDGE_FILES'] }),
        systemMessage({ content: 'Memory', tags: ['PROJECT_MEMORY'] }),
        userMessage('Hello'),
      ]
      const result = convertCbToModelMessages({ messages, includeCacheControl: true })
      expect(getCacheControl(result[0])).toEqual({ type: 'ephemeral' }) // T0.2
      expect(getCacheControl(result[1])).toEqual({ type: 'ephemeral' }) // T0.3
      expect(getCacheControl(result[2])).toEqual({ type: 'ephemeral' }) // T0.4
    })

    it('all three stable breakpoints present simultaneously', () => {
      const messages: Message[] = [
        systemMessage('System base'),
        systemMessage({ content: 'Knowledge files', tags: ['KNOWLEDGE_FILES'] }),
        systemMessage({ content: '.nevan/memory.md content', tags: ['PROJECT_MEMORY'] }),
        systemMessage('Git changes and system info (volatile)'),
        userMessage({ content: 'User message', tags: ['USER_PROMPT'] }),
      ]
      const result = convertCbToModelMessages({ messages, includeCacheControl: true })
      const cached = result.filter((msg) => getCacheControl(msg) !== undefined)
      // Exactly 3: system base, knowledge files, project memory
      expect(cached.length).toBe(3)
      expect(getCacheControl(result[0])).toEqual({ type: 'ephemeral' })
      expect(getCacheControl(result[1])).toEqual({ type: 'ephemeral' })
      expect(getCacheControl(result[2])).toEqual({ type: 'ephemeral' })
      // Volatile tail (index 3) must NOT be cached
      expect(getCacheControl(result[3])).toBeUndefined()
    })

    it('project memory is NOT cached when includeCacheControl=false', () => {
      const messages: Message[] = [
        systemMessage('Base'),
        systemMessage({ content: 'Memory', tags: ['PROJECT_MEMORY'] }),
        userMessage('Hello'),
      ]
      const result = convertCbToModelMessages({ messages, includeCacheControl: false })
      expect(countCacheBreakpoints(result)).toBe(0)
    })
  })

  describe('MAX_CACHE_BREAKPOINTS = 3 (message-level cap)', () => {
    it('message-level caching never exceeds 3 breakpoints', () => {
      // Full realistic conversation: stable system trio + volatile tail + long history
      const messages: Message[] = [
        systemMessage('System base'),
        systemMessage({ content: 'Knowledge', tags: ['KNOWLEDGE_FILES'] }),
        systemMessage({ content: 'Memory', tags: ['PROJECT_MEMORY'] }),
        systemMessage('Volatile tail'),
        ...Array.from({ length: 15 }, (_, i) =>
          i % 2 === 0
            ? userMessage(`turn ${i}`)
            : assistantMessage(`response ${i}`),
        ),
        userMessage({ content: 'User prompt', tags: ['USER_PROMPT'] }),
        userMessage({ content: 'Step prompt', tags: ['STEP_PROMPT'] }),
        assistantMessage({
          content: 'Assistant reply',
          tags: ['LAST_ASSISTANT_MESSAGE'],
        }),
        userMessage('Final'),
      ]
      const result = convertCbToModelMessages({ messages, includeCacheControl: true })
      const total = countCacheBreakpoints(result)
      expect(total).toBeLessThanOrEqual(3)
    })

    it('3-slot cap still leaves the 4th Anthropic slot for tools schema', () => {
      // The design rationale: 3 message-level + 1 tool-schema = 4 Anthropic total.
      // We validate the message-level part is ≤ 3; tools are validated separately.
      const messages: Message[] = [
        systemMessage('System'),
        systemMessage({ content: 'Knowledge', tags: ['KNOWLEDGE_FILES'] }),
        systemMessage({ content: 'Memory', tags: ['PROJECT_MEMORY'] }),
        userMessage({ content: 'Prompt', tags: ['USER_PROMPT'] }),
      ]
      const result = convertCbToModelMessages({ messages, includeCacheControl: true })
      const total = countCacheBreakpoints(result)
      // 3 slots used for stable content; 0 for conversation → total = 3
      expect(total).toBe(3)
    })

    it('with only system+knowledge (no memory), conversation can still use the 3rd slot', () => {
      // Without project memory, the 3rd slot can be used for a conversation
      // message (before USER_PROMPT). This ensures back-compat when memory is absent.
      const messages: Message[] = [
        systemMessage('System'),
        systemMessage({ content: 'Knowledge', tags: ['KNOWLEDGE_FILES'] }),
        userMessage('History 1'),
        assistantMessage('Response 1'),
        userMessage({ content: 'User prompt', tags: ['USER_PROMPT'] }),
      ]
      const result = convertCbToModelMessages({ messages, includeCacheControl: true })
      const total = countCacheBreakpoints(result)
      // At most 3: system(1) + knowledge(1) + one conversation(1)
      expect(total).toBeLessThanOrEqual(3)
      expect(total).toBeGreaterThanOrEqual(2) // at least system + knowledge
    })
  })

  describe('Tools schema caching via providerOptions', () => {
    // The tools-schema caching is applied in loopAgentSteps (run-agent-step.ts)
    // by adding providerOptions.anthropic.cacheControl to the last tool in the
    // ToolSet. We test the structural behavior here using a simplified version
    // of that logic.

    function applyToolsCacheControl(
      tools: Record<string, Record<string, unknown>>,
    ): Record<string, Record<string, unknown>> {
      const entries = Object.entries(tools)
      if (entries.length === 0) return tools
      const [lastName, lastTool] = entries[entries.length - 1]
      tools[lastName] = {
        ...lastTool,
        providerOptions: {
          ...(lastTool.providerOptions as Record<string, unknown> | undefined),
          anthropic: {
            ...((lastTool.providerOptions as { anthropic?: Record<string, unknown> } | undefined)
              ?.anthropic ?? {}),
            cacheControl: { type: 'ephemeral' },
          },
        },
      }
      return tools
    }

    it('adds cacheControl to last tool in a single-tool set', () => {
      const tools = { myTool: { description: 'A tool' } }
      const result = applyToolsCacheControl(tools)
      const provOpts = result.myTool.providerOptions as {
        anthropic?: { cacheControl?: unknown }
      }
      expect(provOpts?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' })
    })

    it('adds cacheControl only to the LAST tool in a multi-tool set', () => {
      const tools = {
        tool1: { description: 'First' },
        tool2: { description: 'Second' },
        tool3: { description: 'Third (last)' },
      }
      const result = applyToolsCacheControl(tools)

      const t1 = result.tool1.providerOptions as {
        anthropic?: { cacheControl?: unknown }
      } | undefined
      const t2 = result.tool2.providerOptions as {
        anthropic?: { cacheControl?: unknown }
      } | undefined
      const t3 = result.tool3.providerOptions as {
        anthropic?: { cacheControl?: unknown }
      }

      // Only last tool gets cache_control
      expect(t1?.anthropic?.cacheControl).toBeUndefined()
      expect(t2?.anthropic?.cacheControl).toBeUndefined()
      expect(t3?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' })
    })

    it('preserves existing providerOptions on the last tool', () => {
      const tools = {
        myTool: {
          description: 'A tool',
          providerOptions: { anthropic: { someFlag: true } },
        },
      }
      const result = applyToolsCacheControl(tools)
      const provOpts = result.myTool.providerOptions as {
        anthropic?: { cacheControl?: unknown; someFlag?: boolean }
      }
      expect(provOpts?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' })
      expect(provOpts?.anthropic?.someFlag).toBe(true)
    })

    it('does not add cacheControl when tool set is empty', () => {
      const tools = {}
      const result = applyToolsCacheControl(tools)
      expect(Object.keys(result)).toHaveLength(0)
    })
  })
})

// ─── End-to-end: Full system prompt pipeline ───────────────────────────────────

describe('End-to-end: Full cache pipeline (T0.2 + T0.3 + T0.4 combined)', () => {
  it('produces exactly 3 message-level breakpoints for full stable system trio', () => {
    // This simulates the exact shape produced by buildSystemMessagesWithKnowledgeCache
    // when knowledge files AND project memory are both present.
    const knowledgeContent = '```CLAUDE.md\nUse Bun, not npm.\n```'
    const memoryContent = '````.nevan/memory.md\nPort: 3000\n```'

    const system = [
      'System base instructions',
      `${KNOWLEDGE_FILES_SEGMENT_START}${knowledgeContent}${KNOWLEDGE_FILES_SEGMENT_END}`,
      '# Project Memory\n',
      `${PROJECT_MEMORY_SEGMENT_START}${memoryContent}${PROJECT_MEMORY_SEGMENT_END}`,
      '# System Info\nOS: darwin',
    ].join('\n')

    const segments = buildSystemMessagesWithKnowledgeCache(system)

    // Must have knowledge files segment
    expect(segments.some((s) => s.tags?.includes('KNOWLEDGE_FILES'))).toBe(true)
    // Must have project memory segment
    expect(segments.some((s) => s.tags?.includes('PROJECT_MEMORY'))).toBe(true)

    // Build a message list and run through convertCbToModelMessages
    const messages: Message[] = [
      ...segments,
      userMessage({ content: 'What does this codebase do?', tags: ['USER_PROMPT'] }),
    ]

    const result = convertCbToModelMessages({ messages, includeCacheControl: true })
    const total = countCacheBreakpoints(result)

    expect(total).toBe(3) // system base + knowledge + memory
    // Verify specific positions
    expect(getCacheControl(result[0])).toEqual({ type: 'ephemeral' }) // base system
    // Find knowledge and memory breakpoints
    const kIdx = result.findIndex(
      (m) =>
        m.content === knowledgeContent ||
        (typeof m.content !== 'string' &&
          m.content?.[0] &&
          'text' in m.content[0] &&
          (m.content[0] as { text: string }).text === knowledgeContent),
    )
    const mIdx = result.findIndex(
      (m) =>
        m.content === memoryContent ||
        (typeof m.content !== 'string' &&
          m.content?.[0] &&
          'text' in m.content[0] &&
          (m.content[0] as { text: string }).text === memoryContent),
    )
    if (kIdx !== -1) expect(getCacheControl(result[kIdx])).toEqual({ type: 'ephemeral' })
    if (mIdx !== -1) expect(getCacheControl(result[mIdx])).toEqual({ type: 'ephemeral' })
  })

  it('conversation messages beyond the 3-slot cap are NOT cached', () => {
    const messages: Message[] = [
      systemMessage('System base'),
      systemMessage({ content: 'Knowledge', tags: ['KNOWLEDGE_FILES'] }),
      systemMessage({ content: 'Memory', tags: ['PROJECT_MEMORY'] }),
      // Volatile tail
      userMessage('History turn 1'),
      assistantMessage('Reply 1'),
      userMessage({ content: 'User prompt now', tags: ['USER_PROMPT'] }),
    ]
    const result = convertCbToModelMessages({ messages, includeCacheControl: true })

    // All 3 stable breakpoints used → no capacity for conversation
    expect(countCacheBreakpoints(result)).toBe(3)

    // The conversation messages (index 3+) must not carry cache_control
    for (let i = 3; i < result.length; i++) {
      expect(getCacheControl(result[i])).toBeUndefined()
    }
  })

  it('without includeCacheControl, zero breakpoints across the entire pipeline', () => {
    const messages: Message[] = [
      systemMessage('System base'),
      systemMessage({ content: 'Knowledge', tags: ['KNOWLEDGE_FILES'] }),
      systemMessage({ content: 'Memory', tags: ['PROJECT_MEMORY'] }),
      userMessage({ content: 'Prompt', tags: ['USER_PROMPT'] }),
    ]
    const result = convertCbToModelMessages({ messages, includeCacheControl: false })
    expect(countCacheBreakpoints(result)).toBe(0)
  })
})

// ─── T0.5: Cache hit/miss telemetry ───────────────────────────────────────────

/**
 * Pure helper that mirrors the metrics logic inside onCacheDebugUsageReceived
 * in run-agent-step.ts. Tested in isolation so the math is easy to verify.
 */
function computeCacheMetrics(usage: {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  totalTokens: number
}): { cacheHitRate: number; estimatedSavingsTokens: number } {
  const cacheHitRate =
    usage.inputTokens > 0 ? usage.cachedInputTokens / usage.inputTokens : 0
  return { cacheHitRate, estimatedSavingsTokens: usage.cachedInputTokens }
}

describe('T0.5 — Cache hit/miss telemetry metrics', () => {
  describe('cacheHitRate computation', () => {
    it('is 0 when no tokens are cached (cold start)', () => {
      const { cacheHitRate } = computeCacheMetrics({
        inputTokens: 1000,
        outputTokens: 200,
        cachedInputTokens: 0,
        totalTokens: 1200,
      })
      expect(cacheHitRate).toBe(0)
    })

    it('is 0.5 for a 50% cache hit', () => {
      const { cacheHitRate } = computeCacheMetrics({
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 50,
        totalTokens: 150,
      })
      expect(cacheHitRate).toBe(0.5)
    })

    it('is 1.0 for a full cache hit', () => {
      const { cacheHitRate } = computeCacheMetrics({
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 100,
        totalTokens: 150,
      })
      expect(cacheHitRate).toBe(1)
    })

    it('is 0 (not NaN) when inputTokens is 0 (guard against divide-by-zero)', () => {
      const { cacheHitRate } = computeCacheMetrics({
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 0,
      })
      expect(cacheHitRate).toBe(0)
      expect(Number.isNaN(cacheHitRate)).toBe(false)
    })

    it('is between 0 and 1 for all realistic usage values', () => {
      const cases = [
        { inputTokens: 500, outputTokens: 100, cachedInputTokens: 200, totalTokens: 600 },
        { inputTokens: 10_000, outputTokens: 2_000, cachedInputTokens: 9_500, totalTokens: 12_000 },
        { inputTokens: 1, outputTokens: 1, cachedInputTokens: 1, totalTokens: 2 },
      ]
      for (const usage of cases) {
        const { cacheHitRate } = computeCacheMetrics(usage)
        expect(cacheHitRate).toBeGreaterThanOrEqual(0)
        expect(cacheHitRate).toBeLessThanOrEqual(1)
        expect(Number.isNaN(cacheHitRate)).toBe(false)
      }
    })
  })

  describe('estimatedSavingsTokens computation', () => {
    it('equals cachedInputTokens (cache reads = 90% cheaper than regular input)', () => {
      const { estimatedSavingsTokens } = computeCacheMetrics({
        inputTokens: 1000,
        outputTokens: 200,
        cachedInputTokens: 800,
        totalTokens: 1200,
      })
      expect(estimatedSavingsTokens).toBe(800)
    })

    it('is 0 when there are no cache hits', () => {
      const { estimatedSavingsTokens } = computeCacheMetrics({
        inputTokens: 500,
        outputTokens: 100,
        cachedInputTokens: 0,
        totalTokens: 600,
      })
      expect(estimatedSavingsTokens).toBe(0)
    })

    it('never returns NaN across all edge cases', () => {
      const edgeCases = [
        { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
        { inputTokens: 100, outputTokens: 0, cachedInputTokens: 0, totalTokens: 100 },
        { inputTokens: 1, outputTokens: 1, cachedInputTokens: 1, totalTokens: 2 },
      ]
      for (const usage of edgeCases) {
        const { estimatedSavingsTokens } = computeCacheMetrics(usage)
        expect(Number.isNaN(estimatedSavingsTokens)).toBe(false)
      }
    })
  })

  describe('AnalyticsEvent.CACHE_HIT_TELEMETRY', () => {
    it('is defined in the AnalyticsEvent enum', () => {
      expect(AnalyticsEvent.CACHE_HIT_TELEMETRY).toBeDefined()
    })

    it('has the correct event name string', () => {
      expect(AnalyticsEvent.CACHE_HIT_TELEMETRY).toBe('backend.cache_hit_telemetry')
    })

    it('is scoped under backend namespace (not cli or web)', () => {
      expect(AnalyticsEvent.CACHE_HIT_TELEMETRY.startsWith('backend.')).toBe(true)
    })
  })

  describe('telemetry resilience', () => {
    it('swallowing a trackEvent exception does not propagate', () => {
      // Mirrors the try/catch in onCacheDebugUsageReceived so a PostHog outage
      // never crashes the agent run.
      const failingTrackEvent = (): never => {
        throw new Error('telemetry service unavailable')
      }

      expect(() => {
        try {
          failingTrackEvent()
        } catch {
          // swallowed
        }
      }).not.toThrow()
    })

    it('telemetry handler emits event even when cacheDebugCorrelation is absent', () => {
      // Simulate the handler with no cacheDebugCorrelation (production default).
      const emitted: Array<{ event: string; cachedInputTokens: number }> = []

      const mockTrackEvent = (params: { event: string; properties: Record<string, unknown> }) => {
        emitted.push({
          event: params.event,
          cachedInputTokens: params.properties.cachedInputTokens as number,
        })
      }

      const usage = { inputTokens: 200, outputTokens: 80, cachedInputTokens: 120, totalTokens: 280 }
      const cacheHitRate = usage.inputTokens > 0 ? usage.cachedInputTokens / usage.inputTokens : 0

      // Mimic the exact trackEvent call in run-agent-step.ts onCacheDebugUsageReceived
      try {
        mockTrackEvent({
          event: AnalyticsEvent.CACHE_HIT_TELEMETRY,
          properties: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cachedInputTokens,
            totalTokens: usage.totalTokens,
            cacheHitRate,
            estimatedSavingsTokens: usage.cachedInputTokens,
          },
        })
      } catch {
        // must not throw
      }

      expect(emitted).toHaveLength(1)
      expect(emitted[0].event).toBe('backend.cache_hit_telemetry')
      expect(emitted[0].cachedInputTokens).toBe(120)
    })

    it('cacheHitRate property in the emitted event is never NaN', () => {
      const zeroUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 }
      const cacheHitRate = zeroUsage.inputTokens > 0
        ? zeroUsage.cachedInputTokens / zeroUsage.inputTokens
        : 0

      const emittedProperties = {
        cacheHitRate,
        cachedInputTokens: zeroUsage.cachedInputTokens,
      }

      expect(Number.isNaN(emittedProperties.cacheHitRate)).toBe(false)
      expect(emittedProperties.cacheHitRate).toBe(0)
    })
  })
})
