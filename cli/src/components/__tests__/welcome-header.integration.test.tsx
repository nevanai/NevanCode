import React from 'react'
import { describe, expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'

import { WelcomeHeader } from '../welcome-header'
import { buildCliRuntimeIdentity } from '../../utils/runtime-identity'
import { chatThemes } from '../../utils/theme-system'

describe('WelcomeHeader runtime identity', () => {
  test('renders the runtime line for non-production environments', () => {
    const markup = renderToString(
      <WelcomeHeader
        logoComponent={<text>LOGO</text>}
        productName="Codebuff"
        foregroundColor={chatThemes.light.foreground}
        mutedColor={chatThemes.light.muted}
        runtimeIdentity={buildCliRuntimeIdentity({
          environment: 'dev',
          configDir: '/Users/example/.config/manicode-dev',
        })}
        directoryLink={<span>~/Desktop/codebuff-main</span>}
      />,
    )

    expect(markup).toContain(
      'Runtime: dev · Config: /Users/example/.config/manicode-dev',
    )
  })

  test('omits the runtime line in production', () => {
    const markup = renderToString(
      <WelcomeHeader
        logoComponent={<text>LOGO</text>}
        productName="Codebuff"
        foregroundColor={chatThemes.light.foreground}
        mutedColor={chatThemes.light.muted}
        runtimeIdentity={buildCliRuntimeIdentity({
          environment: 'prod',
          configDir: '/Users/example/.config/manicode',
        })}
        directoryLink={<span>~/Desktop/codebuff-main</span>}
      />,
    )

    expect(markup).not.toContain('Runtime: prod')
  })
})
