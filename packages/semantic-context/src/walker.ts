import { promises as fs } from 'fs'
import * as path from 'path'

import ignore from 'ignore'

import {
  INDEXABLE_EXTENSIONS,
  MAX_INDEX_FILES,
  TEXTUAL_EXTENSIONS,
} from './config'

import type { Ignore } from 'ignore'

const ALWAYS_IGNORE = [
  '.git',
  '.nevan',
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'build',
  'out',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.gradle',
  '.idea',
  '.vscode',
  '*.lock',
]

export interface WalkedFile {
  /** Absolute path on disk. */
  absPath: string
  /** Project-root-relative path with forward slashes. */
  relPath: string
  /** Extension (lowercased, including leading dot). */
  ext: string
  /** Size in bytes from stat. */
  size: number
  /** mtimeMs from stat. */
  mtimeMs: number
}

export interface WalkOptions {
  /** Maximum total files to enumerate. Defaults to MAX_INDEX_FILES. */
  maxFiles?: number
  /** Skip files larger than this many bytes (still counted toward maxFiles). */
  maxFileBytes?: number
  /** Optional callback invoked once per file as discovered. */
  onFile?: (file: WalkedFile) => void
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/')
}

async function readIgnoreFile(absPath: string): Promise<Ignore | null> {
  try {
    const text = await fs.readFile(absPath, 'utf8')
    return ignore().add(text)
  } catch {
    return null
  }
}

/**
 * ignore@6 doesn't let us merge Ignore instances directly, so a directory's
 * "effective" ignore is the array of (parent-dir-relative ignore, base) tuples
 * we walked through. We test against each one with the file's path relative to
 * THAT directory.
 */
interface IgnoreLayer {
  /** Path of the directory whose .gitignore produced this Ignore, relative to project root, posix. */
  dirRel: string
  ig: Ignore
}

function isIgnored(layers: IgnoreLayer[], relPath: string, isDir: boolean): boolean {
  for (const layer of layers) {
    const sub = layer.dirRel === '' ? relPath : relPath.slice(layer.dirRel.length + 1)
    if (!sub) continue
    // ignore@6 treats trailing slash as "directory only" — test both forms so
    // a pattern like "build" matches a build/ directory.
    if (layer.ig.ignores(sub)) return true
    if (isDir && layer.ig.ignores(`${sub}/`)) return true
  }
  return false
}

export function isIndexable(ext: string): boolean {
  return INDEXABLE_EXTENSIONS.has(ext) || TEXTUAL_EXTENSIONS.has(ext)
}

/**
 * Walk the project tree returning every indexable source file.
 * Honors .gitignore and .nevanignore at every directory level, plus a
 * built-in ALWAYS_IGNORE list (node_modules, .git, build outputs, ...).
 */
export async function walkProject(
  projectRoot: string,
  options: WalkOptions = {},
): Promise<WalkedFile[]> {
  const maxFiles = options.maxFiles ?? MAX_INDEX_FILES
  const maxFileBytes = options.maxFileBytes ?? Infinity
  const out: WalkedFile[] = []

  const rootBase = ignore().add(ALWAYS_IGNORE)
  const initialLayers: IgnoreLayer[] = [{ dirRel: '', ig: rootBase }]

  const rootGit = await readIgnoreFile(path.join(projectRoot, '.gitignore'))
  if (rootGit) initialLayers.push({ dirRel: '', ig: rootGit })
  const rootNevan = await readIgnoreFile(path.join(projectRoot, '.nevanignore'))
  if (rootNevan) initialLayers.push({ dirRel: '', ig: rootNevan })

  type Frame = { abs: string; rel: string; layers: IgnoreLayer[] }
  const stack: Frame[] = [{ abs: projectRoot, rel: '', layers: initialLayers }]

  while (stack.length > 0 && out.length < maxFiles) {
    const frame = stack.pop()!
    let dirents
    try {
      dirents = await fs.readdir(frame.abs, { withFileTypes: true })
    } catch {
      continue
    }

    // Layer in this directory's own .gitignore / .nevanignore (only if we are
    // not at root — root files are already in initialLayers).
    let layers = frame.layers
    if (frame.rel !== '') {
      const localLayers: IgnoreLayer[] = []
      const dirGit = await readIgnoreFile(path.join(frame.abs, '.gitignore'))
      if (dirGit) localLayers.push({ dirRel: frame.rel, ig: dirGit })
      const dirNevan = await readIgnoreFile(path.join(frame.abs, '.nevanignore'))
      if (dirNevan) localLayers.push({ dirRel: frame.rel, ig: dirNevan })
      if (localLayers.length > 0) layers = [...layers, ...localLayers]
    }

    for (const entry of dirents) {
      if (out.length >= maxFiles) break
      const childAbs = path.join(frame.abs, entry.name)
      const childRel = frame.rel === '' ? entry.name : `${frame.rel}/${entry.name}`

      if (isIgnored(layers, childRel, entry.isDirectory())) continue

      if (entry.isDirectory()) {
        stack.push({ abs: childAbs, rel: childRel, layers })
        continue
      }
      if (!entry.isFile()) continue

      const ext = path.extname(entry.name).toLowerCase()
      if (!isIndexable(ext)) continue

      let stat
      try {
        stat = await fs.stat(childAbs)
      } catch {
        continue
      }
      if (stat.size > maxFileBytes) continue

      const file: WalkedFile = {
        absPath: childAbs,
        relPath: toPosix(childRel),
        ext,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      }
      out.push(file)
      options.onFile?.(file)
    }
  }

  return out
}
