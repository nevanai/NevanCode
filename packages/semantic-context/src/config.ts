import * as path from 'path'

/** Directory placed inside the project root holding all on-disk index state. */
export const NEVAN_DIR = '.nevan'

/** Default sentence-transformer model published to the HuggingFace Hub. */
export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'
/** Output dimensionality of DEFAULT_EMBEDDING_MODEL. */
export const DEFAULT_EMBEDDING_DIM = 384

/** Maximum file size we will embed. Larger files are skipped. */
export const MAX_INDEX_FILE_BYTES = 512 * 1024
/** Hard ceiling on files we will attempt to index in one run. */
export const MAX_INDEX_FILES = 500_000

/** Number of files to process in one batch through the embedder. */
export const DEFAULT_EMBED_BATCH_SIZE = 16

/** Default cosine-similarity threshold for surfacing hits in search. */
export const DEFAULT_SEARCH_THRESHOLD = 0.3

/** Default topK for search. */
export const DEFAULT_SEARCH_TOPK = 25

// ---------------------------------------------------------------------------
// Smart Context Curation (Feature 3) defaults.
//
// Relevance is defined as `max(0, cosine)` (see curator.ts) so it lives in
// [0, 1] and stays interpretable — no remapping. The PRD suggests a 0.7
// inclusion threshold "as an example / configurable"; with all-MiniLM-L6-v2
// over the synthesized embedding text, genuine code matches sit well below
// that, so the *shipped* default below is data-driven rather than the literal
// 0.7. This is a documented deviation in the same spirit as T1.2 (HNSW instead
// of ChromaDB). The threshold remains fully configurable per call / via
// NEVAN_CURATION_THRESHOLD.
//
// Source: T1.18 measurement (__tests__/curation-measure.test.ts, real model,
// 90 real repo files, 20 queries). Cosine of the genuinely-relevant file ran
// min/median/max = 0.089 / 0.451 / 0.544. Token reduction vs the un-curated
// "inject all candidates" baseline was ~92% at the shipped threshold, so recall
// (not dropping the right file) is the binding constraint. Threshold-vs-recall:
// 0.20→17/20, 0.25→16/20, 0.30→14/20, 0.40→10/20, 0.50→3/20. 0.25 is the chosen
// balance (16/20 relevant files clear it, ~92% reduction).
// ---------------------------------------------------------------------------

/** Default relevance (max(0,cosine)) a file must reach to enter curated context. */
export const DEFAULT_CURATION_THRESHOLD = 0.25

/** Candidates pulled from the vector index before threshold filtering. */
export const DEFAULT_CURATION_TOPK = 40

/** Hard cap on files included in one curated context block. */
export const DEFAULT_CURATION_MAX_FILES = 12

/** Token budget for one curated context block; files stop being added past it. */
export const DEFAULT_CURATION_MAX_TOKENS = 6000

/** Files with more lines than this get section extraction instead of whole-file. */
export const DEFAULT_LARGE_FILE_LINES = 160

/** Sliding-window size (lines) used when extracting sections from large files. */
export const SECTION_WINDOW_LINES = 60

/** Stride between section windows (lines). Smaller than the window ⇒ overlap. */
export const SECTION_STRIDE_LINES = 45

/** Max sections kept per large file. */
export const MAX_SECTIONS_PER_FILE = 3

/** Cap on the total number of section windows embedded in one curate() call. */
export const MAX_SECTION_WINDOWS = 48

/** File extensions we know how to parse via tree-sitter. */
export const INDEXABLE_EXTENSIONS = new Set<string>([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.cs',
  '.cpp',
  '.hpp',
  '.cc',
  '.hh',
  '.rb',
])

/** Documentation / text extensions we index for context but do not parse via tree-sitter. */
export const TEXTUAL_EXTENSIONS = new Set<string>(['.md', '.mdx', '.txt'])

export interface NevanPaths {
  root: string
  indexDir: string
  metadataDb: string
  hnswFile: string
  manifestFile: string
  modelCacheDir: string
}

export function getNevanPaths(projectRoot: string): NevanPaths {
  const indexDir = path.join(projectRoot, NEVAN_DIR)
  return {
    root: projectRoot,
    indexDir,
    metadataDb: path.join(indexDir, 'index.db'),
    hnswFile: path.join(indexDir, 'vectors.hnsw'),
    manifestFile: path.join(indexDir, 'manifest.json'),
    modelCacheDir: path.join(indexDir, 'models'),
  }
}
