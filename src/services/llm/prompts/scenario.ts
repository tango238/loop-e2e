import type { RequirementContext } from '../../repo/reader.js'

/**
 * Build a prompt that asks the planning LLM (Opus) to generate E2E scenarios
 * for all repositories in one shot.
 *
 * The prompt asks for a JSON array of scenario objects matching ScenarioSchema.
 */
export function buildScenarioPrompt(contexts: RequirementContext[]): string {
  const repoSections = contexts.map(buildRepoSection).join('\n\n')

  return `You are an expert QA engineer. Based on the software requirements below,
generate a comprehensive set of end-to-end test scenarios in JSON format.

Each scenario must follow this exact structure:
{
  "id": "sc-<three-digit-number>",        // e.g. "sc-001"
  "title": "<short descriptive title>",
  "businessFlow": "<one or two sentences describing the user journey>",
  "steps": [
    {
      "action": "<navigate|click|fill|submit|wait|assert>",
      "target": "<selector, URL path, or field name>",
      "input": "<optional: value to type>",    // omit if not applicable
      "expectedOutcome": "<what should happen after this step>"
    }
  ],
  "expectedResults": [
    {
      "kind": "<ui|api|db|email|log>",
      "description": "<what is expected>",
      "assertion": "<how to verify it>"
    }
  ],
  "expectedDbState": [                        // can be empty array []
    {
      "connection": "<database connection name>",
      "table": "<table name>",
      "match": { "<column>": "<value>" },
      "expectedValues": { "<column>": "<value>" }
    }
  ]
}

Rules:
- Generate at least 3 scenarios per repository, covering happy paths and key error cases.
- Each scenario must have at least 2 steps and at least 1 expectedResult.
- expectedDbState can be an empty array if no DB verification is needed.
- IDs must be unique across all scenarios.
- Respond with a JSON array of scenario objects ONLY — no markdown, no prose.

--- REPOSITORIES ---

${repoSections}

--- END OF REQUIREMENTS ---

Respond with a JSON array of scenario objects.`
}

function buildRepoSection(ctx: RequirementContext): string {
  const parts: string[] = [
    `## Repository: ${ctx.repo.label} (${ctx.repo.name})`,
    `Role: ${ctx.repo.role} | Audience: ${ctx.repo.audience}`,
  ]

  if (ctx.readme) {
    parts.push('\n### README\n' + ctx.readme)
  }

  if (ctx.docs.length > 0) {
    parts.push('\n### Documentation\n' + ctx.docs.join('\n\n---\n\n'))
  }

  if (ctx.codeSummary) {
    parts.push('\n### Source Code\n' + ctx.codeSummary)
  }

  if (ctx.gitlogSummary) {
    parts.push('\n### Recent Git Log\n' + ctx.gitlogSummary)
  }

  return parts.join('\n')
}
