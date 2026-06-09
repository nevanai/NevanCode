import { bold } from 'picocolors'

import { LOGIN_WEBSITE_URL } from './constants'
import { generateLoginUrl, pollLoginStatus } from './login-flow'
import { saveUserCredentials } from '../utils/auth'
import { getFingerprintId } from '../utils/fingerprint'
import { logger } from '../utils/logger'

import type { User } from '../utils/auth'

/**
 * Plain-text login flow that runs outside the TUI.
 * Prints the login URL as plain text so the user can select and copy it
 * using normal terminal text selection (Cmd+C / Ctrl+Shift+C).
 *
 * This is the escape hatch for remote/SSH environments where the TUI's
 * clipboard and browser integration don't work.
 */
export async function runPlainLogin(): Promise<void> {
  const fingerprintId = await getFingerprintId()

  console.log()
  console.log(bold('NevanCode Login'))
  console.log()
  console.log('Generating login URL...')

  let loginData
  try {
    loginData = await generateLoginUrl(
      { logger },
      { baseUrl: LOGIN_WEBSITE_URL, fingerprintId },
    )
  } catch (error) {
    console.error(
      `Failed to generate login URL: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    process.exit(1)
  }

  console.log()
  console.log('Open this URL in your browser to log in:')
  console.log()
  console.log(loginData.loginUrl)
  console.log()
  console.log('Please open the URL above manually to complete login.')
  console.log()
  console.log('Waiting for login...')

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms)
    })

  const result = await pollLoginStatus(
    { sleep, logger },
    {
      baseUrl: LOGIN_WEBSITE_URL,
      fingerprintId,
      fingerprintHash: loginData.fingerprintHash,
      expiresAt: loginData.expiresAt,
    },
  )

  if (result.status === 'success') {
    const user = result.user as User
    saveUserCredentials(user)
    console.log()
    console.log(bold(`Logged in as ${user.name} (${user.email})`))
    console.log()
    console.log('You can now run ' + bold('nevancode') + ' to start.')
    process.exit(0)
  } else if (result.status === 'timeout') {
    console.error('Login timed out. Please try again.')
    process.exit(1)
  } else {
    console.error('Login was aborted.')
    process.exit(1)
  }
}
