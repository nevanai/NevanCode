import { describe, expect, test } from 'bun:test'

import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'

import { HashFallbackEmbedder } from '../src/embedder'
import { SemanticContextEngine } from '../src/engine'
import { IndexWatcher } from '../src/watcher'
import { destroyTmpProject, makeTmpProject, writeFile } from './test-utils'

const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('IndexWatcher', () => {
  test('add → indexed; change → indexed; unlink → removed', async () => {
    const root = makeTmpProject()
    const engine = new SemanticContextEngine({
      projectRoot: root,
      embedder: new HashFallbackEmbedder(16),
    })
    try {
      writeFile(root, 'a.ts', 'export const a = 1')
      await engine.index()
      expect(engine.count()).toBe(1)

      const events: Array<[string, string]> = []
      const watcher = new IndexWatcher(engine, {
        debounceMs: 25,
        onChange: (p, r) => events.push([p, r]),
      })
      await watcher.start()
      await settle(500)

      writeFileSync(join(root, 'b.ts'), 'export const b = 2')
      writeFileSync(join(root, 'a.ts'), 'export const a = 999')
      await settle(800)
      await watcher.drain()

      expect(events.some((e) => e[0] === 'b.ts' && e[1] === 'indexed')).toBe(true)
      expect(events.some((e) => e[0] === 'a.ts' && e[1] === 'indexed')).toBe(true)
      expect(engine.count()).toBe(2)

      unlinkSync(join(root, 'a.ts'))
      await settle(800)
      await watcher.drain()

      expect(events.some((e) => e[0] === 'a.ts' && e[1] === 'removed')).toBe(true)
      expect(engine.count()).toBe(1)

      await watcher.stop()
    } finally {
      await engine.close().catch(() => {})
      destroyTmpProject(root)
    }
  }, 15000)

  test('rapid writes are debounced to a single re-index', async () => {
    const root = makeTmpProject()
    const engine = new SemanticContextEngine({
      projectRoot: root,
      embedder: new HashFallbackEmbedder(16),
    })
    try {
      writeFile(root, 'a.ts', 'export const a = 1')
      await engine.index()

      const events: Array<[string, string]> = []
      const watcher = new IndexWatcher(engine, {
        debounceMs: 200,
        onChange: (p, r) => events.push([p, r]),
      })
      await watcher.start()
      await settle(500)

      // 5 rapid writes within debounce window
      for (let i = 1; i <= 5; i++) {
        writeFileSync(join(root, 'a.ts'), `export const a = ${i}`)
        await settle(30)
      }
      await settle(800)
      await watcher.drain()

      const aIndexes = events.filter((e) => e[0] === 'a.ts').length
      // Strictly fewer than 5 — debouncing should collapse rapid writes.
      expect(aIndexes).toBeLessThanOrEqual(2)

      await watcher.stop()
    } finally {
      await engine.close().catch(() => {})
      destroyTmpProject(root)
    }
  }, 15000)
})
