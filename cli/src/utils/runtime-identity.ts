import { env } from '@codebuff/common/env'

import { getConfigDir } from './auth'
import { formatCwd } from './path-helpers'

export type CliRuntimeEnvironment = 'dev' | 'test' | 'prod'

export interface CliRuntimeIdentity {
  environment: CliRuntimeEnvironment
  configDir: string
  configDirDisplay: string
  label: string
  visibleInUi: boolean
}

export const buildCliRuntimeIdentity = ({
  environment,
  configDir,
}: {
  environment: CliRuntimeEnvironment
  configDir: string
}): CliRuntimeIdentity => {
  const configDirDisplay = formatCwd(configDir)

  return {
    environment,
    configDir,
    configDirDisplay,
    label: `Runtime: ${environment} · Config: ${configDirDisplay}`,
    visibleInUi: environment !== 'prod',
  }
}

export const getCliRuntimeIdentity = (): CliRuntimeIdentity => {
  return buildCliRuntimeIdentity({
    environment: env.NEXT_PUBLIC_CB_ENVIRONMENT,
    configDir: getConfigDir(),
  })
}

export const prependCliRuntimeIdentity = (
  content: string,
  runtimeIdentity: CliRuntimeIdentity = getCliRuntimeIdentity(),
): string => {
  if (!runtimeIdentity.visibleInUi) {
    return content
  }

  return `${runtimeIdentity.label}\n\n${content}`
}
