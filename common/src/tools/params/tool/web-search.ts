import z from 'zod/v4'

import { $getNativeToolCallExampleString, jsonToolResultSchema } from '../utils'

import type { $ToolParams } from '../../constants'

const toolName = 'web_search'
const endsAgentStep = true
const inputSchema = z
  .object({
    query: z
      .string()
      .min(1, 'Query cannot be empty')
      .describe(`The search query to find relevant web content`),
    depth: z
      .enum(['standard', 'deep'])
      .optional()
      .default('standard')
      .describe(
        `Search depth - 'standard' for quick results, 'deep' for more comprehensive search. Default is 'standard'.`,
      ),
  })
  .describe(`Search the web for current information using Linkup API.`)
const description = `
Purpose: Search the web for current, up-to-date information on any topic. This tool uses Linkup's web search API to find relevant content from across the internet.

IMPORTANT — Use this tool proactively whenever:
- You need the current version of any library, framework, or tool (never rely on training-cutoff knowledge for version numbers)
- The user asks about something that may have changed recently (new APIs, deprecations, breaking changes)
- You are about to use a library and need to verify it is still actively maintained and not superseded
- You need information from the current year that your training data may not contain
- The user asks about recent events, releases, announcements, or industry news

Query best practices for recency (enforced by /Smartsearch protocol):
- Include the current year (e.g. "2026") in queries about versions or recent changes. Never search for version numbers without a year qualifier.
- Use terms like "latest", "current", "2026" to bias results toward recent information
- For library docs, include the version number if known (e.g. "React 19 hooks")
- Year filtering: prefer queries like "React latest stable version 2026" over "React version" to avoid stale results and ensure the /Smartsearch protocol returns current information only

Use 'deep' depth for comprehensive research and complex technology decisions (mandatory for /Smartsearch deep search level); 'standard' for quick version checks and simple lookups (/Smartsearch quick search level).

Examples:
${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    query: 'Next.js latest stable version 2026',
    depth: 'standard',
  },
  endsAgentStep,
})}

${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    query: 'React Server Components best practices 2026',
    depth: 'deep',
  },
  endsAgentStep,
})}

${$getNativeToolCallExampleString({
  toolName,
  inputSchema,
  input: {
    query: 'Bun runtime new features changelog 2026',
    depth: 'standard',
  },
  endsAgentStep,
})}
`.trim()

export const webSearchParams = {
  toolName,
  endsAgentStep,
  description,
  inputSchema,
  outputSchema: jsonToolResultSchema(
    z.union([
      z.object({
        result: z.string(),
      }),
      z.object({
        errorMessage: z.string(),
      }),
    ]),
  ),
} satisfies $ToolParams
