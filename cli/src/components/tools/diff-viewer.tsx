import { TextAttributes } from '@opentui/core'

import { useTheme } from '../../hooks/use-theme'

interface DiffViewerProps {
  diffText: string
}

// Monochrome diff palette: distinguish added vs removed via weight, not hue.
const DIFF_LINE_COLORS = {
  dark: {
    added: '#ffffff',
    removed: '#9a9a9a',
  },
  light: {
    added: '#000000',
    removed: '#6a6a6a',
  },
}

const lineColor = (
  line: string,
  themeName: 'dark' | 'light',
  mutedColor: string,
): { fg: string; attrs?: number } => {
  if (line.startsWith('@@')) {
    return { fg: mutedColor, attrs: TextAttributes.BOLD }
  }
  if (line.startsWith('+++') || line.startsWith('---')) {
    return { fg: mutedColor, attrs: TextAttributes.BOLD }
  }
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('rename ') ||
    line.startsWith('similarity ')
  ) {
    return { fg: mutedColor }
  }
  if (line.startsWith('+')) {
    return { fg: DIFF_LINE_COLORS[themeName].added, attrs: TextAttributes.BOLD }
  }
  if (line.startsWith('-')) {
    return { fg: DIFF_LINE_COLORS[themeName].removed, attrs: TextAttributes.DIM }
  }
  if (line.startsWith('\\')) {
    return { fg: mutedColor }
  }
  return { fg: '' }
}

export const DiffViewer = ({ diffText }: DiffViewerProps) => {
  const theme = useTheme()

  const lines = diffText.trim().split('\n')

  return (
    <box
      style={{ flexDirection: 'column', gap: 0, width: '100%', flexGrow: 1 }}
    >
      {lines
        .filter((rawLine) => !rawLine.startsWith('@@'))
        .map((rawLine, idx) => {
          const line = rawLine.length === 0 ? ' ' : rawLine
          const { fg, attrs } = lineColor(line, theme.name, theme.muted)
          const resolvedFg = fg || theme.foreground
          return (
            <text key={`diff-line-${idx}`} style={{ wrapMode: 'none' }}>
              <span fg={resolvedFg} attributes={attrs}>
                {line}
              </span>
            </text>
          )
        })}
    </box>
  )
}
