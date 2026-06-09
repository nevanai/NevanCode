import { describe, expect, test } from 'bun:test'

import { writeFileSync } from 'fs'
import { join } from 'path'

import { hashString, quickStamp, stampFile } from '../src/hasher'
import { destroyTmpProject, makeTmpProject } from './test-utils'

describe('hasher', () => {
  test('stampFile returns content hash + size + mtime', async () => {
    const root = makeTmpProject()
    try {
      const file = join(root, 'x.ts')
      writeFileSync(file, 'hello world')
      const s = await stampFile(file)
      expect(s.size).toBe(11)
      expect(typeof s.mtimeMs).toBe('number')
      expect(s.contentHash).toMatch(/^[0-9a-f]{40}$/)
    } finally {
      destroyTmpProject(root)
    }
  })

  test('identical content → identical hash; different content → different hash', async () => {
    const root = makeTmpProject()
    try {
      const a = join(root, 'a.ts')
      const b = join(root, 'b.ts')
      const c = join(root, 'c.ts')
      writeFileSync(a, 'same')
      writeFileSync(b, 'same')
      writeFileSync(c, 'different')
      const [sa, sb, sc] = await Promise.all([stampFile(a), stampFile(b), stampFile(c)])
      expect(sa.contentHash).toBe(sb.contentHash)
      expect(sa.contentHash).not.toBe(sc.contentHash)
    } finally {
      destroyTmpProject(root)
    }
  })

  test('quickStamp returns size + mtime without reading content', async () => {
    const root = makeTmpProject()
    try {
      const file = join(root, 'x.ts')
      writeFileSync(file, 'abc')
      const s = await quickStamp(file)
      expect(s.size).toBe(3)
      expect(typeof s.mtimeMs).toBe('number')
    } finally {
      destroyTmpProject(root)
    }
  })

  test('hashString is deterministic SHA1', () => {
    expect(hashString('hello')).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d')
  })
})
