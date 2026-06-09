import { describe, expect, test } from 'bun:test'

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import * as path from 'path'

import { TransformersEmbedder } from '../src/embedder'
import { SemanticContextEngine } from '../src/engine'
import { destroyTmpProject, makeTmpProject } from './test-utils'

/**
 * T1.18 — empirical token-reduction measurement on REAL source files embedded
 * by the REAL model. This is the experiment that picks the shipped curation
 * threshold and substantiates the PRD's ≥60% token-reduction target. It is NOT
 * a DictionaryEmbedder unit test; it downloads/loads all-MiniLM-L6-v2 (cached)
 * like integration-transformers.test.ts.
 *
 * The honest baseline = "inject every retrieved candidate whole" (computeBaseline),
 * which is exactly what an un-curated semantic retrieval would dump into the
 * prompt. Reduction is therefore the curator's own contribution (threshold
 * filtering + section extraction), not the trivially-huge "whole repo" number.
 *
 * Gated behind NEVAN_MEASURE=1 because it indexes ~90 files with the real model
 * (~85s) — far too slow for the default `bun test` loop. Correctness of the
 * curation logic is covered by the deterministic curator.test.ts; this test is
 * the empirical benchmark that justified the shipped threshold. Run with:
 *   NEVAN_MEASURE=1 bun test __tests__/curation-measure.test.ts
 */

const MEASURE_ENABLED = process.env.NEVAN_MEASURE === '1'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const MODEL_CACHE =
  process.env.NEVAN_TEST_MODEL_CACHE ??
  path.join(__dirname, '..', '.nevan-test-cache', 'models')

// Real source directories to assemble a realistic, multi-domain corpus.
const SOURCE_DIRS = [
  'packages/semantic-context/src',
  'packages/code-map/src',
  'common/src/util',
  'common/src/tools/params/tool',
]

/** Natural-language queries paired with a substring of the file we expect to surface. */
const QUERIES: Array<{ q: string; expect: string }> = [
  { q: 'how are file changes watched and re-indexed incrementally', expect: 'watcher.ts' },
  { q: 'persist the vector index to disk and reload it between sessions', expect: 'store.ts' },
  { q: 'walk the project tree while respecting gitignore rules', expect: 'walker.ts' },
  { q: 'extract identifiers and function calls from source code', expect: 'extractor.ts' },
  { q: 'turn text into an embedding vector with a transformer model', expect: 'embedder.ts' },
  { q: 'coalesce progress updates so the terminal UI does not rerender too often', expect: 'progress.ts' },
  { q: 'compute a content hash of a file to detect changes', expect: 'hasher.ts' },
  { q: 'select the most relevant files and trim large ones for context', expect: 'curator.ts' },
  { q: 'estimate how many tokens a string of text is', expect: 'tokens.ts' },
  { q: 'orchestrate the indexing pipeline walk parse embed upsert', expect: 'engine.ts' },
  { q: 'default configuration constants and on-disk paths', expect: 'config.ts' },
  { q: 'parse a file and capture identifier and call tokens with tree-sitter', expect: 'parse.ts' },
  // 13–20 — bring the task set to the PRD-specified 20.
  { q: 'search across multiple repositories in one unified workspace', expect: 'workspace.ts' },
  { q: 'clone every repository from a github organization via the api', expect: 'github.ts' },
  { q: 'select the tree-sitter grammar for a file by its extension', expect: 'languages.ts' },
  { q: 'initialize the tree-sitter web assembly parser at startup', expect: 'init-node.ts' },
  { q: 'skip re-embedding files whose content has not changed since last index', expect: 'engine.ts' },
  { q: 'approximate nearest neighbor vector graph for cosine similarity search', expect: 'store.ts' },
  { q: 'debounce rapid file save events before re-indexing a single file', expect: 'watcher.ts' },
  { q: 'build a compact embedding text summary from a file and its symbols', expect: 'extractor.ts' },
]

function collectFiles(): string[] {
  const files: string[] = []
  for (const dir of SOURCE_DIRS) {
    const abs = path.join(REPO_ROOT, dir)
    if (!existsSync(abs)) continue
    let entries: string[]
    try {
      entries = readdirSync(abs)
    } catch {
      continue
    }
    for (const name of entries) {
      const full = path.join(abs, name)
      try {
        if (statSync(full).isFile() && /\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
          files.push(full)
        }
      } catch {
        // ignore
      }
    }
  }
  return files
}

