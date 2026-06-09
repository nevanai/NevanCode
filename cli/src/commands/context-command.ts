/**
 * Headless `nevan context <query>` command (Feature 3 — Smart Context Curation).
 *
 * Runs the curator against the on-disk semantic index for the current project
 * and prints the curated files. With `--debug` it prints the full per-candidate
 * relevance table (included AND rejected, with reasons + raw cosine) and the
 * estimated token reduction versus injecting every candidate whole — satisfying
 * T1.17 ("relevance scores are inspectable via a --debug flag").
 *
 * The core logic is a pure function over an injected IO + engine factory so it
 * can be unit-tested with a deterministic embedder (no model download).
 */

import { SemanticContextEngine } from '@codebuff/semantic-context'

import type { CuratedContext } from '@codebuff/semantic-context'

export interface ContextCommandIO {
  cwd: string
  write: (s: string) => void
  writeErr: (s: string) => void
}

export interface ParsedContextArgs {
  query: string
  threshold?: number
  topK?: number
  maxFiles?: number
  debug: boolean
  json: boolean
  cwd?: string
  help: boolean
}

const USAGE =
  'Usage: nevan context <query...> [--debug] [--threshold <0-1>] [--top-k <n>] [--max-files <n>] [--json] [--cwd <dir>]\n'

/** Parse argv (everything after `context`). Pure + total — never throws. */
export function parseContextArgs(argv: string[]): ParsedContextArgs {
  const out: ParsedContextArgs = { query: '', debug: false, json: false, help: false }
  const queryParts: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--debug':
        out.debug = true
        break
      case '--json':
        out.json = true
        break
      case '-h':
      case '--help':
        out.help = true
        break
      case '--threshold': {
        const n = Number(argv[++i])
        if (Number.isFinite(n) && n >= 0 && n <= 1) out.threshold = n
        break
      }
      case '--top-k': {
        const n = Number(argv[++i])
        if (Number.isInteger(n) && n > 0) out.topK = n
        break
      }
      case '--max-files': {
        const n = Number(argv[++i])
        if (Number.isInteger(n) && n > 0) out.maxFiles = n
        break
      }
      case '--cwd':
        out.cwd = argv[++i]
        break
      default:
        if (a.startsWith('--threshold=')) {
          const n = Number(a.slice('--threshold='.length))
          if (Number.isFinite(n) && n >= 0 && n <= 1) out.threshold = n
        } else if (!a.startsWith('-')) {
          queryParts.push(a)
        }
        break
    }
  }
  out.query = queryParts.join(' ').trim()
  return out
}

function formatHuman(ctx: CuratedContext, debug: boolean): string {
  const lines: string[] = []
  if (ctx.files.length === 0) {
    lines.push(`No relevant files found for: "${ctx.query}"`)
    lines.push(
      `(searched ${ctx.candidateCount} candidate${ctx.candidateCount === 1 ? '' : 's'}; ` +
        `try a lower --threshold)`,
    )
  } else {
    lines.push(`Relevant files for: "${ctx.query}"`)
    lines.push('')
    for (const f of ctx.files) {
      const pct = (f.relevance * 100).toFixed(0)
      if (f.content !== undefined) {
        lines.push(`  ${pct}%  ${f.path}  (whole file, ~${f.tokens} tok)`)
      } else if (f.sections && f.sections.length > 0) {
        const ranges = f.sections.map((s) => `${s.startLine}-${s.endLine}`).join(', ')
        lines.push(`  ${pct}%  ${f.path}  (lines ${ranges}, ~${f.tokens} tok)`)
      }
    }
  }

  if (debug) {
    lines.push('')
    lines.push('── debug: candidate scores ──')
    lines.push('relevance | cosine | inc | reason            | path')
    for (const d of ctx.debug ?? []) {
      lines.push(
        `  ${d.relevance.toFixed(3)}  | ${d.cosine.toFixed(3)} | ${d.included ? ' ✓ ' : ' ✗ '} | ` +
          `${d.reason.padEnd(17)} | ${d.path}`,
      )
    }
    lines.push('')
    lines.push(
      `tokens: included ${ctx.includedTokens} vs baseline ${ctx.baselineTokens} ` +
        `(reduction ${(ctx.reductionRatio * 100).toFixed(1)}%); ` +
        `embed ${ctx.embedMs}ms, search ${ctx.searchMs}ms`,
    )
  }
  return lines.join('\n') + '\n'
}

export interface ContextCommandDeps {
  createEngine?: (projectRoot: string) => SemanticContextEngine
}

/** Run the context command. Returns a process exit code. */
export async function runContextCommand(
  argv: string[],
  io: ContextCommandIO,
  deps: ContextCommandDeps = {},
): Promise<number> {
  const args = parseContextArgs(argv)
  if (args.help) {
    io.write(USAGE)
    return 0
  }
  if (!args.query) {
    io.writeErr(USAGE)
    return 1
  }

  const projectRoot = args.cwd ?? io.cwd
  const engine =
    deps.createEngine?.(projectRoot) ?? new SemanticContextEngine({ projectRoot })

  try {
    await engine.open()
    if (engine.count() === 0) {
      io.writeErr('No semantic index found — building it now (first run can take a while)…\n')
      await engine.index()
    }
    const ctx = await engine.curate(args.query, {
      debug: true,
      computeBaseline: true,
      threshold: args.threshold,
      topK: args.topK,
      maxFiles: args.maxFiles,
    })
    if (args.json) {
      io.write(JSON.stringify(ctx, null, 2) + '\n')
    } else {
      io.write(formatHuman(ctx, args.debug))
    }
    return 0
  } catch (err) {
    io.writeErr(`context command failed: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  } finally {
    await engine.close().catch(() => {})
  }
}
