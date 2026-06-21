import { z } from 'zod'
import { logger } from '../../util/logger.js'
import type { VerifyFinding, RawPage } from '../../domain/types.js'
import type { Llm } from '../../services/llm/client.js'
import type { Scenario } from '../../scenario/schema.js'

export type ConditionalDeps = {
  llm: Llm
  pages: RawPage[]
  scenarios: Scenario[]
}

const ConditionalFindingSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(['high', 'medium', 'low']),
      title: z.string(),
      detail: z.string(),
      evidence: z.string(),
    }),
  ),
})

function buildConditionalPrompt(page: RawPage, scenarios: Scenario[]): string {
  const htmlSnippet = page.html.slice(0, 5000)

  const scenarioContext = scenarios
    .map((s) => {
      const dbExpectations = s.expectedDbState
        .map((db) => `  - connection:${db.connection} table:${db.table}`)
        .join('\n')
      const resultExpectations = s.expectedResults.map((r) => `  - [${r.kind}] ${r.assertion}`).join('\n')
      return `Scenario "${s.title}" (${s.id}):
  Business flow: ${s.businessFlow}
  Expected results:
${resultExpectations || '  (none)'}
  Expected DB:
${dbExpectations || '  (none)'}`
    })
    .join('\n\n')

  return `You are a QA engineer verifying conditional display logic on a web page.

Page URL: ${page.url}
Page Title: ${page.title}

HTML (truncated):
${htmlSnippet}

Active scenarios and their expectations:
${scenarioContext || '(no scenarios)'}

Check for these conditional display issues:
1. Adult/child pricing displayed incorrectly (wrong age-based price tier shown)
2. Time-based availability shown incorrectly (e.g., event sold out but still shown as available, or time-restricted content shown at wrong time)
3. Discount/coupon display discrepancies (discount not applied, wrong amount shown, or expired coupon accepted)
4. Member/non-member pricing or content display errors
5. Regional or locale-specific conditional content rendered incorrectly

Return JSON:
{
  "findings": [
    {
      "severity": "high" | "medium" | "low",
      "title": "short title",
      "detail": "what is wrong and how it differs from expectations",
      "evidence": "specific text, price, or element from the page"
    }
  ]
}

If no conditional display issues are detected, return: { "findings": [] }`
}

/**
 * Verifies conditional display: pricing tiers, time-based, discounts.
 * Uses LLM judgment against scenario expectations.
 */
export async function verifyConditional(deps: ConditionalDeps): Promise<VerifyFinding[]> {
  const { llm, pages, scenarios } = deps

  if (pages.length === 0) {
    return []
  }

  const allFindings: VerifyFinding[] = []

  for (const page of pages) {
    try {
      const prompt = buildConditionalPrompt(page, scenarios)
      const result = await llm.complete('planning', prompt, ConditionalFindingSchema)

      for (const f of result.findings) {
        allFindings.push({
          category: 'conditional',
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          evidence: `[${page.url}] ${f.evidence}`,
        })
      }
    } catch (error) {
      logger.warn({ error, url: page.url }, 'conditional verify: LLM call failed for page — skipping')
    }
  }

  return allFindings
}
