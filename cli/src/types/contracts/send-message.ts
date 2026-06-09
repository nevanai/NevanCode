import type { PendingAttachment } from '../store'
import type { AgentMode } from '../../utils/constants'
import type { ChatMessage } from '../chat'

export type PostUserMessageFn = (prev: ChatMessage[]) => ChatMessage[]

export type SendMessageFn = (params: {
  content: string
  agentMode: AgentMode
  postUserMessage?: PostUserMessageFn
  attachments?: PendingAttachment[]
  /**
   * Optional raw user intent that the auto-goal trigger should use instead of
   * `content`. Set this when a slash-command handler builds an agent-facing
   * wrapper around the user's input (e.g. `/plan`, `/review`, `/interview`,
   * or the clear-and-implement seed) so the goal captures the user's actual
   * intent rather than the wrapped prompt.
   */
  userIntent?: string
}) => Promise<void>
