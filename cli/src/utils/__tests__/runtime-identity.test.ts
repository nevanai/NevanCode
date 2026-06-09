import os from 'os'
import path from 'path'

import { describe, expect, test } from 'bun:test'

import {
  buildCliRuntimeIdentity,
  prependCliRuntimeIdentity,
} from '../runtime-identity'

describe('runtime identity helpers', () => {
  test('uses the dev config directory label in development', () => {
    const identity = buildCliRuntimeIdentity({
      environment: 'dev',
      configDir: path.join(os.homedir(), '.config', 'manicode-dev'),
    })

    expect(identity.environment).toBe('dev')
    expect(identity.configDirDisplay).toBe('~/.config/manicode-dev')
    expect(identity.label).toBe('Runtime: dev · Config: ~/.config/manicode-dev')
    expect(identity.visibleInUi).toBe(true)
  })

  test('uses the production config directory label without enabling the banner', () => {
    const identity = buildCliRuntimeIdentity({
      environment: 'prod',
      configDir: path.join(os.homedir(), '.config', 'manicode'),
    })

    expect(identity.configDirDisplay).toBe('~/.config/manicode')
    expect(identity.label).toBe('Runtime: prod · Config: ~/.config/manicode')
    expect(identity.visibleInUi).toBe(false)
  })

  test('prepends the runtime line only when the identity should be visible', () => {
    const devIdentity = buildCliRuntimeIdentity({
      environment: 'dev',
      configDir: path.join(os.homedir(), '.config', 'manicode-dev'),
    })
    const prodIdentity = buildCliRuntimeIdentity({
      environment: 'prod',
      configDir: path.join(os.homedir(), '.config', 'manicode'),
    })

    expect(
      prependCliRuntimeIdentity('Selected model: GPT-5.5', devIdentity),
    ).toBe(
      'Runtime: dev · Config: ~/.config/manicode-dev\n\nSelected model: GPT-5.5',
    )
    expect(
      prependCliRuntimeIdentity('Selected model: GPT-5.5', prodIdentity),
    ).toBe('Selected model: GPT-5.5')
  })
})
