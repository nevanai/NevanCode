import {
  access,
  appendFile as fsAppend,
  constants,
  copyFile as fsCopy,
  mkdir,
  readdir,
  readFile as fsRead,
  rename,
  rm,
  stat,
  writeFile as fsWrite,
} from 'fs/promises'
import { basename, dirname, resolve } from 'path'

import type { Tool } from '@modelcontextprotocol/sdk/types.js'

// ── Input types ───────────────────────────────────────────────────────────────

export interface FileReadInput {
  path: string
  encoding?: 'utf-8' | 'base64'
}

export interface FileWriteInput {
  path: string
  content: string
  encoding?: 'utf-8' | 'base64'
  create_dirs?: boolean
}

export interface FileAppendInput {
  path: string
  content: string
}

export interface FileDeleteInput {
  path: string
}

export interface FileMoveInput {
  source: string
  destination: string
}

export interface FileCopyInput {
  source: string
  destination: string
  overwrite?: boolean
}

export interface FileExistsInput {
  path: string
}

export interface DirCreateInput {
  path: string
  recursive?: boolean
}

export interface DirListInput {
  path: string
  show_hidden?: boolean
  recursive?: boolean
}

export interface DirDeleteInput {
  path: string
  recursive?: boolean
}

// ── Tool definitions (JSON Schema) ────────────────────────────────────────────

export const fileManagerTools: Tool[] = [
  {
    name: 'file_read',
    description: 'Reads the contents of a file from the filesystem. Returns text or base64 data.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file.' },
        encoding: {
          type: 'string',
          enum: ['utf-8', 'base64'],
          description: 'How to decode the file (default: utf-8).',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description:
      'Writes content to a file, creating it if it does not exist or overwriting it if it does.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file.' },
        content: { type: 'string', description: 'Content to write.' },
        encoding: {
          type: 'string',
          enum: ['utf-8', 'base64'],
          description: 'Content encoding (default: utf-8).',
        },
        create_dirs: {
          type: 'boolean',
          description: 'Create parent directories if they do not exist (default: false).',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_append',
    description: 'Appends text to the end of a file. Creates the file if it does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        content: { type: 'string', description: 'Content to append.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_delete',
    description: 'Deletes a single file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to delete.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_move',
    description: 'Moves or renames a file from source to destination.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Current path of the file.' },
        destination: { type: 'string', description: 'New path for the file.' },
      },
      required: ['source', 'destination'],
    },
  },
  {
    name: 'file_copy',
    description: 'Copies a file from source to destination.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Path of the file to copy.' },
        destination: { type: 'string', description: 'Destination path for the copy.' },
        overwrite: {
          type: 'boolean',
          description: 'Overwrite the destination if it already exists (default: false).',
        },
      },
      required: ['source', 'destination'],
    },
  },
  {
    name: 'file_exists',
    description: 'Checks whether a file or directory exists at the given path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to check.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'dir_create',
    description: 'Creates a directory, optionally including all parent directories.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to create.' },
        recursive: {
          type: 'boolean',
          description: 'Create parent directories as needed (default: true).',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'dir_list',
    description: 'Lists the contents of a directory with file metadata (name, size, type, modified).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list.' },
        show_hidden: {
          type: 'boolean',
          description: 'Include hidden files (starting with .) (default: false).',
        },
        recursive: {
          type: 'boolean',
          description: 'List subdirectories recursively (default: false).',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'dir_delete',
    description: 'Deletes a directory and optionally its contents.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to delete.' },
        recursive: {
          type: 'boolean',
          description: 'Delete all contents recursively (default: false).',
        },
      },
      required: ['path'],
    },
  },
]

// ── Helper: resolve and validate path ────────────────────────────────────────

