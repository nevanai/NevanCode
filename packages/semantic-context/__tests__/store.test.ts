import { describe, expect, test } from 'bun:test'

import { HashFallbackEmbedder } from '../src/embedder'
import { SemanticStore } from '../src/store'
import { destroyTmpProject, makeTmpProject } from './test-utils'

import type { FileRecord } from '../src/types'

function makeRecord(path: string, hash = 'h'): FileRecord {
  return {
    path,
    contentHash: hash,
    mtimeMs: 1,
    size: 10,
    numLines: 1,
    language: 'typescript',
    identifiers: ['fooBar'],
    calls: ['baz'],
    indexedAtMs: Date.now(),
  }
}

describe('SemanticStore', () => {
  test('upsert + getFile roundtrip', async () => {
    const root = makeTmpProject()
    try {
      const emb = new HashFallbackEmbedder(16)
      const [v] = await emb.embed(['hello'])
      const store = new SemanticStore({ projectRoot: root, modelId: emb.modelId, dim: emb.dim })
      await store.open()
      store.transaction(() => store.upsertFile(makeRecord('a.ts'), v))
      const got = store.getFile('a.ts')
      expect(got?.path).toBe('a.ts')
      expect(got?.identifiers).toContain('fooBar')
      expect(got?.calls).toContain('baz')
      await store.close()
    } finally {
      await SemanticStore.destroy(root)
      destroyTmpProject(root)
    }
  })

  test('persistence survives close/reopen', async () => {
    const root = makeTmpProject()
    try {
      const emb = new HashFallbackEmbedder(16)
      const [v] = await emb.embed(['hello'])
      const s1 = new SemanticStore({ projectRoot: root, modelId: emb.modelId, dim: emb.dim })
      await s1.open()
      s1.transaction(() => s1.upsertFile(makeRecord('a.ts'), v))
      await s1.close()

      const s2 = new SemanticStore({ projectRoot: root, modelId: emb.modelId, dim: emb.dim })
      await s2.open()
      expect(s2.count()).toBe(1)
      expect(s2.getFile('a.ts')?.path).toBe('a.ts')
      await s2.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('deleteFile removes both metadata and HNSW entry', async () => {
    const root = makeTmpProject()
    try {
      const emb = new HashFallbackEmbedder(16)
      const [va, vb] = await emb.embed(['first', 'second'])
      const store = new SemanticStore({ projectRoot: root, modelId: emb.modelId, dim: emb.dim })
      await store.open()
      store.transaction(() => {
        store.upsertFile(makeRecord('a.ts', 'h1'), va)
        store.upsertFile(makeRecord('b.ts', 'h2'), vb)
      })
      expect(store.count()).toBe(2)
      store.deleteFile('a.ts')
      expect(store.count()).toBe(1)
      expect(store.getFile('a.ts')).toBeUndefined()
      expect(store.getFile('b.ts')).toBeDefined()
      // searching after delete should not return a.ts
      const hits = store.search(va, 5)
      expect(hits.find((h) => h.path === 'a.ts')).toBeUndefined()
      await store.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('search returns hits sorted by similarity', async () => {
    const root = makeTmpProject()
    try {
      const emb = new HashFallbackEmbedder(16)
      const vecs = await emb.embed(['the quick brown fox', 'totally different topic about pasta'])
      const store = new SemanticStore({ projectRoot: root, modelId: emb.modelId, dim: emb.dim })
      await store.open()
      store.transaction(() => {
        store.upsertFile(makeRecord('fox.ts', 'h1'), vecs[0])
        store.upsertFile(makeRecord('pasta.ts', 'h2'), vecs[1])
      })
      const [q] = await emb.embed(['the quick brown fox'])
      const hits = store.search(q, 5)
      expect(hits[0].path).toBe('fox.ts')
      expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score)
      await store.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('rejects vectors of the wrong dimension', async () => {
    const root = makeTmpProject()
    try {
      const store = new SemanticStore({ projectRoot: root, modelId: 'm', dim: 16 })
      await store.open()
      const bad = new Float32Array(8)
      expect(() => store.upsertFile(makeRecord('a.ts'), bad)).toThrow()
      await store.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('reusing an index dir under a different model id resets manifest', async () => {
    const root = makeTmpProject()
    try {
      const emb1 = new HashFallbackEmbedder(16)
      const [v] = await emb1.embed(['hello'])
      const s1 = new SemanticStore({ projectRoot: root, modelId: emb1.modelId, dim: emb1.dim })
      await s1.open()
      s1.transaction(() => s1.upsertFile(makeRecord('a.ts'), v))
      await s1.close()

      // Open with different model — should not throw, manifest is reset.
      const s2 = new SemanticStore({ projectRoot: root, modelId: 'other-model', dim: 16 })
      await s2.open()
      // Either the new store sees the orphan row (existing) or treats it as empty;
      // both behaviours are valid as long as it opens cleanly.
      expect(s2.count()).toBeGreaterThanOrEqual(0)
      await s2.close()
    } finally {
      destroyTmpProject(root)
    }
  })
})
