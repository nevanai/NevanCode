import { promises as fs } from 'fs'
import * as path from 'path'

import {
  DEFAULT_CURATION_MAX_FILES,
  DEFAULT_CURATION_MAX_TOKENS,
  DEFAULT_CURATION_THRESHOLD,
  DEFAULT_CURATION_TOPK,
  DEFAULT_LARGE_FILE_LINES,
  MAX_SECTION_WINDOWS,
  MAX_SECTIONS_PER_FILE,
  SECTION_STRIDE_LINES,
  SECTION_WINDOW_LINES,
} from './config'
import { estimateTokens, estimateTokensFromBytes } from './tokens'

import type { Embedder } from './embedder'

/**
 * The slice of SemanticStore the curator needs. Declared structurally so the
 * curator can be unit-tested against the real store or a fake.
 */
export interface CuratorStore {
  search(
    vector: Float32Array,
    topK: number,
  ): Array<{ path: string; score: number; language: string; numLines: number }>
  getFile(relPath: string):
    | {
        path: string
        size: number
        numLines: number
        language: string
      }
    | undefined
}

export interface CuratorDeps {
  store: CuratorStore
  embedder: Embedder
  projectRoot: string
}

export interface CurateOptions {
  /** Minimum relevance (max(0,cosine)) a file must reach to be included. */
  threshold?: number
  /** Candidates pulled from the index before threshold filtering. */
  topK?: number
  /** Hard cap on files included. */
  maxFiles?: number
  /** Token budget for the whole curated context. */
  maxTokens?: number
  /** Files with more lines than this get section-extracted rather than whole. */
  largeFileLines?: number
  /**
   * Compute the "inject every retrieved candidate whole" baseline so the
   * reduction ratio is populated. Off by default because it isn't needed on
   * the live injection path (only for --debug and the T1.18 measurement).
   */
  computeBaseline?: boolean
  /** Populate `debug` with a row per candidate (included + rejected). */
  debug?: boolean
}

export interface CuratedSection {
  /** 1-based inclusive start line. */
  startLine: number
  /** 1-based inclusive end line. */
  endLine: number
  text: string
  relevance: number
}

export interface CuratedFile {
  path: string
  language: string
  numLines: number
  /** File-level relevance: max(0, cosine) of the query vs the file embedding. */
  relevance: number
  /** Raw cosine similarity in [-1, 1]. */
  cosine: number
  /** Whole-file text (small files). Mutually exclusive with `sections`. */
  content?: string
  /** Extracted relevant sections (large files). */
  sections?: CuratedSection[]
  /** Estimated tokens of what we actually include for this file. */
  tokens: number
}

export type CurationRejectReason =
  | 'included'
  | 'below-threshold'
  | 'max-files'
  | 'token-budget'
  | 'missing-on-disk'

export interface CurationDebugEntry {
  path: string
  cosine: number
  relevance: number
  included: boolean
  reason: CurationRejectReason
}

export interface CuratedContext {
  query: string
  files: CuratedFile[]
  /** Estimated tokens actually included across all files. */
  includedTokens: number
  /**
   * Estimated tokens if every retrieved candidate were injected whole — the
   * honest "no curation" baseline for this query. 0 when not computed.
   */
  baselineTokens: number
  /** (baseline − included) / baseline, in [0, 1]. 0 when baseline is 0. */
  reductionRatio: number
  embedMs: number
  searchMs: number
  /** Total candidates retrieved from the index before filtering. */
  candidateCount: number
  debug?: CurationDebugEntry[]
}

/** Dot product of two equal-length vectors. */
function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/** cosine → relevance: clamp the unused negative range to 0, keep it interpretable. */
function toRelevance(cosine: number): number {
  return cosine > 0 ? (cosine > 1 ? 1 : cosine) : 0
}

/**
 * Smart Context Curation (PRD Feature 3).
 *
 * Given a natural-language query, embeds it (T1.13), scores every candidate
 * file by cosine relevance (T1.14), keeps only those above a configurable
 * threshold (T1.15), and for large files pulls just the most relevant line
 * ranges instead of the whole file (T1.16). The result reports per-file
 * relevance scores (T1.17 debug) and an estimated token reduction versus
 * injecting every candidate whole (T1.18).
 */
export class ContextCurator {
  private readonly store: CuratorStore
  private readonly embedder: Embedder
  private readonly projectRoot: string

  constructor(deps: CuratorDeps) {
    this.store = deps.store
    this.embedder = deps.embedder
    this.projectRoot = deps.projectRoot
  }

