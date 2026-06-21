import { PageInfoSchema } from '../../domain/types.js'
import { buildStructurePrompt } from './prompts/structure.js'
import { logger } from '../../util/logger.js'
import type { Llm } from './client.js'
import type { RawPage, PageInfo } from '../../domain/types.js'

/**
 * Extracts structured PageInfo from a raw crawled page using the LLM.
 * Uses role='planning' and validates the response against PageInfoSchema.
 */
export async function extractPageInfo(llm: Llm, raw: RawPage): Promise<PageInfo> {
  const prompt = buildStructurePrompt(raw)
  logger.debug({ url: raw.url }, 'Extracting page info via LLM')
  const pageInfo = await llm.complete('planning', prompt, PageInfoSchema)
  logger.debug({ url: raw.url }, 'Page info extracted')
  return pageInfo
}
