import { describe, expect, test } from 'bun:test'

import {
  FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID,
  FREEBUFF_KIMI_MODEL_ID,
  FREEBUFF_MINIMAX_MODEL_ID,
} from '@codebuff/common/constants/freebuff-models'

import { createBase2, MANDATORY_PROMPT } from '../base2/base2'
import hunterDefinition from '../base2/base2-hunter'
import liteDefinition from '../base2/base2-lite'
import maxDefinition from '../base2/base2-max'
import planDefinition from '../base2/base2-plan'
import defaultDefinition from '../base2/base2'

describe('base2 reviewer selection', () => {
  test.each([
    [FREEBUFF_MINIMAX_MODEL_ID, 'code-reviewer-minimax'],
    [FREEBUFF_KIMI_MODEL_ID, 'code-reviewer-kimi'],
    [FREEBUFF_DEEPSEEK_V4_PRO_MODEL_ID, 'code-reviewer-deepseek'],
    [FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID, 'code-reviewer-deepseek-flash'],
  ])('uses matching reviewer for model %p', (model, expectedReviewer) => {
    const base2 = createBase2('free', { model })

    expect(base2.spawnableAgents).toContain(expectedReviewer)
    expect(base2.instructionsPrompt).toContain(`Spawn a ${expectedReviewer}`)
    expect(base2.stepPrompt).toContain(`spawn a ${expectedReviewer}`)
  })
})

describe('mandatory prompt enforcement across all modes', () => {
  const ARABIC_CORE = 'أنت المسؤول الكامل عن جودة النتيجة'
  const NO_GUESSING = 'لا تسوي اي شيء بتخمين او خيالي'
  const STOP_AND_ASK = 'توقف واسأل سؤالاً واحداً فقط'
  const VERIFY_BEFORE_NEXT = 'لا تكمل إلى الخطوة التالية إلا بعد التحقق من الحالية'
  const ADMIT_ERRORS = 'إذا وجدت خطأً اعترف به مباشرة ولا تخفيه'

  test('MANDATORY_PROMPT constant contains all required directives', () => {
    expect(MANDATORY_PROMPT).toContain(ARABIC_CORE)
    expect(MANDATORY_PROMPT).toContain(NO_GUESSING)
    expect(MANDATORY_PROMPT).toContain(STOP_AND_ASK)
    expect(MANDATORY_PROMPT).toContain(VERIFY_BEFORE_NEXT)
    expect(MANDATORY_PROMPT).toContain(ADMIT_ERRORS)
  })

  test('MANDATORY_PROMPT appears at the top of systemPrompt (before # Identity)', () => {
    const agent = createBase2('default')
    const mandatoryIdx = agent.systemPrompt!.indexOf(MANDATORY_PROMPT)
    const identityIdx = agent.systemPrompt!.indexOf('# Identity')
    expect(mandatoryIdx).toBeGreaterThanOrEqual(0)
    expect(mandatoryIdx).toBeLessThan(identityIdx)
  })

  test.each([
    ['default', createBase2('default')],
    ['lite', createBase2('lite')],
    ['max', createBase2('max')],
    ['plan', createBase2('default', { planOnly: true })],
    ['free', createBase2('free')],
    ['fast', createBase2('fast')],
  ])('mode %s has mandatory prompt in systemPrompt', (_, agent) => {
    expect(agent.systemPrompt).toContain(ARABIC_CORE)
    expect(agent.systemPrompt).toContain(NO_GUESSING)
    expect(agent.systemPrompt).toContain(STOP_AND_ASK)
    expect(agent.systemPrompt).toContain(VERIFY_BEFORE_NEXT)
    expect(agent.systemPrompt).toContain(ADMIT_ERRORS)
  })

  test('default exported agent (base2) has mandatory prompt', () => {
    expect(defaultDefinition.systemPrompt).toContain(ARABIC_CORE)
    expect(defaultDefinition.systemPrompt).toContain(NO_GUESSING)
  })

  test('lite agent has mandatory prompt', () => {
    expect(liteDefinition.systemPrompt).toContain(ARABIC_CORE)
    expect(liteDefinition.systemPrompt).toContain(NO_GUESSING)
  })

  test('max agent has mandatory prompt', () => {
    expect(maxDefinition.systemPrompt).toContain(ARABIC_CORE)
    expect(maxDefinition.systemPrompt).toContain(NO_GUESSING)
  })

  test('plan agent has mandatory prompt', () => {
    expect(planDefinition.systemPrompt).toContain(ARABIC_CORE)
    expect(planDefinition.systemPrompt).toContain(NO_GUESSING)
  })

  test('cybernevan/hunter agent has mandatory prompt', () => {
    expect(hunterDefinition.systemPrompt).toContain(ARABIC_CORE)
    expect(hunterDefinition.systemPrompt).toContain(NO_GUESSING)
    expect(hunterDefinition.systemPrompt).toContain(STOP_AND_ASK)
    expect(hunterDefinition.systemPrompt).toContain(VERIFY_BEFORE_NEXT)
    expect(hunterDefinition.systemPrompt).toContain(ADMIT_ERRORS)
  })

  test('cybernevan/hunter mandatory prompt precedes MYTHOS content', () => {
    const mandatoryIdx = hunterDefinition.systemPrompt!.indexOf(ARABIC_CORE)
    const mythosIdx = hunterDefinition.systemPrompt!.indexOf('MYTHOS')
    expect(mandatoryIdx).toBeGreaterThanOrEqual(0)
    expect(mandatoryIdx).toBeLessThan(mythosIdx)
  })
})

