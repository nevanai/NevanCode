import { readFile, writeFile, mkdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { Browser, Page } from 'playwright'

// ── Persistent memory store ───────────────────────────────────────────────────

const MEMORY_FILE = join(homedir(), '.codebuff', 'hermes-memory.json')

async function loadMemory(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(MEMORY_FILE, 'utf-8')
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return {}
  }
}

async function saveMemory(store: Record<string, string>): Promise<void> {
  await mkdir(join(homedir(), '.codebuff'), { recursive: true })
  await writeFile(MEMORY_FILE, JSON.stringify(store, null, 2), 'utf-8')
}

// ── Browser singleton ─────────────────────────────────────────────────────────

let browserInstance: Browser | null = null
let pageInstance: Page | null = null

async function getPage(): Promise<Page> {
  if (!browserInstance || !browserInstance.isConnected()) {
    const { chromium } = await import('playwright')
    browserInstance = await chromium.launch({ headless: true })
    pageInstance = await browserInstance.newPage()
  }
  if (!pageInstance || pageInstance.isClosed()) {
    pageInstance = await browserInstance.newPage()
  }
  return pageInstance
}

// ── Input types ───────────────────────────────────────────────────────────────

export interface BrowserNavigateInput {
  url: string
  wait_until?: 'load' | 'domcontentloaded' | 'networkidle'
  timeout_ms?: number
}

export interface BrowserGetContentInput {
  format?: 'text' | 'html' | 'markdown'
  selector?: string
}

export interface BrowserClickInput {
  selector: string
  timeout_ms?: number
}

export interface BrowserFillInput {
  selector: string
  value: string
  timeout_ms?: number
}

export interface BrowserEvaluateInput {
  script: string
}

export interface BrowserScreenshotInput {
  full_page?: boolean
  selector?: string
}

export interface MemorySetInput {
  key: string
  value: string
}

export interface MemoryGetInput {
  key: string
}

export interface MemoryDeleteInput {
  key: string
}

// ── Tool definitions (JSON Schema) ────────────────────────────────────────────

export const browserTools: Tool[] = [
  {
    name: 'browser_navigate',
    description:
      'Opens a URL in the headless Chromium browser. The browser session persists across calls ' +
      'so cookies and local storage survive between tool invocations.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to navigate to (must include https://).' },
        wait_until: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle'],
          description: 'When to consider navigation complete (default: load).',
        },
        timeout_ms: {
          type: 'number',
          description: 'Navigation timeout in milliseconds (default: 30000).',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Captures a screenshot of the current browser page as a base64-encoded PNG.',
    inputSchema: {
      type: 'object',
      properties: {
        full_page: {
          type: 'boolean',
          description: 'Capture the full scrollable page (default: false = viewport only).',
        },
        selector: {
          type: 'string',
          description: 'CSS selector of a specific element to screenshot instead of the whole page.',
        },
      },
    },
  },
  {
    name: 'browser_get_content',
    description: 'Returns the text or HTML content of the current page or a selected element.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['text', 'html'],
          description: 'Return plain text (default) or raw HTML.',
        },
        selector: {
          type: 'string',
          description: 'CSS selector to narrow content to a specific element.',
        },
      },
    },
  },
  {
    name: 'browser_click',
    description: 'Clicks on the first element matching the CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click.' },
        timeout_ms: {
          type: 'number',
          description: 'How long to wait for the element (default: 5000).',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_fill',
    description: 'Clears and fills an input or textarea element with the given value.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input element.' },
        value: { type: 'string', description: 'Value to type into the element.' },
        timeout_ms: {
          type: 'number',
          description: 'How long to wait for the element (default: 5000).',
        },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'browser_evaluate',
    description:
      'Runs arbitrary JavaScript in the page context and returns the serialised result. ' +
      'The script runs as a function body; use `return` to return a value.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'JavaScript code to execute in the page.' },
      },
      required: ['script'],
    },
  },
  {
    name: 'browser_close',
    description: 'Closes the headless browser and its page, freeing all resources.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_set',
    description:
      'Stores a key-value pair in persistent memory. Survives across MCP server restarts. ' +
      'Stored at ~/.codebuff/hermes-memory.json.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Unique key name.' },
        value: { type: 'string', description: 'String value to store.' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'memory_get',
    description: 'Retrieves a value from persistent memory by key. Returns null if the key does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to retrieve.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'memory_delete',
    description: 'Deletes a key from persistent memory.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to delete.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'memory_list',
    description: 'Returns all keys and values currently in persistent memory.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
]

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function handleBrowserNavigate(input: BrowserNavigateInput): Promise<string> {
  const page = await getPage()
  const response = await page.goto(input.url, {
    waitUntil: input.wait_until ?? 'load',
    timeout: input.timeout_ms ?? 30_000,
  })
  const status = response?.status() ?? 'unknown'
  const title = await page.title()
  return `Navigated to ${input.url} — status ${status}, title: "${title}"`
}

