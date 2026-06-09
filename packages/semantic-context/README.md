# @codebuff/semantic-context

Persistent, local-first **semantic context engine** for Nevan Code. It indexes a
project into an on-disk vector index and answers "which files matter for *this*
request?" — so the agent starts from the right code instead of rediscovering it
turn by turn.

This package implements PRD Milestone M1 (Features 1–3) and the cross-repository
awareness of M2 (Feature 4).

## Architecture

```
walk → extract (tree-sitter) → embed (all-MiniLM-L6-v2) → upsert → persist
                                                                │
                          query ──embed──► HNSW kNN ──► curate ─┘──► <relevant_files>
```

- **Index storage** is local and embedded — no external server. File metadata +
  the symbol graph live in `bun:sqlite`; vectors live in an HNSW graph
  (`hnswlib-node`). State is written under `<project>/.nevan/`
  (`index.db`, `vectors.hnsw`, `manifest.json`).
  > Documented deviation from the PRD's ChromaDB/Qdrant suggestion (T1.2): an
  > embedded index keeps the "start in any folder" UX and is air-gap friendly.
- **Embeddings** come from `Xenova/all-MiniLM-L6-v2` (384-dim, L2-normalized),
  running in-process and offline after the first ~25MB download.
- **Incremental**: a SHA-1 content hash per file means unchanged files are
  skipped on re-index; a `chokidar` watcher re-embeds only the file that changed.

## Feature 3 — Smart Context Curation

`ContextCurator` (see `src/curator.ts`) turns a natural-language request into a
small, high-signal set of files:

1. **Embed the query** (`engine.curate(query)`).
2. **Score** every candidate by cosine relevance, normalized as
   `relevance = max(0, cosine)` so it stays in `[0,1]` and remains interpretable
   (no remapping tricks).
3. **Threshold-filter** — only files at/above the threshold are included.
4. **Section-extract large files** — files longer than `largeFileLines` (160) are
   sliced into overlapping windows; each window is embedded and scored, and only
   the most relevant line ranges are kept. Small files are sent whole.
5. **Budget** — stop adding files past `maxFiles` / `maxTokens`.

### Live, per-turn use

In the CLI, `curateRelevantFilesBlock(query)` is invoked while preparing each
user message and prepends a `<relevant_files>` block to the prompt (alongside the
goal block). It is strictly best-effort: it only runs once the index has settled
(model warm), is capped by a timeout, and returns `''` on any problem — it can
never block or break sending a message.

Toggles (env):

| Var | Effect |
|---|---|
| `NEVAN_SEMANTIC_CONTEXT=0` | Disable the whole engine (no indexing, no curation). |
| `NEVAN_CONTEXT_INJECTION=0` | Keep indexing, but stop auto-injecting curated files. |
| `NEVAN_CURATION_THRESHOLD=0.3` | Override the relevance threshold (0–1). |

### Headless command (`--debug`)

```bash
# Print the files Nevan would inject for a request:
nevan context "where is the vector index persisted to disk"

# Inspect every candidate's relevance + cosine + reason, and the token reduction:
nevan context "incremental file watching" --debug

# Machine-readable:
nevan context "query embedding and cosine search" --json --threshold 0.3
```

### The shipped threshold (data-driven)

The PRD suggests a `0.7` inclusion threshold "as an example / configurable". With
all-MiniLM over real code, the *genuinely relevant* file's cosine runs roughly
`0.09 / 0.45 / 0.54` (min / median / max), so `0.7` would filter out everything.
The shipped default is therefore **`0.25`**, chosen from the T1.18 measurement
(`__tests__/curation-measure.test.ts`, real model, 90 repo files, 20 queries).
Token reduction at 0.25 is **92.4%**¹; recall is the binding constraint, so the
sweep shows how many of the 20 relevant files clear each threshold:

| threshold | relevant file clears it |
|---:|---:|
| 0.20 | 17/20 |
| **0.25** | **16/20** |
| 0.30 | 14/20 |
| 0.40 | 10/20 |
| 0.50 | 3/20 |

¹ Reduction is measured against the honest baseline of *injecting every retrieved
candidate whole* — i.e. what an un-curated semantic retrieval would dump into the
prompt — not against "the whole repo". Run it yourself:

```bash
NEVAN_MEASURE=1 bun test __tests__/curation-measure.test.ts
```

> **Honest limitation:** the PRD's "no answer-quality regression across 20 live
> tasks" can't be verified without a live model + budget, so it is not asserted.
> We use retrieval recall (the relevant file is in the top-50 for 18/20 queries)
> as the quality proxy.

## Feature 4 — Cross-Repository Awareness

`MultiRepoWorkspace` (see `src/workspace.ts`) puts several repos under one
semantic roof. Each repo keeps its **own** `.nevan` index, so incremental
re-indexing stays per-repo (an unchanged repo costs ~nothing and reports
`changed: false`). All engines share **one** embedder instance so cross-repo
vectors are comparable.

```bash
# Index several local repos into one workspace (saved to .nevan/workspace.json):
nevan index --repos ./service-a ./service-b ./shared-lib

# Index every repo in a GitHub org (needs network + GITHUB_TOKEN/GH_TOKEN):
nevan index --org github.com/myorg

# "I changed a function — who uses it across all services?"
nevan impact fetchUserProfile
#  Symbol: fetchUserProfile  (cross-repo ✓)
#  Defined in:
#    service-a  src/users.ts
#  Called from:
#    service-b  src/handler.ts
```

What it provides:

- **Unified search (T2.1)** — `workspace.search(q)` merges per-repo hits and
  re-ranks them, tagging each with its `repoId`/`repoRoot`.
- **Cross-repo impact (T2.5)** — `workspace.impactOf(symbol)` returns every
  repo+file that *defines* the symbol and every repo+file that *calls* it. The
  definition/call split is exact (tree-sitter captures the declaration name as
  an `identifier` and a callee as a `call`, never both).
- **API contracts (T2.4)** — `workspace.apiContracts(repoId?)` lists the
  defined-symbol → file surface per repo.
- **Incremental (T2.6)** — per-repo content-hash skipping; `--org` re-clones via
  `git pull --ff-only`.

> **Honest scope:** contracts and impact match by **bare symbol name**, because
> code-map extracts identifier/call *names*, not full type signatures. Common
> names (`run`, `handle`, `init`, …) collide across services, so `impactOf`
> sets `ambiguous: true` for them and the `impact` command prints a warning.
> The `--org` path is real (GitHub REST list → `git clone --depth 1` → index);
> it is unit-tested with an injected fake provider, while the live path needs
> network + a token.

## API

```ts
import { SemanticContextEngine, MultiRepoWorkspace } from '@codebuff/semantic-context'

// Cross-repo:
const ws = new MultiRepoWorkspace({ repos: ['./service-a', './service-b'] })
await ws.indexAll()
const impact = await ws.impactOf('getUser')   // { definitions, callSites, crossRepo }
await ws.close()
```

```ts

const engine = new SemanticContextEngine({ projectRoot })
await engine.index()                         // build / refresh the index
const ctx = await engine.curate('reset the auth token', {
  threshold: 0.25,
  maxFiles: 8,
  debug: true,           // attach a per-candidate score table
  computeBaseline: true, // populate reductionRatio
})
// ctx.files[].relevance, ctx.files[].sections, ctx.reductionRatio, ctx.debug
```

## Tests

```bash
bun test                                   # fast suite (deterministic embedder)
NEVAN_MEASURE=1 bun test __tests__/curation-measure.test.ts   # real-model benchmark
```
