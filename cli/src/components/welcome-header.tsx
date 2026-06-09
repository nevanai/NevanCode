import React from 'react'

import type { CliRuntimeIdentity } from '../utils/runtime-identity'

interface WelcomeHeaderProps {
  directoryLink: React.ReactNode
  foregroundColor: string
  logoComponent: React.ReactNode
  mutedColor: string
  productName: string
  runtimeIdentity?: CliRuntimeIdentity
}

export const WelcomeHeader = ({
  directoryLink,
  foregroundColor,
  logoComponent,
  mutedColor,
  productName,
  runtimeIdentity,
}: WelcomeHeaderProps) => {
  return (
    <box
      style={{
        flexDirection: 'column',
        gap: 0,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <box
        style={{
          flexDirection: 'column',
          marginBottom: 1,
          marginTop: 2,
        }}
      >
        {logoComponent}
      </box>
      <text style={{ wrapMode: 'word', marginBottom: 1, fg: foregroundColor }}>
        {productName} will run commands on your behalf to help you build.
      </text>
      <text style={{ wrapMode: 'word', marginBottom: 1, fg: foregroundColor }}>
        Directory {directoryLink}
      </text>
      {runtimeIdentity?.visibleInUi ? (
        <text style={{ wrapMode: 'word', marginBottom: 1, fg: mutedColor }}>
          {runtimeIdentity.label}
        </text>
      ) : null}
    </box>
  )
}
