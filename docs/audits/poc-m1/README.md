# M1 PoC Sandbox

Disposable PoC code backing the two decision docs:
- `docs/audits/m1-vector-store-decision.md` (T1.1.1)
- `docs/audits/m1-embedding-model-decision.md` (T1.1.2)

Kept **outside** the Bun workspace so it doesn't ship as a runtime dependency.

## Files
- `smoke-lancedb.ts` — verifies `@lancedb/lancedb` loads under Bun and runs a basic VSS query.
- `smoke-sqlite-vec.ts` — verifies `sqlite-vec` under Bun via `Database.setCustomSQLite` (requires `brew install sqlite`).
- `bench-vector-stores.ts` — full benchmark (20K × 1024-dim × 200 queries) for sqlite-vec vs LanceDB.
- `embedding-eval.ts` — provider-agnostic recall@K + latency harness with three backends:
  - `makeHashEmbedder()` — offline deterministic stub used to validate harness mechanics.
  - `makeOpenAIEmbedder()` — real, requires `OPENAI_API_KEY`.
  - `makeVoyageEmbedder()` — real, requires `VOYAGE_API_KEY`.

## Reproducibility

```bash
cd docs/audits/poc-m1
bun install                       # isolated, doesn't touch root workspace

bun smoke-lancedb.ts              # ~1s, no keys needed
bun smoke-sqlite-vec.ts           # ~1s, requires brew sqlite
bun bench-vector-stores.ts        # ~15s, no keys needed
bun embedding-eval.ts             # ~1s, no keys (uses hash embedder for sanity)
```

For T1.1.6 (later) — to run real recall@10 against OpenAI + Voyage:
```bash
export OPENAI_API_KEY=sk-...
export VOYAGE_API_KEY=pa-...
# See "Reproducibility" in m1-embedding-model-decision.md §9
```
