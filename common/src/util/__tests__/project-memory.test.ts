import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import {
  PROJECT_MEMORY_DIR,
  PROJECT_MEMORY_FILE,
  PROJECT_MEMORY_MAX_BYTES,
  appendProjectMemory,
  appendProjectMemoryEntry,
  getProjectMemoryPath,
  getProjectMemoryRelativePath,
  pruneProjectMemoryFile,
  readProjectMemory,
} from '../project-memory'

import type { Logger } from '../../types/contracts/logger'

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

describe('project-memory', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nevan-memory-test-'))
  })

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true })
  })

  describe('path helpers', () => {
    it('builds an absolute path under .nevan/', () => {
      const p = getProjectMemoryPath('/proj')
      expect(p).toBe(path.join('/proj', PROJECT_MEMORY_DIR, PROJECT_MEMORY_FILE))
    })

    it('relative path is stable for prompt copy', () => {
      expect(getProjectMemoryRelativePath()).toBe('.nevan/memory.md')
    })
  })

  describe('readProjectMemory', () => {
    it('returns undefined when the memory file does not exist', async () => {
      const memory = await readProjectMemory({
        projectRoot,
        fs,
        logger: silentLogger,
      })
      expect(memory).toBeUndefined()
    })

    it('returns undefined for a whitespace-only file', async () => {
      await fs.mkdir(path.join(projectRoot, PROJECT_MEMORY_DIR))
      await fs.writeFile(
        getProjectMemoryPath(projectRoot),
        '   \n\t\n   ',
        'utf8',
      )

      const memory = await readProjectMemory({
        projectRoot,
        fs,
        logger: silentLogger,
      })
      expect(memory).toBeUndefined()
    })

    it('returns trimmed contents when the file exists', async () => {
      await fs.mkdir(path.join(projectRoot, PROJECT_MEMORY_DIR))
      await fs.writeFile(
        getProjectMemoryPath(projectRoot),
        '\n\n# Project Memory\n- bun, not npm\n',
        'utf8',
      )

      const memory = await readProjectMemory({
        projectRoot,
        fs,
        logger: silentLogger,
      })
      expect(memory).toBe('# Project Memory\n- bun, not npm')
    })

    it('truncates contents larger than the cap to a tail', async () => {
      await fs.mkdir(path.join(projectRoot, PROJECT_MEMORY_DIR))
      const tailMarker = '\nTAIL_LINE_SENTINEL_42\n'
      const filler = 'x'.repeat(PROJECT_MEMORY_MAX_BYTES + 5_000)
      await fs.writeFile(
        getProjectMemoryPath(projectRoot),
        `# Header\n${filler}${tailMarker}`,
        'utf8',
      )

      const memory = await readProjectMemory({
        projectRoot,
        fs,
        logger: silentLogger,
      })
      expect(memory).toBeDefined()
      expect(Buffer.byteLength(memory!, 'utf8')).toBeLessThanOrEqual(
        PROJECT_MEMORY_MAX_BYTES + 100,
      )
      expect(memory!).toContain('TAIL_LINE_SENTINEL_42')
      expect(memory!).toContain('earlier memory truncated')
    })
  })

  describe('appendProjectMemory', () => {
    it('creates the .nevan directory and seeds a header on first write', async () => {
      await appendProjectMemory({
        projectRoot,
        entry: '- runs on port 5001',
        fs,
        logger: silentLogger,
      })

      const memoryPath = getProjectMemoryPath(projectRoot)
      const content = await fs.readFile(memoryPath, 'utf8')
      expect(content).toContain('# Project Memory')
      expect(content).toContain('- runs on port 5001')
    })

    it('appends to existing content without re-seeding the header', async () => {
      await appendProjectMemory({
        projectRoot,
        entry: '- runs on port 5001',
        fs,
        logger: silentLogger,
      })
      await appendProjectMemory({
        projectRoot,
        entry: '- backend on 8080',
        fs,
        logger: silentLogger,
      })

      const content = await fs.readFile(
        getProjectMemoryPath(projectRoot),
        'utf8',
      )
      const headerCount = content.split('# Project Memory').length - 1
      expect(headerCount).toBe(1)
      expect(content).toContain('- runs on port 5001')
      expect(content).toContain('- backend on 8080')
    })

    it('round-trips through readProjectMemory', async () => {
      await appendProjectMemory({
        projectRoot,
        entry: '- bun, not npm',
        fs,
        logger: silentLogger,
      })

      const memory = await readProjectMemory({
        projectRoot,
        fs,
        logger: silentLogger,
      })
      expect(memory).toBeDefined()
      expect(memory!).toContain('# Project Memory')
      expect(memory!).toContain('- bun, not npm')
    })
  })

  describe('appendProjectMemoryEntry (T0.7 categorization)', () => {
    it('writes a categorized bullet under the correct heading', async () => {
      await appendProjectMemoryEntry({
        projectRoot,
        content: 'prefers bun over npm',
        category: 'user',
        fs,
        logger: silentLogger,
        now: new Date('2026-05-24T00:00:00Z'),
      })

      const content = await fs.readFile(
        getProjectMemoryPath(projectRoot),
        'utf8',
      )
      expect(content).toContain('## User')
      expect(content).toContain('- 2026-05-24 · prefers bun over npm')
    })

    it('groups multiple appends into their category sections', async () => {
      const now = new Date('2026-05-24T00:00:00Z')
      await appendProjectMemoryEntry({
        projectRoot,
        content: 'always run tests before merge',
        category: 'feedback',
        fs,
        now,
      })
      await appendProjectMemoryEntry({
        projectRoot,
        content: 'M0 wip',
        category: 'project',
        fs,
        now,
      })
      await appendProjectMemoryEntry({
        projectRoot,
        content: 'uses bun',
        category: 'user',
        fs,
        now,
      })

      const content = await fs.readFile(
        getProjectMemoryPath(projectRoot),
        'utf8',
      )
      // Canonical order: User → Feedback → Project → Reference → Notes
      const userIdx = content.indexOf('## User')
      const feedbackIdx = content.indexOf('## Feedback')
      const projectIdx = content.indexOf('## Project')
      expect(userIdx).toBeGreaterThan(-1)
      expect(feedbackIdx).toBeGreaterThan(userIdx)
      expect(projectIdx).toBeGreaterThan(feedbackIdx)
    })

    it('infers the category when not provided', async () => {
      await appendProjectMemoryEntry({
        projectRoot,
        content: "don't mock the database in tests",
        fs,
        now: new Date('2026-05-24T00:00:00Z'),
      })

      const content = await fs.readFile(
        getProjectMemoryPath(projectRoot),
        'utf8',
      )
      expect(content).toContain('## Feedback')
      expect(content).toContain("don't mock the database in tests")
    })

    it('records pinned + score markers', async () => {
      await appendProjectMemoryEntry({
        projectRoot,
        content: 'M0 quick wins critical',
        category: 'project',
        pinned: true,
        score: 5,
        fs,
        now: new Date('2026-05-24T00:00:00Z'),
      })

      const content = await fs.readFile(
        getProjectMemoryPath(projectRoot),
        'utf8',
      )
      expect(content).toContain('[score:5]')
      expect(content).toContain('[pinned]')
    })

    it('strips a leading "- " from the entry content', async () => {
      await appendProjectMemoryEntry({
        projectRoot,
        content: '- already a bullet',
        category: 'user',
        fs,
        now: new Date('2026-05-24T00:00:00Z'),
      })

      const content = await fs.readFile(
        getProjectMemoryPath(projectRoot),
        'utf8',
      )
      expect(content).toContain('- 2026-05-24 · already a bullet')
      // Should not double the dash.
      expect(content).not.toContain('- - already')
    })
  })

  describe('TTL-aware readProjectMemory (T0.6)', () => {
    it('filters TTL-expired project entries from the rendered prompt', async () => {
      await fs.mkdir(path.join(projectRoot, PROJECT_MEMORY_DIR))
      await fs.writeFile(
        getProjectMemoryPath(projectRoot),
        [
          '# Project Memory',
          '',
          '## Project',
          '- 2026-01-01 · old project work',
          '- 2026-05-20 · fresh project work',
          '',
        ].join('\n'),
        'utf8',
      )

      const now = new Date('2026-05-24T00:00:00Z')
      const memory = await readProjectMemory({
        projectRoot,
        fs,
        logger: silentLogger,
        now,
      })

      expect(memory).toBeDefined()
      expect(memory!).toContain('fresh project work')
      expect(memory!).not.toContain('old project work')
    })

    it('keeps pinned entries even when past TTL', async () => {
      await fs.mkdir(path.join(projectRoot, PROJECT_MEMORY_DIR))
      await fs.writeFile(
        getProjectMemoryPath(projectRoot),
        [
          '# Project Memory',
          '',
          '## Project',
          '- 2023-01-01 · ancient pinned bullet [pinned]',
          '',
        ].join('\n'),
        'utf8',
      )

      const memory = await readProjectMemory({
        projectRoot,
        fs,
        logger: silentLogger,
        now: new Date('2026-05-24T00:00:00Z'),
      })

      expect(memory).toBeDefined()
      expect(memory!).toContain('ancient pinned bullet')
    })

    it('does NOT modify the on-disk file when filtering on read', async () => {
      await fs.mkdir(path.join(projectRoot, PROJECT_MEMORY_DIR))
      const original = [
        '# Project Memory',
        '',
        '## Project',
        '- 2026-01-01 · old project work',
        '- 2026-05-20 · fresh project work',
        '',
      ].join('\n')
      await fs.writeFile(
        getProjectMemoryPath(projectRoot),
        original,
        'utf8',
      )

      await readProjectMemory({
        projectRoot,
        fs,
        logger: silentLogger,
        now: new Date('2026-05-24T00:00:00Z'),
      })

      const onDisk = await fs.readFile(
        getProjectMemoryPath(projectRoot),
        'utf8',
      )
      // File on disk is unchanged — read is pure.
      expect(onDisk).toBe(original)
    })

    it('preserves legacy unstructured files (no categories) unchanged', async () => {
      await fs.mkdir(path.join(projectRoot, PROJECT_MEMORY_DIR))
      const legacy = [
        '# Project Memory',
        '',
        '- runs on port 5001',
        '- uses bun',
      ].join('\n')
      await fs.writeFile(getProjectMemoryPath(projectRoot), legacy, 'utf8')

      const memory = await readProjectMemory({
        projectRoot,
        fs,
        logger: silentLogger,
      })
      expect(memory).toBe(legacy)
    })
  })

  describe('pruneProjectMemoryFile (T0.6 writeback)', () => {
    it('drops TTL-expired entries from disk and reports counts', async () => {
      await fs.mkdir(path.join(projectRoot, PROJECT_MEMORY_DIR))
      await fs.writeFile(
        getProjectMemoryPath(projectRoot),
        [
          '# Project Memory',
          '',
          '## Project',
          '- 2026-01-01 · old project work',
          '- 2026-05-20 · fresh project work',
          '',
          '## Reference',
          '- 2020-01-01 · Slack #legacy',
          '',
        ].join('\n'),
        'utf8',
      )

      const report = await pruneProjectMemoryFile({
        projectRoot,
        fs,
        logger: silentLogger,
        now: new Date('2026-05-24T00:00:00Z'),
      })

      expect(report.expired).toBe(1)
      expect(report.kept).toBe(2)
      expect(report.deduplicated).toBe(0)

      const after = await fs.readFile(
        getProjectMemoryPath(projectRoot),
        'utf8',
      )
      expect(after).toContain('fresh project work')
      expect(after).toContain('Slack #legacy')
      expect(after).not.toContain('old project work')
    })

    it('returns zeros when no pruning is necessary', async () => {
      await fs.mkdir(path.join(projectRoot, PROJECT_MEMORY_DIR))
      await fs.writeFile(
        getProjectMemoryPath(projectRoot),
        [
          '# Project Memory',
          '',
          '## Reference',
          '- 2026-05-20 · grafana://nevan',
          '',
        ].join('\n'),
        'utf8',
      )

      const report = await pruneProjectMemoryFile({
        projectRoot,
        fs,
        logger: silentLogger,
        now: new Date('2026-05-24T00:00:00Z'),
      })

      expect(report).toEqual({
        kept: 1,
        expired: 0,
        evictedForBudget: 0,
        deduplicated: 0,
      })
    })

    it('returns zeros when no memory file exists', async () => {
      const report = await pruneProjectMemoryFile({
        projectRoot,
        fs,
        logger: silentLogger,
        now: new Date('2026-05-24T00:00:00Z'),
      })
      expect(report).toEqual({
        kept: 0,
        expired: 0,
        evictedForBudget: 0,
        deduplicated: 0,
      })
    })

    it('collapses same-category duplicates already on disk (T0.8)', async () => {
      await fs.mkdir(path.join(projectRoot, PROJECT_MEMORY_DIR))
      await fs.writeFile(
        getProjectMemoryPath(projectRoot),
        [
          '# Project Memory',
          '',
          '## User',
          '- 2026-05-20 · uses bun, not npm',
          '- 2026-05-22 · Uses Bun, not npm.',
          '- 2026-05-23 · uses  bun,  not   npm',
          '',
        ].join('\n'),
        'utf8',
      )

      const report = await pruneProjectMemoryFile({
        projectRoot,
        fs,
        logger: silentLogger,
        now: new Date('2026-05-24T00:00:00Z'),
      })

      expect(report.kept).toBe(1)
      expect(report.deduplicated).toBe(2)

      const after = await fs.readFile(
        getProjectMemoryPath(projectRoot),
        'utf8',
      )
      // Survivor should be the FIRST occurrence's content, with the
      // latest date carried forward via merge.
      expect(after).toContain('- 2026-05-23 · uses bun, not npm')
      const occurrences = after.match(/uses bun, not npm/gi)
      expect(occurrences?.length).toBe(1)
    })
  })

  describe('appendProjectMemoryEntry — deduplication (T0.8)', () => {
    it('does not duplicate an entry that is appended twice', async () => {
      const now = new Date('2026-05-24T00:00:00Z')
      const first = await appendProjectMemoryEntry({
        projectRoot,
        content: 'uses bun, not npm',
        category: 'user',
        fs,
        now,
      })
      const second = await appendProjectMemoryEntry({
        projectRoot,
        content: 'Uses Bun, not npm.',
        category: 'user',
        fs,
        now,
      })

      expect(first.deduplicated).toBe(false)
      expect(second.deduplicated).toBe(true)

      const content = await fs.readFile(
        getProjectMemoryPath(projectRoot),
        'utf8',
      )
      const matches = content.match(/uses bun, not npm/gi)
      expect(matches?.length).toBe(1)
    })

    it('promotes pinned/score when the second write upgrades them', async () => {
      const now = new Date('2026-05-24T00:00:00Z')
      await appendProjectMemoryEntry({
        projectRoot,
        content: 'always run bun test before merge',
        category: 'feedback',
        fs,
        now,
      })
      const second = await appendProjectMemoryEntry({
        projectRoot,
        content: 'Always run bun test before merge.',
        category: 'feedback',
        pinned: true,
        score: 7,
        fs,
        now,
      })

      expect(second.deduplicated).toBe(true)

      const content = await fs.readFile(
        getProjectMemoryPath(projectRoot),
        'utf8',
      )
      expect(content).toContain('[pinned]')
      expect(content).toContain('[score:7]')
    })

    it('keeps entries with the same text under different categories', async () => {
      const now = new Date('2026-05-24T00:00:00Z')
      await appendProjectMemoryEntry({
        projectRoot,
        content: 'bun, not npm',
        category: 'user',
        fs,
        now,
      })
      const second = await appendProjectMemoryEntry({
        projectRoot,
        content: 'bun, not npm',
        category: 'feedback',
        fs,
        now,
      })

      // Cross-category dedup is intentionally skipped.
      expect(second.deduplicated).toBe(false)

      const content = await fs.readFile(
        getProjectMemoryPath(projectRoot),
        'utf8',
      )
      expect(content).toContain('## User')
      expect(content).toContain('## Feedback')
      const matches = content.match(/bun, not npm/g)
      expect(matches?.length).toBe(2)
    })
  })
})
