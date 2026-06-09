import { existsSync } from 'fs'
import { homedir } from 'os'
import * as path from 'path'

import { SemanticContextEngine, IndexWatcher, renderContextBlock } from '@codebuff/semantic-context'

import { useIndexingStore } from '../state/indexing-store'
import { getCliEnv } from './env'
import { logger } from './logger'

import type { IndexProgress, IndexSummary } from '@codebuff/semantic-context'

interface Active {
  projectRoot: string
  engine: SemanticContextEngine
  watcher: IndexWatcher
  indexPromise: Promise<IndexSummary>
  unsubscribeProgress: () => void
}

let active: Active | null = null
let disabledByEnv: boolean | null = null

function isExplicitlyDisabled(): boolean {
  if (disabledByEnv !== null) return disabledByEnv
  const v = getCliEnv().NEVAN_SEMANTIC_CONTEXT
  disabledByEnv = v === '0' || v === 'false' || v === 'off'
  return disabledByEnv
}

function isAllowedProject(projectRoot: string): boolean {
  const abs = path.resolve(projectRoot)
  if (!existsSync(abs)) return false
  if (abs === homedir()) return false
  if (abs === '/' || abs === path.parse(abs).root) return false
  return true
}

/**
 * Boot (or rebuild after a project change) the semantic context engine for the
 * given project root. Returns the active engine handle. Subsequent calls with
 * the same root are no-ops; calls with a different root cleanly stop the prior
 * engine first.
 *
 * Indexing runs in the background. The returned promise from `engine.index()`
 * is not awaited here — observers should subscribe via `useIndexingStore`.
 */
export async function startSemanticContext(projectRoot: string): Promise<SemanticContextEngine | null> {
  if (isExplicitlyDisabled()) {
    logger.debug({}, '[semantic-context] disabled via NEVAN_SEMANTIC_CONTEXT')
    return null
  }
  if (!isAllowedProject(projectRoot)) {
    return null
  }

  const store = useIndexingStore.getState()
  if (active && active.projectRoot === projectRoot) {
    return active.engine
  }
  if (active) {
    await stopSemanticContext().catch(() => {})
  }

  store.enable(projectRoot)

  const engine = new SemanticContextEngine({ projectRoot })
  const unsubscribeProgress = engine.onProgress((p: IndexProgress) => {
    useIndexingStore.getState().setProgress(p)
  })

  try {
    await engine.open()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn({ error: msg }, '[semantic-context] failed to open store')
    useIndexingStore.getState().setError(msg)
    unsubscribeProgress()
    useIndexingStore.getState().disable()
    return null
  }

  const watcher = new IndexWatcher(engine, {
    onError: (relPath: string, error: Error) => {
      logger.debug({ relPath, error: error.message }, '[semantic-context] watcher error')
    },
  })

  const indexPromise = (async () => {
    try {
      const summary = await engine.index()
      useIndexingStore.getState().setSummary(summary)
      await watcher.start().catch((err: Error) => {
        logger.warn({ error: err.message }, '[semantic-context] watcher failed to start')
      })
      return summary
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn({ error: msg }, '[semantic-context] indexing failed')
      useIndexingStore.getState().setError(msg)
      throw err
    }
  })()

  active = { projectRoot, engine, watcher, indexPromise, unsubscribeProgress }
  // Don't await indexPromise — it runs in the background.
  void indexPromise.catch(() => {})
  return engine
}

export async function stopSemanticContext(): Promise<void> {
  if (!active) return
  const a = active
  active = null
  try {
    a.unsubscribeProgress()
  } catch {
    // ignore
  }
  try {
    await a.watcher.stop()
  } catch (err) {
    logger.debug({ error: (err as Error).message }, '[semantic-context] watcher stop error')
  }
  try {
    await a.engine.close()
  } catch (err) {
    logger.debug({ error: (err as Error).message }, '[semantic-context] engine close error')
  }
  useIndexingStore.getState().disable()
}

export function getActiveEngine(): SemanticContextEngine | null {
  return active?.engine ?? null
}

/** Hard ceiling on how long live curation may take before we give up for this turn. */
const CURATION_TIMEOUT_MS = 2500

function isInjectionDisabled(): boolean {
  const v = getCliEnv().NEVAN_CONTEXT_INJECTION
  return v === '0' || v === 'false' || v === 'off'
}

function configuredThreshold(): number | undefined {
  const raw = getCliEnv().NEVAN_CURATION_THRESHOLD
  if (!raw) return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    ;(timer as { unref?: () => void }).unref?.()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

/**
 * Smart Context Curation (Feature 3), live per-turn path.
 *
 * Given the user's message, returns a `<relevant_files>` block to prepend to
 * the prompt — or an empty string when curation is disabled, the index isn't
 * ready, or anything goes wrong. This is strictly best-effort: it must never
 * block sending a message, so we only run once indexing has settled (model is
 * warm) and cap the whole thing with a timeout. A returned '' simply means
 * "no curated context this turn" and the agent proceeds as before.
 */
export async function curateRelevantFilesBlock(
  query: string,
  engineOverride?: SemanticContextEngine,
): Promise<string> {
  if (isExplicitlyDisabled() || isInjectionDisabled()) return ''
  const engine = engineOverride ?? active?.engine
  if (!engine) return ''
  if (!query || query.trim().length === 0) return ''

  try {
    // Only curate when the index is populated AND has settled. Before that the
    // embedding model may still be loading; calling curate() would block on the
    // model load and stall the user's turn. 'done'/'watching' ⇒ model is warm.
    if (engine.count() <= 0) return ''
    const phase = engine.current().phase
    if (phase !== 'done' && phase !== 'watching') return ''

    const ctx = await withTimeout(
      engine.curate(query, { maxFiles: 8, threshold: configuredThreshold() }),
      CURATION_TIMEOUT_MS,
    )
    if (!ctx || ctx.files.length === 0) return ''
    return renderContextBlock(ctx)
  } catch (err) {
    logger.debug(
      { error: err instanceof Error ? err.message : String(err) },
      '[semantic-context] live curation failed',
    )
    return ''
  }
}
