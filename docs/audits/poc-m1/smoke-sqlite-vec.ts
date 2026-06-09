// Smoke test: does sqlite-vec load under Bun?
//
// Under Bun, two friction points show up immediately:
//  1) better-sqlite3 throws ERR_DLOPEN_FAILED (Bun N-API gap; tracked in
//     oven-sh/bun#4290). Cannot be used.
//  2) bun:sqlite is statically linked against a build of sqlite3 with
//     extension loading disabled by default. `db.loadExtension(...)`
//     errors with "This build of sqlite3 does not support dynamic
//     extension loading".
//
// Workaround: Database.setCustomSQLite(<path>) before constructing any
// Database. Pointing it at Homebrew's libsqlite3 (which is compiled
// with SQLITE_ENABLE_LOAD_EXTENSION) enables loadExtension.
//
// This means a real adoption requires either:
//   (a) shipping/discovering a system libsqlite3 with extension support, OR
//   (b) running indexer in a Node sidecar process (extra moving part).
//
// Note: sqlite-vss (the original tasks.md candidate) is unmaintained;
// sqlite-vec is its successor by the same author.

import { Database } from 'bun:sqlite'
import { getLoadablePath } from 'sqlite-vec'
import { existsSync } from 'node:fs'

const candidates = [
  '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
  '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
]
const systemSqlite = candidates.find((p) => existsSync(p))
if (!systemSqlite) {
  throw new Error(
    `No system sqlite with extension support found. Tried: ${candidates.join(', ')}. Install with: brew install sqlite`,
  )
}
console.log('Using system sqlite:', systemSqlite)
Database.setCustomSQLite(systemSqlite)

const db = new Database(':memory:')
db.loadExtension(getLoadablePath())

const { vec_version } = db
  .query('SELECT vec_version() AS vec_version')
  .get() as { vec_version: string }
console.log('sqlite-vec version:', vec_version)

db.exec('CREATE VIRTUAL TABLE items USING vec0(embedding FLOAT[4])')

const insert = db.prepare('INSERT INTO items(rowid, embedding) VALUES (?, ?)')
const vectors: Array<[number, Float32Array]> = [
  [1, new Float32Array([0.1, 0.1, 0.1, 0.1])],
  [2, new Float32Array([0.9, 0.9, 0.9, 0.9])],
  [3, new Float32Array([0.5, 0.5, 0.5, 0.5])],
]
for (const [id, v] of vectors) insert.run(id, new Uint8Array(v.buffer))

const query = new Float32Array([0.85, 0.85, 0.85, 0.85])
const rows = db
  .query(
    `SELECT rowid, distance FROM items
       WHERE embedding MATCH ?
       ORDER BY distance LIMIT 3`,
  )
  .all(new Uint8Array(query.buffer))

console.log('top-3 nearest:', rows)
db.close()
console.log('SQLITE-VEC SMOKE: OK')
