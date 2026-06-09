import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'

import type { Embedder } from '../src/embedder'

export function makeTmpProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nevan-sctx-test-'))
  return root
}

export function destroyTmpProject(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

export function writeFile(root: string, relPath: string, contents: string): void {
  const full = path.join(root, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, contents)
}

/**
 * A test embedder that maps inputs to predictable vectors based on a small
 * dictionary of "topic" words. Lets a test assert "input X is closer to Y
 * than to Z" without paying for a real transformer.
 */
export class DictionaryEmbedder implements Embedder {
  readonly dim: number
  readonly modelId = 'dictionary-test'

  constructor(private readonly topics: string[]) {
    this.dim = topics.length
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const lower = text.toLowerCase()
      const vec = new Float32Array(this.dim)
      for (let i = 0; i < this.topics.length; i++) {
        if (lower.includes(this.topics[i])) vec[i] = 1
      }
      let norm = 0
      for (let i = 0; i < this.dim; i++) norm += vec[i] * vec[i]
      norm = Math.sqrt(norm)
      if (norm > 0) for (let i = 0; i < this.dim; i++) vec[i] /= norm
      return vec
    })
  }
}
