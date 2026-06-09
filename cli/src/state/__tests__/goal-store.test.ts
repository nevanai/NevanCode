import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'fs'
import os from 'os'
import path from 'path'

import { getProjectDataDir, setProjectRoot } from '../../project-files'
import { buildGoalContextBlock, useGoalStore } from '../goal-store'

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'codebuff-goal-test-'))
const FAKE_PROJECT = path.join(TMP_ROOT, 'sample-project')

setProjectRoot(FAKE_PROJECT)

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true })
})

describe('goal-store', () => {
  beforeEach(() => {
    useGoalStore.getState().clearGoal()
    useGoalStore.getState().resetAutoCreateFlag()
  })

  describe('createGoal', () => {
    test('creates an active goal with the given objective', () => {
      const goal = useGoalStore.getState().createGoal({
        objective: 'Ship feature X',
      })

      expect(goal.objective).toBe('Ship feature X')
      expect(goal.status).toBe('active')
      expect(goal.tokenBudget).toBeNull()
      expect(goal.tokensUsed).toBe(0)
      expect(goal.autoCreated).toBe(false)
      expect(useGoalStore.getState().currentGoal?.goalId).toBe(goal.goalId)
    })

    test('trims whitespace from objectives', () => {
      const goal = useGoalStore
        .getState()
        .createGoal({ objective: '   Add login flow   ' })
      expect(goal.objective).toBe('Add login flow')
    })

    test('marks the auto-create attempt latch after creating', () => {
      useGoalStore.getState().createGoal({
        objective: 'auto-goal',
        autoCreated: true,
      })
      expect(useGoalStore.getState().hasAttemptedAutoCreate).toBe(true)
    })

    test('accepts an optional token budget', () => {
      const goal = useGoalStore.getState().createGoal({
        objective: 'budgeted',
        tokenBudget: 10_000,
      })
      expect(goal.tokenBudget).toBe(10_000)
    })

    test('drops a non-positive token budget', () => {
      const goal = useGoalStore.getState().createGoal({
        objective: 'no-budget',
        tokenBudget: 0,
      })
      expect(goal.tokenBudget).toBeNull()
    })
  })

  describe('updateStatus', () => {
    test('paused → active transitions are reflected', () => {
      useGoalStore.getState().createGoal({ objective: 'work' })
      useGoalStore.getState().updateStatus('paused')
      expect(useGoalStore.getState().currentGoal?.status).toBe('paused')
      useGoalStore.getState().updateStatus('active')
      expect(useGoalStore.getState().currentGoal?.status).toBe('active')
    })

    test('no-op when there is no current goal', () => {
      useGoalStore.getState().updateStatus('complete')
      expect(useGoalStore.getState().currentGoal).toBeNull()
    })
  })

  describe('updateObjective', () => {
    test('replaces the objective and rotates the goal_id', () => {
      const original = useGoalStore
        .getState()
        .createGoal({ objective: 'first objective' })
      useGoalStore.getState().updateObjective('replacement objective')

      const next = useGoalStore.getState().currentGoal!
      expect(next.objective).toBe('replacement objective')
      expect(next.goalId).not.toBe(original.goalId)
    })
  })

  describe('accountUsage', () => {
    test('increments tokensUsed only while active', () => {
      useGoalStore.getState().createGoal({ objective: 'a' })
      useGoalStore.getState().accountUsage({ tokens: 100 })
      expect(useGoalStore.getState().currentGoal?.tokensUsed).toBe(100)

      useGoalStore.getState().updateStatus('paused')
      useGoalStore.getState().accountUsage({ tokens: 100 })
      // Paused goals don't accumulate usage.
      expect(useGoalStore.getState().currentGoal?.tokensUsed).toBe(100)
    })

    test('crossing the token budget transitions to budget_limited', () => {
      useGoalStore.getState().createGoal({
        objective: 'budgeted',
        tokenBudget: 1_000,
      })
      useGoalStore.getState().accountUsage({ tokens: 1_500 })
      expect(useGoalStore.getState().currentGoal?.status).toBe('budget_limited')
    })

    test('does not increment for non-positive or missing values', () => {
      useGoalStore.getState().createGoal({ objective: 'a' })
      useGoalStore.getState().accountUsage({ tokens: 0 })
      useGoalStore.getState().accountUsage({})
      expect(useGoalStore.getState().currentGoal?.tokensUsed).toBe(0)
    })
  })

  describe('clearGoal', () => {
    test('removes the goal and resets the auto-create latch', () => {
      useGoalStore.getState().createGoal({ objective: 'to clear' })
      useGoalStore.getState().clearGoal()
      expect(useGoalStore.getState().currentGoal).toBeNull()
      expect(useGoalStore.getState().hasAttemptedAutoCreate).toBe(false)
    })
  })

  describe('persistence (disk)', () => {
    // Resolve the file path the same way the store does — through
    // getProjectDataDir(). Other tests in the suite mutate HOME at runtime;
    // recomputing os.homedir() here would race against those mutations.
    const getGoalFilePath = () =>
      path.join(getProjectDataDir(), 'thread_goal.json')

    test('createGoal writes thread_goal.json under the project data dir', () => {
      useGoalStore.getState().createGoal({ objective: 'persist me' })
      const filePath = getGoalFilePath()
      expect(existsSync(filePath)).toBe(true)
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
      expect(parsed.objective).toBe('persist me')
    })

    test('clearGoal removes the persisted file', () => {
      useGoalStore.getState().createGoal({ objective: 'temp' })
      useGoalStore.getState().clearGoal()
      expect(existsSync(getGoalFilePath())).toBe(false)
    })
  })

  describe('hydrateFromDisk', () => {
    const getGoalFilePath = () =>
      path.join(getProjectDataDir(), 'thread_goal.json')

    const writeGoalFile = (goal: Record<string, unknown>) => {
      const filePath = getGoalFilePath()
      mkdirSync(path.dirname(filePath), { recursive: true })
      writeFileSync(filePath, JSON.stringify(goal, null, 2), 'utf8')
    }

    const baseGoal = {
      goalId: 'persisted-goal',
      objective: 'objective from a previous session',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    }

    test('restores a goal the user set explicitly (autoCreated: false)', () => {
      writeGoalFile({ ...baseGoal, autoCreated: false })

      useGoalStore.getState().hydrateFromDisk()

      const goal = useGoalStore.getState().currentGoal
      expect(goal?.objective).toBe('objective from a previous session')
      expect(useGoalStore.getState().hasAttemptedAutoCreate).toBe(true)
    })

    test('discards an auto-created goal and deletes the stale file', () => {
      writeGoalFile({ ...baseGoal, autoCreated: true })

      useGoalStore.getState().hydrateFromDisk()

      // The previous session's auto-goal must not leak in: no current goal, and
      // the latch stays disarmed so the next first message seeds a fresh goal.
      expect(useGoalStore.getState().currentGoal).toBeNull()
      expect(useGoalStore.getState().hasAttemptedAutoCreate).toBe(false)
      expect(existsSync(getGoalFilePath())).toBe(false)
    })

    test('discards a legacy goal that is missing the autoCreated field', () => {
      writeGoalFile(baseGoal) // no autoCreated key at all

      useGoalStore.getState().hydrateFromDisk()

      expect(useGoalStore.getState().currentGoal).toBeNull()
      expect(existsSync(getGoalFilePath())).toBe(false)
    })
  })

  describe('startNewThread', () => {
    test('clears an auto-created goal so the next message can reseed', () => {
      useGoalStore
        .getState()
        .createGoal({ objective: 'auto goal', autoCreated: true })

      useGoalStore.getState().startNewThread()

      expect(useGoalStore.getState().currentGoal).toBeNull()
      expect(useGoalStore.getState().hasAttemptedAutoCreate).toBe(false)
    })

    test('keeps an explicit user-set goal and only re-arms the latch', () => {
      const goal = useGoalStore
        .getState()
        .createGoal({ objective: 'user goal', autoCreated: false })

      useGoalStore.getState().startNewThread()

      expect(useGoalStore.getState().currentGoal?.goalId).toBe(goal.goalId)
      expect(useGoalStore.getState().hasAttemptedAutoCreate).toBe(false)
    })
  })
})

