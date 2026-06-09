import { exec } from 'child_process'
import { readFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

import type { Tool } from '@modelcontextprotocol/sdk/types.js'

const execAsync = promisify(exec)

// ── Input types ──────────────────────────────────────────────────────────────

export interface ScreenshotInput {
  display_id?: number
}

export interface MouseMoveInput {
  x: number
  y: number
}

export interface MouseClickInput {
  x: number
  y: number
  button?: 'left' | 'right' | 'double'
}

export interface TypeTextInput {
  text: string
  delay_ms?: number
}

export interface KeyPressInput {
  keys: string[]
}

// ── Result type ───────────────────────────────────────────────────────────────

export interface ImageResult {
  base64: string
  mimeType: 'image/png' | 'image/jpeg'
}

// ── Screenshot downscaling ─────────────────────────────────────────────────────

/**
 * Vision models downscale anything past ~1568px on the long edge anyway, so a
 * native Retina capture (~6-9MB PNG) is pure waste on the wire and at the model.
 * We cap the long edge and re-encode as JPEG, cutting the payload ~15-20x with
 * no loss in what the model actually sees. Quality 85 keeps small UI/terminal
 * text legible.
 */
const MAX_SCREENSHOT_EDGE = 1568
const SCREENSHOT_JPEG_QUALITY = 85

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execAsync(`command -v ${cmd}`)
    return true
  } catch {
    return false
  }
}

/**
 * Downscale a PNG to at most MAX_SCREENSHOT_EDGE on its longest side and
 * re-encode as JPEG. Returns the JPEG path, or null when no downscaler is
 * available (the caller then falls back to the original PNG — the token-counter
 * already charges a flat per-image cost, so an un-resized fallback still won't
 * hang the agent, it just costs more on the wire).
 */
async function downscaleToJpeg(srcPath: string): Promise<string | null> {
  const outPath = srcPath.replace(/\.png$/, '.jpg')

  // macOS: `sips` ships with the OS.
  if (process.platform === 'darwin') {
    try {
      await execAsync(
        `sips -Z ${MAX_SCREENSHOT_EDGE} -s format jpeg -s formatOptions ${SCREENSHOT_JPEG_QUALITY} "${srcPath}" --out "${outPath}"`,
      )
      return outPath
    } catch {
      return null
    }
  }

  // Linux / other: use ImageMagick if present.
  const magick = (await commandExists('magick'))
    ? 'magick'
    : (await commandExists('convert'))
      ? 'convert'
      : null
  if (magick) {
    try {
      await execAsync(
        `${magick} "${srcPath}" -resize "${MAX_SCREENSHOT_EDGE}x${MAX_SCREENSHOT_EDGE}>" -quality ${SCREENSHOT_JPEG_QUALITY} "${outPath}"`,
      )
      return outPath
    } catch {
      return null
    }
  }

  return null
}

// ── Tool definitions (JSON Schema) ────────────────────────────────────────────

export const computerUseTools: Tool[] = [
  {
    name: 'computer_take_screenshot',
    description:
      'Captures a screenshot of the current screen and returns it as a base64-encoded PNG image. ' +
      'Requires Screen Recording permission on macOS (System Settings → Privacy & Security).',
    inputSchema: {
      type: 'object',
      properties: {
        display_id: {
          type: 'number',
          description: 'Display/monitor index to capture (default: primary display).',
        },
      },
    },
  },
  {
    name: 'computer_move_mouse',
    description:
      'Moves the mouse cursor to absolute screen coordinates (x, y). ' +
      'Requires Accessibility permission on macOS.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Horizontal position in pixels from the left edge.' },
        y: { type: 'number', description: 'Vertical position in pixels from the top edge.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'computer_click',
    description:
      'Moves the mouse to (x, y) and performs a click. ' +
      'Requires Accessibility permission on macOS.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Horizontal position in pixels.' },
        y: { type: 'number', description: 'Vertical position in pixels.' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'double'],
          description: 'Which mouse button to click (default: left).',
        },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'computer_type_text',
    description:
      'Types the given text at the current cursor position using simulated keystrokes. ' +
      'Requires Accessibility permission on macOS.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
        delay_ms: {
          type: 'number',
          description: 'Delay in milliseconds between each keystroke (default: 0).',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'computer_press_keys',
    description:
      'Presses a combination of keys simultaneously (e.g. ["ctrl", "c"] for copy). ' +
      'Supported modifiers: ctrl/control, shift, alt, meta/cmd/command. ' +
      'Supported special keys: return/enter, space, tab, escape/esc, backspace, delete, ' +
      'up, down, left, right, f1–f12. ' +
      'Requires Accessibility permission on macOS.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of key names to press together.',
        },
      },
      required: ['keys'],
    },
  },
]

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function handleTakeScreenshot(input: ScreenshotInput): Promise<ImageResult> {
  const tmpPath = join(tmpdir(), `hermes_ss_${Date.now()}.png`)
  let jpegPath: string | null = null
  try {
    const platform = process.platform
    if (platform === 'darwin') {
      const displayFlag =
        input.display_id !== undefined ? `-D ${input.display_id}` : ''
      await execAsync(`screencapture -x -t png ${displayFlag} "${tmpPath}"`)
    } else if (platform === 'linux') {
      try {
        await execAsync(`scrot "${tmpPath}"`)
      } catch {
        await execAsync(`import -window root "${tmpPath}"`)
      }
    } else if (platform === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '$s=[System.Windows.Forms.Screen]::PrimaryScreen',
        '$b=New-Object System.Drawing.Bitmap($s.Bounds.Width,$s.Bounds.Height)',
        '$g=[System.Drawing.Graphics]::FromImage($b)',
        '$g.CopyFromScreen($s.Bounds.Location,[System.Drawing.Point]::Empty,$s.Bounds.Size)',
        `$b.Save('${tmpPath}')`,
      ].join(';')
      await execAsync(`powershell -Command "${ps}"`)
    } else {
      throw new Error(`Unsupported platform for screenshots: ${platform}`)
    }

    // Downscale + re-encode as JPEG so the captured Retina PNG (~6-9MB) doesn't
    // bloat the wire payload and the LLM request. Falls back to the raw PNG when
    // no downscaler is available.
    jpegPath = await downscaleToJpeg(tmpPath)
    if (jpegPath) {
      const data = await readFile(jpegPath)
      return { base64: data.toString('base64'), mimeType: 'image/jpeg' }
    }

    const data = await readFile(tmpPath)
    return { base64: data.toString('base64'), mimeType: 'image/png' }
  } finally {
    unlink(tmpPath).catch(() => {})
    if (jpegPath) unlink(jpegPath).catch(() => {})
  }
}

