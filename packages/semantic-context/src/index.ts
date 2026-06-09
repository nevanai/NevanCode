export {
  DEFAULT_CURATION_MAX_FILES,
  DEFAULT_CURATION_MAX_TOKENS,
  DEFAULT_CURATION_THRESHOLD,
  DEFAULT_CURATION_TOPK,
  DEFAULT_EMBEDDING_DIM,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_LARGE_FILE_LINES,
  DEFAULT_SEARCH_THRESHOLD,
  DEFAULT_SEARCH_TOPK,
  NEVAN_DIR,
  getNevanPaths,
} from './config'

export { SemanticContextEngine } from './engine'
export type { EngineOptions } from './engine'

export { ContextCurator, renderContextBlock } from './curator'
export type {
  CurateOptions,
  CuratedContext,
  CuratedFile,
  CuratedSection,
  CurationDebugEntry,
  CurationRejectReason,
  CuratorStore,
  CuratorDeps,
} from './curator'

export { estimateTokens, estimateTokensFromBytes } from './tokens'

export { MultiRepoWorkspace, normalizeRepos } from './workspace'
export type {
  RepoRef,
  WorkspaceOptions,
  RepoIndexResult,
  WorkspaceSearchHit,
  SymbolHit,
  SymbolImpact,
} from './workspace'

export { GitHubRepoProvider, parseOrgFromUrl } from './github'
export type { RepoProvider, OrgRepo } from './github'

export {
  HashFallbackEmbedder,
  TransformersEmbedder,
} from './embedder'
export type { Embedder, EmbedderOptions } from './embedder'

export { SemanticStore } from './store'
export type { StoreOptions } from './store'

export { IndexWatcher } from './watcher'
export type { WatcherOptions } from './watcher'

export { walkProject, isIndexable } from './walker'
export type { WalkedFile, WalkOptions } from './walker'

export { extractFile } from './extractor'
export type { ExtractedFile } from './extractor'

export type {
  FileRecord,
  IndexPhase,
  IndexProgress,
  IndexSummary,
  ProgressListener,
  SearchHit,
  SearchOptions,
  SearchResult,
} from './types'
