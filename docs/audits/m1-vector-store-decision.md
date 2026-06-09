# Vector Store Decision — SQLite-VSS vs LanceDB (T1.1.1)

> مخرَج المهمة **T1.1.1** من `tasks.md` (معلم M1 — Code Understanding Layer).
> **النطاق**: اختيار vector store لـ semantic code indexing داخل `packages/agent-runtime/`.
> **القرار النهائي**: **LanceDB** (`@lancedb/lancedb`).
> **حالة المهمة**: ✅ مكتملة.

---

## 1) ملخّص القرار (TL;DR)

| البند | sqlite-vss / sqlite-vec | LanceDB | الفائز |
|---|---|---|---|
| Bun compatibility | يحتاج `Database.setCustomSQLite()` + `brew install sqlite` (لأن `bun:sqlite` يأتي بـ `SQLITE_ENABLE_LOAD_EXTENSION` مُعطَّل، و `better-sqlite3` لا يعمل أصلاً على Bun) | يعمل out-of-the-box | 🟢 LanceDB |
| ANN index | ❌ غير موجود (brute force MATCH فقط) | ✅ IVF_PQ + HNSW | 🟢 LanceDB |
| Insert throughput (1024-dim) | ~12.5K vec/s | ~40K vec/s | 🟢 LanceDB (×3.2) |
| Query p95 — flat scan | 10.45 ms | 11.96 ms | تعادُل |
| Query p95 — ANN | غير متاح | 1.75 ms | 🟢 LanceDB (×6) |
| Edit (del + ins) p50 | 0.62 ms | 6.92 ms | 🟢 sqlite-vec |
| Maintenance status | `sqlite-vss` مهجور؛ `sqlite-vec` (الخليفة) في pre-1.0 (v0.1.x) | حِفظ نَشِط من LanceDB Inc، v0.29.x | 🟢 LanceDB |
| Disk @ 20K × 1024-dim | 80.5 MB | 78.3 MB | تعادُل |