export async function handleMoveMouse(input: MouseMoveInput): Promise<void> {
  const { mouse, Point } = await import('@nut-tree-fork/nut-js')
  await mouse.setPosition(new Point(input.x, input.y))
}

export async function handleClickMouse(input: MouseClickInput): Promise<void> {
  const { mouse, Point, Button } = await import('@nut-tree-fork/nut-js')
  await mouse.setPosition(new Point(input.x, input.y))
  const btn = input.button ?? 'left'
  if (btn === 'double') {
    await mouse.doubleClick(Button.LEFT)
  } else if (btn === 'right') {
    await mouse.click(Button.RIGHT)
  } else {
    await mouse.click(Button.LEFT)
  }
}

export async function handleTypeText(input: TypeTextInput): Promise<void> {
  const { keyboard } = await import('@nut-tree-fork/nut-js')
  if (input.delay_ms !== undefined) {
    keyboard.config.autoDelayMs = input.delay_ms
  }
  await keyboard.type(input.text)
}

// Mapping of human-readable key names to nut-js Key enum names
const KEY_NAME_MAP: Record<string, string> = {
  return: 'Return',
  enter: 'Return',
  space: 'Space',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  ctrl: 'LeftControl',
  control: 'LeftControl',
  shift: 'LeftShift',
  alt: 'LeftAlt',
  meta: 'LeftSuper',
  cmd: 'LeftSuper',
  command: 'LeftSuper',
  f1: 'F1',
  f2: 'F2',
  f3: 'F3',
  f4: 'F4',
  f5: 'F5',
  f6: 'F6',
  f7: 'F7',
  f8: 'F8',
  f9: 'F9',
  f10: 'F10',
  f11: 'F11',
  f12: 'F12',
}

export async function handlePressKeys(input: KeyPressInput): Promise<void> {
  const nutJs = await import('@nut-tree-fork/nut-js')
  const { keyboard, Key } = nutJs

  const keyRecord = Key as unknown as Record<string, number>
  const resolvedKeys = input.keys.map((k) => {
    const lower = k.toLowerCase()
    const mappedName = KEY_NAME_MAP[lower] ?? k.toUpperCase()
    const keyValue = keyRecord[mappedName]
    if (keyValue === undefined) {
      throw new Error(
        `Unknown key: "${k}". Supported: ${Object.keys(KEY_NAME_MAP).join(', ')}, A-Z, 0-9.`,
      )
    }
    return keyValue
  })

  await keyboard.pressKey(...resolvedKeys)
  await keyboard.releaseKey(...resolvedKeys)
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export async function handleComputerUseTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> }> {
  switch (name) {
    case 'computer_take_screenshot': {
      const result = await handleTakeScreenshot(args as unknown as ScreenshotInput)
      // Include a short text acknowledgment alongside the image. This guards
      // against models / providers that ignore standalone image tool results
      // and keeps the agent from re-invoking the screenshot tool in a loop
      // when it can't "see" any text reply.
      return {
        content: [
          { type: 'text', text: 'Screenshot captured.' },
          { type: 'image', data: result.base64, mimeType: result.mimeType },
        ],
      }
    }
    case 'computer_move_mouse': {
      await handleMoveMouse(args as unknown as MouseMoveInput)
      return { content: [{ type: 'text', text: `Mouse moved to (${args['x']}, ${args['y']})` }] }
    }
    case 'computer_click': {
      await handleClickMouse(args as unknown as MouseClickInput)
      const btn = (args['button'] as string | undefined) ?? 'left'
      return {
        content: [
          { type: 'text', text: `${btn} click at (${args['x']}, ${args['y']})` },
        ],
      }
    }
    case 'computer_type_text': {
      await handleTypeText(args as unknown as TypeTextInput)
      return { content: [{ type: 'text', text: `Typed: ${args['text']}` }] }
    }
    case 'computer_press_keys': {
      await handlePressKeys(args as unknown as KeyPressInput)
      const keys = (args['keys'] as string[]).join('+')
      return { content: [{ type: 'text', text: `Pressed keys: ${keys}` }] }
    }
    default:
      throw new Error(`Unknown computer use tool: ${name}`)
  }
}
