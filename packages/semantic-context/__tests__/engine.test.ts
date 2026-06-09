import { describe, expect, test } from 'bun:test'

import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'

import { HashFallbackEmbedder } from '../src/embedder'
import { SemanticContextEngine } from '../src/engine'
import { DictionaryEmbedder, destroyTmpProject, makeTmpProject, writeFile } from './test-utils'

describe('SemanticContextEngine', () => {
  test('first run indexes all files; second run skips unchanged', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'src/a.ts', 'export const a = 1')
      writeFile(root, 'src/b.ts', 'export const b = 2')

      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new HashFallbackEmbedder(16),
      })
      const first = await engine.index()
      expect(first.indexedFiles).toBe(2)
      expect(first.skippedFiles).toBe(0)

      const second = await engine.index()
      expect(second.indexedFiles).toBe(0)
      expect(second.skippedFiles).toBe(2)
      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('changing a file causes only that file to re-embed', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'a.ts', 'export const x = 1')
      writeFile(root, 'b.ts', 'export const y = 2')

      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new HashFallbackEmbedder(16),
      })
      await engine.index()
      writeFileSync(join(root, 'a.ts'), 'export const x = 99')
      const summary = await engine.index()
      expect(summary.indexedFiles).toBe(1)
      expect(summary.skippedFiles).toBe(1)
      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('deleted files are pruned on next run', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'keep.ts', 'export const a = 1')
      writeFile(root, 'doomed.ts', 'export const b = 2')

      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new HashFallbackEmbedder(16),
      })
      await engine.index()
      expect(engine.count()).toBe(2)
      unlinkSync(join(root, 'doomed.ts'))
      await engine.index()
      expect(engine.count()).toBe(1)
      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('search ranks semantically related files higher', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'user.ts', 'export function getUser() {}')
      writeFile(root, 'account.ts', 'export function getAccount() {}')
      writeFile(root, 'pasta.ts', 'export function cookPasta() {}')

      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new DictionaryEmbedder(['user', 'account', 'pasta']),
      })
      await engine.index()

      const result = await engine.search('look up a user account', { topK: 5, threshold: 0 })
      const paths = result.hits.map((h) => h.path)
      // user.ts and account.ts should both appear; pasta.ts should be last or filtered.
      expect(paths.includes('user.ts') || paths.includes('account.ts')).toBe(true)
      const pastaIdx = paths.indexOf('pasta.ts')
      const userIdx = paths.indexOf('user.ts')
      if (pastaIdx >= 0 && userIdx >= 0) {
        expect(userIdx).toBeLessThan(pastaIdx)
      }
      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('threshold filters out low-relevance hits', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'user.ts', 'export function getUser() {}')
      writeFile(root, 'pasta.ts', 'export function cookPasta() {}')

      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new DictionaryEmbedder(['user', 'pasta']),
      })
      await engine.index()
      const result = await engine.search('user lookup', { topK: 5, threshold: 0.5 })
      const paths = result.hits.map((h) => h.path)
      expect(paths).toContain('user.ts')
      expect(paths).not.toContain('pasta.ts')
      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('debug option attaches matchedSymbols to hits', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'user.ts', 'export function getUser() {}')
      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new DictionaryEmbedder(['user']),
      })
      await engine.index()
      const result = await engine.search('getUser please', { topK: 5, threshold: 0, debug: true })
      expect(result.hits[0].matchedSymbols).toContain('getUser')
      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('progress events fire through every phase', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'a.ts', 'export const a = 1')
      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new HashFallbackEmbedder(16),
      })
      const phases: string[] = []
      engine.onProgress((p) => phases.push(p.phase))
      await engine.index()
      expect(phases).toContain('walking')
      expect(phases).toContain('parsing')
      expect(phases).toContain('embedding')
      expect(phases).toContain('persisting')
      expect(phases).toContain('done')
      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('indexOne handles add/change/remove', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'a.ts', 'export const a = 1')
      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new HashFallbackEmbedder(16),
      })
      await engine.index()

      // No change → skipped
      const r1 = await engine.indexOne('a.ts')
      expect(r1).toBe('skipped')

      // Change content → indexed
      writeFileSync(join(root, 'a.ts'), 'export const a = 999')
      const r2 = await engine.indexOne('a.ts')
      expect(r2).toBe('indexed')

      // Delete → removed
      unlinkSync(join(root, 'a.ts'))
      const r3 = await engine.indexOne('a.ts')
      expect(r3).toBe('removed')
      expect(engine.count()).toBe(0)

      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('summary reflects modules and services heuristically', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'lib/util.ts', 'export const x = 1')
      writeFile(root, 'auth-service/main.ts', 'export const y = 2')
      writeFile(root, 'payments-server/index.ts', 'export const z = 3')

      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new HashFallbackEmbedder(16),
      })
      const summary = await engine.index()
      expect(summary.modules).toBe(3)
      expect(summary.services).toBe(2)
      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  })
})
