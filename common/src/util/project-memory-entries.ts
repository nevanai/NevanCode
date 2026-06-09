/**
 * Categorized + TTL-aware project memory entries.
 *
 * The on-disk format remains a plain Markdown file under `.nevan/memory.md`
 * so it stays human-editable. We layer structure on top by recognizing four
 * category headings and a small bullet metadata syntax. Anything that does
 * not match the structured format is preserved verbatim under "Notes" with
 * no TTL applied — this keeps legacy memory files working unchanged.
 *
 * Categories (T0.7):
 *   - user       — user role, preferences, knowledge
 *   - feedback   — corrections / confirmations on how to work
 *   - project    — ongoing initiatives, decisions, work in flight
 *   - reference  — pointers to external systems (Slack channels, dashboards)
 *
 * Auto-pruning (T0.6) is driven by:
 *   - per-category TTL (entries with an `addedAt` date older than the
 *     category's TTL are pruned). Reference + unclassified never expire.
 *   - relevance score (higher score = more durable). Used as a tiebreaker
 *     when evicting to fit the byte budget.
 *   - `pinned` marker bypasses TTL and byte-budget eviction entirely.
 */

export const MEMORY_CATEGORIES = [
  'user',
  'feedback',
  'project',
  'reference',
] as const

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number] | 'unclassified'

/**
 * TTL in days per category. `null` = never expire.
 * Tuned so that durable preferences (feedback) survive longest, ongoing
 * project state decays fastest, and external references never expire.
 */
export const MEMORY_CATEGORY_TTL_DAYS: Record<MemoryCategory, number | null> = {
  user: 90,
  feedback: 180,
  project: 30,
  reference: null,
  unclassified: null,
}

export type MemoryEntry = {
  category: MemoryCategory
  content: string
  /** ISO date string YYYY-MM-DD. Missing => no TTL applied. */
  addedAt?: string
  /** Default 1. Higher means "keep this longer when over budget". */
  score: number
  /** Pinned entries bypass TTL and byte-budget eviction. */
  pinned: boolean
}

export type ParsedProjectMemory = {
  /** Lines before the first `##` heading, preserved verbatim. */
  header: string
  entries: MemoryEntry[]
}

const DEFAULT_HEADER = [
  '# Project Memory',
  '',
  '<!-- Persistent memory for Nevan Code. Hand-editable. Auto-extended by the agent. -->',
  '',
].join('\n')

const CATEGORY_HEADING_PATTERN = /^##\s+(.+?)\s*$/
const BULLET_PATTERN = /^\s*[-*]\s+(.*\S)\s*$/
// Accept several separator styles for the date prefix so hand edits survive:
//   "- 2026-05-24 · content"
//   "- 2026-05-24 - content"
//   "- 2026-05-24 — content"
//   "- 2026-05-24: content"
const DATE_PREFIX_PATTERN = /^(\d{4}-\d{2}-\d{2})\s*(?:[·\-—:]\s+|\s+)(.*\S)\s*$/
const PINNED_SUFFIX_PATTERN = /\s*\[pinned\]\s*$/i
const SCORE_SUFFIX_PATTERN = /\s*\[score\s*:\s*(-?\d+)\]\s*$/i

function normalizeHeading(heading: string): MemoryCategory {
  const lower = heading.trim().toLowerCase()
  switch (lower) {
    case 'user':
    case 'user preferences':
    case 'user prefs':
      return 'user'
    case 'feedback':
    case 'feedback / corrections':
    case 'corrections':
      return 'feedback'
    case 'project':
    case 'project state':
    case 'projects':
      return 'project'
    case 'reference':
    case 'references':
    case 'pointers':
      return 'reference'
    default:
      return 'unclassified'
  }
}

function headingForCategory(category: MemoryCategory): string {
  switch (category) {
    case 'user':
      return '## User'
    case 'feedback':
      return '## Feedback'
    case 'project':
      return '## Project'
    case 'reference':
      return '## Reference'
    case 'unclassified':
      return '## Notes'
  }
}

