/**
 * Fetch wrapper tuned for long-lived agent sessions.
 *
 * Bun's built-in fetch enforces an idle-socket timeout (defaults vary by
 * version, historically 30–255s). When the LLM stream pauses between tokens —
 * common during deep reasoning or large tool calls — that idle timer can fire
 * and throw "The operation timed out.", killing an agent that's been running
 * for hours. This wrapper passes `verbose: false, idleTimeout: 0` so the
 * connection stays open as long as the LLM keeps the socket alive.
 *
 * The `idleTimeout` field is Bun-specific; on Node it's silently ignored, so
 * this is a no-op there.
 *
 * Set `CODEBUFF_FETCH_IDLE_TIMEOUT_MS` to override (positive integer in ms,
 * `0` disables). Set `CODEBUFF_DISABLE_TIMEOUTS=1` to also disable.
 */

const parseIdleTimeoutMs = (): number => {
  const envValue =
    typeof process !== 'undefined'
      ? process.env?.CODEBUFF_FETCH_IDLE_TIMEOUT_MS
      : undefined
  if (envValue !== undefined && envValue !== '') {
    const parsed = Number(envValue)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed
    }
  }
  return 0
}

const timeoutsDisabled = (): boolean =>
  typeof process !== 'undefined' &&
  process.env?.CODEBUFF_DISABLE_TIMEOUTS === '1'

const longLivedFetchImpl = (
  input: URL | RequestInfo,
  init?: RequestInit,
): Promise<Response> => {
  const idleTimeout = timeoutsDisabled() ? 0 : parseIdleTimeoutMs()
  const extendedInit = {
    ...(init ?? {}),
    idleTimeout,
    keepalive: true,
  } as RequestInit & { idleTimeout?: number }
  return globalThis.fetch(input as RequestInfo, extendedInit)
}

// `preconnect` is a Bun/web-fetch static method; expose the wrapped fetch as
// the same shape so it slots in anywhere `typeof globalThis.fetch` is required.
// We declare the signature explicitly rather than via `typeof fetch.preconnect`
// because the standard DOM `fetch` type (used when the SDK bundles its .d.ts)
// has no `preconnect`, which made the declaration build fail with TS2339.
type PreconnectFn = (url: string | URL) => void
;(longLivedFetchImpl as unknown as { preconnect?: PreconnectFn }).preconnect =
  (globalThis.fetch as unknown as { preconnect?: PreconnectFn }).preconnect ??
  (() => {})

export const longLivedFetch = longLivedFetchImpl as typeof globalThis.fetch
