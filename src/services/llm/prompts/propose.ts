import type { PageInfo } from '../../../domain/types.js'

/**
 * Build a prompt asking the planning LLM (Opus) to propose E2E scenarios for
 * pages discovered AFTER login that no existing scenario covers. The caller is
 * already authenticated, so each scenario starts by navigating to the page.
 */
export function buildProposePrompt(pages: PageInfo[]): string {
  const sections = pages.map(buildPageSection).join('\n\n')

  return `You are an expert QA engineer. The user is ALREADY LOGGED IN to an admin
application. Below are pages that were discovered by crawling the app after login
and which no existing test scenario covers yet. Propose one end-to-end test
scenario per page that exercises that page's primary purpose (viewing its key
data and/or performing its main action).

Each scenario must be a JSON object with this exact structure:
{
  "id": "grow-<short-kebab-slug-of-the-page>",
  "title": "<short descriptive title>",
  "businessFlow": "<one or two sentences describing the user journey, assuming already logged in>",
  "steps": [
    { "action": "<navigate|click|fill|submit|wait|assert>", "target": "<selector or URL path>", "input": "<optional value>", "expectedOutcome": "<what should happen>" }
  ],
  "expectedResults": [
    { "kind": "<ui|api|db|email|log>", "description": "<what is expected>", "assertion": "<how to verify>" }
  ],
  "expectedDbState": []
}

Rules:
- The FIRST step of every scenario must be a "navigate" to the discovered page's path.
- Assume the session is already authenticated — do NOT include login steps.
- NEVER include real credentials, passwords, tokens, or personal data — use placeholders.
- Each scenario needs at least 2 steps and at least 1 expectedResult.
- IDs must be unique and start with "grow-".
- Respond with a JSON array of scenario objects ONLY — no markdown, no prose.

--- DISCOVERED PAGES ---

${sections}

--- END ---

Respond with a JSON array of scenario objects.`
}

function buildPageSection(page: PageInfo): string {
  const parts: string[] = [
    `## Page: ${page.title} (${page.url})`,
    page.description ? `Description: ${page.description}` : '',
    page.displayItems.length ? `Display items: ${page.displayItems.map((d) => d.label).join(', ')}` : '',
    page.inputItems.length ? `Input items: ${page.inputItems.map((i) => i.label).join(', ')}` : '',
    page.capabilities.length ? `Can do here: ${page.capabilities.join('; ')}` : '',
  ]
  return parts.filter(Boolean).join('\n')
}