/**
 * Parse a project memory file into a header + a flat list of entries.
 * Unknown lines / non-bullet content under a category heading are kept
 * as `unclassified` entries so we never silently lose data.
 */
export function parseProjectMemory(content: string): ParsedProjectMemory {
  const lines = content.split('\n')
  const headerLines: string[] = []
  const entries: MemoryEntry[] = []

  let currentCategory: MemoryCategory = 'unclassified'
  // The header ends as soon as we see either a category heading or the
  // first bullet line — so a legacy file like:
  //   # Project Memory
  //
  //   - port 5001
  // still parses its bullets as unclassified entries (no TTL applied)
  // rather than swallowing them into the header.
  let inBody = false

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    const headingMatch = line.match(CATEGORY_HEADING_PATTERN)
    if (headingMatch) {
      inBody = true
      currentCategory = normalizeHeading(headingMatch[1])
      continue
    }

    const bulletMatch = line.match(BULLET_PATTERN)
    if (bulletMatch) {
      inBody = true
      entries.push(parseBullet(bulletMatch[1], currentCategory))
      continue
    }

    if (!inBody) {
      headerLines.push(line)
      continue
    }

    // Free-form text in the body — preserve as an entry under the current
    // section so it round-trips without being silently dropped.
    const trimmed = line.trim()
    if (trimmed.length > 0) {
      entries.push({
        category: currentCategory,
        content: trimmed,
        score: 1,
        pinned: false,
      })
    }
  }

  const header = stripTrailingBlank(headerLines.join('\n'))
  return { header, entries }
}

function parseBullet(
  body: string,
  category: MemoryCategory,
): MemoryEntry {
  let remaining = body
  let pinned = false
  let score = 1

  const pinnedMatch = remaining.match(PINNED_SUFFIX_PATTERN)
  if (pinnedMatch) {
    pinned = true
    remaining = remaining.slice(0, pinnedMatch.index ?? 0).trimEnd()
  }

  const scoreMatch = remaining.match(SCORE_SUFFIX_PATTERN)
  if (scoreMatch) {
    const parsed = Number.parseInt(scoreMatch[1], 10)
    if (Number.isFinite(parsed)) score = parsed
    remaining = remaining.slice(0, scoreMatch.index ?? 0).trimEnd()
  }

  let addedAt: string | undefined
  const dateMatch = remaining.match(DATE_PREFIX_PATTERN)
  if (dateMatch) {
    addedAt = dateMatch[1]
    remaining = dateMatch[2].trim()
  }

  return {
    category,
    content: remaining,
    addedAt,
    score,
    pinned,
  }
}

/**
 * Render entries back to canonical Markdown, grouped by category in a stable
 * order. Empty categories are omitted. The provided header is preserved
 * verbatim — if it is empty we seed the default banner.
 */
export function renderProjectMemory(
  parsed: ParsedProjectMemory,
): string {
  const header =
    parsed.header.trim().length === 0 ? DEFAULT_HEADER : `${parsed.header}\n`

  const order: MemoryCategory[] = [
    'user',
    'feedback',
    'project',
    'reference',
    'unclassified',
  ]

  const sections: string[] = []
  for (const category of order) {
    const bucket = parsed.entries.filter((e) => e.category === category)
    if (bucket.length === 0) continue
    const heading = headingForCategory(category)
    const body = bucket.map(renderBullet).join('\n')
    sections.push(`${heading}\n${body}`)
  }

  if (sections.length === 0) {
    return header.trimEnd() + '\n'
  }

  return `${header}\n${sections.join('\n\n')}\n`
}

function renderBullet(entry: MemoryEntry): string {
  const parts: string[] = []
  if (entry.addedAt) parts.push(entry.addedAt, '·')
  parts.push(entry.content)
  if (entry.score !== 1) parts.push(`[score:${entry.score}]`)
  if (entry.pinned) parts.push('[pinned]')
  return `- ${parts.join(' ')}`
}

function stripTrailingBlank(s: string): string {
  return s.replace(/\n+$/, '')
}