  async curate(query: string, options: CurateOptions = {}): Promise<CuratedContext> {
    const threshold = options.threshold ?? DEFAULT_CURATION_THRESHOLD
    const topK = options.topK ?? DEFAULT_CURATION_TOPK
    const maxFiles = options.maxFiles ?? DEFAULT_CURATION_MAX_FILES
    const maxTokens = options.maxTokens ?? DEFAULT_CURATION_MAX_TOKENS
    const largeFileLines = options.largeFileLines ?? DEFAULT_LARGE_FILE_LINES

    const trimmed = query.trim()
    if (!trimmed) {
      return {
        query,
        files: [],
        includedTokens: 0,
        baselineTokens: 0,
        reductionRatio: 0,
        embedMs: 0,
        searchMs: 0,
        candidateCount: 0,
        ...(options.debug ? { debug: [] } : {}),
      }
    }

    // T1.13 — query → embedding vector.
    const embedStart = Date.now()
    const [qVec] = await this.embedder.embed([trimmed])
    const embedMs = Date.now() - embedStart

    // Retrieve nearest candidates from the vector index.
    const searchStart = Date.now()
    const candidates = this.store.search(qVec, topK)
    const searchMs = Date.now() - searchStart

    // T1.14 — relevance per candidate, ranked.
    const ranked = candidates
      .map((c) => ({ ...c, relevance: toRelevance(c.score) }))
      .sort((a, b) => b.relevance - a.relevance)

    // T1.18 — baseline: inject every retrieved candidate whole.
    let baselineTokens = 0
    if (options.computeBaseline) {
      for (const c of ranked) {
        const meta = this.store.getFile(c.path)
        if (meta) baselineTokens += estimateTokensFromBytes(meta.size)
      }
    }

    const files: CuratedFile[] = []
    const debug: CurationDebugEntry[] = []
    let includedTokens = 0
    const windowBudget = { remaining: MAX_SECTION_WINDOWS }

    for (const c of ranked) {
      // T1.15 — threshold filter.
      if (c.relevance < threshold) {
        if (options.debug) {
          debug.push({
            path: c.path,
            cosine: c.score,
            relevance: c.relevance,
            included: false,
            reason: 'below-threshold',
          })
        }
        continue
      }
      if (files.length >= maxFiles) {
        if (options.debug) {
          debug.push({
            path: c.path,
            cosine: c.score,
            relevance: c.relevance,
            included: false,
            reason: 'max-files',
          })
        }
        continue
      }

      const built = await this.buildFile(c, qVec, threshold, largeFileLines, windowBudget)
      if (!built) {
        if (options.debug) {
          debug.push({
            path: c.path,
            cosine: c.score,
            relevance: c.relevance,
            included: false,
            reason: 'missing-on-disk',
          })
        }
        continue
      }

      // Token budget: never blow past maxTokens. Always allow the very first
      // (most relevant) file even if it alone exceeds the budget — sending the
      // single best file is better than sending nothing.
      if (includedTokens + built.tokens > maxTokens && files.length > 0) {
        if (options.debug) {
          debug.push({
            path: c.path,
            cosine: c.score,
            relevance: c.relevance,
            included: false,
            reason: 'token-budget',
          })
        }
        continue
      }

      files.push(built)
      includedTokens += built.tokens
      if (options.debug) {
        debug.push({
          path: c.path,
          cosine: c.score,
          relevance: c.relevance,
          included: true,
          reason: 'included',
        })
      }
    }

    const reductionRatio =
      baselineTokens > 0
        ? Math.max(0, (baselineTokens - includedTokens) / baselineTokens)
        : 0

    return {
      query,
      files,
      includedTokens,
      baselineTokens,
      reductionRatio,
      embedMs,
      searchMs,
      candidateCount: candidates.length,
      ...(options.debug ? { debug } : {}),
    }
  }

