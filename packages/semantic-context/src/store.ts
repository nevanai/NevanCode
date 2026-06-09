import { promises as fs, existsSync, writeFileSync, renameSync } from 'fs'
import * as path from 'path'

import { Database } from 'bun:sqlite'
import hnswlib from 'hnswlib-node'

import { getNevanPaths } from './config'

import type { FileRecord } from './types'

const { HierarchicalNSW } = hnswlib

const SCHEMA_VERSION = 1
const HNSW_M = 16
const HNSW_EF_CONSTRUCTION = 200
const HNSW_EF_SEARCH = 64

interface Manifest {
  schemaVersion: number
  modelId: string
  dim: number
  hnswMaxElements: number
  nextLabel: number
  createdAtMs: number
  updatedAtMs: number
}

export interface StoreOptions {
  projectRoot: string
  modelId: string
  dim: number
  /** Initial HNSW capacity. Grows automatically when exceeded. */
  initialCapacity?: number
}

interface StoredFile extends FileRecord {
  hnswLabel: number
}

/**
 * Persistent index store. Responsibilities:
 *  - file metadata + symbol graph in SQLite (bun:sqlite)
 *  - vector embeddings in HNSW (hnswlib-node) for O(log N) cosine search
 *  - on-disk manifest tracking schema, model, label counter
 *
 * The two indexes are kept in sync via `hnsw_label` on the files row. Caller
 * is expected to wrap mutations in `withTransaction` for atomicity.
 */
export class SemanticStore {
  readonly projectRoot: string
  readonly dim: number
  readonly modelId: string
  private readonly paths: ReturnType<typeof getNevanPaths>
  private db!: Database
  private hnsw!: hnswlib.HierarchicalNSW
  private manifest!: Manifest
  private opened = false
  /**
   * Labels whose vector is actually present in the HNSW index right now.
   * Sourced from the index on open and kept in sync on every mutation. Used to
   * detect HNSW/SQLite divergence after a crash: a file row can exist in SQLite
   * while its vector was never flushed to the HNSW file, in which case the file
   * MUST be re-embedded rather than skipped on the hash check.
   */
  private liveLabels = new Set<number>()

  constructor(options: StoreOptions) {
    this.projectRoot = options.projectRoot
    this.modelId = options.modelId
    this.dim = options.dim
    this.paths = getNevanPaths(options.projectRoot)
    this.initialCapacity = options.initialCapacity ?? 4096
  }

  private initialCapacity: number

  async open(): Promise<void> {
    if (this.opened) return
    await fs.mkdir(this.paths.indexDir, { recursive: true })

    this.db = new Database(this.paths.metadataDb)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA synchronous = NORMAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        num_lines INTEGER NOT NULL,
        language TEXT NOT NULL,
        indexed_at_ms INTEGER NOT NULL,
        hnsw_label INTEGER NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS files_hnsw_idx ON files(hnsw_label);

      CREATE TABLE IF NOT EXISTS symbols (
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        PRIMARY KEY (path, name, kind),
        FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS symbols_name_idx ON symbols(name);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)

    this.manifest = await this.loadOrCreateManifest()
    this.hnsw = new HierarchicalNSW('cosine', this.dim)

    let hnswLoaded = false
    if (existsSync(this.paths.hnswFile)) {
      try {
        this.hnsw.readIndexSync(this.paths.hnswFile, true)
        this.hnsw.setEf(HNSW_EF_SEARCH)
        const need = Math.max(this.manifest.hnswMaxElements, this.initialCapacity)
        if (this.hnsw.getMaxElements() < need) {
          this.hnsw.resizeIndex(need)
          this.manifest.hnswMaxElements = need
        }
        hnswLoaded = true
      } catch {
        // Corrupt / truncated HNSW file (e.g. a crash mid-write before the
        // atomic rename landed). Fall through to a fresh index; the metadata
        // in SQLite drives which files get re-embedded.
        this.hnsw = new HierarchicalNSW('cosine', this.dim)
      }
    }
    if (!hnswLoaded) {
      const capacity = Math.max(this.initialCapacity, this.manifest.hnswMaxElements)
      this.hnsw.initIndex(capacity, HNSW_M, HNSW_EF_CONSTRUCTION)
      this.hnsw.setEf(HNSW_EF_SEARCH)
      this.manifest.hnswMaxElements = capacity
    }

    // Record which labels actually carry a vector, so the engine can tell a
    // genuinely-cached file from a SQLite row whose vector never made it to
    // disk (HNSW/DB divergence after an abrupt kill).
    this.liveLabels = new Set<number>(this.hnsw.getIdsList())

    // Reconcile the label counter with reality. A crash can leave SQLite rows
    // with labels the manifest hasn't caught up to; if we trusted a stale
    // (low) nextLabel we would hand out colliding labels and every affected
    // upsert would fail the UNIQUE(hnsw_label) constraint.
    const maxRow = this.db
      .query<{ m: number | null }, []>('SELECT MAX(hnsw_label) AS m FROM files')
      .get()
    const dbNextLabel = (maxRow?.m ?? 0) + 1
    if (dbNextLabel > this.manifest.nextLabel) this.manifest.nextLabel = dbNextLabel

    this.opened = true
  }

