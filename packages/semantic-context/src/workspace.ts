import { promises as fs, existsSync } from 'fs'
import * as path from 'path'

import { DEFAULT_SEARCH_TOPK, getNevanPaths } from './config'
import { TransformersEmbedder } from './embedder'
import { SemanticContextEngine } from './engine'

import type { Embedder } from './embedder'
import type { IndexSummary, SearchHit } from './types'

export interface RepoRef {
  /** Stable identifier for the repo within the workspace (unique). */
  id: string
  /** Absolute path to the repo root. */
  root: string
}

export interface WorkspaceOptions {
  /** Repo roots (string) or explicit {id, root} refs. */
  repos: Array<RepoRef | string>
  /**
   * Embedder shared across every repo engine. Sharing one instance is required
   * for cross-repo vector comparability (same model + dim) and avoids N model
   * loads. When omitted, one TransformersEmbedder is created and shared.
   */
  embedder?: Embedder
  batchSize?: number
  maxFiles?: number
  persist?: boolean
}

export interface RepoIndexResult {
  id: string
  root: string
  summary: IndexSummary
  /** True when at least one file was (re)indexed this run (T2.6: changed repos). */
  changed: boolean
  error?: string
}

export interface WorkspaceSearchHit extends SearchHit {
  repoId: string
  repoRoot: string
}

export interface SymbolHit {
  repoId: string
  repoRoot: string
  /** Repo-relative path. */
  path: string
}

export interface SymbolImpact {
  symbol: string
  definitions: SymbolHit[]
  callSites: SymbolHit[]
  /** True when the symbol is defined in one repo and called from a *different* one. */
  crossRepo: boolean
  /**
   * Heuristic: symbol matching is by bare name, so very common names
   * (run/handle/init/get…) collide across services and over-report. Flagged so
   * callers can treat wide results with suspicion.
   */
  ambiguous: boolean
}

const WORKSPACE_MANIFEST_VERSION = 1

interface WorkspaceManifest {
  version: number
  repos: RepoRef[]
  createdAtMs: number
  updatedAtMs: number
}

/**
 * Bare symbol names that are too common to be a reliable cross-repo signal.
 * Used only to flag `ambiguous` on impact results — never to drop data.
 */
const COMMON_SYMBOLS = new Set([
  'run', 'handle', 'init', 'main', 'index', 'start', 'stop', 'close', 'open',
  'get', 'set', 'update', 'create', 'delete', 'remove', 'add', 'list', 'find',
  'parse', 'format', 'log', 'error', 'data', 'value', 'name', 'id', 'config',
  'process', 'execute', 'send', 'receive', 'read', 'write', 'load', 'save',
])

function emptySummary(): IndexSummary {
  return {
    totalFiles: 0,
    indexedFiles: 0,
    skippedFiles: 0,
    failedFiles: 0,
    modules: 0,
    services: 0,
    elapsedMs: 0,
  }
}

/** Resolve repo inputs to unique {id, root}. Duplicate basenames get suffixed. */
export function normalizeRepos(repos: Array<RepoRef | string>): RepoRef[] {
  const counts = new Map<string, number>()
  const out: RepoRef[] = []
  for (const r of repos) {
    const root = path.resolve(typeof r === 'string' ? r : r.root)
    let id = typeof r === 'string' || !r.id ? path.basename(root) : r.id
    const seen = counts.get(id)
    if (seen !== undefined) {
      counts.set(id, seen + 1)
      id = `${id}-${seen + 1}`
    } else {
      counts.set(id, 1)
    }
    out.push({ id, root })
  }
  return out
}

/**
 * Cross-Repository Awareness (PRD Feature 4).
 *
 * A unified view over several single-repo indexes. Each repo keeps its own
 * `.nevan` index (so incremental re-indexing is per-repo for free — T2.6), and
 * this layer adds: unified cross-repo search (T2.1), API-contract surfacing
 * (T2.4), and "who defines / who calls this symbol, across every repo" impact
 * analysis (T2.5).
 */
export class MultiRepoWorkspace {
  readonly repos: RepoRef[]
  private readonly embedder: Embedder
  private readonly engines = new Map<string, SemanticContextEngine>()
  private opened = false

  constructor(options: WorkspaceOptions) {
    this.repos = normalizeRepos(options.repos)
    const firstRoot = this.repos[0]?.root ?? process.cwd()
    this.embedder =
      options.embedder ??
      new TransformersEmbedder({ cacheDir: getNevanPaths(firstRoot).modelCacheDir })

    for (const repo of this.repos) {
      this.engines.set(
        repo.id,
        new SemanticContextEngine({
          projectRoot: repo.root,
          embedder: this.embedder, // shared — engine won't close it (ownsEmbedder=false)
          batchSize: options.batchSize,
          maxFiles: options.maxFiles,
          persist: options.persist,
        }),
      )
    }
  }

  /** Engine for a repo id (for callers that want progress subscriptions etc.). */
  engineFor(id: string): SemanticContextEngine | undefined {
    return this.engines.get(id)
  }

  async open(): Promise<void> {
    if (this.opened) return
    await Promise.all([...this.engines.values()].map((e) => e.open()))
    this.opened = true
  }

