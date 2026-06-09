import { promises as fs } from 'fs'
import * as path from 'path'

import { DEFAULT_EMBED_BATCH_SIZE, DEFAULT_SEARCH_THRESHOLD, DEFAULT_SEARCH_TOPK, getNevanPaths } from './config'
import { ContextCurator } from './curator'
import { TransformersEmbedder } from './embedder'
import { extractFile } from './extractor'
import { ProgressEmitter } from './progress'
import { SemanticStore } from './store'
import { walkProject } from './walker'

import type { CurateOptions, CuratedContext } from './curator'
import type { Embedder } from './embedder'
import type {
  IndexProgress,
  IndexSummary,
  ProgressListener,
  SearchOptions,
  SearchResult,
} from './types'

export interface EngineOptions {
  projectRoot: string
  embedder?: Embedder
  batchSize?: number
  maxFiles?: number
  /** When false, skips writing/reading the on-disk index. Useful for tests. */
  persist?: boolean
}

const DEFAULT_SERVICE_HINTS = [
  'service',
  'server',
  'api',
  'gateway',
  'controller',
  'handler',
  'worker',
  'daemon',
]

/** Yield to the event loop every N parsed files so the TUI can render / accept input. */
const PARSE_YIELD_EVERY = 25

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Top-level orchestrator. Owns the embedder + store, runs the index pipeline
 * (walk → extract → embed → upsert), and exposes a `search()` for callers.
 */
export class SemanticContextEngine {
  readonly projectRoot: string
  private readonly embedder: Embedder
  /**
   * Whether this engine owns the embedder's lifecycle. True only when we
   * constructed it ourselves; false when one was injected (the caller — e.g. a
   * MultiRepoWorkspace sharing one embedder across many engines — owns it, so
   * close() must NOT close it out from under the other engines).
   */
  private readonly ownsEmbedder: boolean
  private readonly store: SemanticStore
  private readonly progress = new ProgressEmitter()
  private readonly batchSize: number
  private readonly maxFiles?: number
  private readonly persist: boolean
  private openPromise: Promise<void> | null = null
  private indexingPromise: Promise<IndexSummary> | null = null
  private lastSummary: IndexSummary | null = null

  constructor(options: EngineOptions) {
    this.projectRoot = options.projectRoot
    this.ownsEmbedder = options.embedder === undefined
    this.embedder =
      options.embedder ??
      new TransformersEmbedder({
        cacheDir: getNevanPaths(options.projectRoot).modelCacheDir,
      })
    this.batchSize = options.batchSize ?? DEFAULT_EMBED_BATCH_SIZE
    this.maxFiles = options.maxFiles
    this.persist = options.persist !== false
    this.store = new SemanticStore({
      projectRoot: options.projectRoot,
      modelId: this.embedder.modelId,
      dim: this.embedder.dim,
    })
  }

  /** Subscribe to progress updates (also fires once with current state). */
  onProgress(listener: ProgressListener): () => void {
    return this.progress.subscribe(listener)
  }

  current(): IndexProgress {
    return this.progress.current()
  }

  lastSummaryOrNull(): IndexSummary | null {
    return this.lastSummary
  }

  /** Open the store. Cheap and idempotent. */
  async open(): Promise<void> {
    if (!this.openPromise) {
      this.openPromise = this.store.open()
    }
    return this.openPromise
  }

  /**
   * Walk the project, embed any files whose contentHash changed since the
   * last index, upsert them, then persist. Files that vanished from disk are
   * removed from the index. Returns a summary once the run completes.
   *
   * Calling `index()` while a previous run is in flight returns the same
   * promise — there is at most one indexing pass at a time per engine.
   */
  async index(): Promise<IndexSummary> {
    if (this.indexingPromise) return this.indexingPromise
    const stopWatchdog = this.startStallWatchdog()
    this.indexingPromise = this.runIndex().finally(() => {
      stopWatchdog()
      this.indexingPromise = null
    })
    return this.indexingPromise
  }

  /**
   * Internal stall monitor. Periodically checks that the active index pass is
   * still making progress and writes a one-line diagnostic to stderr if it
   * stops advancing for an unexpectedly long time.
   *
   * Honest scope: this is *observability*, not interruption. The embedder runs
   * in-process and we yield to the event loop between every small batch, so a
   * genuine permanent hang is no longer possible (that failure mode lived in
   * the old Worker path, now removed). What this catches is a pathologically
   * slow run — so a regression that reintroduces a stall is visible in logs
   * instead of looking like a freeze. Returns a stop function.
   */
  private startStallWatchdog(): () => void {
    const STALL_WARN_MS = 20_000
    const TICK_MS = 5_000
    let lastSig = ''
    let lastChangeMs = Date.now()
    let warned = false
    const timer = setInterval(() => {
      const p = this.progress.current()
      if (p.phase === 'done' || p.phase === 'error' || p.phase === 'idle') return
      const processed = p.filesIndexed + p.filesSkipped + p.filesFailed
      const sig = `${p.phase}:${processed}:${p.filesDiscovered}`
      if (sig !== lastSig) {
        lastSig = sig
        lastChangeMs = Date.now()
        warned = false
        return
      }
      const idleMs = Date.now() - lastChangeMs
      if (idleMs >= STALL_WARN_MS && !warned) {
        warned = true
        process.stderr.write(
          `[semantic-context] WARNING: indexing has not advanced for ${Math.round(
            idleMs / 1000,
          )}s (phase=${p.phase}, processed=${processed}/${p.filesDiscovered}). ` +
            `The run will continue; if this persists the project may be unusually large or a file is pathological.\n`,
        )
      }
    }, TICK_MS)
    ;(timer as { unref?: () => void }).unref?.()
    return () => clearInterval(timer)
  }