describe('T1.18 — token-reduction measurement (real model)', () => {
  test.skipIf(!MEASURE_ENABLED)('curated context reduces tokens ≥60% vs injecting all candidates, and surfaces the right files', async () => {
    const sources = collectFiles()
    // Guard: if the repo layout changed and we found too few files, the
    // measurement would be meaningless. Fail loudly rather than report a fake number.
    expect(sources.length).toBeGreaterThanOrEqual(25)

    const root = makeTmpProject()
    try {
      // Copy the real files into the temp project, flattened under src/.
      const destDir = path.join(root, 'src')
      mkdirSync(destDir, { recursive: true })
      const seen = new Set<string>()
      for (const src of sources) {
        let base = path.basename(src)
        // De-dup names across dirs (e.g. two index.ts) by prefixing the parent dir.
        if (seen.has(base)) {
          base = `${path.basename(path.dirname(src))}_${base}`
        }
        seen.add(base)
        cpSync(src, path.join(destDir, base))
      }

      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new TransformersEmbedder({ cacheDir: MODEL_CACHE }),
      })
      await engine.index()
      const totalFiles = engine.count()
      expect(totalFiles).toBeGreaterThanOrEqual(25)

      // ONE curate per query at the shipped threshold. Its debug rows carry every
      // candidate's cosine + relevance, so the threshold-recall sweep below costs
      // zero extra embeddings. (Picking 0.25 itself was the earlier 12-query
      // exploration documented in config.ts/README; this validates it at /20.)
      const SHIPPED = 0.25
      const thresholds = [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5]
      const reductions: number[] = []
      const keptByThreshold = new Map<number, number>()
      const expectedCosines: number[] = []
      let expectedFound = 0
      let keptAtShipped = 0

      for (const { q, expect: expectFile } of QUERIES) {
        const ctx = await engine.curate(q, {
          threshold: SHIPPED,
          topK: 50,
          maxFiles: 12,
          computeBaseline: true,
          debug: true,
        })
        reductions.push(ctx.reductionRatio)
        if (ctx.files.some((f) => f.path.endsWith(expectFile))) keptAtShipped++

        // Candidate row for the expected file (present iff it was retrieved top-50).
        const dbg = (ctx.debug ?? []).find((d) => d.path.endsWith(expectFile))
        if (dbg) {
          expectedFound++
          expectedCosines.push(dbg.cosine)
          for (const t of thresholds) {
            if (dbg.relevance >= t) keptByThreshold.set(t, (keptByThreshold.get(t) ?? 0) + 1)
          }
        }
      }

      const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
      const sorted = [...expectedCosines].sort((a, b) => a - b)
      const pct = (p: number) => (sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : 0)
      const reductionAtShipped = mean(reductions)

      // eslint-disable-next-line no-console
      console.log('\n========== T1.18 CURATION MEASUREMENT ==========')
      // eslint-disable-next-line no-console
      console.log(`corpus files: ${totalFiles}, queries: ${QUERIES.length}`)
      // eslint-disable-next-line no-console
      console.log(
        `expected-file retrieved (top-50): ${expectedFound}/${QUERIES.length}; ` +
          `cosine min/median/max = ${pct(0).toFixed(3)}/${pct(0.5).toFixed(3)}/${pct(1).toFixed(3)}`,
      )
      // eslint-disable-next-line no-console
      console.log(
        `mean token reduction at shipped ${SHIPPED}: ${(reductionAtShipped * 100).toFixed(1)}%; ` +
          `expected-file kept in curated set: ${keptAtShipped}/${QUERIES.length}`,
      )
      // eslint-disable-next-line no-console
      console.log('threshold | expected-file clears it (recall, ignores maxFiles cap)')
      for (const t of thresholds) {
        // eslint-disable-next-line no-console
        console.log(`   ${t.toFixed(2)}   |   ${keptByThreshold.get(t) ?? 0}/${QUERIES.length}`)
      }
      console.log('================================================\n')

      // --- Assertions tied to the shipped default (DEFAULT_CURATION_THRESHOLD = 0.25) ---
      // PRD target: ≥60% token reduction per query vs the un-curated baseline.
      expect(reductionAtShipped).toBeGreaterThanOrEqual(0.6)
      // No quality-regression proxy: the relevant file is retrievable for most queries.
      expect(expectedFound).toBeGreaterThanOrEqual(16)
      // The shipped threshold keeps the relevant file in the curated set for most queries.
      expect(keptAtShipped).toBeGreaterThanOrEqual(11)

      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  }, 240_000)
})
