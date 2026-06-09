// Benchmark: sqlite-vec (via bun:sqlite + Homebrew libsqlite3) vs LanceDB.
//
// Workload models the M1 use case: per-file/per-function embeddings of a
// ~50K-file monorepo. We benchmark a realistic slice and project linearly.
//
//   - dim:   1024 (OpenAI text-embedding-3-small/large at reduced dim, or
//                  Voyage voyage-code-3 native; matches the realistic plan)
//   - N:     20,000 vectors  (≈ 2 chunks/file × 10K hot files)
//   - top-K: 10
//   - queries: 200 random unit-norm vectors
//
// Measured:
//   - install/import time (proxy: cold first call to library)
//   - bulk insert time, throughput
//   - on-disk size
//   - top-K query latency: p50 / p95 / p99
//   - incremental update time (insert 500 more, query again)
//   - delete + reinsert (file edit emulation) p50
//
// Notes:
//   - sqlite-vec uses default brute-force MATCH (linear scan over rowid set).
//     Exact, not ANN. Acceptable for ≤ ~250K vectors per the upstream README.
//   - LanceDB defaults to flat scan as well until an IVF/PQ index is built.
//     We benchmark both flat AND post-index latency for LanceDB.

import { Database } from 'bun:sqlite'
import { getLoadablePath } from 'sqlite-vec'
import { existsSync, mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as lancedb from '@lancedb/lancedb'

const DIM = 1024
const N = 20_000
const QUERIES = 200
const TOP_K = 10
const INCREMENTAL_BATCH = 500

// --- helpers -----------------------------------------------------------

function randomUnitVector(dim: number): Float32Array {
  const v = new Float32Array(dim)
  let sum = 0
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1
    sum += v[i] * v[i]
  }
  const norm = Math.sqrt(sum) || 1
  for (let i = 0; i < dim; i++) v[i] /= norm
  return v
}

function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return NaN
  const idx = Math.min(
    sortedMs.length - 1,
    Math.floor((p / 100) * sortedMs.length),
  )
  return sortedMs[idx]
}

