import { afterEach, describe, expect, test } from 'bun:test'

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { HashFallbackEmbedder, SemanticContextEngine } from '@codebuff/semantic-context'

import { curateRelevantFilesBlock, stopSemanticContext } from '../semantic-context'

/**
 * Guard-path tests for the live per-turn curation injection (Feature 3). The
 * full curate→render behavior is covered deterministically by the
 * semantic-context package's curator tests and the context-command tests; here
 * we only assert the safe-default short-circuits so a broken/disabled index can
 * never block or corrupt a user turn.
 */
describe('curateRelevantFilesBlock (live injection guards)', () => {
  afterEach(async () => {
    await stopSemanticContext().catch(() => {})
  })

  test('returns empty string when injection is disabled via env', async () => {
    const prev = process.env.NEVAN_CONTEXT_INJECTION
    process.env.NEVAN_CONTEXT_INJECTION = '0'
    try {
      expect(await curateRelevantFilesBlock('anything relevant')).toBe('')
    } finally {
      if (prev === undefined) delete process.env.NEVAN_CONTEXT_INJECTION
      else process.env.NEVAN_CONTEXT_INJECTION = prev
    }
  })

  test('returns empty string when there is no active engine', async () => {
    await stopSemanticContext().catch(() => {})
    expect(await curateRelevantFilesBlock('some query')).toBe('')
  })

  test('returns empty string for an empty query', async () => {
    expect(await curateRelevantFilesBlock('   ')).toBe('')
  })

  test('produces a <relevant_files> block for a ready, populated engine', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nevan-inject-fire-'))
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src/user.ts'), 'export function getUser() { return user }')
    // threshold 0 ⇒ relevance (max(0,cosine)) always clears it, so a deterministic
    // HashFallbackEmbedder is enough to prove the live path renders a block.
    const prev = process.env.NEVAN_CURATION_THRESHOLD
    process.env.NEVAN_CURATION_THRESHOLD = '0'
    const engine = new SemanticContextEngine({
      projectRoot: root,
      embedder: new HashFallbackEmbedder(32),
    })
    try {
      await engine.index() // phase → 'done', count > 0 (the readiness gate)
      const block = await curateRelevantFilesBlock('getUser', engine)
      expect(block).toContain('<relevant_files>')
      expect(block).toContain('src/user.ts')
    } finally {
      if (prev === undefined) delete process.env.NEVAN_CURATION_THRESHOLD
      else process.env.NEVAN_CURATION_THRESHOLD = prev
      await engine.close().catch(() => {})
      rmSync(root, { recursive: true, force: true })
    }
  })
})
