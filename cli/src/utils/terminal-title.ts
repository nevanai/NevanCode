/**
 * Terminal title utilities using OSC (Operating System Command) escape sequences.
 *
 * OSC sequence format for setting title:
 * - `\x1b]0;${title}\x07` - Sets both window title and icon name
 * - `\x1b` is ESC, `]0;` starts the title command, `\x07` (BEL) ends it
 *
 * We write directly to /dev/tty to bypass OpenTUI's stdout capture,
 * similar to how clipboard.ts handles OSC52 sequences.
 */

import { closeSync, constants, openSync, writeSync } from 'fs'

import { IS_FREEBUFF } from './constants'
import { getCliEnv } from './env'

const TITLE_PREFIX = IS_FREEBUFF ? 'Freebuff' : 'Nevan Code'
const OSC_TERMINATOR = '\x07' // BEL

function isInTmux(env: ReturnType<typeof getCliEnv>): boolean {
  return Boolean(env.TMUX)
}

function isInScreen(env: ReturnType<typeof getCliEnv>): boolean {
  if (env.STY) return true
  const term = env.TERM ?? ''
  return term.startsWith('screen') && !isInTmux(env)
}

/**
 * Build the OSC title sequence with tmux/screen passthrough if needed
 */
function buildTitleSequence(title: string, env: ReturnType<typeof getCliEnv>): string {
  const osc = `\x1b]0;${title}${OSC_TERMINATOR}`

  // tmux passthrough: wrap in DCS and double ESC characters
  if (isInTmux(env)) {
    const escaped = osc.replace(/\x1b/g, '\x1b\x1b')
    return `\x1bPtmux;${escaped}\x1b\\`
  }

  // GNU screen passthrough: wrap in DCS
  if (isInScreen(env)) {
    return `\x1bP${osc}\x1b\\`
  }

  return osc
}

/**
 * Write an escape sequence directly to the controlling terminal.
 * This bypasses OpenTUI's stdout capture by writing to /dev/tty directly.
 */
function writeToTty(sequence: string): boolean {
  const ttyPath = process.platform === 'win32' ? 'CON' : '/dev/tty'

  let fd: number | null = null
  try {
    fd = openSync(ttyPath, constants.O_WRONLY)
    writeSync(fd, sequence)
    return true
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Ignore close errors
      }
    }
  }
}

/**
 * Set the terminal window title to the app name only.
 * The dynamic title argument is intentionally ignored so the terminal
 * window always shows just "Nevan Code".
 */
export function setTerminalTitle(_title: string): void {
  const env = getCliEnv()
  const sequence = buildTitleSequence(TITLE_PREFIX, env)
  writeToTty(sequence)
}

/**
 * Reset the terminal title to the default.
 * Call this when the CLI exits to restore the terminal to a clean state.
 */
export function resetTerminalTitle(): void {
  // Empty title resets to terminal's default behavior
  const env = getCliEnv()
  const sequence = buildTitleSequence('', env)
  writeToTty(sequence)
}
