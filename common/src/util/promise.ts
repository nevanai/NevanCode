export const INITIAL_RETRY_DELAY = 1000 // 1 second

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries?: number
    retryIf?: (error: any) => boolean
    onRetry?: (error: any, attempt: number) => void
    retryDelayMs?: number
  } = {},
): Promise<T> {
  const {
    maxRetries = 3,
    retryIf = (error) => error?.type === 'APIConnectionError',
    onRetry = () => {},
    retryDelayMs = INITIAL_RETRY_DELAY,
  } = options

  let lastError: any = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error

      if (!retryIf(error) || attempt === maxRetries - 1) {
        throw error
      }

      onRetry(error, attempt + 1)

      // Exponential backoff with jitter (±20%) to prevent thundering herd
      const baseDelayMs = retryDelayMs * Math.pow(2, attempt)
      const jitter = 0.8 + Math.random() * 0.4 // Random multiplier between 0.8 and 1.2
      const delayMs = Math.round(baseDelayMs * jitter)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  throw lastError
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Wraps a promise with a timeout.
 *
 * Pass `Infinity`, `0`, or a negative number to disable the timeout entirely.
 * The env var `CODEBUFF_DISABLE_TIMEOUTS=1` also disables every timeout —
 * useful for sessions that must run for hours/days without being killed by a
 * hard-coded short timeout.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string = `Operation timed out after ${timeoutMs}ms`,
): Promise<T> {
  const disabled =
    typeof process !== 'undefined' &&
    process.env?.CODEBUFF_DISABLE_TIMEOUTS === '1'

  if (
    disabled ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return promise
  }

  let timeoutId: NodeJS.Timeout

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage))
    }, timeoutMs)
  })

  return Promise.race([
    promise.then((result) => {
      clearTimeout(timeoutId)
      return result
    }),
    timeoutPromise,
  ])
}
