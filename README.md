# NevanCode build BY CEO/CTO ABDULLAH ALSHMRY

NevanCode هو مشروع TypeScript monorepo مبني على Bun، يوفّر وكيل برمجي ذكي يمكن استخدامه من خلال CLI، SDK، وواجهة Web/API. المستودع يحتوي على عميل طرفية تفاعلي، runtime للوكلاء، تعريفات وكلاء، واجهة Next.js، وحزم مشتركة لإدارة الأدوات، الأنواع، المصادقة، الفوترة، والتقييمات.
               الاداة خصصت للاستخدام المحلي بنسبة 100/100 للحفاظ على الامان بل كامل وللحفاظ على قوة الاداة العالمية
## المحتويات
للاطلاع على المميزات الشاملة يرجى زيارة ملف PRD.md
- نظرة عامة
- المزايا الأساسية
- بنية المستودع
- المتطلبات
- التشغيل السريع
- أوامر التطوير
- الاختبارات والتحقق
- متغيرات البيئة والأسرار
- سير العمل المحلي
- الحزم الرئيسية
- الوكلاء والمهارات
- البحث الذكي/smart search تهدف الى تقنيات تهدآ الى العميل تقنيات خلفية بل جهاز الشخصي للبحث بل انترنت عن مصادر محددثة وذكية لاحدث الاعوام 
فائدتها 
تقليل الثغرات الامنية 
عدم تثبيت مكتبات برمجية قديمة من ذاكرة Agent 
يصنف البحث على حسب المهمة تلقائى 
بحث عميق وخلفي يدار عبر smart search 
بحث سريع وذكي يدار عبر smart search
- context engine
- Web/API
- CLI و SDK
- الإصدارات والنشر
- الأمان
- المساهمة
- الترخيص

## نظرة عامة

NevanCode يعتمد على بنية : مساعد برمجي متقدم يمكنه قراءة الملفات، تعديل الكود، تشغيل أوامر الطرفية، البحث داخل المشروع، واستخدام وكلاء فرعيين لإنجاز مهام برمجية معقدة.

المشروع مصمم كـ monorepo حتى تشترك جميع المكونات في نفس الأنواع والأدوات والمنطق الأساسي:

- `cli/`: واجهة طرفية تفاعلية مبنية بـ OpenTUI و React.
- `sdk/`: SDK TypeScript/JavaScript يستخدمه CLI والمطورون الخارجيون.
- `packages/agent-runtime/`: محرك تشغيل الوكلاء وخطوات التفكير واستخدام الأدوات.
- `common/`: أنواع وأدوات وثوابت مشتركة.
- `agents/`: تعريفات الوكلاء الأساسية والمتخصصة.
- `web/`: تطبيق Next.js والموقع وواجهات API.
- `packages/*`: حزم داخلية مثل billing و bigquery و code-map و internal.
- `.agents/`: وكلاء ومهارات محلية مخصصة للمستودع.
- `evals/`: أدوات تقييم وقياس أداء الوكلاء.
- `scripts/`: سكربتات التطوير والتشغيل والتحليلات والإصدارات.

## المزايا الأساسية

- وكيل برمجي CLI يعمل داخل الطرفية.
- دعم عدة مزودي LLM مثل Anthropic/OpenAI/Gemini/OpenRouter/Fireworks وغيرهم حسب الإعدادات.
- تشغيل الأدوات محلياً على جهاز المستخدم عبر SDK.
- Web API مبني على Next.js.
- نظام وكلاء قابل للتوسعة: prompt agents و programmatic agents.
- دعم وكلاء فرعيين ومراحل تنفيذ متعددة.
- إدارة سياق ومحادثات وتلخيص لتقليل استهلاك السياق.
- أدوات قراءة وتعديل الملفات وتشغيل الأوامر والبحث في الشيفرة.
- تكاملات للفوترة والاشتراكات والرصيد عبر Stripe.
- تكاملات تحليلات عبر BigQuery.
- نظام تقييم BuffBench لقياس جودة الوكلاء.
- اختبارات Bun/Jest و TypeScript typecheck.

## المتطلبات

