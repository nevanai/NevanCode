# Tasks: NevanCode Improvements

## FR-1: Index-First Auto-Load Protocol
- [ ] Read existing `بروتوكول فهم المشروع` and `الفهرسة أولاً` sections in `agents/base2/base2.ts`
- [ ] Modify `agents/base2/base2.ts` to make index reading MANDATORY (auto, not user-triggered)
- [ ] Update the English translation: agent must ALWAYS start with `<relevant_files>` index
- [ ] Verify typecheck passes

## FR-2: Remove Ultra Plan Feature
- [ ] Delete `cli/src/commands/ultraplan.ts`
- [ ] Delete `cli/src/commands/__tests__/ultra-commands.test.ts`
- [ ] Remove `ultraplan` and `mode:ultraplan` from `cli/src/data/slash-commands.ts`
- [ ] Remove `buildUltraplanPrompt` import + `inputMode === 'ultraPlan'` branch from `cli/src/commands/router.ts`
- [ ] Remove `ultraplan` command definition from `cli/src/commands/command-registry.ts`
- [ ] Remove `ultraPlan` from `InputMode` type and `INPUT_MODE_CONFIGS` in `cli/src/utils/input-modes.ts`
- [ ] Update `cli/src/agents/bundled-agents.generated.ts` if it lists ultraplan

## FR-3: Real Context Window Indicator
- [ ] Update `CONTEXT_WINDOW_SIZES` in `cli/src/utils/context-window.ts` with all current model maxes
- [ ] Add `formatTokenCount()` helper (k/M formatting)
- [ ] Add `getContextWindowForModel()` returning dynamic max
- [ ] Modify `cli/src/components/context-window-indicator.tsx` to show "X / Y tokens" + model name
- [ ] Modify `cli/src/hooks/use-context-window-indicator.ts` to expose real model max
- [ ] Update tests in `cli/src/utils/__tests__/context-window.test.ts`

## FR-4: Multi-Agent Focused Tasks
- [ ] Create `agents/focused/context-gatherer.ts` (ONE task: gather context)
- [ ] Create `agents/focused/file-analyzer.ts` (ONE task: analyze file)
- [ ] Create `agents/focused/test-runner.ts` (ONE task: run tests)
- [ ] Create `agents/focused/implementor.ts` (ONE task: implement change)
- [ ] Create `agents/focused/verifier.ts` (ONE task: verify)
- [ ] Register new agents in bundled-agents.generated.ts

## Verification
- [ ] Run typecheck on modified files
- [ ] Run lint
- [ ] Verify all tests pass (or skip deleted ones)
- [ ] Final summary report
