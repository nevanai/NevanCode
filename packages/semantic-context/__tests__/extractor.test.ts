import { describe, expect, test } from 'bun:test'

import { extractFile } from '../src/extractor'
import { destroyTmpProject, makeTmpProject, writeFile } from './test-utils'

describe('extractor', () => {
  test('extracts TypeScript identifiers and calls', async () => {
    const root = makeTmpProject()
    try {
      writeFile(
        root,
        'user.ts',
        `
export class UserService {
  constructor(private db: Database) {}
  async getUserById(id: string) {
    return this.db.users.find(id)
  }
}
`,
      )
      const r = await extractFile(root, 'user.ts')
      expect(r).not.toBeNull()
      expect(r!.record.language).toBe('typescript')
      expect(r!.record.identifiers).toContain('UserService')
      expect(r!.record.identifiers).toContain('getUserById')
      expect(r!.record.calls).toContain('find')
      expect(r!.embeddingText).toContain('symbols:')
      expect(r!.embeddingText).toContain('UserService')
    } finally {
      destroyTmpProject(root)
    }
  })

  test('extracts Python identifiers and calls', async () => {
    const root = makeTmpProject()
    try {
      writeFile(
        root,
        'svc.py',
        `
def fetch_user(user_id):
    result = database.users.find(user_id)
    return result
`,
      )
      const r = await extractFile(root, 'svc.py')
      expect(r).not.toBeNull()
      expect(r!.record.language).toBe('python')
      expect(r!.record.identifiers).toContain('fetch_user')
    } finally {
      destroyTmpProject(root)
    }
  })

  test('markdown returns empty symbol lists but is still indexable', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'doc.md', '# Hello\n\nSome words.')
      const r = await extractFile(root, 'doc.md')
      expect(r).not.toBeNull()
      expect(r!.record.language).toBe('markdown')
      expect(r!.record.identifiers).toEqual([])
      expect(r!.embeddingText).toContain('Hello')
    } finally {
      destroyTmpProject(root)
    }
  })

  test('returns null for binary content (NUL byte heuristic)', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'bin.ts', 'hello\0world')
      const r = await extractFile(root, 'bin.ts')
      expect(r).toBeNull()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('returns null for missing files', async () => {
    const root = makeTmpProject()
    try {
      const r = await extractFile(root, 'nope.ts')
      expect(r).toBeNull()
    } finally {
      destroyTmpProject(root)
    }
  })

  test('contentHash is stable across calls', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'a.ts', 'const x = 1')
      const r1 = await extractFile(root, 'a.ts')
      const r2 = await extractFile(root, 'a.ts')
      expect(r1?.record.contentHash).toBe(r2?.record.contentHash)
    } finally {
      destroyTmpProject(root)
    }
  })
})
