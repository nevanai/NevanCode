import { describe, expect, it } from 'bun:test'

import {
  MEMORY_CATEGORY_TTL_DAYS,
  dedupeEntries,
  inferMemoryCategory,
  normalizeMemoryContent,
  parseProjectMemory,
  pruneEntries,
  renderProjectMemory,
  todayIsoDate,
  type MemoryEntry,
} from '../project-memory-entries'

describe('project-memory-entries — parser', () => {
  it('parses a fully-categorized file into typed entries', () => {
    const md = [
      '# Project Memory',
      '',
      '<!-- banner -->',
      '',
      '## User',
      '- 2026-05-24 · prefers bun over npm',
      '',
      '## Feedback',
      '- 2026-04-20 · always run tests before merge [pinned]',
      '',
      '## Project',
      '- 2026-05-23 · M0 quick wins in progress [score:3]',
      '',
      '## Reference',
      '- 2026-05-10 · Slack #nevan-eng for triage',
      '',
    ].join('\n')

    const parsed = parseProjectMemory(md)

    expect(parsed.header).toContain('# Project Memory')
    expect(parsed.header).toContain('<!-- banner -->')
    expect(parsed.entries).toHaveLength(4)

    const byCategory = Object.fromEntries(
      parsed.entries.map((e) => [e.category, e]),
    ) as Record<string, MemoryEntry>

    expect(byCategory.user.content).toBe('prefers bun over npm')
    expect(byCategory.user.addedAt).toBe('2026-05-24')
    expect(byCategory.user.score).toBe(1)
    expect(byCategory.user.pinned).toBe(false)

    expect(byCategory.feedback.pinned).toBe(true)
    expect(byCategory.feedback.content).toBe('always run tests before merge')

    expect(byCategory.project.score).toBe(3)
    expect(byCategory.project.content).toBe('M0 quick wins in progress')

    expect(byCategory.reference.addedAt).toBe('2026-05-10')
  })

  it('treats legacy unstructured bullets as unclassified', () => {
    const md = [
      '# Project Memory',
      '',
      '- runs on port 5001 (frontend)',
      '- use bun, not npm',
    ].join('\n')

    const parsed = parseProjectMemory(md)

    expect(parsed.entries.every((e) => e.category === 'unclassified')).toBe(true)
    expect(parsed.entries.map((e) => e.content)).toEqual([
      'runs on port 5001 (frontend)',
      'use bun, not npm',
    ])
    expect(parsed.entries.every((e) => e.addedAt === undefined)).toBe(true)
  })

  it('accepts alternative date separators (`-`, `—`, `:`)', () => {
    const md = [
      '## Project',
      '- 2026-05-24 - dash separator',
      '- 2026-05-24 — emdash separator',
      '- 2026-05-24: colon separator',
      '- 2026-05-24 plain space separator',
    ].join('\n')
    const parsed = parseProjectMemory(md)
    expect(parsed.entries).toHaveLength(4)
    expect(parsed.entries.map((e) => e.addedAt)).toEqual([
      '2026-05-24',
      '2026-05-24',
      '2026-05-24',
      '2026-05-24',
    ])
    expect(parsed.entries.map((e) => e.content)).toEqual([
      'dash separator',
      'emdash separator',
      'colon separator',
      'plain space separator',
    ])
  })

  it('preserves unknown headings as unclassified entries', () => {
    const md = [
      '# Project Memory',
      '',
      '## Random Section',
      '- legacy bullet 1',
      '- legacy bullet 2',
    ].join('\n')

    const parsed = parseProjectMemory(md)
    expect(parsed.entries.every((e) => e.category === 'unclassified')).toBe(true)
    expect(parsed.entries.map((e) => e.content)).toEqual([
      'legacy bullet 1',
      'legacy bullet 2',
    ])
  })

  it('round-trips: parse → render preserves entries', () => {
    const md = [
      '# Project Memory',
      '',
      '## User',
      '- 2026-05-24 · bun, not npm',
      '',
      '## Feedback',
      '- 2026-05-20 · be terse [pinned]',
      '',
      '## Project',
      '- 2026-05-22 · M0 in progress [score:2]',
      '',
    ].join('\n')

    const parsed = parseProjectMemory(md)
    const rendered = renderProjectMemory(parsed)
    const reparsed = parseProjectMemory(rendered)

    expect(reparsed.entries).toEqual(parsed.entries)
  })
})