describe('runtime full-authority tool & instruction mastery enforcement', () => {
  const SECTION_HEADER =
    '## بروتوكول السيادة الكاملة على الأدوات والتعليمات (Runtime Full-Authority Tool & Instruction Mastery — Cannot Skip)'
  const FULL_ACCESS = 'وتملك وصولاً كاملاً وغير مقيد إلى جميع الأدوات الممنوحة لك'
  const NEVER_UNAVAILABLE =
    'ممنوع منعاً باتاً الادعاء بأن أداة غير متاحة طالما أنها مُدرجة في قائمة أدواتك'
  const NO_SHORTCUT = '**لا اختصار:**'
  const DIRECT_TOOLS_HEADER = '### أدواتك المباشرة'
  const DELEGATED_HEADER = '### قدرات عبر الوكلاء'
  const WEB_SEARCH_DELEGATED = 'بحث الويب والوثائق (web_search)'
  const TERMINAL_DELEGATED = 'الطرفية والأوامر (run_terminal_command)'
  const INDEX_FIRST_RULE = '**الفهرسة أولاً (Index-First):**'
  const SET_OUTPUT_RESERVED = 'لا تستخدمها بنفسك'
  const ABSOLUTE_INDEX_RULE = '**قاعدة مطلقة:**'

  test('MANDATORY_PROMPT contains the full-authority section header', () => {
    expect(MANDATORY_PROMPT).toContain(SECTION_HEADER)
  })

  test('MANDATORY_PROMPT asserts full unrestricted tool access', () => {
    expect(MANDATORY_PROMPT).toContain(FULL_ACCESS)
    expect(MANDATORY_PROMPT).toContain(NEVER_UNAVAILABLE)
  })

  test('MANDATORY_PROMPT contains the no-shortcut authority rule', () => {
    expect(MANDATORY_PROMPT).toContain(NO_SHORTCUT)
  })

  test('MANDATORY_PROMPT separates direct tools from delegated capabilities', () => {
    expect(MANDATORY_PROMPT).toContain(DIRECT_TOOLS_HEADER)
    expect(MANDATORY_PROMPT).toContain(DELEGATED_HEADER)
  })

  test('web_search and run_terminal_command are described as delegated, not direct', () => {
    expect(MANDATORY_PROMPT).toContain(WEB_SEARCH_DELEGATED)
    expect(MANDATORY_PROMPT).toContain(TERMINAL_DELEGATED)
  })

  test('set_output is marked reserved for sub-agents', () => {
    expect(MANDATORY_PROMPT).toContain(SET_OUTPUT_RESERVED)
  })

  test('mastery section enforces index-first with preserved read-tool fallback', () => {
    expect(MANDATORY_PROMPT).toContain(INDEX_FIRST_RULE)
    // Fallback must remain legitimate: read tools complement the index.
    expect(MANDATORY_PROMPT).toContain('read_files')
    expect(MANDATORY_PROMPT).toContain('read_subtree')
  })

  test('project-understanding phase 1 has the absolute index-first rule', () => {
    expect(MANDATORY_PROMPT).toContain(ABSOLUTE_INDEX_RULE)
    expect(MANDATORY_PROMPT).toContain(
      'الفهرسة الجاهزة هي نقطة البداية الإلزامية لكل مهمة فهم',
    )
  })

  test('every granted direct tool is enumerated in the mastery section (access == granted)', () => {
    const agent = createBase2('default')
    for (const tool of agent.toolNames ?? []) {
      expect(MANDATORY_PROMPT).toContain(tool)
    }
  })

  test('mastery section appears after core accountability and before Smart Testing', () => {
    const coreIdx = MANDATORY_PROMPT.indexOf(
      'أنت المسؤول الكامل عن جودة النتيجة',
    )
    const masteryIdx = MANDATORY_PROMPT.indexOf(SECTION_HEADER)
    const testingIdx = MANDATORY_PROMPT.indexOf('## الاختبار الإجباري الذكي')
    expect(coreIdx).toBeGreaterThanOrEqual(0)
    expect(masteryIdx).toBeGreaterThan(coreIdx)
    expect(masteryIdx).toBeLessThan(testingIdx)
  })

  test('mastery section appears before # Identity in systemPrompt', () => {
    const agent = createBase2('default')
    const masteryIdx = agent.systemPrompt!.indexOf(SECTION_HEADER)
    const identityIdx = agent.systemPrompt!.indexOf('# Identity')
    expect(masteryIdx).toBeGreaterThanOrEqual(0)
    expect(masteryIdx).toBeLessThan(identityIdx)
  })

  test.each([
    ['default', createBase2('default')],
    ['lite', createBase2('lite')],
    ['max', createBase2('max')],
    ['plan', createBase2('default', { planOnly: true })],
    ['free', createBase2('free')],
    ['fast', createBase2('fast')],
  ])('mode %s has full-authority mastery protocol in systemPrompt', (_, agent) => {
    expect(agent.systemPrompt).toContain(SECTION_HEADER)
    expect(agent.systemPrompt).toContain(FULL_ACCESS)
    expect(agent.systemPrompt).toContain(NO_SHORTCUT)
    expect(agent.systemPrompt).toContain(DIRECT_TOOLS_HEADER)
    expect(agent.systemPrompt).toContain(DELEGATED_HEADER)
  })

  test('cybernevan/hunter agent has full-authority mastery protocol', () => {
    expect(hunterDefinition.systemPrompt).toContain(SECTION_HEADER)
    expect(hunterDefinition.systemPrompt).toContain(FULL_ACCESS)
    expect(hunterDefinition.systemPrompt).toContain(NEVER_UNAVAILABLE)
  })
})