function resolvePath(inputPath: string): string {
  return resolve(inputPath)
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function handleFileRead(input: FileReadInput): Promise<string> {
  const resolved = resolvePath(input.path)
  const encoding = input.encoding ?? 'utf-8'

  if (encoding === 'base64') {
    const data = await fsRead(resolved)
    return data.toString('base64')
  }
  return fsRead(resolved, 'utf-8')
}

export async function handleFileWrite(input: FileWriteInput): Promise<string> {
  const resolved = resolvePath(input.path)

  if (input.create_dirs) {
    await mkdir(dirname(resolved), { recursive: true })
  }

  const encoding = input.encoding ?? 'utf-8'
  if (encoding === 'base64') {
    await fsWrite(resolved, Buffer.from(input.content, 'base64'))
  } else {
    await fsWrite(resolved, input.content, 'utf-8')
  }

  return `Written ${input.content.length} bytes to ${resolved}`
}

export async function handleFileAppend(input: FileAppendInput): Promise<string> {
  const resolved = resolvePath(input.path)
  await fsAppend(resolved, input.content, 'utf-8')
  return `Appended ${input.content.length} bytes to ${resolved}`
}

export async function handleFileDelete(input: FileDeleteInput): Promise<string> {
  const resolved = resolvePath(input.path)
  await rm(resolved, { force: false })
  return `Deleted file: ${resolved}`
}

export async function handleFileMove(input: FileMoveInput): Promise<string> {
  const src = resolvePath(input.source)
  const dst = resolvePath(input.destination)
  await rename(src, dst)
  return `Moved ${src} → ${dst}`
}

export async function handleFileCopy(input: FileCopyInput): Promise<string> {
  const src = resolvePath(input.source)
  const dst = resolvePath(input.destination)
  const flags = input.overwrite ? 0 : constants.COPYFILE_EXCL
  await fsCopy(src, dst, flags)
  return `Copied ${src} → ${dst}`
}

export async function handleFileExists(input: FileExistsInput): Promise<string> {
  const resolved = resolvePath(input.path)
  try {
    const info = await stat(resolved)
    const kind = info.isDirectory() ? 'directory' : 'file'
    return `Exists (${kind}): ${resolved}`
  } catch {
    return `Does not exist: ${resolved}`
  }
}

export async function handleDirCreate(input: DirCreateInput): Promise<string> {
  const resolved = resolvePath(input.path)
  await mkdir(resolved, { recursive: input.recursive ?? true })
  return `Directory created: ${resolved}`
}

interface DirEntry {
  name: string
  type: 'file' | 'directory' | 'symlink'
  size: number
  modified: string
}

async function listDirEntries(
  dirPath: string,
  showHidden: boolean,
  recursive: boolean,
  prefix = '',
): Promise<DirEntry[]> {
  const rawEntries = await readdir(dirPath, { withFileTypes: true })
  const entries: DirEntry[] = []

  for (const entry of rawEntries) {
    if (!showHidden && entry.name.startsWith('.')) continue

    const fullPath = `${dirPath}/${entry.name}`
    const displayName = prefix ? `${prefix}/${entry.name}` : entry.name

    try {
      const info = await stat(fullPath)
      const kind: DirEntry['type'] = entry.isDirectory()
        ? 'directory'
        : entry.isSymbolicLink()
          ? 'symlink'
          : 'file'

      entries.push({
        name: displayName,
        type: kind,
        size: info.size,
        modified: info.mtime.toISOString(),
      })

      if (recursive && entry.isDirectory()) {
        const sub = await listDirEntries(fullPath, showHidden, true, displayName)
        entries.push(...sub)
      }
    } catch {
      // Skip entries we can't stat
    }
  }

  return entries
}

export async function handleDirList(input: DirListInput): Promise<string> {
  const resolved = resolvePath(input.path)
  const entries = await listDirEntries(
    resolved,
    input.show_hidden ?? false,
    input.recursive ?? false,
  )

  if (entries.length === 0) return `Directory is empty: ${resolved}`

  const lines = entries.map(
    (e) => `${e.type === 'directory' ? 'd' : '-'} ${e.name.padEnd(40)} ${e.size.toString().padStart(10)} ${e.modified}`,
  )
  return [`Listing of ${resolved}:`, ...lines].join('\n')
}

export async function handleDirDelete(input: DirDeleteInput): Promise<string> {
  const resolved = resolvePath(input.path)
  await rm(resolved, { recursive: input.recursive ?? false, force: false })
  return `Deleted directory: ${resolved}`
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export async function handleFileManagerTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  let text: string

  switch (name) {
    case 'file_read':
      text = await handleFileRead(args as unknown as FileReadInput)
      break
    case 'file_write':
      text = await handleFileWrite(args as unknown as FileWriteInput)
      break
    case 'file_append':
      text = await handleFileAppend(args as unknown as FileAppendInput)
      break
    case 'file_delete':
      text = await handleFileDelete(args as unknown as FileDeleteInput)
      break
    case 'file_move':
      text = await handleFileMove(args as unknown as FileMoveInput)
      break
    case 'file_copy':
      text = await handleFileCopy(args as unknown as FileCopyInput)
      break
    case 'file_exists':
      text = await handleFileExists(args as unknown as FileExistsInput)
      break
    case 'dir_create':
      text = await handleDirCreate(args as unknown as DirCreateInput)
      break
    case 'dir_list':
      text = await handleDirList(args as unknown as DirListInput)
      break
    case 'dir_delete':
      text = await handleDirDelete(args as unknown as DirDeleteInput)
      break
    default:
      throw new Error(`Unknown file manager tool: ${name}`)
  }

  return { content: [{ type: 'text', text }] }
}
