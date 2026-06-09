import { writeFileSync } from 'fs'
import { join } from 'path'
import { jsonToolResult } from '@codebuff/common/util/messages'

import type { CodebuffToolHandlerFunction } from '../handler-function-type'
import type {
  CodebuffToolCall,
  CodebuffToolOutput,
} from '@codebuff/common/tools/list'

type ToolName = 'write_todos'
export const handleWriteTodos = (async (params: {
  previousToolCallFinished: Promise<void>
  toolCall: CodebuffToolCall<ToolName>
}): Promise<{ output: CodebuffToolOutput<ToolName> }> => {
  const { previousToolCallFinished, toolCall } = params

  await previousToolCallFinished

  // Persist the todo list to tasks.md in the project root for cross-turn
  // tracking. This is best-effort: file I/O failures must not block the
  // tool response.
  try {
    const todos = toolCall.input.todos
    if (Array.isArray(todos) && todos.length > 0) {
      const lines: string[] = ['# المهام', '']
      for (const todo of todos) {
        const checkbox = todo.completed ? '✅' : '⬜'
        lines.push(`- ${checkbox} ${todo.task}`)
      }
      lines.push('')
      lines.push('---')
      lines.push(`_آخر تحديث: ${new Date().toISOString()}_`)

      const filePath = join(process.cwd(), 'tasks.md')
      writeFileSync(filePath, lines.join('\n'), 'utf8')
    }
  } catch {
    // File I/O failure is non-fatal. The tool call succeeds regardless.
  }

  return { output: jsonToolResult({ message: 'Todos written' }) }
}) satisfies CodebuffToolHandlerFunction<ToolName>