describe('humanizer writing standards enforcement', () => {
  const HUMANIZER_SECTION = '## Writing Standards for Natural-Language Output (Humanizer — Always Active)'
  const SCOPE_SENTENCE = 'They do NOT apply to code, commands, file content, identifiers, flags, or structured data output.'
  const EM_DASH_RULE = 'No em dashes or en dashes in prose output.'
  const VOCAB_RULE = 'actually, additionally, align with, crucial, delve'
  const FILLER_RULE = 'No signposting announcements'

  test('MANDATORY_PROMPT contains the humanizer section header', () => {
    expect(MANDATORY_PROMPT).toContain(HUMANIZER_SECTION)
  })

  test('MANDATORY_PROMPT contains the scope restriction sentence', () => {
    expect(MANDATORY_PROMPT).toContain(SCOPE_SENTENCE)
  })

  test('MANDATORY_PROMPT contains em-dash hard rule', () => {
    expect(MANDATORY_PROMPT).toContain(EM_DASH_RULE)
  })

  test('MANDATORY_PROMPT contains banned vocabulary list', () => {
    expect(MANDATORY_PROMPT).toContain(VOCAB_RULE)
  })

  test('MANDATORY_PROMPT contains filler/signposting rule', () => {
    expect(MANDATORY_PROMPT).toContain(FILLER_RULE)
  })

  test.each([
    ['default', createBase2('default')],
    ['lite', createBase2('lite')],
    ['max', createBase2('max')],
    ['plan', createBase2('default', { planOnly: true })],
    ['free', createBase2('free')],
    ['fast', createBase2('fast')],
  ])('mode %s has humanizer standards in systemPrompt', (_, agent) => {
    expect(agent.systemPrompt).toContain(HUMANIZER_SECTION)
    expect(agent.systemPrompt).toContain(EM_DASH_RULE)
    expect(agent.systemPrompt).toContain(VOCAB_RULE)
  })

  test('humanizer section appears in systemPrompt before # Identity', () => {
    const agent = createBase2('default')
    const humanizerIdx = agent.systemPrompt!.indexOf(HUMANIZER_SECTION)
    const identityIdx = agent.systemPrompt!.indexOf('# Identity')
    expect(humanizerIdx).toBeGreaterThanOrEqual(0)
    expect(humanizerIdx).toBeLessThan(identityIdx)
  })

  test('cybernevan/hunter agent has humanizer standards', () => {
    expect(hunterDefinition.systemPrompt).toContain(HUMANIZER_SECTION)
    expect(hunterDefinition.systemPrompt).toContain(EM_DASH_RULE)
  })
})

