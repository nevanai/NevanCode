import * as path from 'path'

import {
  dedupeEntries,
  inferMemoryCategory,
  parseProjectMemory,
  pruneEntries,
  renderProjectMemory,
  todayIsoDate,
  type MemoryCategory,
  type MemoryEntry,
  type PruneOptions,
} from './project-memory-entries'

import type { CodebuffFileSystem } from '../types/filesystem'
import type { Logger } from '../types/contracts/logger'

export const PROJECT_MEMORY_DIR = '.nevan'
export const PROJECT_MEMORY_FILE = 'memory.md'

// Rough cap to keep memory injection bounded. ~12KB ~= ~3000 tokens.
export const PROJECT_MEMORY_MAX_BYTES = 12_000

export function getProjectMemoryPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_MEMORY_DIR, PROJECT_MEMORY_FILE)
}

export function getProjectMemoryRelativePath(): string {
  return path.posix.join(PROJECT_MEMORY_DIR, PROJECT_MEMORY_FILE)
}

/**
 * Reads the project memory file if present.
 * Returns the file content (trimmed) or undefined when missing/unreadable.
 *
 * The on-disk file is never modified by this function — we filter
 * TTL-expired categorized entries in-memory only so the prompt stays lean
 * without surprising the user with disk writes on read. Writeback pruning
 * is the job of {@link pruneProjectMemoryFile}, which append routines call
 * after mutating the file.
 *
 * Falls back to byte-tail truncation only when the file is purely legacy
 * unstructured content (no recognized category sections); that preserves
 * the original behavior for hand-rolled memory files.
 */
export async function readProjectMemory(params: {
  projectRoot: string
  fs: CodebuffFileSystem
  logger?: Logger
  /** Override "now" for deterministic tests. */
  now?: Date
}): Promise<string | undefined> {
  const { projectRoot, fs, logger, now } = params
  const memoryPath = getProjectMemoryPath(projectRoot)
  let raw: string
  try {
    raw = await fs.readFile(memoryPath, 'utf8')
  } catch (error) {
    logger?.debug?.(
      { memoryPath, error: getErrorMessage(error) },
      'No project memory file (this is normal for fresh projects)',
    )
    return undefined
  }

  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined

  const parsed = parseProjectMemory(trimmed)
  const hasStructured = parsed.entries.some((e) => e.category !== 'unclassified')

  if (hasStructured) {
    const { kept } = pruneEntries(parsed.entries, {
      now,
      maxBytes: PROJECT_MEMORY_MAX_BYTES,
    })
    const rendered = renderProjectMemory({ header: parsed.header, entries: kept }).trim()
    return rendered.length === 0 ? undefined : rendered
  }

  // Legacy unstructured content: keep historical tail-truncation behavior.
  if (Buffer.byteLength(trimmed, 'utf8') <= PROJECT_MEMORY_MAX_BYTES) {
    return trimmed
  }
  return truncateMemoryToTail(trimmed, PROJECT_MEMORY_MAX_BYTES)
}

/**
 * Appends an entry to the project memory file, creating the .nevan/
 * directory if needed. Intended for tests and explicit user actions —
 * the agent normally edits memory via existing write_file/str_replace.
 */
export async function appendProjectMemory(params: {
  projectRoot: string
  entry: string
  fs: CodebuffFileSystem
  logger?: Logger
}): Promise<void> {
  const { projectRoot, entry, fs, logger } = params
  const memoryDir = path.join(projectRoot, PROJECT_MEMORY_DIR)
  const memoryPath = getProjectMemoryPath(projectRoot)

  try {
    await fs.mkdir(memoryDir, { recursive: true })
  } catch (error) {
    logger?.debug?.(
      { memoryDir, error: getErrorMessage(error) },
      'Failed to ensure project memory directory',
    )
  }

  let existing = ''
  try {
    existing = await fs.readFile(memoryPath, 'utf8')
  } catch {
    existing = ''
  }

  const header = existing.trim().length === 0 ? defaultMemoryHeader() : ''
  const newline = existing.endsWith('\n') || existing.length === 0 ? '' : '\n'
  const next = `${existing}${newline}${header}${entry.trim()}\n`
  await fs.writeFile(memoryPath, next, 'utf8')
}

/**
 * Append a structured memory entry under the appropriate category section.
 * If the file already contains structured sections, the new entry is merged
 * into the right bucket. Otherwise the legacy header + body is preserved
 * and a fresh structured layout is added below it.
 *
 * When `category` is omitted we run a conservative heuristic — unknown
 * content falls back to "unclassified" which has no TTL applied.
 *
 * Deduplication (T0.8): if a same-category entry with equivalent normalized
 * content already exists, the new payload is merged into it (keeping the
 * stronger pinned/score and the latest addedAt) instead of writing a second
 * row. The returned `deduplicated` flag lets callers surface that to
 * telemetry / the user.
 */
