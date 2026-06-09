/**
 * End-to-end round-trip: writing .nevan/memory.md to disk in a project,
 * then constructing a fresh session state, must surface the memory through
 * fileContext.projectMemory exactly as written. This is the "session
 * restart" test the design rests on — without it, agent edits to memory
 * never come back into the next session's prompt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import {
  PROJECT_MEMORY_DIR,
  PROJECT_MEMORY_FILE,
  appendProjectMemory,
} from '@codebuff/common/util/project-memory'

import { initialSessionState } from '../run-state'

import type { Logger } from '@codebuff/common/types/contracts/logger'

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe('project memory round-trip via initialSessionState', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'nevan-memory-rt-'),
    )
  })

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true })
  })

  test('loads memory written to disk into fileContext.projectMemory', async () => {
    const memoryDir = path.join(projectRoot, PROJECT_MEMORY_DIR)
    await fs.mkdir(memoryDir, { recursive: true })
    await fs.writeFile(
      path.join(memoryDir, PROJECT_MEMORY_FILE),
      '# Project Memory\n\n## Facts\n- runs on port 5001 (frontend) and 8080 (backend)\n- use bun, not npm\n',
      'utf8',
    )

    const sessionState = await initialSessionState({
      cwd: projectRoot,
      projectFiles: {},
      fs,
      logger: silentLogger,
    })

    expect(sessionState.fileContext.projectMemory).toBeDefined()
    expect(sessionState.fileContext.projectMemory!).toContain(
      'runs on port 5001 (frontend) and 8080 (backend)',
    )
    expect(sessionState.fileContext.projectMemory!).toContain('use bun, not npm')
  })

  test('leaves projectMemory undefined when no memory file exists', async () => {
    const sessionState = await initialSessionState({
      cwd: projectRoot,
      projectFiles: {},
      fs,
      logger: silentLogger,
    })

    expect(sessionState.fileContext.projectMemory).toBeUndefined()
  })

  test('appendProjectMemory output is visible in the next session state', async () => {
    // First "session": agent learns a fact and writes it.
    await appendProjectMemory({
      projectRoot,
      entry: '- the e2e command is `bun run e2e:ci`',
      fs,
      logger: silentLogger,
    })

    // Second "session": construct a fresh state from disk and confirm
    // the memory now flows into fileContext.
    const sessionState = await initialSessionState({
      cwd: projectRoot,
      projectFiles: {},
      fs,
      logger: silentLogger,
    })

    expect(sessionState.fileContext.projectMemory).toBeDefined()
    expect(sessionState.fileContext.projectMemory!).toContain(
      'the e2e command is `bun run e2e:ci`',
    )
    expect(sessionState.fileContext.projectMemory!).toContain('# Project Memory')
  })
})
