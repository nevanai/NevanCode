import * as fs from 'fs'
import * as path from 'path'

import { createBase2, MANDATORY_PROMPT } from './base2'

const SKILL_MD_PATH = path.join(import.meta.dir, 'cybernevan-hunter-skill.md')
const skillSystemPrompt = fs.readFileSync(SKILL_MD_PATH, 'utf-8')

const base = createBase2('default')

const definition = {
  ...base,
  id: 'base2-hunter',
  displayName: 'CyberNevan/Hunter',
  spawnerPrompt:
    'CyberNevan/Hunter — autonomous authorized-pentest agent. Operates strictly under the SKILL.md system prompt (MYTHOS PRIME) for scoped security assessment.',
  systemPrompt: `${MANDATORY_PROMPT}\n\n${skillSystemPrompt}`,
}

export default definition
