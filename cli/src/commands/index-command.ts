/**
 * Headless multi-repo commands (Feature 4 — Cross-Repository Awareness):
 *
 *   nevan index --repos ./service-a ./service-b ./shared-lib
 *   nevan index --org github.com/myorg
 *   nevan impact <symbol>          # who defines / who calls it, across repos
 *
 * `index` builds (or incrementally refreshes) a unified workspace over several
 * repos and persists the registry to `<cwd>/.nevan/workspace.json`. `impact`
 * reloads that workspace and reports a symbol's definitions + call sites across
 * every repo — the T2.5 "change a function in service-a, see its callers in
 * service-b" capability.
 *
 * Core logic is pure over an injected IO + provider/embedder so the GitHub
 * network/git path is unit-testable with a fake provider.
 */

import { existsSync, statSync } from 'fs'
import * as path from 'path'

import {
  GitHubRepoProvider,
  MultiRepoWorkspace,
  parseOrgFromUrl,
} from '@codebuff/semantic-context'

import type {
  Embedder,
  RepoIndexResult,
  RepoProvider,
} from '@codebuff/semantic-context'

export interface MultiRepoIO {
  cwd: string
  write: (s: string) => void
  writeErr: (s: string) => void
}

// ---------------------------------------------------------------------------
// nevan index
// ---------------------------------------------------------------------------

export interface ParsedIndexArgs {
  repos: string[]
  org?: string
  json: boolean
  cwd?: string
  help: boolean
}

const INDEX_USAGE =
  'Usage:\n' +
  '  nevan index --repos <dir> [<dir> ...]   index multiple local repos\n' +
  '  nevan index --org <github-url>          index every repo in a GitHub org\n' +
  '  [--json] [--cwd <dir>]\n'

export function parseIndexArgs(argv: string[]): ParsedIndexArgs {
  const out: ParsedIndexArgs = { repos: [], json: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') {
      out.json = true
    } else if (a === '-h' || a === '--help') {
      out.help = true
    } else if (a === '--cwd') {
      out.cwd = argv[++i]
    } else if (a === '--org') {
      out.org = argv[++i]
    } else if (a === '--repos') {
      // Consume every following non-flag token as a repo path.
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        out.repos.push(argv[++i])
      }
    }
  }
  return out
}

export interface IndexCommandDeps {
  embedder?: Embedder
  /** Provider for `--org`. Defaults to the live GitHub provider. */
  provider?: RepoProvider
  githubToken?: string
  /** Where `--org` clones repos. Defaults to `<cwd>/.nevan-workspace/<org>`. */
  workspaceDir?: string
}

function formatRepoLine(r: RepoIndexResult): string {
  if (r.error) return `  ✗ ${r.id.padEnd(20)} error: ${r.error}`
  const s = r.summary
  const cache = r.changed ? `${s.indexedFiles} new` : 'cached'
  const secs = (s.elapsedMs / 1000).toFixed(1)
  return `  ✓ ${r.id.padEnd(20)} ${String(s.totalFiles).padStart(5)} files (${cache})  ${secs}s`
}

async function indexWorkspace(
  ws: MultiRepoWorkspace,
  io: MultiRepoIO,
  json: boolean,
): Promise<number> {
  const results = await ws.indexAll((r) => {
    if (!json) io.write(formatRepoLine(r) + '\n')
  })
  await ws.save(io.cwd)

  const totalFiles = results.reduce((n, r) => n + r.summary.totalFiles, 0)
  const failed = results.filter((r) => r.error)
  if (json) {
    io.write(JSON.stringify({ repos: results, totalFiles }, null, 2) + '\n')
  } else {
    io.write(
      `\nWorkspace indexed: ${results.length} repo${results.length === 1 ? '' : 's'}, ` +
        `${totalFiles} files. Saved to ${path.join('.nevan', 'workspace.json')}\n`,
    )
    io.write('Tip: `nevan impact <symbol>` shows cross-repo definitions & call sites.\n')
  }
  return failed.length > 0 ? 1 : 0
}

