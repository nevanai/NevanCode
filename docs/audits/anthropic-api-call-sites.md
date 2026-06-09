# Anthropic API — تدقيق نقاط الاستدعاء (T0.1)

> مخرَج المهمة **T0.1** من `tasks.md` (معلم M0 — Quick Wins).
> **النطاق**: `packages/agent-runtime/` و `web/`.
> **الهدف**: تحديد كل نقطة يصل فيها الكود إلى Anthropic (مباشرةً أو عبر OpenRouter)، ووصف حالة `cache_control` الحالية فيها، وتجهيز قاعدة التنفيذ لـ **T0.2–T0.5**.

ملاحظة سريعة قبل القراءة: في هذا المستودع، **agent-runtime لا يستورد `@anthropic-ai/sdk` مباشرة**. كل ترافيك Anthropic الناتج عن جلسات الـagent يمرّ عبر طبقة `streamText` في Vercel AI SDK ⇒ موفِّر OpenRouter ⇒ Anthropic. الاستدعاءات المباشرة لـ`api.anthropic.com` موجودة فقط في `web/` (token-count + abuse-review).

---

## 1) خريطة المسار (Path Map)

### 1.1 مسار جلسة الـagent (الـpath الرئيسي للترافيك)

```
cli/sdk  ─►  packages/agent-runtime/src/run-agent-step.ts          (yبني messages + يستدعي…)
            └─►  packages/agent-runtime/src/prompt-agent-stream.ts  (yغلّف parameters + provider options)
                  └─►  sdk/src/impl/llm.ts :: promptAiSdkStream     (DI'd — هو من يستدعي AI SDK)
                        └─►  ai/streamText({ model, messages, providerOptions })
                              └─►  @openrouter/ai-sdk-provider       (createOpenRouter)
                                    └─►  POST https://openrouter.ai/api/v1/chat/completions
                                          └─►  (OpenRouter يوجّه إلى Anthropic)
```

نقطة دخول `cache_control` في هذا المسار:

- `packages/agent-runtime/src/run-agent-step.ts:419` يمرّر `includeCacheControl: supportsCacheControl(agentTemplate.model)` إلى `getAgentStreamFromTemplate`.
- هذا الـflag يصل إلى `common/src/util/messages.ts` (دالة `convertCodebuffMessagesToModelMessages`، السطور ~258–373) التي تُعلِّم **حتى 4 رسائل** فقط بـ`cache_control: { type: 'ephemeral' }` عبر `withCacheControl()` (السطور 35–59).
- النقاط الأربع المختارة حالياً (بهذا الترتيب):
  1. الرسالة قبل `LAST_ASSISTANT_MESSAGE`
  2. الرسالة قبل أوّل رسالة موسومة `USER_PROMPT`
  3. الرسالة قبل أوّل رسالة موسومة `STEP_PROMPT`
  4. آخر رسالة في السياق

### 1.2 الاستدعاءات المباشرة لـAnthropic في `web/`

| # | الملف:السطر | الغرض | يستدعي |
|---|---|---|---|
| W1 | `web/src/server/free-session/abuse-review.ts:22, 119–133` | مراجعة T&S لجلسات freebuff (model: `claude-sonnet-4-6`) | `POST https://api.anthropic.com/v1/messages` |
| W2 | `web/src/app/api/v1/token-count/_post.ts:293–331` (`countTokensViaAnthropic`) | عدّ الـtokens للطلبات الواردة (default model: `claude-opus-4-6`) | `POST https://api.anthropic.com/v1/messages/count_tokens` |

### 1.3 الـPassthrough — `web/src/app/api/v1/chat/completions/_post.ts`

هذا الـendpoint يستقبل طلبات من العملاء (CLI/SDK) ويوزّعها على الموفِّر المناسب:
- **OpenRouter** (`web/src/llm-api/openrouter.ts:71` ⇒ `https://openrouter.ai/api/v1/chat/completions`) ← يستقبل كل ترافيك Anthropic.
- موفِّرون آخرون (OpenAI/Moonshot/DeepSeek/Fireworks/OpenCodeZen/SiliconFlow/CanopyWave) — لا يخصّون Anthropic.

العملاء يُرسلون `cache_control` ضمن `messages[*].content[*]` و OpenRouter يمرّرها إلى Anthropic كما هي. الموفِّرون غير المتوافقين مع `cache_control` يجرّدونه قبل الإرسال:

- `web/src/llm-api/moonshot.ts:171, 195`
- `web/src/llm-api/opencode-zen.ts:149, 175`

---

## 2) جدول نقاط الاستدعاء (Call Sites)