- macOS أو Linux أو Windows مع بيئة مناسبة لـ Bun.
- Bun بالإصدار المحدد في المشروع:
  - `bun@1.3.11`
- Git.
- Node/Bun toolchain حسب احتياج الحزم.
- متغيرات البيئة المطلوبة للتشغيل المحلي أو الإنتاجي حسب الملفات والوثائق داخل `docs/` و `INFISICAL_SETUP_GUIDE.md`.

## التثبيت

### تثبيت الأداة للمستخدم النهائي

أوامر التثبيت التالية تثبّت NevanCode نفسه، وليس مجرد wrapper فوق حزمة . السكربت يقوم تلقائياً بـ:

- تنزيل مستودع NevanCode إلى `~/.nevan/NevanCode` على macOS/Linux أو `%USERPROFILE%\.nevan\NevanCode` على Windows.
- تثبيت Bun تلقائياً إذا لم يكن موجوداً.
- تثبيت dependencies الخاصة بالمشروع.
- إنشاء أمر `nevan` الحقيقي.
- تجهيز ملف بيئة محلي افتراضي داخل نسخة المستخدم.
- تشغيل السيرفر/البروكسي/الخدمات الخلفية تلقائياً على المنافذ الافتراضية:
  - Web/API proxy: `3000`
  - PostgreSQL: `5432`
  - Drizzle Studio: `4983`

#### macOS / Linux عبر Curl

شغّل:

```bash
curl -fsSL https://raw.githubusercontent.com/nevanai/NevanCode/main/scripts/install-nevan.sh | bash
```

بعد التثبيت شغّل الأداة:

```bash
nevan
```

عند أول تشغيل، إذا لم تكن الخدمات الخلفية تعمل، سيقوم `nevan` بتشغيل السيرفر والبروكسي والمنافذ المطلوبة تلقائياً في الخلفية ثم يفتح CLI من سورس NevanCode.

أوامر مفيدة:

```bash
nevan --status      # حالة السيرفر والبروكسي والخدمات
nevan --stop        # إيقاف الخدمات الخلفية
nevan --setup-only  # تشغيل الخدمات فقط بدون فتح CLI
nevan --update      # تحديث نسخة NevanCode المثبتة
```

إذا ظهر أن الأمر `nevan` غير موجود، أضف مسار التثبيت إلى `PATH` ثم افتح الطرفية من جديد:

```bash
export PATH="$HOME/.local/bin:$PATH"
nevan
```

#### Windows PowerShell عبر Irm

افتح PowerShell وشغّل:

```powershell
irm https://raw.githubusercontent.com/nevanai/NevanCode/main/scripts/install-nevan.ps1 | iex
```

بعد التثبيت شغّل الأداة:

```powershell
nevan
```

عند أول تشغيل، إذا لم تكن الخدمات الخلفية تعمل، سيقوم `nevan` بتشغيل السيرفر والبروكسي والمنافذ المطلوبة تلقائياً في الخلفية ثم يفتح CLI من سورس NevanCode.

أوامر مفيدة:

```powershell
nevan --status      # حالة السيرفر والبروكسي والخدمات
nevan --stop        # إيقاف الخدمات الخلفية
nevan --setup-only  # تشغيل الخدمات فقط بدون فتح CLI
nevan --update      # تحديث نسخة NevanCode المثبتة
```

إذا لم يتعرف PowerShell على الأمر مباشرة، أغلق PowerShell وافتحه من جديد ثم شغّل:

```powershell
nevan
```

### تثبيت بيئة التطوير من داخل المستودع

من جذر المستودع:

```bash
bun install
```

إذا احتجت تنظيف بيئة TypeScript و node_modules وإعادة التثبيت:

```bash
bun run clean-ts
```

## التشغيل السريع

لتشغيل الخدمات محلياً:

```bash
bun up
```

لفتح CLI بشكل منفصل:

```bash
bun start-cli
```

لمعرفة الخدمات الحالية:

```bash
bun ps
```

لإيقاف الخدمات:

```bash
bun down
```

## أوامر التطوير المهمة

من جذر المشروع:

```bash
bun run dev
bun run up
bun run start-cli
bun run start-db
bun run start-web
bun run start-studio
bun run down
bun run ps
bun run typecheck
bun run test
bun run format
```

