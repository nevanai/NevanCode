import { createHash } from 'crypto'
import { promises as fs } from 'fs'

export interface FileStamp {
  mtimeMs: number
  size: number
  contentHash: string
}

/**
 * Compute a content-addressed stamp for a file. SHA1 of the file bytes is
 * combined with mtime/size; mtime alone is unreliable because git checkouts
 * frequently touch mtime without changing content, while a strong hash alone
 * forces reading every file every run.
 */
export async function stampFile(absPath: string): Promise<FileStamp> {
  const stat = await fs.stat(absPath)
  const buf = await fs.readFile(absPath)
  const sha = createHash('sha1').update(buf).digest('hex')
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    contentHash: sha,
  }
}

export async function quickStamp(absPath: string): Promise<{
  mtimeMs: number
  size: number
}> {
  const stat = await fs.stat(absPath)
  return { mtimeMs: stat.mtimeMs, size: stat.size }
}

export function hashString(input: string): string {
  return createHash('sha1').update(input).digest('hex')
}
