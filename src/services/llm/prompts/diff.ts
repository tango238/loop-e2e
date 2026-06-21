import type { Scenario } from '../../../scenario/schema.js'
import type { PageInfo } from '../../../domain/types.js'

export function diffPrompt(scenario: Scenario, page: PageInfo, evidence: string): string {
  return `You are an E2E test analyst. Identify expectation gaps between what a scenario expects and what the page actually supports.

## Scenario
ID: ${scenario.id}
Title: ${scenario.title}
Business Flow: ${scenario.businessFlow}

Expected Results:
${scenario.expectedResults.map((r, i) => `${i + 1}. [${r.kind}] ${r.description} — ${r.assertion}`).join('\n')}

## Page (${page.url})
Capabilities:
${page.capabilities.length > 0 ? page.capabilities.map((c) => `- ${c}`).join('\n') : '(none listed)'}

Expectations:
${page.expectations.length > 0 ? page.expectations.map((e) => `- ${e}`).join('\n') : '(none listed)'}

## Additional Evidence
${evidence || '(none)'}

Return a JSON array of DiffFinding objects for each expected result NOT covered by the page capabilities.
Each item: { "kind": "expectation-gap", "severity": "high"|"medium"|"low", "expected": "<what scenario expects>", "actual": "not covered", "location": "${page.url}" }
Return [] if all expectations are covered.`
}