/**
 * Light heuristic classifier for free-form bullets the agent might append
 * without an explicit category. Conservative: when in doubt returns
 * `unclassified` so a legacy fact is never demoted to a TTL bucket by
 * accident.
 */
export function inferMemoryCategory(content: string): MemoryCategory {
  const text = content.toLowerCase()
  // Reference: URLs or "see X" pointers
  if (
    /https?:\/\//.test(text) ||
    /\bslack\b|\bgrafana\b|\bdashboard\b|\blinear\b|\bnotion\b|\bjira\b/.test(
      text,
    )
  ) {
    return 'reference'
  }
  // Feedback: imperative / corrective phrasing
  if (
    /^(always|never|don'?t|stop|prefer|avoid|do not|make sure)\b/.test(text) ||
    /\buser (prefers|wants|said|asked)\b/.test(text)
  ) {
    return 'feedback'
  }
  // User: role / identity statements
  if (
    /\bthe user\b|\buser is\b|\bi am a\b|\bmy (role|job|team)\b/.test(text)
  ) {
    return 'user'
  }
  // Project: ongoing work / dates / milestones / deadlines
  if (
    /\b(milestone|deadline|sprint|release|launch|migration|in progress|wip|roadmap|m\d+\b)/.test(
      text,
    )
  ) {
    return 'project'
  }
  return 'unclassified'
}

export type PruneOptions = {
  now?: Date
  /** Override per-category TTLs (in days). `null` to disable a category's TTL. */
  ttlDaysByCategory?: Partial<Record<MemoryCategory, number | null>>
  /** Maximum bytes the rendered output may occupy. */
  maxBytes?: number
  /**
   * Run {@link dedupeEntries} as the first pass. Defaults to true — callers
   * can opt out for tests that need to verify raw TTL/budget behavior on
   * intentionally repeated content.
   */
  dedupe?: boolean
}

export type PruneReport = {
  expired: MemoryEntry[]
  evictedForBudget: MemoryEntry[]
  /** Entries collapsed into earlier duplicates (T0.8). */
  deduplicated: MemoryEntry[]
}

/**
 * Normalize a bullet's content for duplicate detection (T0.8).
 *   - lower-case
 *   - strip leading bullet markers + surrounding whitespace
 *   - drop trailing markdown punctuation
 *   - collapse internal whitespace to a single space
 *
 * The goal is to catch near-duplicates introduced by the agent rephrasing
 * the same fact ("uses bun, not npm" vs "Uses Bun, not npm.") without
 * over-collapsing genuinely distinct entries.
 */
export function normalizeMemoryContent(content: string): string {
  return content
    .replace(/^[-*]\s+/, '')
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[.,;!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export type DedupeReport = {
  /** Entries dropped because an earlier entry already covered them. */
  removed: MemoryEntry[]
}

/**
 * Collapse same-category duplicates while preserving the strongest signal
 * from each match. The "winner" of a merge keeps the higher score, the
 * OR of pinned flags, and the latest `addedAt` so the dedup pass never
 * weakens an entry the user has explicitly marked as durable.
 *
 * Cross-category duplicates are intentionally NOT merged — the same line of
 * text can mean different things under "user" vs "feedback" and we don't
 * want a heuristic re-categorization to silently delete data.
 */
export function dedupeEntries(entries: MemoryEntry[]): {
  kept: MemoryEntry[]
  report: DedupeReport
} {
  const seen = new Map<string, number>()
  const kept: MemoryEntry[] = []
  const removed: MemoryEntry[] = []

  for (const entry of entries) {
    const key = `${entry.category} ${normalizeMemoryContent(entry.content)}`
    if (key.endsWith(' ')) {
      // Empty normalized content — keep verbatim so we don't drop oddities.
      kept.push(entry)
      continue
    }
    const existingIdx = seen.get(key)
    if (existingIdx == null) {
      seen.set(key, kept.length)
      kept.push(entry)
      continue
    }
    const winner = mergeDuplicate(kept[existingIdx], entry)
    kept[existingIdx] = winner
    removed.push(entry)
  }

  return { kept, report: { removed } }
}

function mergeDuplicate(a: MemoryEntry, b: MemoryEntry): MemoryEntry {
  return {
    category: a.category,
    content: a.content,
    addedAt: pickLatestDate(a.addedAt, b.addedAt),
    score: Math.max(a.score, b.score),
    pinned: a.pinned || b.pinned,
  }
}

function pickLatestDate(a?: string, b?: string): string | undefined {
  if (!a) return b
  if (!b) return a
  return a >= b ? a : b
}

/**
 * Drop expired (TTL) and over-budget entries. Pinned entries are never
 * dropped. Eviction order when over budget:
 *   1. lowest score first
 *   2. then oldest `addedAt`
 *   3. then earliest array index (stable)
 */
export function pruneEntries(
  entries: MemoryEntry[],
  options: PruneOptions = {},
): { kept: MemoryEntry[]; report: PruneReport } {
  const now = options.now ?? new Date()
  const ttls = { ...MEMORY_CATEGORY_TTL_DAYS, ...(options.ttlDaysByCategory ?? {}) }

  const dedupeEnabled = options.dedupe !== false
  const { kept: deduped, report: dedupeReport } = dedupeEnabled
    ? dedupeEntries(entries)
    : { kept: entries, report: { removed: [] as MemoryEntry[] } }

  const expired: MemoryEntry[] = []
  const live: MemoryEntry[] = []
  for (const entry of deduped) {
    if (entry.pinned) {
      live.push(entry)
      continue
    }
    const ttl = ttls[entry.category]
    if (ttl == null || !entry.addedAt) {
      live.push(entry)
      continue
    }
    const ageDays = computeAgeDays(entry.addedAt, now)
    if (ageDays > ttl) {
      expired.push(entry)
    } else {
      live.push(entry)
    }
  }

  const evictedForBudget: MemoryEntry[] = []
  let kept = live
  const maxBytes = options.maxBytes
  if (maxBytes && maxBytes > 0) {
    while (renderedBytes(kept) > maxBytes) {
      const victimIndex = pickEvictionVictim(kept)
      if (victimIndex < 0) break
      evictedForBudget.push(kept[victimIndex])
      kept = kept.slice(0, victimIndex).concat(kept.slice(victimIndex + 1))
    }
  }

  return {
    kept,
    report: {
      expired,
      evictedForBudget,
      deduplicated: dedupeReport.removed,
    },
  }
}

function pickEvictionVictim(entries: MemoryEntry[]): number {
  let victim = -1
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.pinned) continue
    if (victim === -1) {
      victim = i
      continue
    }
    const cur = entries[victim]
    if (e.score < cur.score) {
      victim = i
      continue
    }
    if (e.score > cur.score) continue
    // Same score: prefer older entry (smaller addedAt) as victim.
    const eDate = e.addedAt ?? ''
    const curDate = cur.addedAt ?? ''
    if (eDate && curDate) {
      if (eDate < curDate) victim = i
    } else if (curDate && !eDate) {
      // Missing date sorts as "unknown age" — treat as droppable later than
      // a clearly-old entry. Keep the current dated victim.
    } else if (eDate && !curDate) {
      victim = i
    }
  }
  return victim
}

function renderedBytes(entries: MemoryEntry[]): number {
  const sample = renderProjectMemory({ header: '', entries })
  return Buffer.byteLength(sample, 'utf8')
}

function computeAgeDays(isoDate: string, now: Date): number {
  const parsed = parseIsoDate(isoDate)
  if (parsed == null) return 0
  const diffMs = now.getTime() - parsed.getTime()
  return diffMs / (1000 * 60 * 60 * 24)
}

function parseIsoDate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2]) - 1
  const day = Number(m[3])
  const date = new Date(Date.UTC(year, month, day))
  if (Number.isNaN(date.getTime())) return null
  return date
}

/**
 * Format today's date as YYYY-MM-DD in UTC. Centralized so tests can stub
 * via the optional `now` parameter.
 */
export function todayIsoDate(now: Date = new Date()): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