أوامر إضافية:

```bash
bun run release:cli
bun run release:sdk
bun run dev:freebuff
bun run release:freebuff
bun run init-worktree
bun run cleanup-worktree
bun run generate-tool-definitions
```

## الاختبارات والتحقق

تشغيل كل الاختبارات:

```bash
bun run test
```

تشغيل فحص الأنواع:

```bash
bun run typecheck
```

تشغيل التنسيق:

```bash
bun run format
```

اختبارات الحزم الرئيسية:

```bash
bun --cwd common test
bun --cwd agents test
bun --cwd packages/agent-runtime test
bun --cwd sdk test
bun --cwd cli test
bun --cwd web test
```

ملاحظات الاختبار:

- يفضّل استخدام Dependency Injection بدلاً من module mocking.
- لا تستخدم `mock.module()` إلا عند الحاجة للثوابت وبمساعدات الاختبار الموجودة.
- اختبارات CLI التفاعلية تتم عبر tmux وسكربتات `scripts/tmux/`.
- لواجهات React hooks داخل CLI، يفضّل اختبار السلوك عبر مكونات تكاملية بدل `renderHook()`.

## متغيرات البيئة والأسرار

لا ترفع ملف `.env` إلى GitHub. هذا المستودع يتجاهل ملفات البيئة السرية:

```gitignore
.env
.env.*
!.env.example
```

الملف المسموح رفعه هو:

```bash
.env.example
```

استخدم `.env.local` أو `.env.development.local` محلياً حسب الحاجة، ولا تضع أسرار حقيقية داخل README أو الكود.

أمثلة متغيرات قد تحتاجها حسب الميزة:

```bash
NEVANCODE_GEMINI_OAUTH_CLIENT_ID=
NEVANCODE_GEMINI_OAUTH_CLIENT_SECRET=
NEVANCODE_GEMINI_OAUTH_TOKEN=
NEVANCODE_GEMINI_PROJECT=
NEXT_PUBLIC_CODEBUFF_APP_URL=
NEXT_PUBLIC_WEB_PORT=
PORT=
```

راجع:

- `docs/environment-variables.md`
- `INFISICAL_SETUP_GUIDE.md`
- `docs/development.md`

## سير العمل المحلي

### تشغيل web ثم CLI

```bash
bun up
bun start-cli
```

### تشغيل web فقط

```bash
bun run start-web
```

### تشغيل قاعدة البيانات فقط

```bash
bun run start-db
```

### تشغيل Drizzle Studio

```bash
bun run start-studio
```

### إيقاف كل الخدمات

```bash
bun down
```

## بنية المستودع

```text
.
├── .agents/                  # وكلاء ومهارات محلية
├── agents/                   # وكلاء NEVANCODE الأساسيون والمتخصصون
├── agents-graveyard/         # وكلاء وتجارب قديمة أو مؤرشفة
├── cli/                      # TUI client مبني بـ OpenTUI + React
├── common/                   # أنواع وأدوات وثوابت مشتركة
├── docs/                     # وثائق البنية والتطوير والاختبار
├── evals/                    # NevanBench وأدوات التقييم
├── packages/
│   ├── agent-runtime/        # محرك تشغيل الوكلاء
│   ├── bigquery/             # تحليلات BigQuery
│   ├── billing/              # فوترة وائتمانات واشتراكات
│   ├── code-map/             # تحليل الشيفرة عبر tree-sitter
│   ├── internal/             # DB ومرافق داخلية وتكاملات server-side
│   └── ...
├── scripts/                  # سكربتات تشغيل وتحليل وإصدار
├── sdk/                      # JavaScript/TypeScript SDK
├── test/                     # إعدادات ومساعدات اختبار عامة
└── web/                      # Next.js app + API routes
```

## الحزم الرئيسية

### `cli/`

واجهة الطرفية للمستخدم النهائي.

مسؤولياتها:

- عرض المحادثة ومخرجات الوكلاء ونتائج الأدوات.
- إدارة الإدخال والأوامر مثل `/help` و `/usage`.
- اختيار وضع الوكيل مثل DEFAULT و MAX و PLAN.
- إدارة المصادقة وتاريخ الجلسات.
- استدعاء SDK وتشغيل stream للأحداث.

