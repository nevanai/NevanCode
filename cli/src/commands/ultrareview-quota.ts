export type UltrareviewQuotaResponse = {
  reviews_used: number
  reviews_limit: number
  reviews_remaining: number
  is_overage: boolean
}

/**
 * Local ultrareview does not consume remote quota or Extra Usage. Keep this
 * helper for compatibility with existing call sites, but never call external
 * services from it.
 */
export async function fetchUltrareviewQuota(): Promise<UltrareviewQuotaResponse | null> {
  return null
}