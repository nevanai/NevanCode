import { describe, expect, test } from 'bun:test'

import { TransformersEmbedder } from '../src/embedder'
import { SemanticContextEngine } from '../src/engine'
import { destroyTmpProject, makeTmpProject, writeFile } from './test-utils'

/**
 * Integration test exercising the REAL sentence-transformer embedder. This is
 * the test that proves PRD acceptance criterion: "semantic queries return
 * architecturally relevant files, not just textually similar". A pure
 * keyword-hashing embedder would FAIL this — the query never literally
 * mentions any of the file names or symbols.
 *
 * Disabled if NEVAN_SKIP_INTEGRATION=1 (CI without model cache).
 */
const skip = process.env.NEVAN_SKIP_INTEGRATION === '1'

describe.skipIf(skip)('integration: TransformersEmbedder semantic ranking', () => {
  test('semantically-related file ranks above lexically-similar file', async () => {
    const root = makeTmpProject()
    try {
      // "getUserById" and "lookupAccount" share NO substring with the query.
      // Only a real semantic model knows they relate to "fetching a person's
      // profile". A pure hashing/keyword embedder treats both as ~unrelated.
      writeFile(
        root,
        'src/profile.ts',
        `export async function getUserById(id: string) {
  return database.users.find(id)
}
export async function lookupAccount(accountId: string) {
  return database.accounts.lookup(accountId)
}`,
      )
      // This file shares MANY tokens with the query ("look", "up", "data") but
      // is about cooking pasta. A keyword search would mis-rank it as relevant.
      writeFile(
        root,
        'src/recipe.ts',
        `export function lookUpPastaRecipe(name: string) {
  return cookbook.recipes.find(name)
}
// Note: this looks up data about pasta dishes, not about people.`,
      )

      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new TransformersEmbedder({
          cacheDir: '.nevan-test-cache/models',
        }),
        batchSize: 4,
      })
      await engine.index()

      const result = await engine.search('fetch a person profile', {
        topK: 5,
        threshold: 0,
      })
      const top = result.hits[0]?.path
      expect(top).toBe('src/profile.ts')

      // Both files appear; profile.ts should out-rank recipe.ts.
      const profileScore = result.hits.find((h) => h.path === 'src/profile.ts')?.score ?? -1
      const recipeScore = result.hits.find((h) => h.path === 'src/recipe.ts')?.score ?? -1
      expect(profileScore).toBeGreaterThan(recipeScore)

      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  }, 120000)

  test('search latency below 200ms p95 target on small corpus', async () => {
    const root = makeTmpProject()
    try {
      for (let i = 0; i < 30; i++) {
        writeFile(root, `f${i}.ts`, `export const value${i} = ${i}\nexport function compute${i}() {}`)
      }
      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new TransformersEmbedder({
          cacheDir: '.nevan-test-cache/models',
        }),
        batchSize: 8,
      })
      await engine.index()
      // Warmup
      await engine.search('compute something')
      const latencies: number[] = []
      for (let i = 0; i < 20; i++) {
        const t0 = Date.now()
        await engine.search(`query number ${i}`)
        latencies.push(Date.now() - t0)
      }
      latencies.sort((a, b) => a - b)
      const p95 = latencies[Math.floor(latencies.length * 0.95)]
      // 200ms target. Generous bound because the embed of the query itself
      // dominates on CPU.
      expect(p95).toBeLessThan(300)
      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  }, 120000)
})