| ID | الملف:السطر | الموفِّر الفعلي | كيف يصل لـAnthropic | `cache_control` الآن؟ | تأثير على M0 |
|---|---|---|---|---|---|
| A1 | `packages/agent-runtime/src/run-agent-step.ts:419` | OpenRouter ⇒ Anthropic | عبر `streamText` في `sdk/src/impl/llm.ts:280` | ✅ مفعّل عبر `includeCacheControl=supportsCacheControl(model)` ⇒ `convertCodebuffMessagesToModelMessages` يضع ephemeral على 4 رسائل tagged | T0.2 / T0.3 / T0.4 يحتاجون تأكيد أن **system prompt + knowledge + tools** ضمن النقاط الأربع، أو ترقية الاختيار |
| A2 | `packages/agent-runtime/src/prompt-agent-stream.ts:73–115` | OpenRouter ⇒ Anthropic | يضبط `providerOptions.openrouter.reasoning` ويُمرّر `includeCacheControl` للـSDK | ⚠️ يمرّر الـflag فقط — لا يضيف `cache_control` بنفسه | لا تغيير مطلوب — نقطة تمرير |
| A3 | `sdk/src/impl/llm.ts:280–703` (`promptAiSdkStream`) | OpenRouter ⇒ Anthropic | `ai/streamText` + `getProviderOptions` | ⚠️ `getProviderOptions` يضبط `codebuff.codebuff_metadata` و`provider` فقط، **لا يضيف `cache_control` على tools أو system** | هدف رئيسي لـT0.4 (caching tools schema) |
| A4 | `sdk/src/impl/llm.ts:705–771` (`promptAiSdk`) | OpenRouter ⇒ Anthropic | `ai/generateText` | ⚠️ بلا `includeCacheControl` صريح — يعتمد فقط على ما تضعه `convertCbToModelMessages` | يستحق تفعيل caching لو الموديل Anthropic |
| A5 | `sdk/src/impl/llm.ts:773–841` (`promptAiSdkStructured`) | OpenRouter ⇒ Anthropic | `ai/generateObject` | ⚠️ نفس A4 | نفس A4 |
| W1 | `web/src/server/free-session/abuse-review.ts:21–133` | **Anthropic مباشر** | `fetch(API_URL)` بـ`x-api-key` | ❌ غير موجود — `system` يُرسل كسلسلة بدون `cache_control` | **مرشّح فوري لـT0.2**: `system` ~80 سطر ثابت، يتكرر كل sweep |
| W2 | `web/src/app/api/v1/token-count/_post.ts:293–361` | **Anthropic مباشر** | `fetch(...)/count_tokens` | ❌ غير موجود | `count_tokens` لا يستفيد من caching (مجرد عدّ) — يُترك كما هو |
| W3 | `web/src/llm-api/openrouter.ts:71–…` (`fetch openrouter`) | OpenRouter ⇒ Anthropic | passthrough HTTP | ➡️ يمرّر `cache_control` من العميل دون تعديل | لا تغيير مطلوب — السلوك صحيح |
| W4 | `web/src/llm-api/moonshot.ts:171, 195` و `opencode-zen.ts:149, 175` | Moonshot / OpenCode-Zen (ليس Anthropic) | passthrough HTTP بعد تجريد `cache_control` | ✂️ يجرّد `cache_control` عمداً (الموفّرون لا يدعمونه) | السلوك صحيح — لا تغيير |

---

## 3) ما هو موجود فعلاً اليوم (Pre-existing Caching)

- `common/src/util/messages.ts` يحتوي على دالتين أساسيتين:
  - `withCacheControl(obj)` (سطر 35) — يضع `cache_control: { type: 'ephemeral' }` على `providerOptions.anthropic` و `openrouter` و `openaiCompatible`.
  - `withoutCacheControl(obj)` (سطر 61) — للإزالة.
- `convertCodebuffMessagesToModelMessages({ messages, includeCacheControl, logger })` (سطر ~258) يستدعي `withCacheControl` على **حتى 4 نقاط tagged**.
- `common/src/constants/model-config.ts:143 :: supportsCacheControl(model)` يُرجع `true` لـ`anthropic/*` و `openai/*` وكل الموديلات المعرَّفة عدا قائمة `nonCacheableModels` (حالياً: `grok_4` فقط).
- اختبار التغطية: `packages/agent-runtime/src/__tests__/prompt-caching-subagents.test.ts` يتأكد من سلوك caching مع subagents الموروثة.
- خريطة موديلات Anthropic ⇄ OpenRouter موجودة في `common/src/constants/anthropic.ts`.

---

## 4) الفجوات (Gaps) — مدخلات لـT0.2 / T0.3 / T0.4 / T0.5

