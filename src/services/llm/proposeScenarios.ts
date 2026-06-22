import { z } from 'zod'
import { ScenarioSchema, type Scenario } from '../../scenario/schema.js'
import { buildProposePrompt } from './prompts/propose.js'
import { extractPageInfo as defaultExtractPageInfo } from './structureExtract.js'
import { logger } from '../../util/logger.js'
import type { Llm } from './client.js'
import type { RawPage, PageInfo } from '../../domain/types.js'

const ScenarioArraySchema = z.array(ScenarioSchema)

export type ProposeDeps = {
  /** Override page-info extraction for testing */
  extractPageInfo?: (llm: Llm, raw: RawPage) => Promise<PageInfo>
}

/**
 * Propose E2E scenarios (Opus) for discovered pages that no existing scenario
 * covers. Each uncovered page is first structured into PageInfo, then the
 * planning LLM proposes scenarios (zod-validated). Returned scenario ids are
 * normalized to be unique and `grow-` prefixed.
 */
export async function proposeScenarios(
  llm: Llm,
  uncovered: RawPage[],
  deps: ProposeDeps = {},
): Promise<Scenario[]> {
  if (uncovered.length === 0) return []

  const extract = deps.extractPageInfo ?? defaultExtractPageInfo
  logger.info({ count: uncovered.length }, 'Proposing scenarios for uncovered pages')

  const pageInfos: PageInfo[] = []
  for (const raw of uncovered) {
    pageInfos.push(await extract(llm, raw))
  }

  const prompt = buildProposePrompt(pageInfos)
  const scenarios = await llm.complete('planning', prompt, ScenarioArraySchema)

  const normalized = normalizeIds(scenarios)
  logger.info({ count: normalized.length }, 'Scenarios proposed')
  return normalized
}

/** Ensure every proposed scenario has a unique `grow-`-prefixed id. */
function normalizeIds(scenarios: Scenario[]): Scenario[] {
  const seen = new Set<string>()
  return scenarios.map((s) => {
    const base = s.id.startsWith('grow-') ? s.id : `grow-${slugify(s.id || s.title)}`
    let id = base
    let n = 2
    while (seen.has(id)) {
      id = `${base}-${n}`
      n += 1
    }
    seen.add(id)
    return { ...s, id }
  })
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'page'
}
