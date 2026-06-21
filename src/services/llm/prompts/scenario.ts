import type { RequirementContext } from '../../repo/reader.js'

/**
 * Auth context passed to the scenario prompt so the LLM knows how to structure
 * a login scenario. Only structural hints (paths, selectors) are included here —
 * credential VALUES must never be passed to this function.
 */
export type AuthHint = {
  /** The login path, e.g. "/login" or "/auth/sign-in" */
  loginPath: string
  /** Optional CSS selector hint for the username/email field */
  usernameFieldHint?: string
  /** Optional CSS selector hint for the password field */
  passwordFieldHint?: string
}

/**
 * Build a prompt that asks the planning LLM (Opus) to generate E2E scenarios
 * for all repositories in one shot.
 *
 * The prompt asks for a JSON array of scenario objects matching ScenarioSchema.
 * When authHint is provided the prompt adds a mandatory login scenario instruction
 * containing only structural context (path, field selectors) — never credentials.
 */
export function buildScenarioPrompt(contexts: RequirementContext[], authHint?: AuthHint): string {
  const repoSections = contexts.map(buildRepoSection).join('\n\n')

  const loginInstruction = authHint ? buildLoginInstruction(authHint) : ''

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
${loginInstruction}
--- REPOSITORIES ---

${repoSections}

--- END OF REQUIREMENTS ---

Respond with a JSON array of scenario objects.`
}

/**
 * Build the login scenario instruction block.
 * Only structural context (path, selectors) is included — never credential values.
 */
function buildLoginInstruction(authHint: AuthHint): string {
  const fieldLines: string[] = []

  if (authHint.usernameFieldHint) {
    fieldLines.push(`  - Username/email field selector: ${authHint.usernameFieldHint}`)
  }
  if (authHint.passwordFieldHint) {
    fieldLines.push(`  - Password field selector: ${authHint.passwordFieldHint}`)
  }

  const fieldContext = fieldLines.length > 0
    ? `\nField hints for the login form:\n${fieldLines.join('\n')}`
    : ''

  return `
--- LOGIN SCENARIO REQUIREMENT ---
At least one login scenario MUST be included. This scenario must:
1. Navigate to the login path: ${authHint.loginPath}
2. Fill in the username and password fields with placeholder test credentials.
3. Submit the login form.
4. Assert that the user is now logged in (URL changed away from ${authHint.loginPath} or a logged-in element is visible).
${fieldContext}
--- END LOGIN REQUIREMENT ---
`
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