function dirSizeBytes(path: string): number {
  let total = 0
  const stack = [path]
  while (stack.length) {
    const p = stack.pop()!
    const stat = statSync(p)
    if (stat.isDirectory()) {
      for (const entry of readdirSync(p)) stack.push(join(p, entry))
    } else {
      total += stat.size
    }
  }
  return total
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(2)} ms`
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// --- generate corpus once, reused by both stores -----------------------

console.log('Generating corpus...')
const t0 = performance.now()
const vectors: Float32Array[] = new Array(N)
for (let i = 0; i < N; i++) vectors[i] = randomUnitVector(DIM)
const queries: Float32Array[] = new Array(QUERIES)
for (let i = 0; i < QUERIES; i++) queries[i] = randomUnitVector(DIM)
const extraVectors: Float32Array[] = new Array(INCREMENTAL_BATCH)
for (let i = 0; i < INCREMENTAL_BATCH; i++) extraVectors[i] = randomUnitVector(DIM)
console.log(
  `  corpus ready: N=${N}, queries=${QUERIES}, dim=${DIM}, gen took ${fmtMs(performance.now() - t0)}`,
)
console.log()

// ---------- sqlite-vec ----------

async function benchSqliteVec(): Promise<Record<string, unknown>> {
  const label = 'sqlite-vec (bun:sqlite + brew libsqlite3)'
  console.log(`=== ${label} ===`)
  const candidates = [
    '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
    '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
  ]
  const sysSqlite = candidates.find((p) => existsSync(p))
  if (!sysSqlite) throw new Error('No system sqlite with extension support.')

  const tCustomSet = performance.now()
  Database.setCustomSQLite(sysSqlite)
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-vec-bench-'))
  const dbPath = join(dir, 'index.sqlite')
  const db = new Database(dbPath)
  db.loadExtension(getLoadablePath())
  const tImport = performance.now() - tCustomSet
  console.log(`  open + loadExtension: ${fmtMs(tImport)}`)

  db.exec(`CREATE VIRTUAL TABLE items USING vec0(embedding FLOAT[${DIM}])`)

  // Bulk insert in a single transaction for fairness.
  const insert = db.prepare(
    'INSERT INTO items(rowid, embedding) VALUES (?, ?)',
  )
  const txn = db.transaction((batch: Float32Array[], offset: number) => {
    for (let i = 0; i < batch.length; i++) {
      insert.run(offset + i + 1, new Uint8Array(batch[i].buffer))
    }
  })
  const tInsertStart = performance.now()
  txn(vectors, 0)
  const tInsert = performance.now() - tInsertStart
  console.log(
    `  bulk insert N=${N}: ${fmtMs(tInsert)} (${((N / tInsert) * 1000).toFixed(0)} vec/s)`,
  )

  const sizeBytes = statSync(dbPath).size
  console.log(`  on-disk size: ${fmtBytes(sizeBytes)}`)

  const queryStmt = db.prepare(
    `SELECT rowid, distance FROM items
       WHERE embedding MATCH ?
       ORDER BY distance LIMIT ${TOP_K}`,
  )
  const queryTimes: number[] = []
  for (const q of queries) {
    const t = performance.now()
    queryStmt.all(new Uint8Array(q.buffer))
    queryTimes.push(performance.now() - t)
  }
  queryTimes.sort((a, b) => a - b)
  const p50 = percentile(queryTimes, 50)
  const p95 = percentile(queryTimes, 95)
  const p99 = percentile(queryTimes, 99)
  console.log(
    `  query top-${TOP_K}: p50=${fmtMs(p50)} p95=${fmtMs(p95)} p99=${fmtMs(p99)}`,
  )

  // Incremental insert
  const tIncStart = performance.now()
  txn(extraVectors, N)
  const tInc = performance.now() - tIncStart
  console.log(
    `  incremental insert ${INCREMENTAL_BATCH}: ${fmtMs(tInc)} (${((INCREMENTAL_BATCH / tInc) * 1000).toFixed(0)} vec/s)`,
  )

  // Emulate "file edited": delete a rowid, reinsert
  const editStmtDel = db.prepare('DELETE FROM items WHERE rowid = ?')
  const editStmtIns = db.prepare(
    'INSERT INTO items(rowid, embedding) VALUES (?, ?)',
  )
  const editTimes: number[] = []
  for (let i = 0; i < 100; i++) {
    const rowid = Math.floor(Math.random() * N) + 1
    const v = randomUnitVector(DIM)
    const t = performance.now()
    editStmtDel.run(rowid)
    editStmtIns.run(rowid, new Uint8Array(v.buffer))
    editTimes.push(performance.now() - t)
  }
  editTimes.sort((a, b) => a - b)
  console.log(
    `  edit (del+ins) ×100: p50=${fmtMs(percentile(editTimes, 50))} p95=${fmtMs(percentile(editTimes, 95))}`,
  )

  db.close()
  const finalSize = statSync(dbPath).size
  rmSync(dir, { recursive: true, force: true })
  console.log()
  return {
    label,
    openMs: tImport,
    insertMs: tInsert,
    insertThroughputVecPerSec: (N / tInsert) * 1000,
    queryP50Ms: p50,
    queryP95Ms: p95,
    queryP99Ms: p99,
    incrementalInsertMs: tInc,
    editP50Ms: percentile(editTimes, 50),
    diskSizeBytes: finalSize,
  }
}

// ---------- LanceDB ----------

async function benchLanceDb(): Promise<Record<string, unknown>> {
  const label = '@lancedb/lancedb (Bun)'
  console.log(`=== ${label} ===`)

  const tOpenStart = performance.now()
  const dir = mkdtempSync(join(tmpdir(), 'lancedb-bench-'))
  const db = await lancedb.connect(dir)

  // Schema is inferred from the first row; pre-create empty table with explicit schema
  // by inserting one row then deleting it would skew timings. Use createEmptyTable
  // via the typed Arrow schema instead — but the simple API is fine for bench.
  // We'll create the table with a single seed row, then immediately delete it
  // and start the timer from there.
  const seedTable = await db.createTable('items', [
    { id: 0, vector: Array.from(vectors[0]) },
  ])
  await seedTable.delete('id = 0')
  const tImport = performance.now() - tOpenStart
  console.log(`  connect + createTable: ${fmtMs(tImport)}`)

  // Bulk insert — chunk to keep memory bounded.
  const CHUNK = 2_000
  const tInsertStart = performance.now()
  for (let off = 0; off < N; off += CHUNK) {
    const slice: Array<{ id: number; vector: number[] }> = []
    const end = Math.min(off + CHUNK, N)
    for (let i = off; i < end; i++) {
      slice.push({ id: i + 1, vector: Array.from(vectors[i]) })
    }
    await seedTable.add(slice)
  }
  const tInsert = performance.now() - tInsertStart
  console.log(
    `  bulk insert N=${N}: ${fmtMs(tInsert)} (${((N / tInsert) * 1000).toFixed(0)} vec/s)`,
  )

  const sizeBytes = dirSizeBytes(dir)
  console.log(`  on-disk size: ${fmtBytes(sizeBytes)}`)

  // Flat-scan queries
  const flatTimes: number[] = []
  for (const q of queries) {
    const t = performance.now()
    await seedTable.vectorSearch(Array.from(q)).limit(TOP_K).toArray()
    flatTimes.push(performance.now() - t)
  }
  flatTimes.sort((a, b) => a - b)
  console.log(
    `  query top-${TOP_K} (flat): p50=${fmtMs(percentile(flatTimes, 50))} p95=${fmtMs(percentile(flatTimes, 95))} p99=${fmtMs(percentile(flatTimes, 99))}`,
  )

  // Build an ANN index (IVF_PQ). LanceDB recommends ≥ ~5K rows.
  const tIdxStart = performance.now()
  try {
    await seedTable.createIndex('vector')
    const tIdx = performance.now() - tIdxStart
    console.log(`  build ANN index: ${fmtMs(tIdx)}`)
  } catch (e) {
    console.log(`  build ANN index: FAILED — ${(e as Error).message}`)
  }

  const idxTimes: number[] = []
  for (const q of queries) {
    const t = performance.now()
    await seedTable.vectorSearch(Array.from(q)).limit(TOP_K).toArray()
    idxTimes.push(performance.now() - t)
  }
  idxTimes.sort((a, b) => a - b)
  console.log(
    `  query top-${TOP_K} (ANN): p50=${fmtMs(percentile(idxTimes, 50))} p95=${fmtMs(percentile(idxTimes, 95))} p99=${fmtMs(percentile(idxTimes, 99))}`,
  )

  // Incremental insert
  const tIncStart = performance.now()
  const incSlice: Array<{ id: number; vector: number[] }> = []
  for (let i = 0; i < INCREMENTAL_BATCH; i++) {
    incSlice.push({ id: N + i + 1, vector: Array.from(extraVectors[i]) })
  }
  await seedTable.add(incSlice)
  const tInc = performance.now() - tIncStart
  console.log(
    `  incremental insert ${INCREMENTAL_BATCH}: ${fmtMs(tInc)} (${((INCREMENTAL_BATCH / tInc) * 1000).toFixed(0)} vec/s)`,
  )

  // Edit emulation: LanceDB doesn't have a primary-key upsert in the same way;
  // the canonical approach is delete-then-insert.
  const editTimes: number[] = []
  for (let i = 0; i < 100; i++) {
    const rowid = Math.floor(Math.random() * N) + 1
    const v = randomUnitVector(DIM)
    const t = performance.now()
    await seedTable.delete(`id = ${rowid}`)
    await seedTable.add([{ id: rowid, vector: Array.from(v) }])
    editTimes.push(performance.now() - t)
  }
  editTimes.sort((a, b) => a - b)
  console.log(
    `  edit (del+ins) ×100: p50=${fmtMs(percentile(editTimes, 50))} p95=${fmtMs(percentile(editTimes, 95))}`,
  )

  const finalSize = dirSizeBytes(dir)
  rmSync(dir, { recursive: true, force: true })
  console.log()
  return {
    label,
    openMs: tImport,
    insertMs: tInsert,
    insertThroughputVecPerSec: (N / tInsert) * 1000,
    queryFlatP50Ms: percentile(flatTimes, 50),
    queryFlatP95Ms: percentile(flatTimes, 95),
    queryFlatP99Ms: percentile(flatTimes, 99),
    queryAnnP50Ms: percentile(idxTimes, 50),
    queryAnnP95Ms: percentile(idxTimes, 95),
    queryAnnP99Ms: percentile(idxTimes, 99),
    incrementalInsertMs: tInc,
    editP50Ms: percentile(editTimes, 50),
    diskSizeBytes: finalSize,
  }
}

// ---------- run ----------

const sqliteResult = await benchSqliteVec()
const lanceResult = await benchLanceDb()

console.log('=== Summary (JSON) ===')
console.log(JSON.stringify({ sqliteResult, lanceResult }, null, 2))
