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
  /** Pages per LLM proposal call. Bounds the response size so it isn't truncated (default 5). */
  batchSize?: number
}

/** Default number of pages proposed per LLM call. */
const DEFAULT_BATCH_SIZE = 5

/**
 * Propose E2E scenarios (Opus) for discovered pages that no existing scenario
 * covers. Each uncovered page is first structured into PageInfo, then the
 * planning LLM proposes scenarios (zod-validated) in **batches** so a large set
 * of pages never overflows the model's output limit (which truncated the JSON
 * and failed the whole run). Per-page extraction and per-batch proposal failures
 * are isolated — a single failure skips that page/batch instead of aborting grow.
 * Returned scenario ids are normalized to be unique and `grow-` prefixed.
 */
export async function proposeScenarios(
  llm: Llm,
  uncovered: RawPage[],
  deps: ProposeDeps = {},
): Promise<Scenario[]> {
  if (uncovered.length === 0) return []

  const extract = deps.extractPageInfo ?? defaultExtractPageInfo
  const batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE)
  logger.info({ count: uncovered.length, batchSize }, 'Proposing scenarios for uncovered pages')

  const pageInfos: PageInfo[] = []
  for (const raw of uncovered) {
    try {
      pageInfos.push(await extract(llm, raw))
    } catch (err) {
      logger.warn({ err: String(err), url: raw.url }, 'page-info extraction failed — skipping page')
    }
  }

  const proposed: Scenario[] = []
  for (const batch of chunk(pageInfos, batchSize)) {
    try {
      const prompt = buildProposePrompt(batch)
      const scenarios = await llm.complete('planning', prompt, ScenarioArraySchema)
      proposed.push(...scenarios)
    } catch (err) {
      logger.warn(
        { err: String(err), pages: batch.map((p) => p.url), size: batch.length },
        'scenario proposal batch failed — skipping batch',
      )
    }
  }

  const normalized = normalizeIds(proposed)
  logger.info({ count: normalized.length }, 'Scenarios proposed')
  return normalized
}

/** Split an array into consecutive chunks of at most `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Ensure every proposed scenario has a unique `grow-`-prefixed id. */
function normalizeIds(scenarios: Scenario[]): Scenario[] {
  const seen = new Set<string>()
  return scenarios.map((s) => {
    // Always slug the id (strip any 'grow-' the LLM added) so it is filename-safe
    // — an LLM-returned id like "grow-../x" must not keep path separators.
    const seed = s.id.replace(/^grow-/, '') || s.title
    const base = `grow-${slugify(seed)}`
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
