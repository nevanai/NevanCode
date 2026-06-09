import { promises as fs } from 'fs'

import { DEFAULT_EMBEDDING_DIM, DEFAULT_EMBEDDING_MODEL } from './config'

export interface Embedder {
  readonly dim: number
  readonly modelId: string
  /** Returns one L2-normalized vector per input text, length === inputs.length. */
  embed(texts: string[]): Promise<Float32Array[]>
  /** Optional: begin loading the model ahead of the first embed (overlaps I/O). */
  warm?(): Promise<void>
  /** Optional shutdown to release any native resources. */
  close?(): Promise<void>
}

export interface EmbedderOptions {
  /** Override the model id; must produce a vector of this.dim dimensions. */
  modelId?: string
  /** Override the model output dimensionality. Default = 384 for all-MiniLM-L6-v2. */
  dim?: number
  /** Override the per-call inner batch size sent to the model. */
  batchSize?: number
  /** Folder where the model is cached on disk. */
  cacheDir?: string
}

type FeatureExtractionPipeline = (
  texts: string | string[],
  opts: { pooling: 'mean'; normalize: true },
) => Promise<{ data: Float32Array; dims: number[] }>

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Real sentence-transformer embedder backed by @xenova/transformers, running
 * IN-PROCESS (no Worker thread).
 *
 * Why in-process: @xenova/transformers loads onnxruntime-node, a native NAPI
 * addon. Running it inside a Bun `Worker` alongside the main thread's other
 * native addons (hnswlib-node, bun:sqlite) triggers a non-deterministic
 * "NAPI FATAL ERROR" panic — sometimes crashing the process, sometimes leaving
 * a request that never resolves (a permanent hang, since a dead worker doesn't
 * always fire `onerror`). Running the model in-process removes the second NAPI
 * context entirely, eliminating that whole failure class.
 *
 * Responsiveness is preserved by embedding in small inner batches and yielding
 * to the event loop between them, so the TUI render loop keeps painting and
 * input keeps flowing even during a long index.
 *
 * - First call downloads the model from the HuggingFace Hub into `cacheDir`
 *   (default: ~/.cache/transformers). Subsequent calls load from disk.
 * - Embeddings are mean-pooled token vectors, L2-normalized, so dot product
 *   === cosine similarity.
 */
export class TransformersEmbedder implements Embedder {
  readonly dim: number
  readonly modelId: string
  private readonly batchSize: number
  private readonly cacheDir: string | undefined
  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null
  private closed = false

  constructor(options: EmbedderOptions = {}) {
    this.modelId = options.modelId ?? DEFAULT_EMBEDDING_MODEL
    this.dim = options.dim ?? DEFAULT_EMBEDDING_DIM
    // Small inner batch keeps each blocking inference span short (~tens of ms)
    // so we can yield frequently and never freeze the TUI.
    this.batchSize = options.batchSize ?? 4
    this.cacheDir = options.cacheDir
  }

  private ensurePipeline(): Promise<FeatureExtractionPipeline> {
    if (this.pipelinePromise) return this.pipelinePromise
    this.pipelinePromise = (async () => {
      const mod = await import('@xenova/transformers')
      const env = (mod as { env: { cacheDir?: string; allowLocalModels: boolean } }).env
      if (this.cacheDir) {
        await fs.mkdir(this.cacheDir, { recursive: true }).catch(() => {})
        env.cacheDir = this.cacheDir
      }
      // Prefer a locally cached model; fall back to the Hub only when missing.
      env.allowLocalModels = true
      return mod.pipeline(
        'feature-extraction',
        this.modelId,
      ) as unknown as FeatureExtractionPipeline
    })()
    return this.pipelinePromise
  }

  /**
   * Start loading the model now. Called at the very start of an index pass so
   * the (one-time) load overlaps the async file walk instead of stalling the
   * UI at the parsing→embedding transition. Safe to call repeatedly.
   */
  async warm(): Promise<void> {
    if (this.closed) return
    await this.ensurePipeline()
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    if (this.closed) throw new Error('[semantic-context] embedder is closed')

    const pipeline = await this.ensurePipeline()
    const out: Float32Array[] = []
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize)
      const result = await pipeline(batch, { pooling: 'mean', normalize: true })
      const [batchN, dim] = result.dims
      if (dim !== this.dim) {
        throw new Error(
          `[semantic-context] Model ${this.modelId} produced dim ${dim}, expected ${this.dim}`,
        )
      }
      for (let row = 0; row < batchN; row++) {
        const start = row * dim
        out.push(result.data.slice(start, start + dim))
      }
      // Breathe between inner batches so the event loop (TUI render + input)
      // is never starved during a long index pass.
      if (i + this.batchSize < texts.length) await yieldToEventLoop()
    }
    return out
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

/**
 * Hash-only fallback embedder. Intentionally simple and deterministic; used
 * only by tests that do not want to download a real model. NOT exported for
 * production use — semantic search quality is poor.
 */
export class HashFallbackEmbedder implements Embedder {
  readonly dim: number
  readonly modelId = 'hash-fallback'
  constructor(dim = 64) {
    this.dim = dim
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const vec = new Float32Array(this.dim)
      const tokens = t
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter(Boolean)
      for (const tok of tokens) {
        let h = 2166136261 >>> 0
        for (let i = 0; i < tok.length; i++) {
          h ^= tok.charCodeAt(i)
          h = Math.imul(h, 16777619) >>> 0
        }
        const slot = h % this.dim
        const sign = (h >>> 16) & 1 ? 1 : -1
        vec[slot] += sign
      }
      let norm = 0
      for (let i = 0; i < this.dim; i++) norm += vec[i] * vec[i]
      norm = Math.sqrt(norm)
      if (norm > 0) for (let i = 0; i < this.dim; i++) vec[i] /= norm
      return vec
    })
  }
}
