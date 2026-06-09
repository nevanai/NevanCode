# @codebuff/nevan-agent

Voice-first ambient companion that sits on top of Codebuff / Nevan Code. It
observes the user's workspace, intervenes proactively when useful, and pipes
refined prompts into the Nevan CLI Coder.

See `PRD.md` and `tasks.md` at the repo root for the full vision and milestone plan.

## Module Layout

| Module          | Responsibility                                                                |
| --------------- | ------------------------------------------------------------------------------ |
| `auth`          | Token validation, session records, identity confirmation.                     |
| `core`          | System nucleus, guardrails, event bus, memory layers, prompt rewriter.        |
| `voice_agent`   | STT, TTS (Saudi dialect), humanizer, wake-word, system prompt persona.        |
| `cli_coder`     | Bridge that injects engineered prompts into the existing CLI agent.           |
| `os_listeners`  | Background window / mouse / screen listeners + Hermes MCP integration.        |

Each module exposes a single `index.ts` barrel; everything else is internal.