describe('project-memory-entries — render', () => {
  it('groups entries in canonical category order, omitting empty buckets', () => {
    const rendered = renderProjectMemory({
      header: '# Project Memory',
      entries: [
        {
          category: 'project',
          content: 'M0 wip',
          addedAt: '2026-05-24',
          score: 1,
          pinned: false,
        },
        {
          category: 'user',
          content: 'uses bun',
          addedAt: '2026-05-24',
          score: 1,
          pinned: false,
        },
      ],
    })

    const userIdx = rendered.indexOf('## User')
    const projectIdx = rendered.indexOf('## Project')
    const feedbackIdx = rendered.indexOf('## Feedback')

    expect(userIdx).toBeGreaterThan(-1)
    expect(projectIdx).toBeGreaterThan(userIdx)
    expect(feedbackIdx).toBe(-1)
  })

  it('renders score/pinned markers only when non-default', () => {
    const rendered = renderProjectMemory({
      header: '# Project Memory',
      entries: [
        {
          category: 'user',
          content: 'default',
          addedAt: '2026-05-24',
          score: 1,
          pinned: false,
        },
        {
          category: 'user',
          content: 'pinned only',
          addedAt: '2026-05-24',
          score: 1,
          pinned: true,
        },
        {
          category: 'user',
          content: 'scored only',
          addedAt: '2026-05-24',
          score: 5,
          pinned: false,
        },
      ],
    })

    expect(rendered).toContain('- 2026-05-24 · default')
    expect(rendered).not.toContain('default [pinned]')
    expect(rendered).not.toContain('default [score:')
    expect(rendered).toContain('pinned only [pinned]')
    expect(rendered).toContain('scored only [score:5]')
  })
})

describe('project-memory-entries — pruneEntries (T0.6)', () => {
  const now = new Date('2026-05-24T12:00:00Z')

  const make = (overrides: Partial<MemoryEntry>): MemoryEntry => ({
    category: 'user',
    content: 'x',
    score: 1,
    pinned: false,
    ...overrides,
  })

  it('drops entries whose category TTL has elapsed', () => {
    const projectTtl = MEMORY_CATEGORY_TTL_DAYS.project as number
    const userTtl = MEMORY_CATEGORY_TTL_DAYS.user as number
    expect(projectTtl).toBe(30)

    const entries: MemoryEntry[] = [
      // Project entries: 31d old (drop), 5d old (keep)
      make({
        category: 'project',
        content: 'old project',
        addedAt: '2026-04-22',
      }),
      make({
        category: 'project',
        content: 'fresh project',
        addedAt: '2026-05-19',
      }),
      // User entry: 100d old → over 90d TTL (drop)
      make({
        category: 'user',
        content: 'old user',
        addedAt: '2026-02-13',
      }),
      // User entry: 60d old → within 90d TTL (keep)
      make({
        category: 'user',
        content: 'recent user',
        addedAt: '2026-03-25',
      }),
    ]

    const { kept, report } = pruneEntries(entries, { now })

    const keptContents = kept.map((e) => e.content)
    expect(keptContents).toContain('fresh project')
    expect(keptContents).toContain('recent user')
    expect(keptContents).not.toContain('old project')
    expect(keptContents).not.toContain('old user')
    expect(report.expired.map((e) => e.content).sort()).toEqual([
      'old project',
      'old user',
    ])

    // Sanity: confirmed userTtl applied
    expect(userTtl).toBe(90)
  })

  it('respects pinned entries even past TTL', () => {
    const entries: MemoryEntry[] = [
      make({
        category: 'project',
        content: 'ancient but pinned',
        addedAt: '2024-01-01',
        pinned: true,
      }),
    ]
    const { kept, report } = pruneEntries(entries, { now })
    expect(kept).toHaveLength(1)
    expect(report.expired).toHaveLength(0)
  })

  it('never expires reference entries (no TTL)', () => {
    const entries: MemoryEntry[] = [
      make({
        category: 'reference',
        content: 'Slack #nevan',
        addedAt: '2023-01-01',
      }),
    ]
    const { kept, report } = pruneEntries(entries, { now })
    expect(kept).toHaveLength(1)
    expect(report.expired).toHaveLength(0)
  })

  it('never expires entries without addedAt (legacy bullets)', () => {
    const entries: MemoryEntry[] = [
      make({
        category: 'user',
        content: 'legacy without date',
        addedAt: undefined,
      }),
    ]
    const { kept, report } = pruneEntries(entries, { now })
    expect(kept).toHaveLength(1)
    expect(report.expired).toHaveLength(0)
  })

  it('evicts by lowest score first when over byte budget', () => {
    // With the default banner header (~106B) + section heading + bullets,
    // 3 entries render to ~238 bytes and 2 entries (high + pinned) to ~191B.
    // maxBytes=225 forces exactly one eviction.
    const entries: MemoryEntry[] = [
      make({ content: 'low score keeper', score: 1, addedAt: '2026-05-20' }),
      make({ content: 'high score keeper', score: 10, addedAt: '2026-05-20' }),
      make({ content: 'pinned no matter what', pinned: true, score: 1, addedAt: '2026-05-20' }),
    ]

    const { kept, report } = pruneEntries(entries, {
      now,
      maxBytes: 225,
    })

    const keptContents = kept.map((e) => e.content)
    expect(keptContents).toContain('pinned no matter what')
    expect(keptContents).toContain('high score keeper')
    expect(keptContents).not.toContain('low score keeper')
    expect(report.evictedForBudget.map((e) => e.content)).toEqual([
      'low score keeper',
    ])
  })

  it('uses age as tiebreaker when scores are equal', () => {
    // 3 entries render to ~180B, 2 entries to ~157B with the default header.
    // maxBytes=170 forces eviction of the single oldest entry.
    const entries: MemoryEntry[] = [
      make({ content: 'newer', score: 1, addedAt: '2026-05-20' }),
      make({ content: 'older', score: 1, addedAt: '2026-05-01' }),
      make({ content: 'newest', score: 1, addedAt: '2026-05-23' }),
    ]

    const { kept, report } = pruneEntries(entries, {
      now,
      maxBytes: 170,
    })

    // Should evict "older" first, in order of age, until under budget.
    expect(report.evictedForBudget.map((e) => e.content)).toContain('older')
    expect(kept.map((e) => e.content)).toContain('newest')
    expect(kept.map((e) => e.content)).toContain('newer')
  })

  it('returns an empty kept list when all entries are expired and none pinned', () => {
    const entries: MemoryEntry[] = [
      make({
        category: 'project',
        content: 'old',
        addedAt: '2025-01-01',
      }),
    ]
    const { kept, report } = pruneEntries(entries, { now })
    expect(kept).toHaveLength(0)
    expect(report.expired).toHaveLength(1)
  })
})