  private async loadOrCreateManifest(): Promise<Manifest> {
    try {
      const raw = await fs.readFile(this.paths.manifestFile, 'utf8')
      const m = JSON.parse(raw) as Manifest
      if (m.schemaVersion !== SCHEMA_VERSION) {
        throw new Error(
          `schema version mismatch (have ${m.schemaVersion}, expected ${SCHEMA_VERSION})`,
        )
      }
      if (m.modelId !== this.modelId || m.dim !== this.dim) {
        throw new Error(
          `manifest model mismatch (have ${m.modelId}/${m.dim}, expected ${this.modelId}/${this.dim})`,
        )
      }
      return m
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code && code !== 'ENOENT') {
        // Schema or model drift — reset.
      }
      return {
        schemaVersion: SCHEMA_VERSION,
        modelId: this.modelId,
        dim: this.dim,
        hnswMaxElements: this.initialCapacity,
        nextLabel: 1,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
      }
    }
  }

  /** True when `label`'s vector is currently present in the HNSW index. */
  hasVector(label: number): boolean {
    return this.liveLabels.has(label)
  }

  /** Total number of indexed files. */
  count(): number {
    const row = this.db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM files')
      .get()
    return row?.n ?? 0
  }

  /** Returns the previously stamped row for a path, or undefined. */
  getFile(relPath: string): StoredFile | undefined {
    const row = this.db
      .query<
        {
          path: string
          content_hash: string
          mtime_ms: number
          size: number
          num_lines: number
          language: string
          indexed_at_ms: number
          hnsw_label: number
        },
        [string]
      >('SELECT * FROM files WHERE path = ?')
      .get(relPath)
    if (!row) return undefined
    const syms = this.db
      .query<{ name: string; kind: string }, [string]>(
        'SELECT name, kind FROM symbols WHERE path = ?',
      )
      .all(relPath)
    return {
      path: row.path,
      contentHash: row.content_hash,
      mtimeMs: row.mtime_ms,
      size: row.size,
      numLines: row.num_lines,
      language: row.language,
      indexedAtMs: row.indexed_at_ms,
      identifiers: syms.filter((s) => s.kind === 'identifier').map((s) => s.name),
      calls: syms.filter((s) => s.kind === 'call').map((s) => s.name),
      hnswLabel: row.hnsw_label,
    }
  }

  listPaths(): string[] {
    return this.db
      .query<{ path: string }, []>('SELECT path FROM files')
      .all()
      .map((r) => r.path)
  }

  /**
   * Files containing a symbol with the given name. Optionally filter by kind
   * ('identifier' = declared/defined here, 'call' = referenced here). Backs
   * cross-repository call-site / definition lookup (Feature 4, T2.4/T2.5).
   */
  findFilesBySymbol(
    name: string,
    kind?: 'identifier' | 'call',
  ): Array<{ path: string; kind: string }> {
    if (kind) {
      return this.db
        .query<{ path: string; kind: string }, [string, string]>(
          'SELECT path, kind FROM symbols WHERE name = ? AND kind = ?',
        )
        .all(name, kind)
    }
    return this.db
      .query<{ path: string; kind: string }, [string]>(
        'SELECT path, kind FROM symbols WHERE name = ?',
      )
      .all(name)
  }

  /**
   * All symbols of a given kind (default: identifier — the "definition" surface
   * used to derive a repo's API-contract symbol set). Returns name+path pairs.
   */
  listSymbols(kind: 'identifier' | 'call' = 'identifier'): Array<{ name: string; path: string }> {
    return this.db
      .query<{ name: string; path: string }, [string]>(
        'SELECT name, path FROM symbols WHERE kind = ?',
      )
      .all(kind)
  }

  /** Map hnsw label → relative path. Used to translate kNN labels to files. */
  private resolveLabels(labels: number[]): Map<number, { path: string; language: string; numLines: number }> {
    if (labels.length === 0) return new Map()
    const placeholders = labels.map(() => '?').join(',')
    const rows = this.db
      .query<
        { hnsw_label: number; path: string; language: string; num_lines: number },
        number[]
      >(
        `SELECT hnsw_label, path, language, num_lines FROM files WHERE hnsw_label IN (${placeholders})`,
      )
      .all(...labels)
    const m = new Map<number, { path: string; language: string; numLines: number }>()
    for (const r of rows) {
      m.set(r.hnsw_label, {
        path: r.path,
        language: r.language,
        numLines: r.num_lines,
      })
    }
    return m
  }

  /**
   * Insert or replace a file's metadata + vector in the index. Caller must
   * ensure `vector.length === this.dim` and that the vector is L2-normalized.
   */
  upsertFile(record: FileRecord, vector: Float32Array): void {
    if (vector.length !== this.dim) {
      throw new Error(
        `[semantic-context] Vector length ${vector.length} != store dim ${this.dim}`,
      )
    }

    const existing = this.getFile(record.path)
    let label = existing?.hnswLabel
    if (label === undefined) {
      label = this.manifest.nextLabel++
    }
    this.ensureCapacity(label + 1)

    // hnswlib `addPoint` updates a point in place when the label already
    // exists, or inserts otherwise. We don't rely on version-specific
    // markDelete/replaceDeleted semantics: when re-embedding an already-live
    // label we mark-delete first, then unmark after, so the refreshed point is
    // guaranteed searchable. A brand-new (or crash-orphaned, vector-missing)
    // label is just inserted. Both hnsw calls tolerate "not in that state".
    const wasLive = this.liveLabels.has(label)
    if (wasLive) {
      try {
        this.hnsw.markDelete(label)
      } catch {
        // Already deleted — fine.
      }
    }
    this.hnsw.addPoint(Array.from(vector), label)
    if (wasLive) {
      try {
        this.hnsw.unmarkDelete(label)
      } catch {
        // Not in a deleted state — fine.
      }
    }
    this.liveLabels.add(label)

    const upsert = this.db.query<
      void,
      [string, string, number, number, number, string, number, number]
    >(
      `INSERT INTO files (path, content_hash, mtime_ms, size, num_lines, language, indexed_at_ms, hnsw_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         content_hash = excluded.content_hash,
         mtime_ms     = excluded.mtime_ms,
         size         = excluded.size,
         num_lines    = excluded.num_lines,
         language     = excluded.language,
         indexed_at_ms= excluded.indexed_at_ms,
         hnsw_label   = excluded.hnsw_label`,
    )
    upsert.run(
      record.path,
      record.contentHash,
      record.mtimeMs,
      record.size,
      record.numLines,
      record.language,
      record.indexedAtMs,
      label,
    )

    const deleteSyms = this.db.prepare('DELETE FROM symbols WHERE path = ?')
    deleteSyms.run(record.path)
    const insertSym = this.db.prepare(
      'INSERT OR IGNORE INTO symbols (path, name, kind) VALUES (?, ?, ?)',
    )
    for (const id of record.identifiers) insertSym.run(record.path, id, 'identifier')
    for (const c of record.calls) insertSym.run(record.path, c, 'call')

    this.manifest.updatedAtMs = Date.now()
  }

  /** Remove a file from both indexes. Safe to call for a missing path. */
  deleteFile(relPath: string): void {
    const row = this.db
      .query<{ hnsw_label: number }, [string]>(
        'SELECT hnsw_label FROM files WHERE path = ?',
      )
      .get(relPath)
    if (!row) return
    try {
      this.hnsw.markDelete(row.hnsw_label)
    } catch {
      // Already deleted from HNSW
    }
    this.liveLabels.delete(row.hnsw_label)
    this.db.prepare('DELETE FROM files WHERE path = ?').run(relPath)
    this.manifest.updatedAtMs = Date.now()
  }

  /** Vector search returning labels with distance (cosine distance, lower is better). */
  search(
    vector: Float32Array,
    topK: number,
  ): Array<{ path: string; score: number; language: string; numLines: number }> {
    if (vector.length !== this.dim) {
      throw new Error(
        `[semantic-context] Query vector length ${vector.length} != store dim ${this.dim}`,
      )
    }
    const filesIndexed = this.count()
    if (filesIndexed === 0) return []
    const k = Math.min(topK, filesIndexed)
    if (k <= 0) return []
    const raw = this.hnsw.searchKnn(Array.from(vector), k)
    const resolved = this.resolveLabels(raw.neighbors)
    const hits: Array<{
      path: string
      score: number
      language: string
      numLines: number
    }> = []
    for (let i = 0; i < raw.neighbors.length; i++) {
      const info = resolved.get(raw.neighbors[i])
      if (!info) continue
      // hnswlib-node returns cosine distance in [0, 2]; sim = 1 - distance.
      const score = 1 - raw.distances[i]
      hits.push({
        path: info.path,
        score,
        language: info.language,
        numLines: info.numLines,
      })
    }
    return hits
  }

  /**
   * Persist HNSW + manifest to disk, crash-safely.
   *
   * Each file is written to a sibling `.tmp` then atomically `rename`d into
   * place, so an abrupt kill mid-flush can never leave a torn HNSW or manifest
   * (the old, consistent file survives instead). We also checkpoint the SQLite
   * WAL so a kill doesn't leave a multi-MB uncheckpointed `-wal` that has to be
   * replayed on the next open.
   */
  async flush(): Promise<void> {
    if (!this.opened) return
    this.manifest.updatedAtMs = Date.now()

    const tmpHnsw = `${this.paths.hnswFile}.tmp`
    this.hnsw.writeIndexSync(tmpHnsw)
    renameSync(tmpHnsw, this.paths.hnswFile)

    const tmpManifest = `${this.paths.manifestFile}.tmp`
    writeFileSync(tmpManifest, JSON.stringify(this.manifest, null, 2))
    renameSync(tmpManifest, this.paths.manifestFile)

    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {
      // Checkpoint is best-effort; data is already durable in the WAL.
    }
  }

  async close(): Promise<void> {
    if (!this.opened) return
    await this.flush()
    this.db.close()
    this.opened = false
  }

  /** Run callback in a SQLite transaction; throws → ROLLBACK. */
  transaction<T>(fn: () => T): T {
    const txn = this.db.transaction(fn)
    return txn()
  }

  private ensureCapacity(min: number): void {
    if (min <= this.manifest.hnswMaxElements) return
    const next = Math.max(min, Math.ceil(this.manifest.hnswMaxElements * 1.5))
    this.hnsw.resizeIndex(next)
    this.manifest.hnswMaxElements = next
  }

  /** Wipe all on-disk state. Mostly used by tests. */
  static async destroy(projectRoot: string): Promise<void> {
    const paths = getNevanPaths(projectRoot)
    await fs.rm(paths.indexDir, { recursive: true, force: true })
  }
}
