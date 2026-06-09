/**
 * Local ultrareview is always available because it no longer depends on remote
 * feature gates, quota, billing, or Claude Code on the web.
 */
export function isUltrareviewEnabled(): boolean {
  return true
}