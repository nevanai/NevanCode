import { describe, expect, test } from 'bun:test'

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'

import { HashFallbackEmbedder } from '../src/embedder'
import { MultiRepoWorkspace, normalizeRepos } from '../src/workspace'
import { DictionaryEmbedder } from './test-utils'

function makeRepo(label: string, files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), `nevan-ws-${label}-`))
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

describe('normalizeRepos', () => {
  test('dedupes colliding basenames with a numeric suffix', () => {
    const norm = normalizeRepos(['/x/svc', '/y/svc', '/z/other'])
    expect(norm.map((r) => r.id)).toEqual(['svc', 'svc-2', 'other'])
    expect(norm.every((r) => path.isAbsolute(r.root))).toBe(true)
  })

  test('honors explicit ids', () => {
    const norm = normalizeRepos([{ id: 'api', root: '/x/whatever' }])
    expect(norm[0].id).toBe('api')
  })
})

describe('MultiRepoWorkspace (Feature 4 — Cross-Repository Awareness)', () => {
  test('T2.1: unified search returns hits tagged by repo, ranked across repos', async () => {
    const a = makeRepo('a', { 'src/user.ts': 'export function getUser() { return user }' })
    const b = makeRepo('b', { 'src/order.ts': 'export function getOrder() { return order }' })
    const ws = new MultiRepoWorkspace({
      repos: [{ id: 'service-a', root: a }, { id: 'service-b', root: b }],
      embedder: new DictionaryEmbedder(['user', 'order']),
    })
    try {
      await ws.indexAll()
      const hits = await ws.search('user', { topK: 5, threshold: 0 })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0].repoId).toBe('service-a')
      expect(hits[0].path).toBe('src/user.ts')
      for (const h of hits) {
        expect(typeof h.repoRoot).toBe('string')
        expect(h.score).toBeLessThanOrEqual(1)
      }
    } finally {
      await ws.close()
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  test('T2.5: impactOf finds a function defined in one repo and called in another', async () => {
    const a = makeRepo('a', { 'src/users.ts': 'export function fetchUserProfile() { return 42 }' })
    const b = makeRepo('b', { 'src/handler.ts': 'export function handle() { return fetchUserProfile() }' })
    const ws = new MultiRepoWorkspace({
      repos: [{ id: 'service-a', root: a }, { id: 'service-b', root: b }],
      embedder: new HashFallbackEmbedder(32),
    })
    try {
      await ws.indexAll()
      const impact = await ws.impactOf('fetchUserProfile')
      expect(impact.definitions.map((d) => d.repoId)).toEqual(['service-a'])
      expect(impact.definitions[0].path).toBe('src/users.ts')
      expect(impact.callSites.map((c) => c.repoId)).toEqual(['service-b'])
      expect(impact.callSites[0].path).toBe('src/handler.ts')
      expect(impact.crossRepo).toBe(true)
      expect(impact.ambiguous).toBe(false)
    } finally {
      await ws.close()
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  test('common symbol names are flagged ambiguous', async () => {
    const a = makeRepo('a', { 'src/x.ts': 'export function run() { return 1 }' })
    const ws = new MultiRepoWorkspace({ repos: [a], embedder: new HashFallbackEmbedder(16) })
    try {
      await ws.indexAll()
      const impact = await ws.impactOf('run')
      expect(impact.ambiguous).toBe(true)
    } finally {
      await ws.close()
      rmSync(a, { recursive: true, force: true })
    }
  })

  test('T2.4: apiContracts surfaces defined symbols per repo', async () => {
    const a = makeRepo('a', { 'src/users.ts': 'export function fetchUserProfile() { return 42 }' })
    const ws = new MultiRepoWorkspace({
      repos: [{ id: 'service-a', root: a }],
      embedder: new HashFallbackEmbedder(16),
    })
    try {
      await ws.indexAll()
      const contracts = await ws.apiContracts('service-a')
      expect(
        contracts.some((c) => c.symbol === 'fetchUserProfile' && c.repoId === 'service-a'),
      ).toBe(true)
    } finally {
      await ws.close()
      rmSync(a, { recursive: true, force: true })
    }
  })

  test('T2.6: re-indexing an unchanged repo reports changed=false (incremental)', async () => {
    const a = makeRepo('a', { 'src/x.ts': 'export const x = 1' })
    const ws = new MultiRepoWorkspace({ repos: [a], embedder: new HashFallbackEmbedder(16) })
    try {
      const first = await ws.indexAll()
      expect(first[0].changed).toBe(true)
      expect(first[0].summary.indexedFiles).toBe(1)

      const second = await ws.indexAll()
      expect(second[0].changed).toBe(false)
      expect(second[0].summary.skippedFiles).toBe(1)
      expect(second[0].summary.indexedFiles).toBe(0)
    } finally {
      await ws.close()
      rmSync(a, { recursive: true, force: true })
    }
  })

  test('save/load round-trips the repo registry', async () => {
    const a = makeRepo('a', { 'src/x.ts': 'export const x = 1' })
    const b = makeRepo('b', { 'src/y.ts': 'export const y = 2' })
    const cwd = mkdtempSync(path.join(tmpdir(), 'nevan-ws-cwd-'))
    const ws = new MultiRepoWorkspace({ repos: [a, b], embedder: new HashFallbackEmbedder(16) })
    try {
      await ws.indexAll()
      await ws.save(cwd)

      const loaded = await MultiRepoWorkspace.load(cwd, { embedder: new HashFallbackEmbedder(16) })
      expect(loaded).not.toBeNull()
      expect(loaded!.repos.map((r) => r.root).sort()).toEqual(
        [path.resolve(a), path.resolve(b)].sort(),
      )
      await loaded!.close()

      // No manifest → null.
      const empty = mkdtempSync(path.join(tmpdir(), 'nevan-ws-empty-'))
      expect(await MultiRepoWorkspace.load(empty, { embedder: new HashFallbackEmbedder(16) })).toBeNull()
      rmSync(empty, { recursive: true, force: true })
    } finally {
      await ws.close()
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
