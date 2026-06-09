import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

import {
  loadGoalForProject,
  persistGoalForProject,
  clearPersistedGoal,
} from '../utils/goal-storage'

export type GoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'budget_limited'
  | 'complete'

export interface ThreadGoal {
  goalId: string
  objective: string
  status: GoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAtMs: number
  updatedAtMs: number
  /** True when the agent or runtime set this goal automatically. */
  autoCreated: boolean
}

export interface GoalStoreState {
  currentGoal: ThreadGoal | null
  hasAttemptedAutoCreate: boolean
}

interface GoalStoreActions {
  setGoal: (goal: ThreadGoal | null) => void
  createGoal: (params: {
    objective: string
    tokenBudget?: number | null
    autoCreated?: boolean
  }) => ThreadGoal
  updateStatus: (status: GoalStatus) => void
  updateObjective: (objective: string) => void
  accountUsage: (params: { tokens?: number; timeSeconds?: number }) => void
  clearGoal: () => void
  markAutoCreateAttempted: () => void
  resetAutoCreateFlag: () => void
  startNewThread: () => void
  hydrateFromDisk: () => void
}

type GoalStore = GoalStoreState & GoalStoreActions

const generateGoalId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `goal_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`

const initialState: GoalStoreState = {
  currentGoal: null,
  hasAttemptedAutoCreate: false,
}

export const useGoalStore = create<GoalStore>()(
  immer((set, get) => ({
    ...initialState,

    setGoal: (goal) =>
      set((state) => {
        state.currentGoal = goal
        if (goal) {
          persistGoalForProject(goal)
        } else {
          clearPersistedGoal()
        }
      }),

    createGoal: ({ objective, tokenBudget = null, autoCreated = false }) => {
      const now = Date.now()
      const goal: ThreadGoal = {
        goalId: generateGoalId(),
        objective: objective.trim(),
        status: 'active',
        tokenBudget: tokenBudget && tokenBudget > 0 ? tokenBudget : null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAtMs: now,
        updatedAtMs: now,
        autoCreated,
      }
      set((state) => {
        state.currentGoal = goal
        state.hasAttemptedAutoCreate = true
      })
      persistGoalForProject(goal)
      return goal
    },

    updateStatus: (status) =>
      set((state) => {
        if (!state.currentGoal) return
        state.currentGoal.status = status
        state.currentGoal.updatedAtMs = Date.now()
        persistGoalForProject(state.currentGoal)
      }),

    updateObjective: (objective) =>
      set((state) => {
        if (!state.currentGoal) return
        state.currentGoal.objective = objective.trim()
        state.currentGoal.updatedAtMs = Date.now()
        state.currentGoal.goalId = generateGoalId()
        persistGoalForProject(state.currentGoal)
      }),

    accountUsage: ({ tokens, timeSeconds }) =>
      set((state) => {
        const goal = state.currentGoal
        if (!goal) return
        if (goal.status !== 'active') return
        if (typeof tokens === 'number' && tokens > 0) {
          goal.tokensUsed += tokens
        }
        if (typeof timeSeconds === 'number' && timeSeconds > 0) {
          goal.timeUsedSeconds += timeSeconds
        }
        goal.updatedAtMs = Date.now()
        if (
          goal.tokenBudget !== null &&
          goal.tokensUsed >= goal.tokenBudget
        ) {
          goal.status = 'budget_limited'
        }
        persistGoalForProject(goal)
      }),

    clearGoal: () => {
      set((state) => {
        state.currentGoal = null
        state.hasAttemptedAutoCreate = false
      })
      clearPersistedGoal()
    },

    markAutoCreateAttempted: () =>
      set((state) => {
        state.hasAttemptedAutoCreate = true
      }),

    resetAutoCreateFlag: () =>
      set((state) => {
        state.hasAttemptedAutoCreate = false
      }),

    startNewThread: () => {
      // `/new`, `/clear`: begin a fresh thread. An auto-created goal belongs to
      // the thread that produced it; carrying it over lets a previous request's
      // objective hijack the next one (it blocks a fresh auto-goal from seeding
      // and is re-injected as <active_thread_goal> every turn). Drop it so the
      // next message can seed its own goal. An explicit user-set goal
      // (`autoCreated === false`) is deliberate, so keep it and just re-arm the
      // auto-create latch.
      const goal = get().currentGoal
      if (goal && goal.autoCreated !== false) {
        get().clearGoal()
      } else {
        get().resetAutoCreateFlag()
      }
    },

    hydrateFromDisk: () => {
      const persisted = loadGoalForProject()
      if (!persisted) return
      // Only restore goals the user set explicitly via `/goal`. A fresh CLI
      // launch is a new thread, so an auto-created goal from a previous session
      // must not be revived — otherwise its stale objective stays in
      // `currentGoal`, blocks the new first message from seeding a fresh goal,
      // and gets injected as <active_thread_goal> every turn. Treat a missing
      // or legacy `autoCreated` field as auto-created so stale goals already on
      // disk are cleared on next launch too.
      if (persisted.autoCreated === false) {
        set((state) => {
          state.currentGoal = persisted
          state.hasAttemptedAutoCreate = true
        })
        return
      }
      clearPersistedGoal()
    },
  })),
)

/**
 * Build the system context block that conveys the active goal to the agent.
 * Returned as a string ready to prepend to a user message. Returns empty
 * string when no goal is active.
 */
export const buildGoalContextBlock = (goal: ThreadGoal | null): string => {
  if (!goal) return ''
  if (goal.status === 'paused') return ''
  if (goal.status === 'complete') return ''

  const budgetLine =
    goal.tokenBudget !== null
      ? `Tokens used: ${goal.tokensUsed} / ${goal.tokenBudget}`
      : `Tokens used: ${goal.tokensUsed}`
  return [
    '<active_thread_goal>',
    `Status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    budgetLine,
    `Time used (s): ${goal.timeUsedSeconds}`,
    '',
    'This goal persists across turns. Keep working toward this objective until the user marks it complete or clears it.',
    'You may call get_goal to inspect the current goal, or update_goal with status "complete" or "blocked" when the criteria are met.',
    'Do not silently abandon the goal; report progress and remaining work each turn.',
    '</active_thread_goal>',
  ].join('\n')
}
