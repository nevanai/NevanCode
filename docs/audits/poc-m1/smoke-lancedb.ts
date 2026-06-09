// Smoke test: does @lancedb/lancedb load under Bun and run a basic VSS query?

import * as lancedb from '@lancedb/lancedb'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'lancedb-smoke-'))
try {
  const db = await lancedb.connect(dir)
  const table = await db.createTable('items', [
    { id: 1, vector: [0.1, 0.1, 0.1, 0.1] },
    { id: 2, vector: [0.9, 0.9, 0.9, 0.9] },
    { id: 3, vector: [0.5, 0.5, 0.5, 0.5] },
  ])

  const rows = await table
    .vectorSearch([0.85, 0.85, 0.85, 0.85])
    .limit(3)
    .toArray()
  console.log('top-3 nearest:', rows)
  console.log('LANCEDB SMOKE: OK')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