describe('project understanding protocol enforcement', () => {
  const PROTOCOL_SECTION = '## بروتوكول فهم المشروع (Mandatory Project Understanding Protocol — Cannot Skip)'
  const INDEX_FIRST_PHASE = 'المرحلة الأولى: قراءة الفهرسة الجاهزة (Index-First — الخيار الإلزامي الأول)'
  const SELF_ANALYSIS_PHASE = 'المرحلة الثانية: التحليل الذاتي الشامل (Self-Analysis — عند غياب الفهرسة)'
  const RELEVANT_FILES_TRIGGER = '<relevant_files>'
  const FAST_PATH_EXCEPTION = 'استثناء وحيد'

  test('MANDATORY_PROMPT contains the project understanding protocol section', () => {
    expect(MANDATORY_PROMPT).toContain(PROTOCOL_SECTION)
  })

  test('MANDATORY_PROMPT contains index-first phase directive', () => {
    expect(MANDATORY_PROMPT).toContain(INDEX_FIRST_PHASE)
  })

  test('MANDATORY_PROMPT contains self-analysis phase directive', () => {
    expect(MANDATORY_PROMPT).toContain(SELF_ANALYSIS_PHASE)
  })

  test('MANDATORY_PROMPT references relevant_files trigger', () => {
    expect(MANDATORY_PROMPT).toContain(RELEVANT_FILES_TRIGGER)
  })

  test('MANDATORY_PROMPT preserves fast-path exception for operational requests', () => {
    expect(MANDATORY_PROMPT).toContain(FAST_PATH_EXCEPTION)
  })

  test('protocol section appears before # Identity in systemPrompt', () => {
    const agent = createBase2('default')
    const protocolIdx = agent.systemPrompt!.indexOf(PROTOCOL_SECTION)
    const identityIdx = agent.systemPrompt!.indexOf('# Identity')
    expect(protocolIdx).toBeGreaterThanOrEqual(0)
    expect(protocolIdx).toBeLessThan(identityIdx)
  })

  test('protocol section appears after mandatory testing section', () => {
    const testingSection = 'الاختبار الإجباري'
    const protocolIdx = MANDATORY_PROMPT.indexOf(PROTOCOL_SECTION)
    const testingIdx = MANDATORY_PROMPT.indexOf(testingSection)
    expect(protocolIdx).toBeGreaterThan(testingIdx)
  })

  test.each([
    ['default', createBase2('default')],
    ['lite', createBase2('lite')],
    ['max', createBase2('max')],
    ['plan', createBase2('default', { planOnly: true })],
    ['free', createBase2('free')],
    ['fast', createBase2('fast')],
  ])('mode %s has project understanding protocol in systemPrompt', (_, agent) => {
    expect(agent.systemPrompt).toContain(PROTOCOL_SECTION)
    expect(agent.systemPrompt).toContain(INDEX_FIRST_PHASE)
    expect(agent.systemPrompt).toContain(SELF_ANALYSIS_PHASE)
  })

  test('cybernevan/hunter agent has project understanding protocol', () => {
    expect(hunterDefinition.systemPrompt).toContain(PROTOCOL_SECTION)
    expect(hunterDefinition.systemPrompt).toContain(INDEX_FIRST_PHASE)
    expect(hunterDefinition.systemPrompt).toContain(SELF_ANALYSIS_PHASE)
  })
})