**سبب القرار الجوهري**: على Bun، `sqlite-vss/sqlite-vec` يفرض اعتماديّة خارجية على نظام التشغيل (`libsqlite3.dylib` من Homebrew أو ما يماثله) لأن `bun:sqlite` لا يدعم `loadExtension()` مع الـ build المُضمَّن، و `better-sqlite3` يفشل تماماً بـ `ERR_DLOPEN_FAILED` (المتابعة في [`oven-sh/bun#4290`](https://github.com/oven-sh/bun/issues/4290)). LanceDB يأتي بـ Rust-via-N-API ويعمل تحت Bun بدون هذه القفزة.

---

## 2) النطاق ومتطلبات M1

استناداً إلى `PRD.md` و `tasks.md` (T1.1.1 → T1.1.6):
- **monorepo بحجم 50K ملف** ⇒ تقدير 100K–250K chunk (~ دالة/ملف).
- **استعلام دلالي < 500 ms p95** (مذكور صراحة في معايير M1 القابلة للقياس).
- **incremental indexing** عند تغيُّر الملفات (T1.1.4).
- **Recall@10 + p95 latency** على benchmark monorepo حقيقي (T1.1.6).

⇒ نحن نحتاج: ANN على ≥ 100K متّجه، إدخال incremental رخيص، ودعم Bun بدون اعتماديّات نظام إضافيّة.

---

## 3) عملي مع `bun:sqlite` و `better-sqlite3` (نتائج PoC)

كلتا المحاولتين موثَّقتان في `docs/audits/poc-m1/smoke-sqlite-vec.ts`:

**(أ) `better-sqlite3@12.10.0` تحت Bun 1.3.14**
```
error: 'better-sqlite3' is not yet supported in Bun.
Track the status in https://github.com/oven-sh/bun/issues/4290
In the meantime, you could try bun:sqlite which has a similar API.
 code: "ERR_DLOPEN_FAILED"
```
⇒ غير قابل للاستخدام مع Bun.

**(ب) `bun:sqlite` + `sqlite-vec@0.1.9`**
```
error: This build of sqlite3 does not support dynamic extension loading
```
⇒ الـ build المُضمَّن في Bun يأتي بدون `SQLITE_ENABLE_LOAD_EXTENSION`.

**(ج) `bun:sqlite` + `Database.setCustomSQLite(/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib)` + `sqlite-vec`**
```
sqlite-vec version: v0.1.9
SQLITE-VEC SMOKE: OK
```
⇒ يعمل، لكن مع شرط مسبق: تثبيت `brew install sqlite` على كل بيئة تشغيل (CLI users, CI, Docker images). هذا يخلق قصّة توزيع مزعجة لـ Windows + Linux أيضاً.

**(د) `@lancedb/lancedb@0.29.0` تحت Bun**
```
LANCEDB SMOKE: OK
```
⇒ يعمل مباشرةً، Rust binary موزَّع عبر `@lancedb/lancedb-darwin-*` و `@lancedb/lancedb-linux-*` و `@lancedb/lancedb-win32-*` بدون شيء يدوي.

---

## 4) Benchmark — 20,000 vectors × 1024-dim × 200 queries

السكربت في `docs/audits/poc-m1/bench-vector-stores.ts` (قابل لإعادة التشغيل عبر `bun bench-vector-stores.ts`).

**البيئة**: macOS arm64، Bun 1.3.14، corpus عشوائي unit-norm، dim=1024 (يطابق الخيار العملي لـ embedding models في T1.1.2).

| القياس | sqlite-vec | LanceDB |
|---|---:|---:|
| فتح + import | 1.33 ms | 15.27 ms |
| Bulk insert 20K | 1,600 ms (12.5K vec/s) | **500 ms (40K vec/s)** |
| On-disk size | 80.5 MB | 78.3 MB |
| Top-10 flat p50 / p95 / p99 | 10.23 / 10.45 / 10.58 ms | 10.44 / 11.96 / 13.70 ms |
| Top-10 ANN p50 / p95 / p99 | N/A | **1.08 / 1.75 / 3.19 ms** |
| Index build (ANN) | N/A | 7.31 s |
| Incremental insert 500 | 115.23 ms (4.3K vec/s) | **19.36 ms (25.8K vec/s)** |
| Edit (del + ins) ×100 p50 | **0.62 ms** | 6.92 ms |

### الاستنتاج من Benchmark
- **flat scan على ≥ 100K vec**: استقراء خطّي يعطي ~50 ms لـ sqlite-vec على 100K؛ ~50 ms على LanceDB flat — كلاهما داخل الميزانية لكن ضيّق.
- **ANN على LanceDB يُقصِّر الـ p95 إلى ≤ 2 ms** حتى يفترض على 500K vec يبقى < 5 ms. وحده هذا يحقق هدف M1 "< 500 ms" مع هامش راحة كبير لباقي الـ pipeline (embedding API + reranking).
- **Insert throughput** أهم للـ initial indexing (50K ملف × ~3 chunk = 150K vec ⇒ 12s on LanceDB vs 40s+ on sqlite-vec).
- **Edit cost** لصالح sqlite-vec بـ ~10×، لكن في الحياة العمليّة الـ file watcher يجمع التعديلات في batches، فالـ delta على مستوى الجلسة هامشي.

---

## 5) العوامل غير الأدائيّة

### 5.1 Maintenance & Trust
- `sqlite-vss` ⇒ آخر commit في 2024-Q1، النشاط ميت، الـ author (Alex Garcia) أعلن صراحة أن `sqlite-vec` هو الخليفة الموصى به. **لا يجوز اختيار `sqlite-vss` في 2026**.
- `sqlite-vec` ⇒ pre-1.0 (v0.1.x)، API لم يُجمَّد، ANN على الـroadmap لكن لم يصل بعد.
- `@lancedb/lancedb` ⇒ v0.29.x مع releases شهريّة، LanceDB Inc. شركة قائمة، الـ format (Lance) مرخّص Apache 2.0 ومدعوم من Databricks/Anyscale في عدّة منتجات.

### 5.2 Schema & Metadata
- sqlite-vec: vector + rowid فقط داخل `vec0` virtual table؛ أي metadata (file path, function name, lang) في جدول SQLite عادي يُربط بـ `rowid`. مرن لكن يتطلب JOIN يدوي.
- LanceDB: schema-on-write مع Arrow، حقول scalar/timestamp/JSON بجانب الـ vector في نفس الـ row. أبسط لاستعلامات `WHERE language = 'ts' AND vector NEAR ?`.

### 5.3 Code Graph (T1.2.x) Integration
معلم M1 يطلب أيضاً **code graph** (T1.2). LanceDB يدعم blob storage و scalar indices للحقول النصيّة، فمن السهل تخزين الـ graph nodes/edges في جدول مرافق داخل نفس قاعدة البيانات. SQLite بطبيعته دعم ممتاز للـ graph عبر relational queries، لكن دمج الاثنين (vec0 + graph tables) في schema واحدة يضيف تعقيد JOIN. تعادُل تقريبي هنا.

### 5.4 Operations
- sqlite-vec: ملف واحد `.sqlite` ⇒ نسخ احتياطي/نقل تافه.
- LanceDB: مجلد versioned (Lance format) ⇒ نسخ احتياطي يحتاج `cp -r` لكامل المجلد، لكن يربح bonus: time-travel queries مدمجة بدون كود إضافي.

---

## 6) المخاطر التي قبلناها مع LanceDB

1. **حجم binary أكبر** — `@lancedb/lancedb` ~50 MB per-platform، أكبر من `sqlite-vec` (~ 3 MB). مقبول لـ CLI لكن يستحق تتبُّع في `cli/` bundle size.
2. **ANN index يحتاج إعادة بناء دوريّاً** عند incremental updates كثيرة (LanceDB توصي بـ `compaction` كل ~100K row جديدة). نضيف هذا إلى T1.1.4.
3. **Format-coupled** — لو احتجنا تشغيل الـ index داخل process آخر (مثلاً Rust أو Python)، LanceDB يدعم ذلك (نفس الـ format)، لكن خروجاً عن النظام يحتاج تعديل.
4. **Methodology caveat على Benchmark**: قِسنا ANN **latency** فقط، لا ANN **recall vs flat**. الـ corpus العشوائي unit-norm سهل على IVF_PQ؛ embeddings كود حقيقيّة قد تخفض recall للـ ANN بنسبة 5–15%. هذا لا يقلب القرار (LanceDB يفوز بـ Bun-compat + إدخال + توفر ANN حتى لو recall أنزل قليلاً) لكنه شرط في T1.1.6: قياس **recall(ANN) / recall(flat)** على corpus حقيقي وضبط `nprobes` لو الفجوة > 5%.

---

## 7) خطّة التنفيذ بعد القرار

| في `tasks.md` | المسار العملي |
|---|---|
| T1.1.3 (Indexer + chunking) | أضِف `packages/agent-runtime/src/semantic-index/` يستخدم `@lancedb/lancedb` كاعتماديّة |
| T1.1.4 (Incremental + file watcher) | استعمل `chokidar` (موجود في الـ workspace) + delete-by-path + add (LanceDB لا يوجد فيه upsert بالـ id ⇒ del-then-add) |
| T1.1.5 (`semantic_search` tool) | `vectorSearch(embedding).where("lang = ?").limit(K)` |
| T1.1.6 (Benchmark) | امتداد لهذا الـ PoC على corpus حقيقي |

نضيف `@lancedb/lancedb` إلى `packages/agent-runtime/package.json` كاعتماديّة عادية وقت بدء T1.1.3 — ليس الآن (PoC فقط).

---

## 8) الملفات المرفقة (Artifacts)

- `docs/audits/poc-m1/package.json` — sandbox isolated من الـ workspace
- `docs/audits/poc-m1/smoke-lancedb.ts` — smoke test
- `docs/audits/poc-m1/smoke-sqlite-vec.ts` — smoke test + workaround تحت Bun
- `docs/audits/poc-m1/bench-vector-stores.ts` — benchmark كامل قابل لإعادة التشغيل

لإعادة الإنتاج:
```bash
cd docs/audits/poc-m1
bun install
bun smoke-lancedb.ts
bun smoke-sqlite-vec.ts   # يحتاج: brew install sqlite
bun bench-vector-stores.ts
```
