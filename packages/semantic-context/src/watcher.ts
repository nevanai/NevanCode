import * as path from 'path'

import chokidar from 'chokidar'

import { INDEXABLE_EXTENSIONS, NEVAN_DIR, TEXTUAL_EXTENSIONS } from './config'

import type { SemanticContextEngine } from './engine'
import type { FSWatcher } from 'chokidar'

export interface WatcherOptions {
  /** Debounce window per file in ms. Avoids reindexing 5× during a save. */
  debounceMs?: number
  /** Override extensions watched. Defaults to INDEXABLE_EXTENSIONS ∪ TEXTUAL_EXTENSIONS. */
  extensions?: Set<string>
  /** Called on every re-index attempt; useful for tests. */
  onChange?: (
    relPath: string,
    result: 'indexed' | 'skipped' | 'removed' | 'failed',
  ) => void
  /** Called when the watcher fails to apply an update. */
  onError?: (relPath: string, error: Error) => void
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  NEVAN_DIR,
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
])

/**
 * chokidar wrapper that re-indexes a single file whenever it is added,
 * changed, or unlinked. The engine itself decides whether the file content
 * actually changed (via hash) — this layer just routes events.
 *
 * NOTE on the chokidar version: this is pinned to chokidar 3.x deliberately.
 * chokidar 5.0.0 under Bun performs a fully SYNCHRONOUS recursive directory
 * scan on `watch()` that blocked the event loop for ~24s on a real repo
 * (walking node_modules/.git before its `ignored` filter could prune them),
 * which froze the TUI right after indexing finished. chokidar 3.x scans
 * asynchronously (ready in tens of ms) and prunes ignored directories before
 * descending, so startup never blocks while still detecting every edit
 * reliably (which raw `fs.watch` does not under event bursts).
 */
export class IndexWatcher {
  private readonly engine: SemanticContextEngine
  private readonly debounceMs: number
  private readonly extensions: Set<string>
  private readonly onChange?: WatcherOptions['onChange']
  private readonly onError?: WatcherOptions['onError']
  private watcher: FSWatcher | null = null
  private pending = new Map<string, NodeJS.Timeout>()
  private inFlight = new Map<string, Promise<void>>()
  private started = false

  constructor(engine: SemanticContextEngine, options: WatcherOptions = {}) {
    this.engine = engine
    this.debounceMs = options.debounceMs ?? 250
    this.extensions =
      options.extensions ??
      new Set([...INDEXABLE_EXTENSIONS, ...TEXTUAL_EXTENSIONS])
    this.onChange = options.onChange
    this.onError = options.onError
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    this.watcher = chokidar.watch('.', {
      cwd: this.engine.projectRoot,
      ignored: (p: string) => this.shouldIgnore(p),
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      followSymlinks: false,
    })

    this.watcher.on('add', (relPath: string) => this.schedule(relPath))
    this.watcher.on('change', (relPath: string) => this.schedule(relPath))
    this.watcher.on('unlink', (relPath: string) => this.schedule(relPath))
  }

  private shouldIgnore(p: string): boolean {
    // chokidar consults this for directories too, and depending on version
    // hands us either project-relative OR absolute paths. The old checks only
    // matched relative forms, so an ignored directory passed as an absolute
    // path slipped through and chokidar descended into it. Reduce to a path
    // relative to the project root, then ignore if ANY segment is a known
    // build/vendor dir. Going relative-to-root first means a project that
    // itself lives under a directory called e.g. "build" isn't ignored
    // wholesale.
    let rel = p
    const root = this.engine.projectRoot
    if (path.isAbsolute(p) && (p === root || p.startsWith(`${root}${path.sep}`))) {
      rel = p.slice(root.length)
    }
    const segments = rel.split(/[\\/]/).filter(Boolean)
    for (const seg of segments) {
      if (IGNORED_DIRS.has(seg)) return true
    }
    // We intentionally do not filter by extension here. chokidar passes
    // directory paths through this filter too, and they have no extension we
    // recognize — filtering by extension would prune real directories. Extension
    // filtering happens later, after stat, inside `engine.indexOne`.
    return false
  }

  private schedule(relPath: string): void {
    const norm = relPath.split(path.sep).join('/')
    const existing = this.pending.get(norm)
    if (existing) clearTimeout(existing)
    const handle = setTimeout(() => {
      this.pending.delete(norm)
      void this.flush(norm)
    }, this.debounceMs)
    this.pending.set(norm, handle)
  }

  private async flush(relPath: string): Promise<void> {
    // Serialize per-file: a slow re-index shouldn't run twice in parallel.
    const prior = this.inFlight.get(relPath)
    const next = (async () => {
      if (prior) await prior.catch(() => {})
      try {
        const result = await this.engine.indexOne(relPath)
        this.onChange?.(relPath, result)
      } catch (err) {
        this.onError?.(relPath, err instanceof Error ? err : new Error(String(err)))
      }
    })()
    this.inFlight.set(relPath, next)
    await next
    if (this.inFlight.get(relPath) === next) this.inFlight.delete(relPath)
  }

  /** Wait for any pending debounced / in-flight updates to finish. */
  async drain(): Promise<void> {
    // Flush all scheduled debounces immediately.
    for (const [p, handle] of this.pending) {
      clearTimeout(handle)
      this.pending.delete(p)
      void this.flush(p)
    }
    await Promise.all(this.inFlight.values())
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    for (const handle of this.pending.values()) clearTimeout(handle)
    this.pending.clear()
    await Promise.all(this.inFlight.values()).catch(() => {})
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }
  }
}
