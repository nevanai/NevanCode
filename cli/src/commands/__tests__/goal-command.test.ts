import { describe, test, expect, beforeEach, beforeAll } from 'bun:test'
import { mkdtempSync } from 'fs'
import os from 'os'
import path from 'path'

import { setProjectRoot } from '../../project-files'
import { useGoalStore } from '../../state/goal-store'
import {
  handleGoalCommand,
  maybeAutoCreateGoalFromFirstMessage,
} from '../goal'

const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'codebuff-goal-cmd-'))
setProjectRoot(path.join(TMP_ROOT, 'fake-project'))

const last = <T>(arr: readonly T[]): T => {
  return arr[arr.length - 1]
}

beforeAll(() => {
  // ensure no previous test leaks a goal
  useGoalStore.getState().clearGoal()
})

describe('handleGoalCommand', () => {
  beforeEach(() => {
    useGoalStore.getState().clearGoal()
  })

  describe('/goal (no args, no active goal)', () => {
    test('responds with usage hint and no active goal', () => {
      const { postUserMessage } = handleGoalCommand('/goal', '')
      const messages = postUserMessage([])
      expect(messages).toHaveLength(2)
      const sysText = JSON.stringify(last(messages))
      expect(sysText).toContain('No active goal')
      expect(sysText).toContain('Usage')
      expect(useGoalStore.getState().currentGoal).toBeNull()
    })
  })

  describe('/goal <objective>', () => {
    test('creates a non-autoCreated goal and surfaces the formatted block', () => {
      const { postUserMessage } = handleGoalCommand(
        '/goal Add OAuth login',
        'Add OAuth login',
      )
      const messages = postUserMessage([])
      const sysText = JSON.stringify(last(messages))
      expect(sysText).toContain('Goal set')
      expect(sysText).toContain('Add OAuth login')

      const goal = useGoalStore.getState().currentGoal
      expect(goal).not.toBeNull()
      expect(goal?.objective).toBe('Add OAuth login')
      expect(goal?.autoCreated).toBe(false)
      expect(goal?.status).toBe('active')
    })

    test('rejects objectives longer than 4000 characters', () => {
      const huge = 'x'.repeat(4001)
      const { postUserMessage } = handleGoalCommand('/goal x', huge)
      expect(JSON.stringify(last(postUserMessage([])))).toContain('too long')
      expect(useGoalStore.getState().currentGoal).toBeNull()
    })

    test('updating an existing goal rotates the objective and goal_id', () => {
      handleGoalCommand('/goal first', 'first')
      const firstId = useGoalStore.getState().currentGoal!.goalId

      handleGoalCommand('/goal second', 'second')
      const next = useGoalStore.getState().currentGoal!
      expect(next.objective).toBe('second')
      expect(next.goalId).not.toBe(firstId)
    })
  })

  describe('/goal pause + /goal resume', () => {
    test('toggles between paused and active', () => {
      handleGoalCommand('/goal work', 'work')
      handleGoalCommand('/goal pause', 'pause')
      expect(useGoalStore.getState().currentGoal?.status).toBe('paused')

      handleGoalCommand('/goal resume', 'resume')
      expect(useGoalStore.getState().currentGoal?.status).toBe('active')
    })

    test('no-op messages when the transition is meaningless', () => {
      handleGoalCommand('/goal work', 'work')
      const { postUserMessage } = handleGoalCommand('/goal resume', 'resume')
      expect(JSON.stringify(last(postUserMessage([])))).toContain('already active')
    })

    test('pause without an active goal yields a helpful error', () => {
      const { postUserMessage } = handleGoalCommand('/goal pause', 'pause')
      expect(JSON.stringify(last(postUserMessage([])))).toContain('No active goal')
    })
  })

  describe('/goal clear', () => {
    test('removes the active goal', () => {
      handleGoalCommand('/goal foo', 'foo')
      const { postUserMessage } = handleGoalCommand('/goal clear', 'clear')
      expect(JSON.stringify(last(postUserMessage([])))).toContain('Goal cleared')
      expect(useGoalStore.getState().currentGoal).toBeNull()
    })

    test('reports no-op when there is nothing to clear', () => {
      const { postUserMessage } = handleGoalCommand('/goal clear', 'clear')
      expect(JSON.stringify(last(postUserMessage([])))).toContain('No active goal to clear')
    })
  })

  describe('/goal status', () => {
    test('mirrors the bare /goal output for an existing goal', () => {
      handleGoalCommand('/goal x', 'inspect me')
      const { postUserMessage } = handleGoalCommand('/goal status', 'status')
      expect(JSON.stringify(last(postUserMessage([])))).toContain('inspect me')
    })
  })

  describe('/goal complete', () => {
    test('marks the goal complete and includes the final block', () => {
      handleGoalCommand('/goal x', 'finish me')
      const { postUserMessage } = handleGoalCommand('/goal complete', 'complete')
      const sys = JSON.stringify(last(postUserMessage([])))
      expect(sys).toContain('Goal marked complete')
      expect(useGoalStore.getState().currentGoal?.status).toBe('complete')
    })
  })
})

describe('maybeAutoCreateGoalFromFirstMessage', () => {
  beforeEach(() => {
    useGoalStore.getState().clearGoal()
  })

  test('creates an auto-flagged goal from the first message', () => {
    const goal = maybeAutoCreateGoalFromFirstMessage('Help me ship feature Y')
    expect(goal).not.toBeNull()
    expect(goal?.autoCreated).toBe(true)
    expect(goal?.objective).toBe('Help me ship feature Y')
  })

  test('subsequent invocations in the same session are no-ops', () => {
    maybeAutoCreateGoalFromFirstMessage('first')
    const second = maybeAutoCreateGoalFromFirstMessage('second')
    expect(second).toBeNull()
    expect(useGoalStore.getState().currentGoal?.objective).toBe('first')
  })

  test('does not overwrite an existing manually-set goal', () => {
    useGoalStore
      .getState()
      .createGoal({ objective: 'manual', autoCreated: false })
    const auto = maybeAutoCreateGoalFromFirstMessage('would-be-auto')
    expect(auto).toBeNull()
    expect(useGoalStore.getState().currentGoal?.objective).toBe('manual')
  })

  test('skips empty content', () => {
    const empty = maybeAutoCreateGoalFromFirstMessage('   ')
    expect(empty).toBeNull()
    expect(useGoalStore.getState().currentGoal).toBeNull()
  })

  test('after /new (resetAutoCreateFlag) it can fire again', () => {
    maybeAutoCreateGoalFromFirstMessage('first')
    useGoalStore.getState().clearGoal() // sim. /goal clear
    useGoalStore.getState().resetAutoCreateFlag() // sim. /new
    const goal = maybeAutoCreateGoalFromFirstMessage('second session')
    expect(goal?.objective).toBe('second session')
    expect(goal?.autoCreated).toBe(true)
  })
})
