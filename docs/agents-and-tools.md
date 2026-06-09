# Agents and Tools

## Agents

- Prompt/programmatic agents live in `.agents/` (programmatic agents use `handleSteps` generators).
- Generator functions execute in a sandbox; agent templates define tool access and subagents.

### Shell Shims

Direct commands without `codebuff` prefix:

```bash
codebuff shims install codebuff/base-lite@1.0.0
eval "$(codebuff shims env)"
base-lite "fix this bug"
```

## Tools

- Tool definitions live in `common/src/tools` and are executed via the SDK helpers + agent-runtime.

## Project Memory (`.nevan/memory.md`)

Project memory is a per-repo Markdown file that survives across sessions
and is auto-injected into the agent's prompt. The implementation lives in
`common/src/util/project-memory.ts` and `common/src/util/project-memory-entries.ts`.

### File location

```
<projectRoot>/.nevan/memory.md
```

The file is hand-editable. The agent reads it on session start and
re-writes it whenever it appends a fact via `appendProjectMemoryEntry`.

### Categories (T0.7)

Each bullet sits under one of five canonical sections:

| Heading      | Category       | TTL    | Notes                                                           |
| ------------ | -------------- | ------ | --------------------------------------------------------------- |
| `## User`    | `user`         | 90 d   | Role, preferences, knowledge about the operator                 |
| `## Feedback`| `feedback`     | 180 d  | Corrections / "always do X" rules from the user                 |
| `## Project` | `project`      | 30 d   | Ongoing initiatives, deadlines, work-in-flight                  |
| `## Reference`| `reference`   | never  | Pointers to external systems (Slack, Grafana, Linear, …)        |
| `## Notes`   | `unclassified` | never  | Anything that does not match a recognized heading               |

Section order is canonical in the rendered output (User → Feedback →
Project → Reference → Notes) so diffs stay stable. Empty sections are
omitted.

### Bullet syntax

```
- 2026-05-24 · the agent should prefer bun over npm
- 2026-05-24 · always run tests before merge [pinned]
- 2026-05-24 · M0 quick wins critical [score:5] [pinned]
```

- **Date prefix** — `YYYY-MM-DD` followed by one of `·`, `-`, `—`, `:`,
  or a single space. Used for TTL computation.
- **`[pinned]`** — exempt from TTL expiry and byte-budget eviction.
- **`[score:N]`** — relevance score. Default `1`. Higher score = kept
  longer when over the byte budget.

Hand edits that omit either marker are fine — defaults are restored on
the next round-trip.

### Auto-pruning (T0.6)

`pruneEntries` runs three passes (in this order):

1. **Dedupe** — collapse normalized-equivalent same-category bullets
   (see T0.8 below).
2. **TTL** — drop bullets whose `addedAt` is older than the category
   TTL. Pinned bullets and bullets without a date are exempt.
3. **Byte budget** — evict the lowest-score, then oldest, non-pinned
   bullet until the rendered file is ≤ `PROJECT_MEMORY_MAX_BYTES`
   (12 KB ≈ ~3K tokens). Pinned bullets are never evicted.

Read path (`readProjectMemory`) runs prune in-memory only — the on-disk
file is **never** modified during a read. To rewrite the file with the
pruned content, call `pruneProjectMemoryFile` explicitly.

### Deduplication (T0.8)

`dedupeEntries` collapses bullets that share a normalized form within
the same category. Normalization (`normalizeMemoryContent`):

- lowercases
- strips a leading `- ` / `* ` bullet marker
- removes markdown punctuation (`` ` * _ ~ ``)
- removes trailing `. , ; ! ?`
- collapses internal whitespace to a single space

Examples that collapse together under `## User`:

```
- 2026-05-20 · uses bun, not npm
- 2026-05-22 · Uses Bun, not npm.
- 2026-05-23 · uses   bun,   not   npm
```

Merge rules for the survivor:

- **Content + category** — first-seen wins.
- **`addedAt`** — latest of the two (so the entry stays "fresh").
- **`score`** — `max(a, b)`.
- **`pinned`** — `a.pinned || b.pinned` (pin is sticky).

Cross-category duplicates are intentionally NOT merged: the same line of
text can mean different things under `user` vs `feedback`, and a silent
re-categorization would lose data.

`appendProjectMemoryEntry` returns `{ deduplicated: boolean }` so callers
can surface "merged into an existing fact" to telemetry or the user
without an extra read.

### Inferred categories

When `appendProjectMemoryEntry` is called without an explicit `category`,
`inferMemoryCategory` runs a conservative heuristic:

| Trigger pattern                                                       | Category   |
| --------------------------------------------------------------------- | ---------- |
| URL / mentions Slack / Grafana / Linear / Notion / Jira / dashboard   | reference  |
| Starts with `always` / `never` / `don't` / `prefer` / `avoid` / `stop`| feedback   |
| Contains "the user is" / "I am a" / "my role"                         | user       |
| Contains `milestone` / `deadline` / `sprint` / `release` / `WIP`      | project    |
| Otherwise                                                              | unclassified |

Ambiguous content falls back to `unclassified` — which has no TTL — so a
legacy fact is never demoted to a TTL bucket by accident.

### Programmatic API

```ts
import {
  appendProjectMemoryEntry,
  pruneProjectMemoryFile,
  readProjectMemory,
} from '@codebuff/common/util/project-memory'

// Add (with auto-dedup, auto-prune, auto-byte-cap):
const { deduplicated } = await appendProjectMemoryEntry({
  projectRoot,
  content: 'always run bun test before merge',
  category: 'feedback', // optional — inferred when omitted
  pinned: true,         // optional
  score: 3,             // optional, default 1
  fs,
  logger,
})

// Force a writeback prune pass (drops expired, evicts over-budget,
// rewrites duplicates):
const report = await pruneProjectMemoryFile({ projectRoot, fs, logger })
// report = { kept, expired, evictedForBudget, deduplicated }

// Read for prompt injection (TTL + dedup applied in-memory only):
const rendered = await readProjectMemory({ projectRoot, fs, logger })
```