describe('buildGoalContextBlock', () => {
  test('returns empty string when no goal is set', () => {
    expect(buildGoalContextBlock(null)).toBe('')
  })

  test('returns empty string when the goal is paused', () => {
    expect(
      buildGoalContextBlock({
        goalId: 'g',
        objective: 'x',
        status: 'paused',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAtMs: 0,
        updatedAtMs: 0,
        autoCreated: false,
      }),
    ).toBe('')
  })

  test('returns empty string when the goal is complete', () => {
    expect(
      buildGoalContextBlock({
        goalId: 'g',
        objective: 'x',
        status: 'complete',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAtMs: 0,
        updatedAtMs: 0,
        autoCreated: false,
      }),
    ).toBe('')
  })

  test('includes the objective and status inside a tagged block', () => {
    const block = buildGoalContextBlock({
      goalId: 'g',
      objective: 'Migrate auth to OAuth',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 42,
      timeUsedSeconds: 7,
      createdAtMs: 1,
      updatedAtMs: 2,
      autoCreated: true,
    })
    expect(block).toContain('<active_thread_goal>')
    expect(block).toContain('</active_thread_goal>')
    expect(block).toContain('Migrate auth to OAuth')
    expect(block).toContain('Status: active')
    expect(block).toContain('Tokens used: 42')
  })

  test('shows the budget ratio when a token budget exists', () => {
    const block = buildGoalContextBlock({
      goalId: 'g',
      objective: 'x',
      status: 'active',
      tokenBudget: 1_000,
      tokensUsed: 250,
      timeUsedSeconds: 0,
      createdAtMs: 0,
      updatedAtMs: 0,
      autoCreated: false,
    })
    expect(block).toContain('Tokens used: 250 / 1000')
  })
})