export async function handleBrowserScreenshot(
  input: BrowserScreenshotInput,
): Promise<{ base64: string; mimeType: 'image/jpeg' }> {
  const page = await getPage()
  let buffer: Buffer

  // JPEG (quality 85) instead of PNG: a full-page screenshot can be several MB
  // as PNG, which bloats the wire payload and the LLM request for no visual gain
  // (vision models downscale large images anyway). Quality 85 keeps text legible.
  if (input.selector) {
    const element = await page.locator(input.selector).first()
    buffer = await element.screenshot({ type: 'jpeg', quality: 85 }) as Buffer
  } else {
    buffer = await page.screenshot({
      fullPage: input.full_page ?? false,
      type: 'jpeg',
      quality: 85,
    }) as Buffer
  }

  return { base64: buffer.toString('base64'), mimeType: 'image/jpeg' }
}

export async function handleBrowserGetContent(input: BrowserGetContentInput): Promise<string> {
  const page = await getPage()
  if (input.format === 'html') {
    if (input.selector) {
      return page.locator(input.selector).first().innerHTML()
    }
    return page.content()
  }
  if (input.selector) {
    return page.locator(input.selector).first().innerText()
  }
  return page.evaluate(() => document.body.innerText)
}

export async function handleBrowserClick(input: BrowserClickInput): Promise<string> {
  const page = await getPage()
  await page.locator(input.selector).first().click({ timeout: input.timeout_ms ?? 5_000 })
  return `Clicked element: ${input.selector}`
}

export async function handleBrowserFill(input: BrowserFillInput): Promise<string> {
  const page = await getPage()
  await page.locator(input.selector).first().fill(input.value, {
    timeout: input.timeout_ms ?? 5_000,
  })
  return `Filled "${input.selector}" with value`
}

export async function handleBrowserEvaluate(input: BrowserEvaluateInput): Promise<string> {
  const page = await getPage()
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const result = await page.evaluate(new Function(input.script) as () => unknown)
  return result !== undefined ? JSON.stringify(result, null, 2) : 'undefined'
}

export async function handleBrowserClose(): Promise<string> {
  if (browserInstance) {
    await browserInstance.close()
    browserInstance = null
    pageInstance = null
  }
  return 'Browser closed.'
}

export async function handleMemorySet(input: MemorySetInput): Promise<string> {
  const store = await loadMemory()
  store[input.key] = input.value
  await saveMemory(store)
  return `Stored key "${input.key}".`
}

export async function handleMemoryGet(input: MemoryGetInput): Promise<string> {
  const store = await loadMemory()
  const value = store[input.key]
  if (value === undefined) return `Key "${input.key}" not found.`
  return value
}

export async function handleMemoryDelete(input: MemoryDeleteInput): Promise<string> {
  const store = await loadMemory()
  if (!(input.key in store)) return `Key "${input.key}" does not exist.`
  delete store[input.key]
  await saveMemory(store)
  return `Deleted key "${input.key}".`
}

export async function handleMemoryList(): Promise<string> {
  const store = await loadMemory()
  const entries = Object.entries(store)
  if (entries.length === 0) return 'Memory is empty.'
  return entries.map(([k, v]) => `${k}: ${v}`).join('\n')
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export async function handleBrowserTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
}> {
  switch (name) {
    case 'browser_navigate': {
      const text = await handleBrowserNavigate(args as unknown as BrowserNavigateInput)
      return { content: [{ type: 'text', text }] }
    }
    case 'browser_screenshot': {
      const result = await handleBrowserScreenshot(args as unknown as BrowserScreenshotInput)
      return { content: [{ type: 'image', data: result.base64, mimeType: result.mimeType }] }
    }
    case 'browser_get_content': {
      const text = await handleBrowserGetContent(args as unknown as BrowserGetContentInput)
      return { content: [{ type: 'text', text }] }
    }
    case 'browser_click': {
      const text = await handleBrowserClick(args as unknown as BrowserClickInput)
      return { content: [{ type: 'text', text }] }
    }
    case 'browser_fill': {
      const text = await handleBrowserFill(args as unknown as BrowserFillInput)
      return { content: [{ type: 'text', text }] }
    }
    case 'browser_evaluate': {
      const text = await handleBrowserEvaluate(args as unknown as BrowserEvaluateInput)
      return { content: [{ type: 'text', text }] }
    }
    case 'browser_close': {
      const text = await handleBrowserClose()
      return { content: [{ type: 'text', text }] }
    }
    case 'memory_set': {
      const text = await handleMemorySet(args as unknown as MemorySetInput)
      return { content: [{ type: 'text', text }] }
    }
    case 'memory_get': {
      const text = await handleMemoryGet(args as unknown as MemoryGetInput)
      return { content: [{ type: 'text', text }] }
    }
    case 'memory_delete': {
      const text = await handleMemoryDelete(args as unknown as MemoryDeleteInput)
      return { content: [{ type: 'text', text }] }
    }
    case 'memory_list': {
      const text = await handleMemoryList()
      return { content: [{ type: 'text', text }] }
    }
    default:
      throw new Error(`Unknown browser tool: ${name}`)
  }
}