describe('project-memory-entries — inferMemoryCategory', () => {
  it('classifies URL-bearing bullets as reference', () => {
    expect(inferMemoryCategory('see https://internal/dash')).toBe('reference')
    expect(inferMemoryCategory('Slack #engineering is the eng channel')).toBe(
      'reference',
    )
    expect(inferMemoryCategory('grafana board is at internal/lat')).toBe(
      'reference',
    )
  })

  it('classifies imperative phrasing as feedback', () => {
    expect(inferMemoryCategory('always run bun test before merge')).toBe(
      'feedback',
    )
    expect(inferMemoryCategory("don't mock the database in tests")).toBe(
      'feedback',
    )
    expect(inferMemoryCategory('prefer typescript-eslint over jshint')).toBe(
      'feedback',
    )
  })

  it('classifies role / identity statements as user', () => {
    expect(inferMemoryCategory('the user is a backend engineer')).toBe('user')
    expect(inferMemoryCategory('I am a data scientist on the ranking team')).toBe(
      'user',
    )
  })

  it('classifies milestone/launch wording as project', () => {
    expect(inferMemoryCategory('M0 quick wins in progress')).toBe('project')
    expect(inferMemoryCategory('hermes migration WIP')).toBe('project')
    expect(inferMemoryCategory('release deadline next sprint')).toBe('project')
  })

  it('falls back to unclassified for ambiguous content', () => {
    expect(inferMemoryCategory('blue is a nice color')).toBe('unclassified')
    expect(inferMemoryCategory('42')).toBe('unclassified')
  })
})

