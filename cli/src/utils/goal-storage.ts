import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import path from 'path'

import { getProjectDataDir } from '../project-files'

import type { ThreadGoal } from '../state/goal-store'

const GOAL_FILE_NAME = 'thread_goal.json'

const tryGetGoalFilePath = (): string | null => {
  try {
    const dir = getProjectDataDir()
    return path.join(dir, GOAL_FILE_NAME)
  } catch {
    return null
  }
}

const ensureDir = (filePath: string) => {
  const dir = path.dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export const persistGoalForProject = (goal: ThreadGoal): void => {
  const filePath = tryGetGoalFilePath()
  if (!filePath) return
  try {
    ensureDir(filePath)
    writeFileSync(filePath, JSON.stringify(goal, null, 2), 'utf8')
  } catch {
    // Persistence is best-effort; CLI continues without disk goal cache
  }
}

export const loadGoalForProject = (): ThreadGoal | null => {
  const filePath = tryGetGoalFilePath()
  if (!filePath || !existsSync(filePath)) return null
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as ThreadGoal
    if (
      typeof parsed?.goalId === 'string' &&
      typeof parsed.objective === 'string' &&
      typeof parsed.status === 'string'
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export const clearPersistedGoal = (): void => {
  const filePath = tryGetGoalFilePath()
  if (!filePath || !existsSync(filePath)) return
  try {
    unlinkSync(filePath)
  } catch {
    // best-effort cleanup
  }
}