تشغيل CLI:

```bash
bun --cwd cli dev
```

### `sdk/`

SDK عام ومستخدم داخلياً من CLI.

مسؤولياته:

- تنسيق agent runs.
- تشغيل الأدوات محلياً على جهاز المستخدم.
- إدارة credentials.
- دعم مزودي النماذج وإعادة المحاولة وتحويل الأخطاء.

بناء SDK:

```bash
bun --cwd sdk build
```

### `packages/agent-runtime/`

المحرك الأساسي لدورة الوكيل:

```text
LLM call -> parse response -> execute tools -> append results -> repeat
```

مسؤولياته:

- تشغيل خطوات الوكيل.
- إدارة system prompts وتعريفات الأدوات.
- دعم subagents.
- التعامل مع streaming من AI SDK.
- إدارة token counting والتكلفة والسياق.

### `common/`

حزمة مشتركة تحتوي على:

- أنواع TypeScript.
- Zod schemas للأدوات.
- ثوابت النماذج والوكلاء.
- أدوات رسائل وأخطاء XML.
- قوالب agent definitions.
- أدوات testing مشتركة.

### `agents/`

تعريفات الوكلاء التي تأتي مع المشروع:

- `base2/`: الوكيل الافتراضي ووضع max/free/plan.
- `editor/`: وكيل تعديل الكود.
- `file-explorer/`: البحث واختيار الملفات.
- `thinker/`: تفكير عميق ومقارنة أفضل إجابة.
- `reviewer/`: مراجعة الكود.
- `researcher/`: بحث ويب ووثائق.
- `general-agent/`: وكلاء عامة مثل GPT-5/Opus.
- `basher.ts`: وكيل تنفيذ أوامر الطرفية.
- `context-pruner.ts`: تلخيص السياق.

### `web/`

تطبيق Next.js للموقع وواجهات API.

أجزاء مهمة:

- `src/app/api/v1/chat/completions/`: endpoint رئيسي للـ LLM proxy.
- `src/app/api/auth/`: NextAuth ومصادقة.
- `src/app/api/stripe/`: فوترة واشتراكات.
- `src/app/api/agents/`: نشر والتحقق من الوكلاء.
- `src/app/api/orgs/`: إدارة المنظمات والفرق.
- `src/llm-api/`: تكاملات LLM providers.
- `src/content/`: docs و MDX content.

تشغيل Web:

```bash
bun --cwd web dev
```

### `packages/internal/`

يحتوي على:

- Drizzle schema والمهاجرات.
- إعدادات البيئة server-side.
- تكاملات Loops.
- مزودي OpenAI/OpenRouter compatible.
- قوالب agent registry.

### `packages/billing/`

يدير:

- حساب الرصيد.
- الاشتراكات.
- شراء credits.
- auto top-up.
- delegated organization credits.

### `packages/bigquery/`

يدير تخزين traces والتحليلات داخل BigQuery.

### `packages/code-map/`

يستخدم tree-sitter لاستخراج أسماء الدوال والمتغيرات من ملفات الشيفرة، ويدعم لغات متعددة مثل TypeScript و JavaScript و Python و Go و Rust و Java و C/C++ و Ruby و PHP.

## الوكلاء والمهارات

المشروع يحتوي على وكلاء built-in داخل `agents/` ووكلاء محليين داخل `.agents/`.

ملفات `.agents/` قد تحتوي على:

- تعريفات وكلاء CLI مثل Claude Code و Codex و Gemini.
- وكلاء بحث Notion.
- مهارات محلية مثل cleanup و review و meta.

لإضافة وكيل جديد، راجع:

- `docs/agents-and-tools.md`
- `docs/patterns/handle-steps-generators.md`
- الملفات داخل `agents/`

## Web API

واجهات API الرئيسية موجودة في:

```text
web/src/app/api/
```

أهم المسارات:

```text
/api/v1/chat/completions
/api/v1/agent-runs
/api/v1/docs-search
/api/v1/web-search
/api/v1/token-count
/api/auth/*
/api/agents/*
/api/orgs/*
/api/stripe/*
```

