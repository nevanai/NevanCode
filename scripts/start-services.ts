#!/usr/bin/env bun

/**
 * Start development services in the background
 *
 * Usage:
 *   bun start-services    # Start services in background
 *   bun start-cli         # Then start CLI in foreground
 *   bun stop-services     # Stop background services
 *
 * Services started:
 *   - db: PostgreSQL database (via Docker)
 *   - studio: Drizzle Studio for database inspection
 *   - sdk: SDK build (one-time)
 *   - web: Next.js web server
 *
 * Bun automatically loads .env.local and .env.development.local,
 * so environment variables are available without manual sourcing.
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, openSync } from 'fs'
import { join, resolve } from 'path'

const PROJECT_ROOT = resolve(import.meta.dir, '..')
const LOG_DIR = join(PROJECT_ROOT, 'debug', 'console')
const PID_FILE = join(LOG_DIR, 'services.json')
function resolveBunPath(): string {
  if (process.env.BUN_BIN) {
    return process.env.BUN_BIN
  }

  // This script is already running under Bun. Reusing process.execPath is the
  // most reliable cross-platform child executable: on Windows the in-repo
  // .bin/bun file is a bash wrapper, not a native .exe/.cmd, so spawning it can
  // fail or resolve modules from the wrong place.
  if (process.execPath) {
    return process.execPath
  }

  return 'bun'
}

const BUN_PATH = resolveBunPath()

// Get config from environment (Bun loads .env files automatically)
const APP_URL = process.env.NEXT_PUBLIC_CODEBUFF_APP_URL || 'http://localhost:3000'
const PORT = process.env.NEXT_PUBLIC_WEB_PORT || '3000'

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

interface ServicePids {
  studio?: number
  sdk?: number
  web?: number
  port: string
}

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ok(name: string, message: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${name.padEnd(10)} ${message}`)
}

function fail(name: string, message: string): void {
  console.log(`  \x1b[31m✗\x1b[0m ${name.padEnd(10)} ${message}`)
}

function loadExistingPids(): ServicePids | null {
  if (!existsSync(PID_FILE)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(PID_FILE, 'utf-8'))
  } catch {
    return null
  }
}

function savePids(pids: ServicePids): void {
  writeFileSync(PID_FILE, JSON.stringify(pids, null, 2))
}

function killPid(pid: number): boolean {
  try {
    process.kill(pid, 0) // Check if exists
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

async function killExistingServices(): Promise<void> {
  const existing = loadExistingPids()
  if (!existing) return

  // Kill existing processes
  if (existing.web) killPid(existing.web)
  if (existing.studio) killPid(existing.studio)
  if (existing.sdk) killPid(existing.sdk)

  // Also kill by port to be safe
  try {
    const result = spawnSync('lsof', ['-ti', `:${existing.port}`], { encoding: 'utf-8' })
    if (result.stdout) {
      const pids = result.stdout.trim().split('\n').filter(Boolean)
      for (const pidStr of pids) {
        const pid = parseInt(pidStr, 10)
        if (!isNaN(pid)) {
          killPid(pid)
        }
      }
    }
  } catch {
    // lsof not available or failed, ignore
  }

  // Clean up PID file
  try {
    unlinkSync(PID_FILE)
  } catch {
    // Ignore
  }

  await sleep(500)
}

function isLocalDbRunning(): boolean {
  try {
    const result = spawnSync('nc', ['-z', 'localhost', '5432'], { encoding: 'utf-8' })
    return result.status === 0
  } catch {
    return false
  }
}

function isRemoteDb(): boolean {
  const dbUrl = process.env.DATABASE_URL || ''
  return !!(dbUrl && !dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1'))
}

function checkRemoteDb(): boolean {
  const dbUrl = process.env.DATABASE_URL || ''
  if (!dbUrl) return false
  try {
    const url = new URL(dbUrl)
    const host = url.hostname
    const port = url.port || '5432'
    const result = spawnSync('nc', ['-z', '-w', '3', host, port], { encoding: 'utf-8' })
    return result.status === 0
  } catch {
    try {
      const match = dbUrl.match(/@([^/?:#]+)(?::([0-9]+))?/)
      if (match) {
        const host = match[1]
        const port = match[2] || '5432'
        const result = spawnSync('nc', ['-z', '-w', '3', host, port], { encoding: 'utf-8' })
        return result.status === 0
      }
    } catch {}
    return false
  }
}

function ensureLocalDbRoleAndDatabase(logFile: number): void {
  const dbUrl = process.env.DATABASE_URL || ''
  let dbName = process.env.POSTGRES_DB || 'manicode_db_local'
  let user = process.env.POSTGRES_USER || 'manicode_user_local'
  let password = process.env.POSTGRES_PASSWORD || 'local_db_password'

  try {
    if (dbUrl) {
      const parsed = new URL(dbUrl)
      dbName = parsed.pathname.replace(/^\//, '') || dbName
      user = decodeURIComponent(parsed.username || user)
      password = decodeURIComponent(parsed.password || password)
    }
  } catch {
    // Keep defaults if DATABASE_URL cannot be parsed.
  }

  const psqlCheck = spawnSync('psql', ['--version'], { stdio: ['ignore', logFile, logFile] })
  if (psqlCheck.status !== 0) {
    return
  }

  const roleSql = `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${user.replace(/'/g, "''")}') THEN CREATE ROLE "${user.replace(/"/g, '""')}" LOGIN PASSWORD '${password.replace(/'/g, "''")}'; ELSE ALTER ROLE "${user.replace(/"/g, '""')}" WITH LOGIN PASSWORD '${password.replace(/'/g, "''")}'; END IF; END $$;`

  spawnSync('psql', ['-h', 'localhost', '-p', '5432', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', roleSql], {
    stdio: ['ignore', logFile, logFile],
    env: process.env,
  })

  const exists = spawnSync('psql', ['-h', 'localhost', '-p', '5432', '-d', 'postgres', '-Atc', `SELECT 1 FROM pg_database WHERE datname='${dbName.replace(/'/g, "''")}'`], {
    encoding: 'utf-8',
    env: process.env,
  })

  if (!exists.stdout?.includes('1')) {
    spawnSync('createdb', ['-h', 'localhost', '-p', '5432', '-O', user, dbName], {
      stdio: ['ignore', logFile, logFile],
      env: process.env,
    })
  }

  spawnSync('psql', ['-h', 'localhost', '-p', '5432', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `ALTER DATABASE "${dbName.replace(/"/g, '""')}" OWNER TO "${user.replace(/"/g, '""')}";`], {
    stdio: ['ignore', logFile, logFile],
    env: process.env,
  })
}

function startDb(): boolean {
  console.log('')

  if (isRemoteDb()) {
    if (!checkRemoteDb()) {
      fail('db', 'Remote PostgreSQL database is not reachable. Check your DATABASE_URL in .env')
      return false
    }
    ok('db', 'Remote PostgreSQL (Neon) detected!')

    process.stdout.write(`  ${SPINNER[0]} db        running migrations on remote database...\r`)
    const logFile = openSync(join(LOG_DIR, 'db.log'), 'w')

    // Run generate
    let result = spawnSync(BUN_PATH, ['--cwd', 'packages/internal', 'db:generate'], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', logFile, logFile],
      env: process.env,
    })

    if (result.status !== 0) {
      fail('db', 'failed to generate migrations schema')
      console.log(`  Check logs: tail -f ${join(LOG_DIR, 'db.log')}`)
      return false
    }

    // Run migrate
    result = spawnSync(BUN_PATH, ['--cwd', 'packages/internal', 'db:migrate'], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', logFile, logFile],
      env: process.env,
    })

    if (result.status !== 0) {
      process.stdout.write(`  ${SPINNER[0]} db        migrate failed/stuck, attempting direct schema push...\r`)
      result = spawnSync(BUN_PATH, ['--cwd', 'packages/internal', 'drizzle-kit', 'push', '--config=./src/db/drizzle.config.ts'], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', logFile, logFile],
        env: process.env,
      })
      
      if (result.status !== 0) {
        fail('db', 'failed to run migrations and schema push fallback')
        console.log(`  Check logs: tail -f ${join(LOG_DIR, 'db.log')}`)
        return false
      }
      ok('db', 'schema pushed successfully to remote database!')
      return true
    }

    ok('db', 'remote migrations applied successfully!')
    return true
  }

  if (isLocalDbRunning()) {
    ok('db', 'local PostgreSQL detected on port 5432!')
    const logFile = openSync(join(LOG_DIR, 'db.log'), 'w')

    // Ensure the expected local role/database exist when a user already has
    // PostgreSQL listening on port 5432 outside this project's Docker setup.
    ensureLocalDbRoleAndDatabase(logFile)

    // Attempt to create database if it doesn't exist
    spawnSync('createdb', ['manicode_db_local'], { env: process.env })

    process.stdout.write(`  ${SPINNER[0]} db        running local migrations...\r`)

    // Run generate
    let result = spawnSync(BUN_PATH, ['--cwd', 'packages/internal', 'db:generate'], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', logFile, logFile],
      env: process.env,
    })

    if (result.status !== 0) {
      fail('db', 'failed to generate migrations schema')
      console.log(`  Check logs: tail -f ${join(LOG_DIR, 'db.log')}`)
      return false
    }

    // Run migrate
    result = spawnSync(BUN_PATH, ['--cwd', 'packages/internal', 'db:migrate'], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', logFile, logFile],
      env: process.env,
    })

    if (result.status !== 0) {
      fail('db', 'failed to run migrations')
      console.log(`  Check logs: tail -f ${join(LOG_DIR, 'db.log')}`)
      return false
    }

    ok('db', 'local migrations applied successfully!')
    return true
  }

  process.stdout.write(`  ${SPINNER[0]} db        starting via Docker...\r`)

  const logFile = openSync(join(LOG_DIR, 'db.log'), 'w')
  const result = spawnSync(BUN_PATH, ['--cwd', 'packages/internal', 'db:start'], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', logFile, logFile],
    env: process.env,
  })

  if (result.status !== 0) {
    fail('db', 'failed to start')
    console.log(`  Check logs: tail -f ${join(LOG_DIR, 'db.log')}`)
    return false
  }

  ok('db', 'ready!')
  return true
}

function spawnBackgroundProcess(
  name: string,
  command: string,
  args: string[],
  logFileName: string,
): ChildProcess {
  const logFile = openSync(join(LOG_DIR, logFileName), 'w')

  const child = spawn(command, args, {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ['ignore', logFile, logFile],
    env: process.env,
  })

  child.unref()
  return child
}

function startBackgroundServices(): ServicePids {
  const pids: ServicePids = { port: PORT }

  // Start SDK build (one-time, will exit when done)
  const sdk = spawnBackgroundProcess('sdk', BUN_PATH, ['run', '--cwd', 'sdk', 'build'], 'sdk.log')
  if (sdk.pid) pids.sdk = sdk.pid
  ok('sdk', '(building)')

  // Start Drizzle Studio
  const studio = spawnBackgroundProcess(
    'studio',
    BUN_PATH,
    ['--cwd', 'packages/internal', 'db:studio'],
    'studio.log',
  )
  if (studio.pid) pids.studio = studio.pid
  ok('studio', '(background)')

  // Kill any existing next-server on this port
  try {
    const result = spawnSync('lsof', ['-ti', `:${PORT}`], { encoding: 'utf-8' })
    if (result.stdout) {
      const existingPids = result.stdout.trim().split('\n').filter(Boolean)
      for (const pidStr of existingPids) {
        const pid = parseInt(pidStr, 10)
        if (!isNaN(pid)) {
          killPid(pid)
        }
      }
    }
  } catch {
    // Ignore
  }

  // Start web server
  const web = spawnBackgroundProcess('web', BUN_PATH, ['--cwd', 'web', 'dev'], 'web.log')
  if (web.pid) pids.web = web.pid

  return pids
}

async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${APP_URL}/api/healthz`)
    return response.ok
  } catch {
    return false
  }
}

async function waitForHealth(timeoutSeconds: number = 60): Promise<boolean> {
  const startTime = Date.now()
  const timeoutMs = timeoutSeconds * 1000
  let frame = 0

  process.stdout.write('\x1B[?25l') // Hide cursor

  while (Date.now() - startTime < timeoutMs) {
    const isHealthy = await checkHealth()
    if (isHealthy) {
      process.stdout.write('\r\x1B[K') // Clear line
      process.stdout.write('\x1B[?25h') // Show cursor
      ok('web', 'ready!')
      return true
    }

    process.stdout.write(`\r  ${SPINNER[frame]} web       starting...`)
    frame = (frame + 1) % SPINNER.length
    await sleep(500)
  }

  process.stdout.write('\r\x1B[K')
  process.stdout.write('\x1B[?25h')
  fail('web', 'timeout')
  return false
}

async function main(): Promise<void> {
  ensureLogDir()

  console.log('Starting services in background...')

  // Kill any existing services first
  await killExistingServices()

  // Start database (blocking)
  if (!startDb()) {
    process.exit(1)
  }

  // Start background services
  const pids = startBackgroundServices()

  // Wait for web to be healthy
  const healthy = await waitForHealth(60)

  if (!healthy) {
    console.log('')
    console.log(`  Check logs: tail -f ${join(LOG_DIR, 'web.log')}`)
    process.exit(1)
  }

  // Save PIDs for stop-services
  savePids(pids)

  console.log('')
  console.log(`  View logs:  tail -f ${join(LOG_DIR, 'web.log')}`)
  console.log(`  Stop with:  bun down`)
  console.log('')
  console.log('Now run: bun start-cli')
}

main().catch((error) => {
  console.error('Error starting services:', error)
  process.exit(1)
})
