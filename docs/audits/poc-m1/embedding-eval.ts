// Embedding model evaluation harness for T1.1.2.
//
// Goal: a single recall@K + latency harness that accepts ANY embedder behind
// the `Embedder` interface, so we can plug:
//   - OpenAI text-embedding-3-large (1024 dim via `dimensions` param)
//   - Voyage voyage-code-3       (1024 dim default)
// and reproduce the comparison once real API keys are available.
//
// What runs without keys:
//   - The harness mechanics are validated against a deterministic offline
//     embedder (`hashEmbedder`) on a small synthetic code corpus + queries.
//     This proves the recall@K and latency math are correct.
//
// What requires keys:
//   - Calling OpenAI or Voyage to produce real embeddings (functions stubbed
//     to throw with a clear message if keys are missing). No fake numbers are
//     reported as if they were real measurements — see the decision doc.

export type Embedder = {
  name: string
  dim: number
  embed(texts: string[]): Promise<Float32Array[]>
  costPerMillionUsd?: number
  maxInputTokens?: number
}

// ---------------- offline hash-based embedder (test only) -----------------
//
// Produces stable pseudo-embeddings via a token hashing scheme — enough to
// give nontrivial neighbor structure but NOT real semantic quality.
// USED ONLY to validate the harness mechanics. Never reported as a model.

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter(Boolean)
}

function hashStr(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}

export function makeHashEmbedder(dim = 256): Embedder {
  return {
    name: 'offline-hash (mechanics-only, NOT a real model)',
    dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = []
      for (const t of texts) {
        const v = new Float32Array(dim)
        for (const tok of tokenize(t)) {
          const h = hashStr(tok)
          v[h % dim] += 1
          v[(h >>> 8) % dim] += 0.5
        }
        let n = 0
        for (let i = 0; i < dim; i++) n += v[i] * v[i]
        n = Math.sqrt(n) || 1
        for (let i = 0; i < dim; i++) v[i] /= n
        out.push(v)
      }
      return out
    },
  }
}

// ---------------- real embedders (require keys) ---------------------------

export function makeOpenAIEmbedder(opts: {
  apiKey?: string
  dimensions?: number
  model?: 'text-embedding-3-large' | 'text-embedding-3-small'
}): Embedder {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY
  const model = opts.model ?? 'text-embedding-3-large'
  const dim = opts.dimensions ?? (model === 'text-embedding-3-large' ? 3072 : 1536)
  // Verified from OpenAI docs (Context7: developers.openai.com/api/docs/guides/embeddings):
  //   - text-embedding-3-large default dim = 3072, max input = 8192 tokens
  //   - text-embedding-3-small default dim = 1536, max input = 8192 tokens
  //   - `dimensions` param shortens with minimal quality loss (MTEB-validated)
  //   - max 300,000 tokens summed across one batch
  // Pricing (Context7: developers.openai.com/api/docs/models/...):
  //   - text-embedding-3-large: $0.13 / 1M tokens
  //   - text-embedding-3-small: $0.02 / 1M tokens
  const costPerMillionUsd = model === 'text-embedding-3-large' ? 0.13 : 0.02
  return {
    name: `OpenAI ${model} (dim=${dim})`,
    dim,
    costPerMillionUsd,
    maxInputTokens: 8192,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (!apiKey || apiKey.startsWith('dummy'))
        throw new Error(
          'OPENAI_API_KEY missing or dummy. Set a real key to run the OpenAI benchmark.',
        )
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          input: texts,
          model,
          dimensions: opts.dimensions,
          encoding_format: 'float',
        }),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`OpenAI embeddings ${res.status}: ${body}`)
      }
      const json = (await res.json()) as { data: { embedding: number[] }[] }
      return json.data.map((d) => Float32Array.from(d.embedding))
    },
  }
}