  private async runIndex(): Promise<IndexSummary> {
    await this.open()
    // Kick off the (one-time) model load now so it overlaps the async file
    // walk below; by the time we reach the embedding phase it's ready and the
    // UI never stalls at the parsing→embedding hand-off. Fire-and-forget: any
    // load error surfaces later on the awaited embed() call.
    void this.embedder.warm?.().catch(() => {})
    const startedAtMs = Date.now()
    this.progress.update({
      phase: 'walking',
      filesDiscovered: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      filesFailed: 0,
      startedAtMs,
      finishedAtMs: undefined,
      error: undefined,
      currentFile: undefined,
    })

    let walked
    try {
      walked = await walkProject(this.projectRoot, {
        maxFiles: this.maxFiles,
        onFile: () => {
          this.progress.update({
            filesDiscovered: this.progress.current().filesDiscovered + 1,
          })
        },
      })
    } catch (err) {
      this.progress.update({
        phase: 'error',
        error: err instanceof Error ? err.message : String(err),
        finishedAtMs: Date.now(),
      })
      throw err
    }

    // Prune files that no longer exist on disk.
    const liveSet = new Set(walked.map((w) => w.relPath))
    const known = this.store.listPaths()
    for (const p of known) {
      if (!liveSet.has(p)) this.store.deleteFile(p)
    }

    this.progress.update({ phase: 'parsing' })

    // Determine which files actually need re-embedding (hash mismatch).
    type Pending = { relPath: string; embeddingText: string; record: import('./types').FileRecord }
    const pending: Pending[] = []
    let skipped = 0
    let failed = 0
    let parsedSinceYield = 0
    for (const w of walked) {
      const existing = this.store.getFile(w.relPath)
      let extraction
      try {
        extraction = await extractFile(this.projectRoot, w.relPath)
      } catch {
        failed++
        this.progress.update({ filesFailed: this.progress.current().filesFailed + 1 })
        continue
      }
      if (!extraction) {
        failed++
        this.progress.update({ filesFailed: this.progress.current().filesFailed + 1 })
        continue
      }
      if (
        existing &&
        existing.contentHash === extraction.record.contentHash &&
        this.store.hasVector(existing.hnswLabel)
      ) {
        // Hash matches AND the vector is actually present in the index. A file
        // whose row survived a crash but whose vector never reached the HNSW
        // file falls through to re-embed instead of being wrongly skipped.
        skipped++
        this.progress.update({ filesSkipped: this.progress.current().filesSkipped + 1 })
      } else {
        pending.push({ relPath: w.relPath, embeddingText: extraction.embeddingText, record: extraction.record })
      }
      // Yield to the event loop periodically. Tree-sitter parsing inside
      // extractFile is synchronous CPU work and would otherwise stall the
      // TUI render loop for seconds at a time on large projects.
      parsedSinceYield++
      if (parsedSinceYield >= PARSE_YIELD_EVERY) {
        parsedSinceYield = 0
        await yieldToEventLoop()
      }
    }

    this.progress.update({ phase: 'embedding' })

    // Persist periodically during embedding (not only at the very end) so an
    // abrupt kill mid-index loses at most a few seconds of work. The next run
    // then skips everything already flushed instead of re-embedding from zero.
    let lastFlushMs = Date.now()
    const FLUSH_INTERVAL_MS = 4000

    for (let i = 0; i < pending.length; i += this.batchSize) {
      const batch = pending.slice(i, i + this.batchSize)
      let vectors: Float32Array[]
      try {
        vectors = await this.embedder.embed(batch.map((p) => p.embeddingText))
      } catch (err) {
        failed += batch.length
        this.progress.update({
          filesFailed: this.progress.current().filesFailed + batch.length,
          error: err instanceof Error ? err.message : String(err),
        })
        continue
      }
      this.store.transaction(() => {
        for (let j = 0; j < batch.length; j++) {
          const { record } = batch[j]
          try {
            this.store.upsertFile(record, vectors[j])
            this.progress.update({
              filesIndexed: this.progress.current().filesIndexed + 1,
              currentFile: record.path,
            })
          } catch {
            failed++
            this.progress.update({ filesFailed: this.progress.current().filesFailed + 1 })
          }
        }
      })
      // Yield between embedding batches — the SQLite transaction + HNSW
      // addPoint loop above is synchronous and benefits from a breath, and the
      // in-process embedder for the next batch will block the thread again.
      await yieldToEventLoop()

      if (this.persist && Date.now() - lastFlushMs >= FLUSH_INTERVAL_MS) {
        await this.store.flush()
        lastFlushMs = Date.now()
      }
    }

    if (this.persist) {
      this.progress.update({ phase: 'persisting' })
      await this.store.flush()
    }

    const finishedAtMs = Date.now()
    this.progress.update({
      phase: 'done',
      finishedAtMs,
      currentFile: undefined,
    })

    const { modules, services } = this.computeProjectShape()
    const summary = this.progress.summary(modules, services)
    this.lastSummary = summary
    return summary
  }