describe('smart search protocol enforcement', () => {
  const SMART_SEARCH_HEADER = '## بروتوكول البحث الذكي الإلزامي — /Smartsearch'
  const AUTO_ACTIVATION = 'يعمل تلقائياً في الخلفية لكل جلسة'
  const QUICK_SEARCH = 'بحث سريع (Quick/Smart)'
  const DEEP_SEARCH = 'بحث عميق (Deep)'
  const YEAR_INJECTION = 'حقن السنة تلقائياً'
  const MULTI_SOURCE = 'التحقق متعدد المصادر'
  const CANNOT_SKIP = 'لا يمكن تخطي البحث'
  const LOGGING_PATH = '.nevan/search-log'

  test('MANDATORY_PROMPT contains Smart Search section header', () => {
    expect(MANDATORY_PROMPT).toContain(SMART_SEARCH_HEADER)
  })

  test('MANDATORY_PROMPT contains auto-activation clause', () => {
    expect(MANDATORY_PROMPT).toContain(AUTO_ACTIVATION)
  })

  test('MANDATORY_PROMPT contains quick search level', () => {
    expect(MANDATORY_PROMPT).toContain(QUICK_SEARCH)
  })

  test('MANDATORY_PROMPT contains deep search level', () => {
    expect(MANDATORY_PROMPT).toContain(DEEP_SEARCH)
  })

  test('MANDATORY_PROMPT contains year injection rule', () => {
    expect(MANDATORY_PROMPT).toContain(YEAR_INJECTION)
  })

  test('MANDATORY_PROMPT contains multi-source verification rule', () => {
    expect(MANDATORY_PROMPT).toContain(MULTI_SOURCE)
  })

  test('MANDATORY_PROMPT contains cannot-skip-search rule', () => {
    expect(MANDATORY_PROMPT).toContain(CANNOT_SKIP)
  })

  test('MANDATORY_PROMPT contains search logging path', () => {
    expect(MANDATORY_PROMPT).toContain(LOGGING_PATH)
  })

  test('Smart Search section appears after Goal Protocol in systemPrompt', () => {
    const agent = createBase2('default')
    const goalProtocol = 'بروتوكول الهدف الإلزامي'
    const smartSearchIdx = agent.systemPrompt!.indexOf(SMART_SEARCH_HEADER)
    const goalIdx = agent.systemPrompt!.indexOf(goalProtocol)
    expect(smartSearchIdx).toBeGreaterThan(goalIdx)
  })

  test('Smart Search section appears before Humanizer in systemPrompt', () => {
    const agent = createBase2('default')
    const humanizerIdx = agent.systemPrompt!.indexOf('Writing Standards for Natural-Language Output')
    const smartSearchIdx = agent.systemPrompt!.indexOf(SMART_SEARCH_HEADER)
    expect(smartSearchIdx).toBeGreaterThanOrEqual(0)
    expect(smartSearchIdx).toBeLessThan(humanizerIdx)
  })

  test('instructionsPrompt of default mode references /Smartsearch', () => {
    const agent = createBase2('default')
    expect(agent.instructionsPrompt).toContain('/Smartsearch Protocol Active')
    expect(agent.instructionsPrompt).toContain('researcher-web BEFORE making decisions')
  })

  test('stepPrompt of default mode references /Smartsearch', () => {
    const agent = createBase2('default')
    expect(agent.stepPrompt).toContain('/Smartsearch Reminder')
    expect(agent.stepPrompt).toContain('year-aware queries')
  })

  test.each([
    ['default', createBase2('default')],
    ['lite', createBase2('lite')],
    ['max', createBase2('max')],
    ['plan', createBase2('default', { planOnly: true })],
    ['free', createBase2('free')],
    ['fast', createBase2('fast')],
  ])('mode %s has Smart Search protocol in systemPrompt', (_, agent) => {
    expect(agent.systemPrompt).toContain(SMART_SEARCH_HEADER)
    expect(agent.systemPrompt).toContain(AUTO_ACTIVATION)
    expect(agent.systemPrompt).toContain(CANNOT_SKIP)
  })

  test('cybernevan/hunter agent has Smart Search protocol', () => {
    expect(hunterDefinition.systemPrompt).toContain(SMART_SEARCH_HEADER)
    expect(hunterDefinition.systemPrompt).toContain(AUTO_ACTIVATION)
    expect(hunterDefinition.systemPrompt).toContain(CANNOT_SKIP)
  })

  test('instructionsPrompt of max mode references /Smartsearch', () => {
    const agent = createBase2('max')
    expect(agent.instructionsPrompt).toContain('/Smartsearch Protocol Active')
  })

  test('stepPrompt of max mode references /Smartsearch', () => {
    const agent = createBase2('max')
    expect(agent.stepPrompt).toContain('/Smartsearch Reminder')
  })

  test('instructionsPrompt of free mode references /Smartsearch', () => {
    const agent = createBase2('free')
    expect(agent.instructionsPrompt).toContain('/Smartsearch Protocol Active')
  })

  test('stepPrompt of free mode references /Smartsearch', () => {
    const agent = createBase2('free')
    expect(agent.stepPrompt).toContain('/Smartsearch Reminder')
  })
})