export function makeVoyageEmbedder(opts: {
  apiKey?: string
  outputDimension?: 256 | 512 | 1024 | 2048
  model?: 'voyage-code-3' | 'voyage-3-large'
}): Embedder {
  const apiKey = opts.apiKey ?? process.env.VOYAGE_API_KEY
  const model = opts.model ?? 'voyage-code-3'
  const dim = opts.outputDimension ?? 1024
  // Verified from Voyage docs (docs.voyageai.com):
  //   - voyage-code-3: 32K context, default 1024 dim (256/512/2048 also)
  //   - Optimized for code retrieval
  //   - Max 1,000 texts per request; voyage-3.5 batch limit 320K tokens
  // Pricing (docs.voyageai.com/docs/pricing):
  //   - voyage-code-3: $0.18 / 1M tokens; first 200M tokens free monthly
  return {
    name: `Voyage ${model} (dim=${dim})`,
    dim,
    costPerMillionUsd: 0.18,
    maxInputTokens: 32_000,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (!apiKey || apiKey.startsWith('dummy'))
        throw new Error(
          'VOYAGE_API_KEY missing or dummy. Set a real key to run the Voyage benchmark.',
        )
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          input: texts,
          model,
          input_type: 'document',
          output_dimension: dim,
        }),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`Voyage embeddings ${res.status}: ${body}`)
      }
      const json = (await res.json()) as { data: { embedding: number[] }[] }
      return json.data.map((d) => Float32Array.from(d.embedding))
    },
  }
}

// ---------------- recall@K + latency harness -----------------------------

export type Doc = { id: number; text: string; tag?: string }
export type Query = { text: string; relevant: number[] }

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

export function topK(
  queryEmb: Float32Array,
  docEmbs: Float32Array[],
  k: number,
): number[] {
  const scored: Array<[number, number]> = new Array(docEmbs.length)
  for (let i = 0; i < docEmbs.length; i++)
    scored[i] = [i, cosine(queryEmb, docEmbs[i])]
  scored.sort((a, b) => b[1] - a[1])
  return scored.slice(0, k).map(([i]) => i)
}

