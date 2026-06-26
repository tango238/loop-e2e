import { z } from 'zod'
import { ScenarioSchema, type Scenario } from '../../scenario/schema.js'
import { isLoginScenario } from '../../scenario/loginScenario.js'
import { buildProposePrompt } from './prompts/propose.js'
import { generateScenarios as defaultGenerateScenarios } from './scenarioGen.js'
import { extractPageInfo as defaultExtractPageInfo } from './structureExtract.js'
import { logger } from '../../util/logger.js'
import type { Llm } from './client.js'
import type { RawPage, PageInfo } from '../../domain/types.js'
import type { RequirementContext } from '../repo/reader.js'
import type { AuthHint } from './prompts/scenario.js'

const ScenarioArraySchema = z.array(ScenarioSchema)

/** Default number of pages proposed per LLM call. */
const DEFAULT_BATCH_SIZE = 5

/** Inputs to a unified proposal: dynamic (crawl) + static (source/requirements). Either may be empty. */
export type ProposeInput = {
  uncovered: RawPage[]
  requirements: RequirementContext[]
  authHint?: AuthHint
}

export type ProposeDeps = {
  /** Override page-info extraction for testing */
  extractPageInfo?: (llm: Llm, raw: RawPage) => Promise<PageInfo>
  /** Override source-derived scenario generation for testing */
  generateScenarios?: (llm: Llm, contexts: RequirementContext[], authHint?: AuthHint) => Promise<Scenario[]>
  /** Pages per LLM proposal call. Bounds the response size so it isn't truncated (default 5). */
  batchSize?: number
}

/**
 * Brief, bounded summary of source/requirement context to fuse into page-proposal prompts.
 * Kept small on purpose: it is appended to EVERY page batch prompt, so total fused tokens grow
 * with the number of batches — the source-derived (b) path uses the full contexts separately.
 */
export function summarizeRequirements(reqs: RequirementContext[], maxChars = 1000): string {
  if (reqs.length === 0) return ''
  const parts = reqs.map((r) => {
    const head = `### ${r.repo.name} (${r.repo.role}/${r.repo.audience})`
    const readme = r.readme ? r.readme.slice(0, 300) : ''
    const code = r.codeSummary ? r.codeSummary.slice(0, 400) : ''
    return [head, readme, code].filter(Boolean).join('\n')
  })
  return parts.join('\n\n').slice(0, maxChars)
}

/**
 * Propose E2E scenarios (Opus) by fusing two understanding sources:
 *  (a) crawl — one+ scenarios per uncovered page, batched (bounded response), with a brief
 *      source summary fused into the prompt for more functional scenarios;
 *  (b) source — functional flows derived from repository requirements/code (generateScenarios).
 * Page extraction, each page batch, and the source proposal fail independently — one failure
 * skips that unit instead of aborting. Returned ids are normalized (unique, `grow-` prefixed).
 */
export async function proposeScenarios(
  llm: Llm,
  input: ProposeInput,
  deps: ProposeDeps = {},
): Promise<Scenario[]> {
  const { uncovered, requirements, authHint } = input
  if (uncovered.length === 0 && requirements.length === 0) return []

  const extract = deps.extractPageInfo ?? defaultExtractPageInfo
  const generate = deps.generateScenarios ?? defaultGenerateScenarios
  const batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE)
  const reqSummary = summarizeRequirements(requirements)

  const proposed: Scenario[] = []

  // (a) page-derived proposals (crawl) — fused with the brief source summary
  if (uncovered.length > 0) {
    logger.info({ count: uncovered.length, batchSize, withSource: Boolean(reqSummary) }, 'Proposing scenarios for uncovered pages')
    const pageInfos: PageInfo[] = []
    for (const raw of uncovered) {
      try {
        pageInfos.push(await extract(llm, raw))
      } catch (err) {
        logger.warn({ err: String(err), url: raw.url }, 'page-info extraction failed — skipping page')
      }
    }
    for (const batch of chunk(pageInfos, batchSize)) {
      try {
        const prompt = buildProposePrompt(batch, reqSummary)
        const scenarios = await llm.complete('planning', prompt, ScenarioArraySchema)
        proposed.push(...scenarios)
      } catch (err) {
        logger.warn(
          { err: String(err), pages: batch.map((p) => p.url), size: batch.length },
          'scenario proposal batch failed — skipping batch',
        )
      }
    }
  }

  // (b) source-derived proposals (requirements/code → functional flows)
  if (requirements.length > 0) {
    try {
      proposed.push(...(await generate(llm, requirements, authHint)))
    } catch (err) {
      logger.warn({ err: String(err) }, 'source-derived scenario proposal failed — skipping')
    }
  }

  const normalized = applyDefaultAuthPrecondition(normalizeIds(proposed), authHint?.loginPath)
  logger.info({ count: normalized.length }, 'Scenarios proposed')
  return normalized
}

/**
 * grow proposes scenarios for pages discovered AFTER login, so each one assumes an
 * authenticated session (see the propose/scenario prompts). The executor only establishes
 * that session when `precondition.auth === 'authenticated'` is set explicitly, so default
 * any scenario that lacks a precondition to `authenticated`. Without this the executor runs
 * the steps on a fresh, cookie-less page and the app redirects every navigate to the login
 * page (all steps then time out). The login scenario itself is exempt — it legitimately starts
 * from an unauthenticated state and establishes the session.
 */
export function applyDefaultAuthPrecondition(scenarios: Scenario[], loginPath?: string): Scenario[] {
  return scenarios.map((s) => {
    if (s.precondition) return s
    if (isLoginScenario(s, loginPath)) return s
    return { ...s, precondition: { auth: 'authenticated' as const } }
  })
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
