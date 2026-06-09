import { memo, useEffect, useState } from 'react'

import { useTheme } from '../hooks/use-theme'
import { useIndexingStore } from '../state/indexing-store'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const PHASE_LABEL: Record<string, string> = {
  idle: 'idle',
  walking: 'discovering files',
  parsing: 'parsing',
  embedding: 'embedding',
  persisting: 'writing index',
  watching: 'watching',
  done: 'ready',
  error: 'error',
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

export const IndexingStatus = memo(() => {
  const theme = useTheme()
  const { enabled, progress, summary, lastError } = useIndexingStore()
  const [frame, setFrame] = useState(0)
  const showSpinner =
    enabled &&
    progress !== null &&
    progress.phase !== 'done' &&
    progress.phase !== 'error'

  useEffect(() => {
    if (!showSpinner) return
    const handle = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length)
    }, 80)
    return () => clearInterval(handle)
  }, [showSpinner])

  if (!enabled) return null

  if (lastError) {
    return (
      <box style={{ paddingLeft: 0, paddingRight: 0 }}>
        <text style={{ fg: theme.muted }}>
          {'  '}
          semantic index error: {lastError}
        </text>
      </box>
    )
  }

  if (summary) {
    return (
      <box style={{ paddingLeft: 0, paddingRight: 0 }}>
        <text style={{ fg: theme.muted }}>
          {'  '}
          ✓ project understood ({formatElapsed(summary.elapsedMs)}) — {summary.totalFiles} files
          {summary.indexedFiles > 0 ? `, ${summary.indexedFiles} indexed` : ''}
          {summary.skippedFiles > 0 ? `, ${summary.skippedFiles} cached` : ''}
          {summary.failedFiles > 0 ? `, ${summary.failedFiles} skipped` : ''}
          {summary.modules > 0 ? ` · ${summary.modules} modules` : ''}
          {summary.services > 0 ? `, ${summary.services} services` : ''}
        </text>
      </box>
    )
  }

  if (!progress) return null

  const phaseLabel = PHASE_LABEL[progress.phase] ?? progress.phase
  const fileCount =
    progress.filesIndexed + progress.filesSkipped + progress.filesFailed
  const totalDiscovered = progress.filesDiscovered
  const detail =
    totalDiscovered > 0
      ? `${fileCount}/${totalDiscovered} files`
      : `${progress.filesDiscovered} files`

  return (
    <box style={{ paddingLeft: 0, paddingRight: 0 }}>
      <text style={{ fg: theme.muted }}>
        {'  '}
        {SPINNER_FRAMES[frame]} indexing project — {phaseLabel} · {detail}
      </text>
    </box>
  )
})
