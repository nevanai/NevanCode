export type IndexPhase =
  | 'idle'
  | 'walking'
  | 'parsing'
  | 'embedding'
  | 'persisting'
  | 'watching'
  | 'done'
  | 'error'

export interface IndexProgress {
  phase: IndexPhase
  filesDiscovered: number
  filesIndexed: number
  filesSkipped: number
  filesFailed: number
  startedAtMs: number
  finishedAtMs?: number
  currentFile?: string
  error?: string
}

export interface IndexSummary {
  totalFiles: number
  indexedFiles: number
  skippedFiles: number
  failedFiles: number
  modules: number
  services: number
  elapsedMs: number
}

export interface FileSymbol {
  name: string
  kind: 'identifier' | 'call'
}

export interface FileRecord {
  /** Path relative to project root, using forward slashes. */
  path: string
  /** SHA1 hex of file contents at index time. */
  contentHash: string
  /** mtimeMs at index time. */
  mtimeMs: number
  /** Byte size of the file. */
  size: number
  /** Line count. */
  numLines: number
  /** Detected language by extension. */
  language: string
  /** Distinct identifier symbols extracted via tree-sitter. */
  identifiers: string[]
  /** Distinct call-target identifiers extracted via tree-sitter. */
  calls: string[]
  /** Unix timestamp (ms) of last successful index. */
  indexedAtMs: number
}

export interface SearchHit {
  path: string
  score: number
  language: string
  numLines: number
  matchedSymbols?: string[]
}

export interface SearchOptions {
  topK?: number
  /** Cosine-similarity threshold in [0, 1]. Hits below this are dropped. */
  threshold?: number
  /** When true, returns extra debug info per hit. */
  debug?: boolean
}

export interface SearchResult {
  query: string
  embeddingTimeMs: number
  searchTimeMs: number
  hits: SearchHit[]
}

export type ProgressListener = (progress: IndexProgress) => void
