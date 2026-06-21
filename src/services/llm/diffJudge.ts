import { z } from 'zod'
import type { Llm } from './client.js'
import type { SiteStructure, DiffFinding } from '../../domain/types.js'
import type { Scenario } from '../../scenario/schema.js'
import { diffPrompt } from './prompts/diff.js'

const DiffFindingSchema = z.object({
  kind: z.literal('expectation-gap'),
  severity: z.enum(['high', 'medium', 'low']),
  expected: z.string(),
  actual: z.string(),
  location: z.string(),
})

const DiffFindingsSchema = z.array(DiffFindingSchema)

export async function diffJudge(
  llm: Llm,
  scenarios: Scenario[],
  structure: SiteStructure,
): Promise<DiffFinding[]> {
  if (scenarios.length === 0 || structure.pages.length === 0) return []

  const findings: DiffFinding[] = []

  for (const scenario of scenarios) {
    for (const page of structure.pages) {
      const prompt = diffPrompt(scenario, page, '')
      const raw = await llm.complete('planning', prompt, DiffFindingsSchema)
      findings.push(...raw)
    }
  }

  return findings
}