describe('mandatory goal protocol enforcement', () => {
  const GOAL_PROTOCOL_HEADER = '## بروتوكول الهدف الإلزامي (Mandatory Goal Protocol — Cannot Skip)'
  const PLAN_CREATION = 'المرحلة 1: إنشاء الخطة'
  const STEP_EXECUTION = 'المرحلة 2: التنفيذ المتدرج'
  const COMPLETION_PHASE = 'المرحلة 3: الإنهاء والإشعار'
  const COMPLETION_NOTIFICATION = '🎯 تم حذف الهدف بنجاح وإكمال المهمة بالكامل'
  const TASKS_MD_REQUIREMENT = 'tasks.md'

  test('MANDATORY_PROMPT contains goal protocol header', () => {
    expect(MANDATORY_PROMPT).toContain(GOAL_PROTOCOL_HEADER)
  })

  test('MANDATORY_PROMPT contains plan creation phase', () => {
    expect(MANDATORY_PROMPT).toContain(PLAN_CREATION)
  })

  test('MANDATORY_PROMPT contains step-by-step execution phase', () => {
    expect(MANDATORY_PROMPT).toContain(STEP_EXECUTION)
  })

  test('MANDATORY_PROMPT contains completion and notification phase', () => {
    expect(MANDATORY_PROMPT).toContain(COMPLETION_PHASE)
  })

  test('MANDATORY_PROMPT contains completion notification text', () => {
    expect(MANDATORY_PROMPT).toContain(COMPLETION_NOTIFICATION)
  })

  test('MANDATORY_PROMPT requires tasks.md creation', () => {
    expect(MANDATORY_PROMPT).toContain(TASKS_MD_REQUIREMENT)
  })

  test('goal protocol appears after project understanding protocol in systemPrompt', () => {
    const agent = createBase2('default')
    const projectProtocol = 'بروتوكول فهم المشروع'
    const goalProtoIdx = agent.systemPrompt!.indexOf(GOAL_PROTOCOL_HEADER)
    const projectProtoIdx = agent.systemPrompt!.indexOf(projectProtocol)
    expect(goalProtoIdx).toBeGreaterThan(projectProtoIdx)
  })

  test('goal protocol appears before humanizer writing standards in systemPrompt', () => {
    const agent = createBase2('default')
    const humanizerIdx = agent.systemPrompt!.indexOf('Writing Standards for Natural-Language Output')
    const goalProtoIdx = agent.systemPrompt!.indexOf(GOAL_PROTOCOL_HEADER)
    expect(goalProtoIdx).toBeGreaterThanOrEqual(0)
    expect(goalProtoIdx).toBeLessThan(humanizerIdx)
  })

  test.each([
    ['default', createBase2('default')],
    ['lite', createBase2('lite')],
    ['max', createBase2('max')],
    ['plan', createBase2('default', { planOnly: true })],
    ['free', createBase2('free')],
    ['fast', createBase2('fast')],
  ])('mode %s has goal protocol in systemPrompt', (_, agent) => {
    expect(agent.systemPrompt).toContain(GOAL_PROTOCOL_HEADER)
    expect(agent.systemPrompt).toContain(COMPLETION_NOTIFICATION)
  })

  test('cybernevan/hunter agent has goal protocol', () => {
    expect(hunterDefinition.systemPrompt).toContain(GOAL_PROTOCOL_HEADER)
    expect(hunterDefinition.systemPrompt).toContain(COMPLETION_NOTIFICATION)
  })
})