export async function appendProjectMemoryEntry(params: {
  projectRoot: string
  content: string
  category?: MemoryCategory
  pinned?: boolean
  score?: number
  fs: CodebuffFileSystem
  logger?: Logger
  /** Override "now" for deterministic tests. */
  now?: Date
}): Promise<{ deduplicated: boolean }> {
  const {
    projectRoot,
    content,
    category,
    pinned = false,
    score = 1,
    fs,
    logger,
    now,
  } = params

  const trimmedContent = content.trim().replace(/^[-*]\s+/, '')
  if (trimmedContent.length === 0) return { deduplicated: false }

  const memoryDir = path.join(projectRoot, PROJECT_MEMORY_DIR)
  const memoryPath = getProjectMemoryPath(projectRoot)

  try {
    await fs.mkdir(memoryDir, { recursive: true })
  } catch (error) {
    logger?.debug?.(
      { memoryDir, error: getErrorMessage(error) },
      'Failed to ensure project memory directory',
    )
  }

  let existing = ''
  try {
    existing = await fs.readFile(memoryPath, 'utf8')
  } catch {
    existing = ''
  }

  const parsed = parseProjectMemory(existing)
  const resolvedCategory: MemoryCategory =
    category ?? inferMemoryCategory(trimmedContent)
  const entry: MemoryEntry = {
    category: resolvedCategory,
    content: trimmedContent,
    addedAt: todayIsoDate(now),
    score,
    pinned,
  }

  const combined = [...parsed.entries, entry]
  const { kept: deduped, report: dedupeReport } = dedupeEntries(combined)
  const wasDeduplicated = dedupeReport.removed.length > 0

  if (wasDeduplicated) {
    logger?.debug?.(
      {
        category: resolvedCategory,
        normalizedDuplicates: dedupeReport.removed.length,
      },
      'project-memory: merged incoming entry with existing duplicate',
    )
  }

  const { kept } = pruneEntries(deduped, {
    now,
    maxBytes: PROJECT_MEMORY_MAX_BYTES,
    // Already deduped above; skip the second pass for clarity + perf.
    dedupe: false,
  })

  const header = parsed.header.trim().length === 0 ? defaultMemoryHeader().trimEnd() : parsed.header
  const rendered = renderProjectMemory({ header, entries: kept })
  await fs.writeFile(memoryPath, rendered, 'utf8')

  return { deduplicated: wasDeduplicated }
}

/**
 * Force a prune pass on the on-disk memory file. Drops TTL-expired entries
 * and evicts low-score entries until the rendered output fits inside
 * `PROJECT_MEMORY_MAX_BYTES`. Pinned entries are never touched.
 *
 * Returns the post-prune entry count plus a report of what was dropped, so
 * the runtime can surface a single line of telemetry without re-reading.
 */
export async function pruneProjectMemoryFile(params: {
  projectRoot: string
  fs: CodebuffFileSystem
  logger?: Logger
  now?: Date
  options?: Omit<PruneOptions, 'now' | 'maxBytes'>
}): Promise<{
  kept: number
  expired: number
  evictedForBudget: number
  deduplicated: number
}> {
  const { projectRoot, fs, logger, now, options } = params
  const memoryPath = getProjectMemoryPath(projectRoot)

  let raw = ''
  try {
    raw = await fs.readFile(memoryPath, 'utf8')
  } catch (error) {
    logger?.debug?.(
      { memoryPath, error: getErrorMessage(error) },
      'pruneProjectMemoryFile: no memory file present',
    )
    return { kept: 0, expired: 0, evictedForBudget: 0, deduplicated: 0 }
  }

  const parsed = parseProjectMemory(raw)
  const { kept, report } = pruneEntries(parsed.entries, {
    ...(options ?? {}),
    now,
    maxBytes: PROJECT_MEMORY_MAX_BYTES,
  })

  if (
    report.expired.length === 0 &&
    report.evictedForBudget.length === 0 &&
    report.deduplicated.length === 0
  ) {
    return {
      kept: kept.length,
      expired: 0,
      evictedForBudget: 0,
      deduplicated: 0,
    }
  }

  const header = parsed.header.trim().length === 0 ? defaultMemoryHeader().trimEnd() : parsed.header
  const rendered = renderProjectMemory({ header, entries: kept })
  await fs.writeFile(memoryPath, rendered, 'utf8')

  return {
    kept: kept.length,
    expired: report.expired.length,
    evictedForBudget: report.evictedForBudget.length,
    deduplicated: report.deduplicated.length,
  }
}

function defaultMemoryHeader(): string {
  return [
    '# Project Memory',
    '',
    '<!-- Persistent memory for Nevan Code. Hand-editable. Auto-extended by the agent. -->',
    '',
  ].join('\n')
}

function truncateMemoryToTail(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, 'utf8')
  if (buf.byteLength <= maxBytes) return content
  const tail = buf.subarray(buf.byteLength - maxBytes).toString('utf8')
  const firstNewline = tail.indexOf('\n')
  const aligned = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail
  return `<!-- earlier memory truncated for context budget -->\n${aligned.trim()}`
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}
