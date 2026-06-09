import { describe, expect, test } from 'bun:test'

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { HashFallbackEmbedder, SemanticContextEngine } from '@codebuff/semantic-context'

import {
  parseContextArgs,
  runContextCommand,
  type ContextCommandIO,
} from '../context-command'

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'nevan-context-cmd-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/user.ts'), 'export function getUser() { return user }')
  writeFileSync(join(root, 'src/pasta.ts'), 'export function cookPasta() { return pasta }')
  return root
}

function makeIO(cwd: string): ContextCommandIO & { out: string; err: string } {
  const sink = {
    cwd,
    out: '',
    err: '',
    write(s: string) {
      this.out += s
    },
    writeErr(s: string) {
      this.err += s
    },
  }
  return sink
}

const createEngine = (projectRoot: string) =>
  new SemanticContextEngine({ projectRoot, embedder: new HashFallbackEmbedder(64) })

describe('parseContextArgs', () => {
  test('joins query words and defaults flags off', () => {
    const a = parseContextArgs(['find', 'the', 'user'])
    expect(a.query).toBe('find the user')
    expect(a.debug).toBe(false)
    expect(a.json).toBe(false)
    expect(a.threshold).toBeUndefined()
  })

  test('parses --debug, --json, --threshold, --top-k, --max-files, --cwd', () => {
    const a = parseContextArgs([
      'q', '--debug', '--json', '--threshold', '0.5', '--top-k', '10', '--max-files', '3', '--cwd', '/tmp/x',
    ])
    expect(a.query).toBe('q')
    expect(a.debug).toBe(true)
    expect(a.json).toBe(true)
    expect(a.threshold).toBe(0.5)
    expect(a.topK).toBe(10)
    expect(a.maxFiles).toBe(3)
    expect(a.cwd).toBe('/tmp/x')
  })

  test('ignores out-of-range threshold and supports --threshold= form', () => {
    expect(parseContextArgs(['q', '--threshold', '5']).threshold).toBeUndefined()
    expect(parseContextArgs(['q', '--threshold=0.4']).threshold).toBe(0.4)
  })

  test('--help is recognized', () => {
    expect(parseContextArgs(['--help']).help).toBe(true)
  })

  test('does not absorb unknown flags into the query', () => {
    const a = parseContextArgs(['--debug', 'hello'])
    expect(a.query).toBe('hello')
  })
})

describe('runContextCommand', () => {
  test('missing query prints usage and exits 1', async () => {
    const io = makeIO(process.cwd())
    const code = await runContextCommand(['--debug'], io, { createEngine })
    expect(code).toBe(1)
    expect(io.err).toContain('Usage:')
  })

  test('--help prints usage and exits 0', async () => {
    const io = makeIO(process.cwd())
    const code = await runContextCommand(['--help'], io, { createEngine })
    expect(code).toBe(0)
    expect(io.out).toContain('Usage:')
  })

  test('curates and prints relevant files (human output)', async () => {
    const root = makeProject()
    try {
      const io = makeIO(root)
      const code = await runContextCommand(['getUser', '--threshold', '0'], io, { createEngine })
      expect(code).toBe(0)
      expect(io.out).toContain('user.ts')
      expect(io.out).toContain('Relevant files for:')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('--debug prints the per-candidate score table and reduction stats', async () => {
    const root = makeProject()
    try {
      const io = makeIO(root)
      const code = await runContextCommand(['getUser', '--threshold', '0', '--debug'], io, { createEngine })
      expect(code).toBe(0)
      expect(io.out).toContain('candidate scores')
      expect(io.out).toContain('cosine')
      expect(io.out).toContain('reduction')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('--json emits a parseable CuratedContext', async () => {
    const root = makeProject()
    try {
      const io = makeIO(root)
      const code = await runContextCommand(['getUser', '--threshold', '0', '--json'], io, { createEngine })
      expect(code).toBe(0)
      const parsed = JSON.parse(io.out)
      expect(parsed.query).toBe('getUser')
      expect(Array.isArray(parsed.files)).toBe(true)
      expect(typeof parsed.reductionRatio).toBe('number')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('--cwd overrides the project root', async () => {
    const root = makeProject()
    try {
      const io = makeIO(process.cwd())
      const code = await runContextCommand(['getUser', '--threshold', '0', '--cwd', root], io, { createEngine })
      expect(code).toBe(0)
      expect(io.out).toContain('user.ts')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