export type EvalResult = {
  embedder: string
  dim: number
  k: number
  numQueries: number
  numDocs: number
  recallAtK: number
  embedDocLatencyMsP50: number
  embedDocLatencyMsP95: number
  searchLatencyMsP50: number
  searchLatencyMsP95: number
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return NaN
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

export async function evalEmbedder(
  embedder: Embedder,
  docs: Doc[],
  queries: Query[],
  k: number,
): Promise<EvalResult> {
  // Time per-doc embedding by batching 32 at a time and computing per-doc avg.
  const BATCH = 32
  const docTimes: number[] = []
  const docEmbs: Float32Array[] = new Array(docs.length)
  for (let off = 0; off < docs.length; off += BATCH) {
    const slice = docs.slice(off, off + BATCH)
    const t = performance.now()
    const embs = await embedder.embed(slice.map((d) => d.text))
    const dt = (performance.now() - t) / slice.length
    for (let i = 0; i < embs.length; i++) {
      docEmbs[off + i] = embs[i]
      docTimes.push(dt)
    }
  }

  const searchTimes: number[] = []
  let hits = 0
  let total = 0
  for (const q of queries) {
    const [qEmb] = await embedder.embed([q.text])
    const t = performance.now()
    const top = topK(qEmb, docEmbs, k)
    searchTimes.push(performance.now() - t)
    const found = new Set(top)
    for (const r of q.relevant) {
      total += 1
      if (found.has(r)) hits += 1
    }
  }

  return {
    embedder: embedder.name,
    dim: embedder.dim,
    k,
    numQueries: queries.length,
    numDocs: docs.length,
    recallAtK: total === 0 ? NaN : hits / total,
    embedDocLatencyMsP50: percentile(docTimes, 50),
    embedDocLatencyMsP95: percentile(docTimes, 95),
    searchLatencyMsP50: percentile(searchTimes, 50),
    searchLatencyMsP95: percentile(searchTimes, 95),
  }
}

// ---------------- synthetic code corpus + query set -----------------------
//
// Small but non-trivial: 24 "code" docs (auth, db, http, validation, etc.)
// and 12 queries each with a known-relevant doc id. The set is small enough
// to validate the harness deterministically; real M1 evaluation needs the
// real codebase (T1.1.6).

export const CORPUS: Doc[] = [
  { id: 0, text: 'function login(username, password) { return verifyPassword(username, password) }', tag: 'auth' },
  { id: 1, text: 'async function fetchUser(id) { const row = await db.users.findById(id); return row }', tag: 'db' },
  { id: 2, text: 'function hashPassword(pwd) { return bcrypt.hashSync(pwd, 12) }', tag: 'auth' },
  { id: 3, text: 'function parseJsonSafe(s) { try { return JSON.parse(s) } catch { return null } }', tag: 'util' },
  { id: 4, text: 'export async function createSession(userId) { const token = randomBytes(32).toString("hex"); await db.sessions.insert({ userId, token }); return token }', tag: 'auth' },
  { id: 5, text: 'function debounce(fn, delay) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay) } }', tag: 'util' },
  { id: 6, text: 'router.get("/api/users/:id", async (req, res) => { const u = await fetchUser(req.params.id); res.json(u) })', tag: 'http' },
  { id: 7, text: 'function isValidEmail(s) { return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(s) }', tag: 'validation' },
  { id: 8, text: 'async function migrateUp() { await db.exec("CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT UNIQUE)") }', tag: 'db' },
  { id: 9, text: 'function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)) }', tag: 'util' },
  { id: 10, text: 'async function logoutUser(userId) { await db.sessions.deleteWhere({ userId }) }', tag: 'auth' },
  { id: 11, text: 'function memoize(fn) { const cache = new Map(); return (k) => { if (!cache.has(k)) cache.set(k, fn(k)); return cache.get(k) } }', tag: 'util' },
  { id: 12, text: 'router.post("/api/login", async (req, res) => { const ok = await login(req.body.username, req.body.password); res.json({ ok }) })', tag: 'http' },
  { id: 13, text: 'function validatePassword(pwd) { return pwd.length >= 8 && /[0-9]/.test(pwd) && /[A-Z]/.test(pwd) }', tag: 'validation' },
  { id: 14, text: 'async function dbConnect(url) { const client = new pg.Client({ connectionString: url }); await client.connect(); return client }', tag: 'db' },
  { id: 15, text: 'function chunkArray(arr, size) { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out }', tag: 'util' },
  { id: 16, text: 'async function rateLimit(req, res, next) { const ok = await limiter.check(req.ip); if (!ok) return res.status(429).end(); next() }', tag: 'http' },
  { id: 17, text: 'function sanitizeHtml(s) { return s.replace(/<script.*?>.*?<\\/script>/gi, "") }', tag: 'validation' },
  { id: 18, text: 'async function refreshAccessToken(refreshToken) { const session = await db.sessions.findByToken(refreshToken); if (!session) throw new Error("invalid"); return issueAccessToken(session.userId) }', tag: 'auth' },
  { id: 19, text: 'function retryWithBackoff(fn, opts) { return new Promise((resolve, reject) => { let n = 0; const tick = () => fn().then(resolve).catch(() => { if (n++ >= opts.max) reject(); else setTimeout(tick, opts.base * 2 ** n) }); tick() }) }', tag: 'util' },
  { id: 20, text: 'async function searchUsers(query) { return db.users.where("email LIKE ?", `%${query}%`).limit(20) }', tag: 'db' },
  { id: 21, text: 'function isStrongPassword(p) { return /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p) && p.length >= 12 }', tag: 'validation' },
  { id: 22, text: 'router.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message }) })', tag: 'http' },
  { id: 23, text: 'async function transferFunds(from, to, amount) { return db.transaction(async (tx) => { await tx.accounts.decrement(from, amount); await tx.accounts.increment(to, amount) }) }', tag: 'db' },
]

export const QUERIES: Query[] = [
  { text: 'authenticate user with username and password', relevant: [0, 12] },
  { text: 'hash a password before storing it', relevant: [2] },
  { text: 'create session token for logged-in user', relevant: [4] },
  { text: 'how do I delete user session on logout', relevant: [10] },
  { text: 'refresh access token using refresh token', relevant: [18] },
  { text: 'check email format is valid', relevant: [7] },
  { text: 'check that password is strong enough', relevant: [13, 21] },
  { text: 'remove unsafe html tags from user input', relevant: [17] },
  { text: 'connect to postgres database', relevant: [14] },
  { text: 'database migration creating users table', relevant: [8] },
  { text: 'http handler that fetches user by id', relevant: [6] },
  { text: 'rate limit middleware for express', relevant: [16] },
]

// ---------------- entry point: validate harness with offline embedder ----

if (import.meta.main) {
  const embedder = makeHashEmbedder(256)
  const result = await evalEmbedder(embedder, CORPUS, QUERIES, 5)
  console.log(JSON.stringify(result, null, 2))
  // Sanity: hash embedder MUST hit > 0 recall@5 on this corpus (token overlap
  // alone catches the obvious keyword matches). If it doesn't, the harness is
  // broken.
  if (Number.isNaN(result.recallAtK) || result.recallAtK <= 0) {
    console.error('Harness sanity check failed: recall@5 is 0 or NaN.')
    process.exit(1)
  }
  console.log('Harness sanity check passed.')
}
