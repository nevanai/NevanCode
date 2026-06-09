import { describe, expect, test } from 'bun:test'

import { walkProject } from '../src/walker'
import { destroyTmpProject, makeTmpProject, writeFile } from './test-utils'

describe('walker', () => {
  test('returns indexable files only', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'src/a.ts', 'export const a = 1')
      writeFile(root, 'src/b.py', 'a = 1')
      writeFile(root, 'README.md', '# hi')
      writeFile(root, 'image.png', 'binary')
      writeFile(root, 'package.json', '{}')

      const files = await walkProject(root)
      const rel = files.map((f) => f.relPath).sort()
      expect(rel).toContain('src/a.ts')
      expect(rel).toContain('src/b.py')
      expect(rel).toContain('README.md')
      expect(rel).not.toContain('image.png')
      expect(rel).not.toContain('package.json')
    } finally {
      destroyTmpProject(root)
    }
  })

  test('ALWAYS_IGNORE excludes node_modules, .git, .nevan', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'src/a.ts', '')
      writeFile(root, 'node_modules/dep/lib.ts', '')
      writeFile(root, '.git/HEAD', '')
      writeFile(root, '.nevan/index.db', '')
      writeFile(root, 'dist/built.ts', '')

      const files = await walkProject(root)
      const rel = files.map((f) => f.relPath)
      expect(rel).toContain('src/a.ts')
      expect(rel).not.toContain('node_modules/dep/lib.ts')
      expect(rel.some((p) => p.includes('.git/'))).toBe(false)
      expect(rel.some((p) => p.includes('.nevan'))).toBe(false)
      expect(rel.some((p) => p.startsWith('dist/'))).toBe(false)
    } finally {
      destroyTmpProject(root)
    }
  })

  test('honors .gitignore at root and in subdirs', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, '.gitignore', 'ignored-at-root.ts\nsubdir/secret/\n')
      writeFile(root, 'src/sub/.gitignore', 'sub-ignored.ts\n')
      writeFile(root, 'ignored-at-root.ts', '')
      writeFile(root, 'kept.ts', '')
      writeFile(root, 'subdir/secret/leaked.ts', '')
      writeFile(root, 'src/sub/sub-ignored.ts', '')
      writeFile(root, 'src/sub/kept.ts', '')

      const files = await walkProject(root)
      const rel = files.map((f) => f.relPath).sort()
      expect(rel).toContain('kept.ts')
      expect(rel).toContain('src/sub/kept.ts')
      expect(rel).not.toContain('ignored-at-root.ts')
      expect(rel).not.toContain('subdir/secret/leaked.ts')
      expect(rel).not.toContain('src/sub/sub-ignored.ts')
    } finally {
      destroyTmpProject(root)
    }
  })

  test('.nevanignore is honored', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, '.nevanignore', 'private.ts\n')
      writeFile(root, 'private.ts', '')
      writeFile(root, 'public.ts', '')

      const files = await walkProject(root)
      const rel = files.map((f) => f.relPath)
      expect(rel).toContain('public.ts')
      expect(rel).not.toContain('private.ts')
    } finally {
      destroyTmpProject(root)
    }
  })

  test('maxFiles caps result size', async () => {
    const root = makeTmpProject()
    try {
      for (let i = 0; i < 20; i++) writeFile(root, `f${i}.ts`, '')
      const files = await walkProject(root, { maxFiles: 5 })
      expect(files.length).toBe(5)
    } finally {
      destroyTmpProject(root)
    }
  })

  test('onFile is invoked once per discovered file', async () => {
    const root = makeTmpProject()
    try {
      writeFile(root, 'a.ts', '')
      writeFile(root, 'b.ts', '')
      const seen: string[] = []
      const files = await walkProject(root, { onFile: (f) => seen.push(f.relPath) })
      expect(seen.length).toBe(files.length)
      expect(new Set(seen)).toEqual(new Set(files.map((f) => f.relPath)))
    } finally {
      destroyTmpProject(root)
    }
  })
})