### 4.1 System Prompt (T0.2)
- **agent-runtime**: الـsystem يدخل عبر `systemMessage(system)` في `run-agent-step.ts:420`. `convertCodebuffMessagesToModelMessages` يمشي للوراء من أربع نقاط tagged، وقد يصل أحدها للـsystem في حال طول السياق قصير، لكن **ليس مضموناً**. الإصلاح المقترح: ضمان `withCacheControl` صريح على آخر content-part من رسالة الـsystem عند تفعيل `includeCacheControl`.
- **web/abuse-review (W1)**: استدعاء مباشر — `system` سلسلة. الإصلاح: تحويل `system` إلى مصفوفة `[{ type: 'text', text: ..., cache_control: { type: 'ephemeral' } }]` وإضافة header `anthropic-beta: prompt-caching-2024-07-31` (أو لاحقاً GA — اختبار التوافق).

### 4.2 Knowledge Files (CLAUDE.md, docs المُحقَنة) (T0.3)
- تُحقَن داخل الـsystem أو رسالة `USER_PROMPT` ضمن `run-agent-step.ts`. لا توجد نقطة caching مستقلة لها. مرشَّح أن تكون كتلة منفصلة في الـsystem array مع `cache_control` خاصّ، أو ضمن إعادة هيكلة `withCacheControl` لتشمل tag مخصّص `KNOWLEDGE`.

### 4.3 Project Memory + Tools Schema (T0.4)
- **Project memory**: حالياً يُحقَن داخل رسائل user/system؛ لا cache_control مخصّص.
- **Tools schema**: `streamText({ tools })` في `sdk/src/impl/llm.ts:327`. Anthropic يدعم `cache_control` على آخر tool ضمن `tools[]` (مكروهة الترتيب لكنها تعمل). الإصلاح: تمرير `tools` بعد إضافة `cache_control` على آخر عنصر أو ضبط `providerOptions.anthropic.tools.cacheControl = { type: 'ephemeral' }` لو موفِّر AI SDK يدعمه.

### 4.4 القياس (T0.5)
- AI SDK يُرجع `usage.cachedInputTokens` ⇒ يلتقطه `emitCacheDebugUsage` في `sdk/src/impl/llm.ts:227–249` ويمرّره عبر `onCacheDebugUsageReceived`.
- موجود `cacheDebugCorrelation` في `getProviderOptions` (`sdk/src/impl/llm.ts:107–117`) و`scripts/compare-cache-debug.ts` للمقارنة.
- الفجوة: لا توجد telemetry تجميعية على نسبة hit/miss لكل جلسة. مطلوب hook يربط `usage.cachedInputTokens / usage.inputTokens` بـcounter في `trackEvent`.

---

## 5) قائمة المرشّحين للتعديل في T0.2–T0.5 (ملفات فقط — لا تنفيذ بعد)

> هذه ليست إجراءات تنفيذيّة — مجرّد مخرَج تدقيقي لـT0.1 يحدّد ساحة العمل.

| المهمة | الملفات المرشَّحة |
|---|---|
| **T0.2** system caching | `common/src/util/messages.ts` (توسعة منطق tag-walking ليضمن إصابة الـsystem)، `web/src/server/free-session/abuse-review.ts` (cache_control على system + beta header) |
| **T0.3** knowledge caching | `common/src/util/messages.ts` (tag جديد `KNOWLEDGE`)، `packages/agent-runtime/src/run-agent-step.ts` (وسم الرسائل القادمة من knowledgeFiles) |
| **T0.4** memory + tools | `sdk/src/impl/llm.ts` (إضافة cache_control على tools schema)، أي مكوِّن يضخّ `project-memory` ضمن الرسائل |
| **T0.5** telemetry | `sdk/src/impl/llm.ts` (`emitCacheDebugUsage` ⇒ إضافة `trackEvent` للـhit-rate)، `web/` dashboards |

---

## 6) خلاصة T0.1
- **agent-runtime**: لا استدعاءات مباشرة لـAnthropic؛ كل الترافيك يمرّ عبر AI SDK ⇒ OpenRouter. caching مُفعَّل جزئياً (4 نقاط tagged) عبر `withCacheControl` في `common/src/util/messages.ts`.
- **web/**: استدعاءان مباشران فقط: `abuse-review.ts` و `token-count/_post.ts`. الأول مرشّح فوري لـT0.2، الثاني لا يستفيد من caching.
- **chat/completions/_post.ts**: passthrough سليم — يمرِّر `cache_control` من العميل إلى OpenRouter.
- التحضير لـT0.2–T0.5 يبدأ من الملفات المُدرَجة في §5.