  /**
   * Index every repo. Sequential on purpose: all engines share ONE in-process
   * embedder, so parallelism would only contend on the model + event loop.
   * Unchanged files are skipped per-repo (hash cache), so an already-indexed
   * repo costs ~nothing and reports `changed: false`.
   */
  async indexAll(onRepo?: (result: RepoIndexResult) => void): Promise<RepoIndexResult[]> {
    const results: RepoIndexResult[] = []
    for (const repo of this.repos) {
      const engine = this.engines.get(repo.id)!
      let result: RepoIndexResult
      try {
        const summary = await engine.index()
        result = {
          id: repo.id,
          root: repo.root,
          summary,
          changed: summary.indexedFiles > 0,
        }
      } catch (err) {
        result = {
          id: repo.id,
          root: repo.root,
          summary: emptySummary(),
          changed: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
      results.push(result)
      onRepo?.(result)
    }
    this.opened = true
    return results
  }

  /**
   * Unified semantic search across every repo (T2.1). Each repo is searched
   * with the shared embedder (comparable vectors), then hits are merged and
   * re-ranked by score. Each hit carries its repo id + root.
   */
  async search(
    query: string,
    options: { topK?: number; threshold?: number } = {},
  ): Promise<WorkspaceSearchHit[]> {
    await this.open()
    const perRepoTopK = options.topK ?? DEFAULT_SEARCH_TOPK
    const threshold = options.threshold ?? 0
    const all: WorkspaceSearchHit[] = []
    for (const repo of this.repos) {
      const engine = this.engines.get(repo.id)!
      const res = await engine.search(query, { topK: perRepoTopK, threshold })
      for (const h of res.hits) {
        all.push({ ...h, repoId: repo.id, repoRoot: repo.root })
      }
    }
    all.sort((a, b) => b.score - a.score)
    return options.topK ? all.slice(0, options.topK) : all
  }

  /**
   * Cross-repo impact of a symbol (T2.5): every repo+file that defines it and
   * every repo+file that calls it. This is what answers "I changed `getUser`
   * in service-a — who uses it?" across the whole workspace.
   */
  async impactOf(symbol: string): Promise<SymbolImpact> {
    await this.open()
    const definitions: SymbolHit[] = []
    const callSites: SymbolHit[] = []
    for (const repo of this.repos) {
      const engine = this.engines.get(repo.id)!
      for (const p of await engine.definitionsOf(symbol)) {
        definitions.push({ repoId: repo.id, repoRoot: repo.root, path: p })
      }
      for (const p of await engine.callSitesOf(symbol)) {
        callSites.push({ repoId: repo.id, repoRoot: repo.root, path: p })
      }
    }
    const defRepos = new Set(definitions.map((d) => d.repoId))
    const callRepos = new Set(callSites.map((c) => c.repoId))
    const crossRepo = defRepos.size > 0 && [...callRepos].some((r) => !defRepos.has(r))
    const ambiguous = COMMON_SYMBOLS.has(symbol) || definitions.length > 4
    return { symbol, definitions, callSites, crossRepo, ambiguous }
  }

  /**
   * API-contract surface (T2.4): the defined-symbol → (repo, file) map. These
   * are symbol *names* (code-map extracts identifiers/calls, not full type
   * signatures), which is enough to track which service owns which contract and
   * to drive the cross-repo call-site analysis above.
   */
  async apiContracts(
    repoId?: string,
  ): Promise<Array<{ repoId: string; symbol: string; path: string }>> {
    await this.open()
    const out: Array<{ repoId: string; symbol: string; path: string }> = []
    const repos = repoId ? this.repos.filter((r) => r.id === repoId) : this.repos
    for (const repo of repos) {
      const engine = this.engines.get(repo.id)!
      for (const s of await engine.definedSymbols()) {
        out.push({ repoId: repo.id, symbol: s.name, path: s.path })
      }
    }
    return out
  }

  async close(): Promise<void> {
    await Promise.all([...this.engines.values()].map((e) => e.close().catch(() => {})))
    // The engines were given the shared embedder (ownsEmbedder=false), so none
    // of them closed it. Close it once here.
    if (this.embedder.close) await this.embedder.close()
    this.opened = false
  }

  // ----- persistence (so `impact` can reload the workspace `index` built) -----

  static manifestPath(cwd: string): string {
    return path.join(cwd, '.nevan', 'workspace.json')
  }

  /** Persist the repo registry under `<cwd>/.nevan/workspace.json`. */
  async save(cwd: string): Promise<void> {
    const file = MultiRepoWorkspace.manifestPath(cwd)
    await fs.mkdir(path.dirname(file), { recursive: true })
    let createdAtMs = Date.now()
    try {
      const prev = JSON.parse(await fs.readFile(file, 'utf8')) as WorkspaceManifest
      if (prev.createdAtMs) createdAtMs = prev.createdAtMs
    } catch {
      // first write
    }
    const manifest: WorkspaceManifest = {
      version: WORKSPACE_MANIFEST_VERSION,
      repos: this.repos,
      createdAtMs,
      updatedAtMs: Date.now(),
    }
    await fs.writeFile(file, JSON.stringify(manifest, null, 2))
  }

  /** Load a previously-saved workspace, or null if none exists at `cwd`. */
  static async load(
    cwd: string,
    options: { embedder?: Embedder } = {},
  ): Promise<MultiRepoWorkspace | null> {
    const file = MultiRepoWorkspace.manifestPath(cwd)
    if (!existsSync(file)) return null
    let manifest: WorkspaceManifest
    try {
      manifest = JSON.parse(await fs.readFile(file, 'utf8')) as WorkspaceManifest
    } catch {
      return null
    }
    if (!manifest.repos || manifest.repos.length === 0) return null
    return new MultiRepoWorkspace({ repos: manifest.repos, embedder: options.embedder })
  }
}
