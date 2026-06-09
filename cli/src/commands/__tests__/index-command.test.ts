import { describe, expect, test } from 'bun:test'

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { HashFallbackEmbedder } from '@codebuff/semantic-context'

import {
  parseImpactArgs,
  parseIndexArgs,
  runImpactCommand,
  runIndexCommand,
  type MultiRepoIO,
} from '../index-command'

import type { OrgRepo, RepoProvider } from '@codebuff/semantic-context'

function makeRepo(label: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `nevan-idxcmd-${label}-`))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return root
}

function makeIO(cwd: string): MultiRepoIO & { out: string; err: string } {
  // Closures over locals (not `this`) so the IO survives `{...io}` spreads
  // inside the command (which rebinds `this`).
  let out = ''
  let err = ''
  return {
    cwd,
    write: (s: string) => {
      out += s
    },
    writeErr: (s: string) => {
      err += s
    },
    get out() {
      return out
    },
    get err() {
      return err
    },
  }
}

const embedder = () => new HashFallbackEmbedder(16)

/** Fake org provider: "clones" by fabricating local dirs with a tiny TS file. */
class FakeProvider implements RepoProvider {
  async listRepos(_org: string): Promise<OrgRepo[]> {
    return [
      { name: 'svc-a', cloneUrl: 'fake://svc-a' },
      { name: 'svc-b', cloneUrl: 'fake://svc-b' },
    ]
  }
  async cloneRepo(repo: OrgRepo, destParentDir: string): Promise<string> {
    const dest = join(destParentDir, repo.name)
    mkdirSync(join(dest, 'src'), { recursive: true })
    writeFileSync(join(dest, 'src/f.ts'), `export function ${repo.name.replace(/-/g, '_')}() { return 1 }\n`)
    return dest
  }
}

describe('parseIndexArgs / parseImpactArgs', () => {
  test('--repos consumes all following non-flag paths', () => {
    const a = parseIndexArgs(['--repos', './a', './b', './c', '--json'])
    expect(a.repos).toEqual(['./a', './b', './c'])
    expect(a.json).toBe(true)
  })

  test('--org and --cwd parse', () => {
    const a = parseIndexArgs(['--org', 'github.com/x', '--cwd', '/tmp/y'])
    expect(a.org).toBe('github.com/x')
    expect(a.cwd).toBe('/tmp/y')
  })

  test('impact takes the first positional as the symbol', () => {
    const a = parseImpactArgs(['fetchUser', '--json'])
    expect(a.symbol).toBe('fetchUser')
    expect(a.json).toBe(true)
  })
})

describe('runIndexCommand --repos + runImpactCommand', () => {
  test('indexes local repos, saves a workspace, and resolves cross-repo impact', async () => {
    const a = makeRepo('a', { 'src/users.ts': 'export function fetchUserProfile() { return 42 }' })
    const b = makeRepo('b', { 'src/handler.ts': 'export function handle() { return fetchUserProfile() }' })
    const cwd = mkdtempSync(join(tmpdir(), 'nevan-idxcmd-cwd-'))
    try {
      const io = makeIO(cwd)
      const code = await runIndexCommand(['--repos', a, b], io, { embedder: embedder() })
      expect(code).toBe(0)
      expect(io.out).toContain('Workspace indexed')
      expect(existsSync(join(cwd, '.nevan', 'workspace.json'))).toBe(true)

      // Now query impact over the saved workspace.
      const io2 = makeIO(cwd)
      const code2 = await runImpactCommand(['fetchUserProfile'], io2, { embedder: embedder() })
      expect(code2).toBe(0)
      expect(io2.out).toContain('cross-repo')
      expect(io2.out).toContain('src/users.ts')
      expect(io2.out).toContain('src/handler.ts')
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('missing --repos/--org prints usage and exits 1', async () => {
    const io = makeIO(process.cwd())
    const code = await runIndexCommand([], io, { embedder: embedder() })
    expect(code).toBe(1)
    expect(io.err).toContain('Usage:')
  })

  test('a non-existent repo path fails fast', async () => {
    const io = makeIO(process.cwd())
    const code = await runIndexCommand(['--repos', '/no/such/dir/xyz'], io, { embedder: embedder() })
    expect(code).toBe(1)
    expect(io.err).toContain('Not a directory')
  })
})

describe('runIndexCommand --org (fake provider)', () => {
  test('lists, clones, and indexes org repos', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nevan-idxcmd-org-'))
    const workspaceDir = mkdtempSync(join(tmpdir(), 'nevan-idxcmd-clones-'))
    try {
      const io = makeIO(cwd)
      const code = await runIndexCommand(['--org', 'github.com/myorg'], io, {
        embedder: embedder(),
        provider: new FakeProvider(),
        workspaceDir,
      })
      expect(code).toBe(0)
      expect(io.out).toContain('cloning svc-a')
      expect(io.out).toContain('Workspace indexed')
      expect(existsSync(join(cwd, '.nevan', 'workspace.json'))).toBe(true)

      // The cloned repos' symbols are queryable.
      const io2 = makeIO(cwd)
      await runImpactCommand(['svc_a'], io2, { embedder: embedder() })
      expect(io2.out).toContain('svc-a')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(workspaceDir, { recursive: true, force: true })
    }
  })
})

describe('runImpactCommand without a workspace', () => {
  test('explains how to build one', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nevan-idxcmd-nows-'))
    try {
      const io = makeIO(cwd)
      const code = await runImpactCommand(['anySymbol'], io, { embedder: embedder() })
      expect(code).toBe(1)
      expect(io.err).toContain('No workspace found')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
