import { logger } from '../../util/logger.js'
import type { VerifyFinding, RawPage } from '../../domain/types.js'
import type { Llm } from '../../services/llm/client.js'
import type { Scenario } from '../../scenario/schema.js'
import type { Config } from '../../config/schema.js'
import type { DbDriverOptions } from '../../services/db/index.js'
import { verifyLayout } from './layout.js'
import { verifySecurity } from './security.js'
import { verifyConditional } from './conditional.js'
import { verifyRegisteredData } from './registeredData.js'
import { verifyErrorHandling } from './errorHandling.js'

export type RunVerifyDeps = {
  llm: Llm
  pages: RawPage[]
  scenarios: Scenario[]
  config: Config
  secrets: Record<string, string>
  /** Injectable DB driver factories — tests only */
  dbDrivers?: DbDriverOptions
}

type CategoryResult = {
  name: string
  fn: () => Promise<VerifyFinding[]>
}

/**
 * Runs all 5 verify categories and aggregates results.
 * Each category is isolated: a failure in one does NOT abort the others.
 * Errors are logged and the category contributes zero findings.
 */
export async function runVerify(deps: RunVerifyDeps): Promise<VerifyFinding[]> {
  const { llm, pages, scenarios, config, secrets, dbDrivers } = deps

  const categories: CategoryResult[] = [
    {
      name: 'layout',
      fn: () => verifyLayout({ llm, pages }),
    },
    {
      name: 'security',
      fn: () => verifySecurity({ llm, pages }),
    },
    {
      name: 'conditional',
      fn: () => verifyConditional({ llm, pages, scenarios }),
    },
    {
      name: 'registered-data',
      fn: () => verifyRegisteredData({ scenarios, config, secrets, dbDrivers }),
    },
    {
      name: 'error-handling',
      fn: () => verifyErrorHandling({ llm, pages }),
    },
  ]

  const allFindings: VerifyFinding[] = []

  for (const { name, fn } of categories) {
    try {
      const findings = await fn()
      allFindings.push(...findings)
      logger.debug({ category: name, count: findings.length }, 'verify category complete')
    } catch (error) {
      logger.error({ error, category: name }, 'verify category failed — continuing with others')
    }
  }

  return allFindings
}
