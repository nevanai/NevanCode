# PRD: NevanCode Improvements (4 Deliverables)

## Objective
Four distinct improvements to the NevanCode CLI/agent system:

1. **Force project index auto-load**: Make agents ALWAYS read the project index at session start (no longer wait for user to mention it).
2. **Remove Ultra Plan feature entirely**: Delete all files, code, slash commands, tests, and UI for `/ultraplan`.
3. **Real Context Window indicator**: Show actual model context (0 → max tokens) with dynamic model-specific max (256K, 1M, etc.) and live token counting.
4. **Multi-agent system**: Each agent focuses on ONE specific task with full focus.

## Functional Requirements

### FR-1: Index-First Protocol (auto-load)
- Modify the agent system prompt `agents/base2/base2.ts` to make index reading MANDATORY at session start.
- Update "بروتوكول فهم المشروع" section to say: agent must read index automatically on first turn, no user prompt required.
- Update "الفهرسة أولاً (Index-First)" rule.
- Update "Mandatory Project Understanding Protocol" to enforce automatic reading.

### FR-2: Remove Ultra Plan
- Delete `cli/src/commands/ultraplan.ts`.
- Delete `cli/src/commands/__tests__/ultra-commands.test.ts` (or rename to not include ultraplan).
- Update `cli/src/data/slash-commands.ts`: remove `ultraplan` entry and its alias.
- Update `cli/src/commands/router.ts`: remove `buildUltraplanPrompt` import + `inputMode === 'ultraPlan'` branch.
- Update `cli/src/commands/command-registry.ts`: remove `ultraplan` command definition.
- Update `cli/src/utils/input-modes.ts`: remove `ultraPlan` from `InputMode` type and `INPUT_MODE_CONFIGS`.
- Update `cli/src/components/bundled-agents.generated.ts` if it references ultraplan.

### FR-3: Real Context Window Bar
- Modify `cli/src/utils/context-window.ts`:
  - Change percentage range from 0-100 to dynamic 0 → maxTokens.
  - Add more model entries (Gemini 1.5, 2.0, 2.5, Claude 4.x, GPT-4.1, GPT-5).
  - Add `formatTokenCount()` helper for k/M display.
  - Add `getContextWindowForModel()` returning the actual max.
- Modify `cli/src/components/context-window-indicator.tsx`:
  - Display "X / Y tokens" with model max.
  - Add label "Context Window" instead of just percentage.
  - Add input live token count.
- Modify `cli/src/hooks/use-context-window-indicator.ts` to expose real model max.

### FR-4: Multi-Agent Focused Tasks
- Add 3 new specialized agents in `agents/`:
  - `agents/focused/context-gatherer.ts` — ONE task: gather context from index + relevant files.
  - `agents/focused/file-analyzer.ts` — ONE task: deep-analyze a specific file/function.
  - `agents/focused/test-runner.ts` — ONE task: run specific test set, report results.
  - `agents/focused/implementor.ts` — ONE task: implement specific change.
  - `agents/focused/verifier.ts` — ONE task: verify change works (run tests, lint, typecheck).
- Each agent has narrow system prompt focused on ONE task only.

## Non-Functional Requirements
- TypeScript must compile cleanly (no new TS errors).
- All existing tests must still pass.
- Lint clean.
- Backward compatibility: existing users of `/plan` continue to work.

## Scope
- IN: All 4 deliverables above.
- OUT: New tests for new agents (FR-4) are basic; full test coverage is stretch.

## Files to Modify / Create

### FR-1 (auto-index)
- `agents/base2/base2.ts` (modify system prompt section)

### FR-2 (delete ultraplan)
- DELETE: `cli/src/commands/ultraplan.ts`
- DELETE: `cli/src/commands/__tests__/ultra-commands.test.ts`
- MODIFY: `cli/src/data/slash-commands.ts`
- MODIFY: `cli/src/commands/router.ts`
- MODIFY: `cli/src/commands/command-registry.ts`
- MODIFY: `cli/src/utils/input-modes.ts`
- MODIFY: `cli/src/agents/bundled-agents.generated.ts` (if needed)

### FR-3 (real context)
- MODIFY: `cli/src/utils/context-window.ts`
- MODIFY: `cli/src/components/context-window-indicator.tsx`
- MODIFY: `cli/src/hooks/use-context-window-indicator.ts`

### FR-4 (focused agents)
- CREATE: `agents/focused/context-gatherer.ts`
- CREATE: `agents/focused/file-analyzer.ts`
- CREATE: `agents/focused/test-runner.ts`
- CREATE: `agents/focused/implementor.ts`
- CREATE: `agents/focused/verifier.ts`
- MODIFY: `agents/constants.ts` (add focused agent IDs)
- MODIFY: `agents/bundled-agents.generated.ts` (register new agents)
