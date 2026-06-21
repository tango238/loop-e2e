import { z } from 'zod'
import { ScenarioSchema, type Scenario } from '../../scenario/schema.js'
import { buildScenarioPrompt } from './prompts/scenario.js'
import { logger } from '../../util/logger.js'
import type { Llm } from './client.js'
import type { RequirementContext } from '../repo/reader.js'

const ScenarioArraySchema = z.array(ScenarioSchema)

/**
 * Ask the planning LLM (Opus) to generate E2E scenarios from requirement
 * contexts collected across all repositories.
 *
 * The LLM is asked to respond with a JSON array; the response is parsed
 * and validated with Zod.  Retries are handled by the Llm client layer.
 */
export async function generateScenarios(
  llm: Llm,
  contexts: RequirementContext[],
): Promise<Scenario[]> {
  logger.info({ repos: contexts.map((c) => c.repo.name) }, 'Generating scenarios')

  const prompt = buildScenarioPrompt(contexts)
  const scenarios = await llm.complete('planning', prompt, ScenarioArraySchema)

  logger.info({ count: scenarios.length }, 'Scenarios generated')
  return scenarios
}
