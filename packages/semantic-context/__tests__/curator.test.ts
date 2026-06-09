import { describe, expect, test } from 'bun:test'

import { renderContextBlock } from '../src/curator'
import { SemanticContextEngine } from '../src/engine'
import { estimateTokens } from '../src/tokens'
import { DictionaryEmbedder, destroyTmpProject, makeTmpProject, writeFile } from './test-utils'

/** Build a "large" file: `lines` total, with `marker` injected around `markerLine`. */
function bigFile(lines: number, markerLine: number, marker: string): string {
  const out: string[] = []
  for (let i = 0; i < lines; i++) {
    if (i >= markerLine && i < markerLine + 8) {
      out.push(`  ${marker}(${i})`)
    } else {
      out.push(`const a${i} = ${i}`)
    }
  }
  return out.join('\n')
}

describe('ContextCurator (Feature 3 — Smart Context Curation)', () => {
  test('T1.14/T1.15: includes only files above the relevance threshold', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'user.ts', 'export function getUser() { return user }')
      writeFile(root, 'account.ts', 'export function getAccount() { return account }')
      writeFile(root, 'pasta.ts', 'export function cookPasta() { return pasta }')

      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new DictionaryEmbedder(['user', 'account', 'pasta']),
      })
      await engine.index()

      const ctx = await engine.curate('user account', { threshold: 0.5 })
      const paths = ctx.files.map((f) => f.path).sort()
      expect(paths).toEqual(['account.ts', 'user.ts'])
      // Every included file's relevance is in [0,1] and clears the threshold.
      for (const f of ctx.files) {
        expect(f.relevance).toBeGreaterThanOrEqual(0.5)
        expect(f.relevance).toBeLessThanOrEqual(1)
      }
      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('small files are included whole, with relevance recorded', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'user.ts', 'export function getUser() { return user }')
      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new DictionaryEmbedder(['user']),
      })
      await engine.index()

      const ctx = await engine.curate('find the user', { threshold: 0.1 })
      expect(ctx.files).toHaveLength(1)
      const f = ctx.files[0]
      expect(f.content).toContain('getUser')
      expect(f.sections).toBeUndefined()
      expect(f.tokens).toBe(estimateTokens(f.content!))
      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('T1.16: large files are section-extracted, not sent whole', async () => {
    const root = makeTmpProject()
    try {
      // 600-line file whose only "user" mentions sit around line 250.
      writeFile(root, 'big.ts', bigFile(600, 250, 'touchUser'))
      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new DictionaryEmbedder(['user', 'pasta']),
      })
      await engine.index()

      const ctx = await engine.curate('user', { threshold: 0.1, largeFileLines: 80 })
      expect(ctx.files).toHaveLength(1)
      const f = ctx.files[0]
      expect(f.content).toBeUndefined()
      expect(f.sections).toBeDefined()
      expect(f.sections!.length).toBeGreaterThan(0)
      // The extracted section must cover the marker region (~line 251).
      const covers = f.sections!.some((s) => s.startLine <= 251 && s.endLine >= 251)
      expect(covers).toBe(true)
      // And it must be materially smaller than the whole file.
      const wholeTokens = estimateTokens(bigFile(600, 250, 'touchUser'))
      expect(f.tokens).toBeLessThan(wholeTokens * 0.6)
      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('T1.17: debug records every candidate with its relevance and reason', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'user.ts', 'export function getUser() { return user }')
      writeFile(root, 'pasta.ts', 'export function cookPasta() { return pasta }')
      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new DictionaryEmbedder(['user', 'pasta']),
      })
      await engine.index()

      const ctx = await engine.curate('user lookup', { threshold: 0.5, debug: true })
      expect(ctx.debug).toBeDefined()
      const byPath = new Map(ctx.debug!.map((d) => [d.path, d]))
      expect(byPath.get('user.ts')?.included).toBe(true)
      expect(byPath.get('user.ts')?.reason).toBe('included')
      expect(byPath.get('pasta.ts')?.included).toBe(false)
      expect(byPath.get('pasta.ts')?.reason).toBe('below-threshold')
      // Relevance scores are inspectable per the acceptance criterion.
      expect(byPath.get('user.ts')!.relevance).toBeGreaterThan(
        byPath.get('pasta.ts')!.relevance,
      )
      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('T1.18: computeBaseline yields a positive token reduction', async () => {
    const root = makeTmpProject()
    try {
      // One large relevant file (only a slice matters) + several irrelevant ones.
      writeFile(root, 'big.ts', bigFile(600, 250, 'touchUser'))
      writeFile(root, 'pasta.ts', bigFile(600, 250, 'cookPasta'))
      writeFile(root, 'salad.ts', bigFile(600, 250, 'tossSalad'))

      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new DictionaryEmbedder(['user', 'pasta', 'salad']),
      })
      await engine.index()

      const ctx = await engine.curate('user', {
        threshold: 0.1,
        largeFileLines: 80,
        computeBaseline: true,
      })
      expect(ctx.baselineTokens).toBeGreaterThan(0)
      expect(ctx.includedTokens).toBeLessThan(ctx.baselineTokens)
      expect(ctx.reductionRatio).toBeGreaterThan(0)
      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('empty query returns an empty context without embedding', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'user.ts', 'export function getUser() {}')
      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new DictionaryEmbedder(['user']),
      })
      await engine.index()
      const ctx = await engine.curate('   ')
      expect(ctx.files).toHaveLength(0)
      expect(ctx.includedTokens).toBe(0)
      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('renderContextBlock emits a relevant_files block with paths', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'user.ts', 'export function getUser() { return user }')
      const engine = new SemanticContextEngine({
        projectRoot: root,
        embedder: new DictionaryEmbedder(['user']),
      })
      await engine.index()
      const ctx = await engine.curate('user', { threshold: 0.1 })
      const block = renderContextBlock(ctx)
      expect(block).toContain('<relevant_files>')
      expect(block).toContain('user.ts')
      expect(block).toContain('getUser')
      expect(block).toContain('</relevant_files>')

      // Empty context renders to empty string.
      expect(renderContextBlock({ ...ctx, files: [] })).toBe('')
      await engine.close()
    } finally {
      destroyTmpProject(root)
    }
  })
})
