import type { IndexProgress, IndexSummary, ProgressListener } from './types'

/**
 * Coalesces progress updates so React subscribers don't re-render hundreds of
 * times per second during heavy indexing. The pending state is merged in
 * memory and broadcast on a setTimeout-driven tick — at most once every
 * `flushIntervalMs`. Final / terminal phases ('done', 'error') flush
 * immediately so the UI shows the resolved state without waiting for the
 * next tick.
 */
export class ProgressEmitter {
  private listeners = new Set<ProgressListener>()
  private state: IndexProgress = {
    phase: 'idle',
    filesDiscovered: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    filesFailed: 0,
    startedAtMs: 0,
  }
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private readonly flushIntervalMs: number

  constructor(options: { flushIntervalMs?: number } = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? 120
  }

  current(): IndexProgress {
    return { ...this.state }
  }

  subscribe(listener: ProgressListener): () => void {
    this.listeners.add(listener)
    listener(this.current())
    return () => {
      this.listeners.delete(listener)
    }
  }

  update(patch: Partial<IndexProgress>): void {
    this.state = { ...this.state, ...patch }
    // Terminal / phase-transition events flush immediately so observers don't
    // miss them — every other update is coalesced.
    const phaseChanged = patch.phase !== undefined
    const terminal = this.state.phase === 'done' || this.state.phase === 'error'
    if (terminal || phaseChanged) {
      this.flush()
      return
    }
    this.dirty = true
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        if (this.dirty) this.flush()
      }, this.flushIntervalMs)
    }
  }

  private flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.dirty = false
    const snapshot = this.current()
    for (const l of this.listeners) {
      try {
        l(snapshot)
      } catch {
        // Don't let a buggy subscriber kill indexing.
      }
    }
  }

  summary(modules: number, services: number): IndexSummary {
    const elapsedMs = (this.state.finishedAtMs ?? Date.now()) - this.state.startedAtMs
    return {
      totalFiles:
        this.state.filesIndexed + this.state.filesSkipped + this.state.filesFailed,
      indexedFiles: this.state.filesIndexed,
      skippedFiles: this.state.filesSkipped,
      failedFiles: this.state.filesFailed,
      modules,
      services,
      elapsedMs,
    }
  }
}