  /** Build a CuratedFile (whole-file or section-extracted), or null if unreadable. */
  private async buildFile(
    candidate: { path: string; score: number; relevance: number; language: string; numLines: number },
    qVec: Float32Array,
    threshold: number,
    largeFileLines: number,
    windowBudget: { remaining: number },
  ): Promise<CuratedFile | null> {
    let source: string
    try {
      source = await fs.readFile(path.join(this.projectRoot, candidate.path), 'utf8')
    } catch {
      return null
    }
    const lines = source.split('\n')

    // Small file → whole content.
    if (lines.length <= largeFileLines) {
      return {
        path: candidate.path,
        language: candidate.language,
        numLines: lines.length,
        relevance: candidate.relevance,
        cosine: candidate.score,
        content: source,
        tokens: estimateTokens(source),
      }
    }

    // T1.16 — large file: extract the most relevant line ranges.
    const sections = await this.extractSections(lines, qVec, threshold, windowBudget)
    if (sections.length === 0) {
      // Nothing extractable within the window budget — fall back to a bounded
      // head slice so the file still contributes something.
      const head = lines.slice(0, SECTION_WINDOW_LINES).join('\n')
      return {
        path: candidate.path,
        language: candidate.language,
        numLines: lines.length,
        relevance: candidate.relevance,
        cosine: candidate.score,
        sections: [
          { startLine: 1, endLine: Math.min(SECTION_WINDOW_LINES, lines.length), text: head, relevance: candidate.relevance },
        ],
        tokens: estimateTokens(head),
      }
    }
    const tokens = sections.reduce((sum, s) => sum + estimateTokens(s.text), 0)
    return {
      path: candidate.path,
      language: candidate.language,
      numLines: lines.length,
      relevance: candidate.relevance,
      cosine: candidate.score,
      sections,
      tokens,
    }
  }

  /**
   * Slide a window over the file, embed each window, score it against the
   * query, keep the best few above threshold, and merge overlapping keepers
   * into contiguous ranges. Bounded by the shared window budget so a curate()
   * call over many large files can't explode into thousands of embeddings.
   */
  private async extractSections(
    lines: string[],
    qVec: Float32Array,
    threshold: number,
    windowBudget: { remaining: number },
  ): Promise<CuratedSection[]> {
    type Window = { start: number; end: number; text: string }
    const windows: Window[] = []
    for (let start = 0; start < lines.length; start += SECTION_STRIDE_LINES) {
      if (windowBudget.remaining <= 0) break
      const end = Math.min(start + SECTION_WINDOW_LINES, lines.length)
      const text = lines.slice(start, end).join('\n')
      if (text.trim().length === 0) continue
      windows.push({ start, end, text })
      windowBudget.remaining--
      if (end >= lines.length) break
    }
    if (windows.length === 0) return []

    const vectors = await this.embedder.embed(windows.map((w) => w.text))
    const scored = windows.map((w, i) => ({
      ...w,
      relevance: toRelevance(dot(qVec, vectors[i])),
    }))

    // Keep windows above threshold; if none clear it, keep the single best so
    // we never drop a file that the file-level score already deemed relevant.
    let keep = scored.filter((w) => w.relevance >= threshold)
    if (keep.length === 0) {
      const best = scored.reduce((a, b) => (b.relevance > a.relevance ? b : a))
      keep = [best]
    }
    keep.sort((a, b) => b.relevance - a.relevance)
    keep = keep.slice(0, MAX_SECTIONS_PER_FILE)

    // Merge overlapping / adjacent kept windows into contiguous ranges.
    keep.sort((a, b) => a.start - b.start)
    const merged: Array<{ start: number; end: number; relevance: number }> = []
    for (const w of keep) {
      const last = merged[merged.length - 1]
      if (last && w.start <= last.end) {
        last.end = Math.max(last.end, w.end)
        last.relevance = Math.max(last.relevance, w.relevance)
      } else {
        merged.push({ start: w.start, end: w.end, relevance: w.relevance })
      }
    }

    return merged.map((m) => ({
      startLine: m.start + 1,
      endLine: m.end,
      text: lines.slice(m.start, m.end).join('\n'),
      relevance: m.relevance,
    }))
  }
}

/**
 * Render a CuratedContext as a compact prompt block. This is the exact text
 * injected ahead of the user's message on the live per-turn path, and what
 * the headless `context` command prints in non-debug mode.
 */
export function renderContextBlock(ctx: CuratedContext): string {
  if (ctx.files.length === 0) return ''
  const parts: string[] = ['<relevant_files>']
  parts.push(
    'These files were selected by semantic relevance to the current request. ' +
      'Prefer them as your starting point; read more with your tools if needed.',
  )
  for (const f of ctx.files) {
    const pct = (f.relevance * 100).toFixed(0)
    if (f.content !== undefined) {
      parts.push(`\n--- ${f.path} (relevance ${pct}%) ---`)
      parts.push(f.content)
    } else if (f.sections && f.sections.length > 0) {
      for (const s of f.sections) {
        parts.push(`\n--- ${f.path}:${s.startLine}-${s.endLine} (relevance ${pct}%) ---`)
        parts.push(s.text)
      }
    }
  }
  parts.push('</relevant_files>')
  return parts.join('\n')
}