describe('project-memory-entries — dedupeEntries (T0.8)', () => {
  const make = (overrides: Partial<MemoryEntry>): MemoryEntry => ({
    category: 'user',
    content: 'x',
    score: 1,
    pinned: false,
    ...overrides,
  })

  it('collapses normalized-equivalent same-category entries', () => {
    const entries: MemoryEntry[] = [
      make({ content: 'uses bun, not npm', addedAt: '2026-05-01' }),
      make({ content: 'Uses Bun, not npm.', addedAt: '2026-05-15' }),
      make({ content: 'uses   bun,   not   npm', addedAt: '2026-05-20' }),
    ]

    const { kept, report } = dedupeEntries(entries)

    expect(kept).toHaveLength(1)
    expect(kept[0].content).toBe('uses bun, not npm')
    // Latest addedAt wins.
    expect(kept[0].addedAt).toBe('2026-05-20')
    expect(report.removed).toHaveLength(2)
  })

  it('does NOT merge across categories', () => {
    const entries: MemoryEntry[] = [
      make({ category: 'user', content: 'bun, not npm' }),
      make({ category: 'feedback', content: 'bun, not npm' }),
    ]

    const { kept, report } = dedupeEntries(entries)
    expect(kept).toHaveLength(2)
    expect(report.removed).toHaveLength(0)
  })

  it('takes max score and OR of pinned across duplicates', () => {
    const entries: MemoryEntry[] = [
      make({ content: 'fact', score: 1, pinned: false, addedAt: '2026-05-01' }),
      make({ content: 'Fact.', score: 5, pinned: false, addedAt: '2026-05-02' }),
      make({ content: 'fact', score: 2, pinned: true, addedAt: '2026-05-03' }),
    ]

    const { kept } = dedupeEntries(entries)
    expect(kept).toHaveLength(1)
    expect(kept[0].score).toBe(5)
    expect(kept[0].pinned).toBe(true)
    expect(kept[0].addedAt).toBe('2026-05-03')
  })

  it('is order-independent for the winning content (first-seen wins)', () => {
    const a = make({ content: 'Original Casing', addedAt: '2026-05-01' })
    const b = make({ content: 'original casing', addedAt: '2026-05-02' })

    const ab = dedupeEntries([a, b]).kept
    const ba = dedupeEntries([b, a]).kept

    expect(ab).toHaveLength(1)
    expect(ba).toHaveLength(1)
    expect(ab[0].content).toBe('Original Casing')
    expect(ba[0].content).toBe('original casing')
  })

  it('pruneEntries.report exposes the dedup count', () => {
    const entries: MemoryEntry[] = [
      make({ content: 'same', score: 1, addedAt: '2026-05-20' }),
      make({ content: 'Same', score: 1, addedAt: '2026-05-21' }),
    ]
    const { kept, report } = pruneEntries(entries, {
      now: new Date('2026-05-24T00:00:00Z'),
    })
    expect(kept).toHaveLength(1)
    expect(report.deduplicated).toHaveLength(1)
  })

  it('pruneEntries can opt out of dedup', () => {
    const entries: MemoryEntry[] = [
      make({ content: 'same', addedAt: '2026-05-20' }),
      make({ content: 'Same', addedAt: '2026-05-21' }),
    ]
    const { kept, report } = pruneEntries(entries, {
      now: new Date('2026-05-24T00:00:00Z'),
      dedupe: false,
    })
    expect(kept).toHaveLength(2)
    expect(report.deduplicated).toHaveLength(0)
  })
})

describe('normalizeMemoryContent (T0.8)', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeMemoryContent('Hello   World')).toBe('hello world')
  })

  it('strips trailing punctuation and markdown markers', () => {
    expect(normalizeMemoryContent('use `bun`, not npm!')).toBe(
      'use bun, not npm',
    )
  })

  it('strips a leading bullet marker', () => {
    expect(normalizeMemoryContent('- already a bullet')).toBe(
      'already a bullet',
    )
    expect(normalizeMemoryContent('* asterisk bullet')).toBe('asterisk bullet')
  })

  it('treats genuinely distinct strings as distinct', () => {
    expect(normalizeMemoryContent('runs on port 5001')).not.toBe(
      normalizeMemoryContent('runs on port 8080'),
    )
  })
})

describe('todayIsoDate', () => {
  it('formats YYYY-MM-DD from a Date in UTC', () => {
    expect(todayIsoDate(new Date('2026-05-24T23:59:00Z'))).toBe('2026-05-24')
    expect(todayIsoDate(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01')
  })
})