  /**
   * Heuristic project-shape detection used for the "1247 files, 89 modules,
   * 12 services" startup banner. Modules = unique top-level dirs; services =
   * those whose name contains common service hints.
   */
  private computeProjectShape(): { modules: number; services: number } {
    const paths = this.store.listPaths()
    const dirs = new Set<string>()
    for (const p of paths) {
      const i = p.indexOf('/')
      if (i > 0) dirs.add(p.slice(0, i))
    }
    let services = 0
    for (const d of dirs) {
      const lower = d.toLowerCase()
      if (DEFAULT_SERVICE_HINTS.some((h) => lower.includes(h))) services++
    }
    return { modules: dirs.size, services }
  }

  /**
   * Re-embed and upsert a single file. Skips when contentHash is unchanged.
   * Used by the watcher for incremental updates.
   */
  async indexOne(relPath: string): Promise<'indexed' | 'skipped' | 'removed' | 'failed'> {
    await this.open()
    const absPath = path.join(this.projectRoot, relPath)
    let exists = true
    try {
      await fs.stat(absPath)
    } catch {
      exists = false
    }
    if (!exists) {
      this.store.deleteFile(relPath)
      if (this.persist) await this.store.flush()
      return 'removed'
    }

    const existing = this.store.getFile(relPath)
    let extraction
    try {
      extraction = await extractFile(this.projectRoot, relPath)
    } catch {
      return 'failed'
    }
    if (!extraction) return 'failed'

    if (
      existing &&
      existing.contentHash === extraction.record.contentHash &&
      this.store.hasVector(existing.hnswLabel)
    ) {
      return 'skipped'
    }
    const [vec] = await this.embedder.embed([extraction.embeddingText])
    this.store.transaction(() => {
      this.store.upsertFile(extraction!.record, vec)
    })
    if (this.persist) await this.store.flush()
    return 'indexed'
  }

  /** Semantic search. Returns hits with cosine-similarity scores in [-1, 1]. */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    await this.open()
    const topK = options.topK ?? DEFAULT_SEARCH_TOPK
    const threshold = options.threshold ?? DEFAULT_SEARCH_THRESHOLD

    const embedStart = Date.now()
    const [qVec] = await this.embedder.embed([query])
    const embeddingTimeMs = Date.now() - embedStart

    const searchStart = Date.now()
    const raw = this.store.search(qVec, topK)
    const filtered = raw.filter((h) => h.score >= threshold)
    const hits = filtered.map((h) => {
      let matchedSymbols: string[] | undefined
      if (options.debug) {
        const stored = this.store.getFile(h.path)
        if (stored) {
          const queryTokens = new Set(query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean))
          matchedSymbols = [...stored.identifiers, ...stored.calls].filter((s) =>
            queryTokens.has(s.toLowerCase()),
          )
        }
      }
      return {
        path: h.path,
        score: h.score,
        language: h.language,
        numLines: h.numLines,
        ...(matchedSymbols !== undefined ? { matchedSymbols } : {}),
      }
    })
    const searchTimeMs = Date.now() - searchStart

    return { query, embeddingTimeMs, searchTimeMs, hits }
  }

  /**
   * Smart Context Curation (Feature 3). Selects the files most relevant to
   * `query`, extracting only the pertinent sections of large files. See
   * ContextCurator for the algorithm.
   */
  async curate(query: string, options: CurateOptions = {}): Promise<CuratedContext> {
    await this.open()
    const curator = new ContextCurator({
      store: this.store,
      embedder: this.embedder,
      projectRoot: this.projectRoot,
    })
    return curator.curate(query, options)
  }

  async close(): Promise<void> {
    await this.store.close()
    if (this.ownsEmbedder && this.embedder.close) await this.embedder.close()
  }

  count(): number {
    return this.store.count()
  }

  /** Files in this repo that DEFINE a symbol of the given name (identifier). */
  async definitionsOf(symbol: string): Promise<string[]> {
    await this.open()
    return this.store.findFilesBySymbol(symbol, 'identifier').map((r) => r.path)
  }

  /** Files in this repo that CALL/reference a symbol of the given name. */
  async callSitesOf(symbol: string): Promise<string[]> {
    await this.open()
    return this.store.findFilesBySymbol(symbol, 'call').map((r) => r.path)
  }

  /** All defined-symbol → file pairs in this repo (the API-contract surface). */
  async definedSymbols(): Promise<Array<{ name: string; path: string }>> {
    await this.open()
    return this.store.listSymbols('identifier')
  }
}