## CLI

تشغيل CLI أثناء التطوير:

```bash
bun start-cli
```

أو:

```bash
bun --cwd cli dev
```

إصدار CLI:

```bash
bun run release:cli
```

## SDK

بناء SDK:

```bash
bun --cwd sdk build
```

اختبار SDK:

```bash
bun --cwd sdk test
```

إصدار SDK:

```bash
bun run release:sdk
```

## Freebuff

تشغيل freebuff:

```bash
bun run dev:freebuff
```

إصدار freebuff:

```bash
bun run release:freebuff
```

## التقييمات Evals

إطار `evals/` يستخدم BuffBench لتقييم جودة الوكلاء على مهام برمجية حقيقية.

يتضمن عادةً:

- اختيار commits.
- توليد مهام تقييم.
- تشغيل وكلاء مثل Codebuff و Claude Code و Codex.
- تحكيم النتائج واستخراج الدروس.

## قواعد التطوير

- استخدم Bun وليس npm.
- لا ترفع `.env` أو أي أسرار.
- لا تعدل main بطرق خطرة مثل force push إلا بطلب صريح.
- اقرأ الوثائق المناسبة قبل التغييرات الكبيرة:
  - `docs/architecture.md`
  - `docs/request-flow.md`
  - `docs/error-schema.md`
  - `docs/development.md`
  - `docs/testing.md`
  - `docs/environment-variables.md`
  - `docs/agents-and-tools.md`
- اختبر التغييرات قبل النشر.
- استخدم Conventional Commits قدر الإمكان.

## الأمان

مهم جداً:

- لا تضع GitHub tokens أو OAuth secrets أو API keys داخل الكود.
- لا ترفع `.env`.
- استخدم Infisical أو GitHub Secrets أو متغيرات بيئة محلية للأسرار.
- إذا تم كشف توكن، ألغِه فوراً وأنشئ توكن جديد.
- GitHub Push Protection قد يمنع الرفع عند اكتشاف أسرار داخل commit history.

## ملفات مهمة

```text
AGENTS.md
CLAUDE.md
PRD.md
SECURITY.md
WINDOWS.md
INFISICAL_SETUP_GUIDE.md
package.json
bun.lock
bunfig.toml
docs/architecture.md
docs/development.md
docs/testing.md
docs/environment-variables.md
docs/agents-and-tools.md
```

## Troubleshooting

### Bun غير مثبت أو إصدار غير صحيح

تأكد من تثبيت Bun واستخدام الإصدار المطلوب:

```bash
bun --version
```

الإصدار المتوقع من `package.json`:

```text
bun@1.3.11
```

### الخدمات لا تعمل

تحقق من الحالة:

```bash
bun ps
```

ثم أوقف وأعد التشغيل:

```bash
bun down
bun up
```

### مشاكل TypeScript

```bash
bun run typecheck
```

### مشاكل الاختبارات

```bash
bun run test
```

### مشاكل الأسرار

تأكد أن `.env` غير مضاف إلى git:

```bash
git status --short
git check-ignore .env
```

## النشر على GitHub

رفع التغييرات:

```bash
git add -A
git commit -m "docs: add project README"
git push origin main
```

قبل الرفع تأكد من:

```bash
git status --short
git diff --cached --name-only
```

ولا ترفع:

```text
.env
.env.*
```

## الترخيص

المشروع يستخدم رخصة Apache-2.0 حسب `package.json` وملف `LICENSE`.

## روابط داخلية مفيدة

- `docs/architecture.md`: شرح معماري كامل.
- `docs/development.md`: تشغيل وتطوير محلي.
- `docs/testing.md`: سياسة الاختبارات.
- `docs/request-flow.md`: دورة الطلب من CLI إلى server والعودة.
- `docs/error-schema.md`: شكل أخطاء السيرفر والتعامل معها.
- `docs/agents-and-tools.md`: نظام الوكلاء والأدوات.
- `docs/patterns/handle-steps-generators.md`: أنماط programmatic agents.

---

NevanCode يجمع CLI + SDK + Agent Runtime + Web API في مستودع واحد لبناء وكيل تعلم وتنفيذ برمجي فعّال وقابل للتوسعة.