export async function runIndexCommand(
  argv: string[],
  io: MultiRepoIO,
  deps: IndexCommandDeps = {},
): Promise<number> {
  const args = parseIndexArgs(argv)
  if (args.help) {
    io.write(INDEX_USAGE)
    return 0
  }
  const cwd = args.cwd ?? io.cwd
  const ioForCwd: MultiRepoIO = { ...io, cwd }

  if (args.org) {
    return runOrgIndex(args.org, ioForCwd, deps)
  }

  if (args.repos.length === 0) {
    io.writeErr(INDEX_USAGE)
    return 1
  }

  // Validate every repo path before doing any work.
  const roots: string[] = []
  for (const repo of args.repos) {
    const abs = path.resolve(cwd, repo)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      io.writeErr(`Not a directory: ${repo}\n`)
      return 1
    }
    roots.push(abs)
  }

  const ws = new MultiRepoWorkspace({ repos: roots, embedder: deps.embedder })
  try {
    if (!args.json) io.write(`Indexing ${roots.length} repositories…\n`)
    return await indexWorkspace(ws, ioForCwd, args.json)
  } catch (err) {
    io.writeErr(`index failed: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  } finally {
    await ws.close().catch(() => {})
  }
}

async function runOrgIndex(
  orgUrl: string,
  io: MultiRepoIO,
  deps: IndexCommandDeps,
): Promise<number> {
  const org = parseOrgFromUrl(orgUrl)
  if (!org) {
    io.writeErr(`Could not parse an org/user from "${orgUrl}"\n`)
    return 1
  }
  const provider = deps.provider ?? new GitHubRepoProvider(deps.githubToken)
  const workspaceDir = deps.workspaceDir ?? path.join(io.cwd, '.nevan-workspace', org)

  let repos
  try {
    io.write(`Listing repositories for ${org}…\n`)
    repos = await provider.listRepos(org)
  } catch (err) {
    io.writeErr(`Failed to list repos for "${org}": ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
  if (repos.length === 0) {
    io.writeErr(`No repositories found for "${org}".\n`)
    return 1
  }

  const roots: string[] = []
  for (const repo of repos) {
    try {
      io.write(`  cloning ${repo.name}…\n`)
      roots.push(await provider.cloneRepo(repo, workspaceDir))
    } catch (err) {
      io.writeErr(`  skip ${repo.name}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
  if (roots.length === 0) {
    io.writeErr('No repositories could be cloned.\n')
    return 1
  }

  const ws = new MultiRepoWorkspace({ repos: roots, embedder: deps.embedder })
  try {
    io.write(`Indexing ${roots.length} repositories…\n`)
    return await indexWorkspace(ws, io, false)
  } catch (err) {
    io.writeErr(`index failed: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  } finally {
    await ws.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// nevan impact
// ---------------------------------------------------------------------------

export interface ParsedImpactArgs {
  symbol: string
  json: boolean
  cwd?: string
  help: boolean
}

const IMPACT_USAGE = 'Usage: nevan impact <symbol> [--json] [--cwd <dir>]\n'

export function parseImpactArgs(argv: string[]): ParsedImpactArgs {
  const out: ParsedImpactArgs = { symbol: '', json: false, help: false }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '-h' || a === '--help') out.help = true
    else if (a === '--cwd') out.cwd = argv[++i]
    else if (!a.startsWith('-')) positional.push(a)
  }
  out.symbol = positional[0] ?? ''
  return out
}

export interface ImpactCommandDeps {
  embedder?: Embedder
}

export async function runImpactCommand(
  argv: string[],
  io: MultiRepoIO,
  deps: ImpactCommandDeps = {},
): Promise<number> {
  const args = parseImpactArgs(argv)
  if (args.help) {
    io.write(IMPACT_USAGE)
    return 0
  }
  if (!args.symbol) {
    io.writeErr(IMPACT_USAGE)
    return 1
  }
  const cwd = args.cwd ?? io.cwd

  const ws = await MultiRepoWorkspace.load(cwd, { embedder: deps.embedder })
  if (!ws) {
    io.writeErr(
      'No workspace found. Run `nevan index --repos <dirs>` or `nevan index --org <url>` first.\n',
    )
    return 1
  }

  try {
    const impact = await ws.impactOf(args.symbol)
    if (args.json) {
      io.write(JSON.stringify(impact, null, 2) + '\n')
      return 0
    }

    const tag = impact.crossRepo ? '  (cross-repo ✓)' : ''
    io.write(`Symbol: ${impact.symbol}${tag}\n`)
    if (impact.ambiguous) {
      io.write('  ⚠ common/ambiguous name — matches are by bare symbol name and may over-report.\n')
    }
    if (impact.definitions.length === 0 && impact.callSites.length === 0) {
      io.write('  No definitions or call sites found in the indexed workspace.\n')
      return 0
    }
    io.write('Defined in:\n')
    if (impact.definitions.length === 0) io.write('  (none found)\n')
    for (const d of impact.definitions) io.write(`  ${d.repoId.padEnd(20)} ${d.path}\n`)
    io.write('Called from:\n')
    if (impact.callSites.length === 0) io.write('  (none found)\n')
    for (const c of impact.callSites) io.write(`  ${c.repoId.padEnd(20)} ${c.path}\n`)
    return 0
  } catch (err) {
    io.writeErr(`impact failed: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  } finally {
    await ws.close().catch(() => {})
  }
}
