import { z } from 'zod'
import { logger } from '../../util/logger.js'
import type { VerifyFinding, RawPage } from '../../domain/types.js'
import type { Llm } from '../../services/llm/client.js'

export type ErrorHandlingDeps = {
  llm: Llm
  pages: RawPage[]
}

const ErrorHandlingFindingSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(['high', 'medium', 'low']),
      title: z.string(),
      detail: z.string(),
      evidence: z.string(),
    }),
  ),
})

// Common error message container selectors / patterns to look for in HTML
const ERROR_INDICATORS_REGEX =
  /(?:class|id)=["'][^"']*(?:error|alert|warning|invalid|danger|fail)[^"']*["']/i

/**
 * Returns true if the page contains error messages (by class/id pattern).
 * Used to skip pages without any error content.
 */
function pageHasErrorMessages(html: string): boolean {
  return ERROR_INDICATORS_REGEX.test(html)
}

function buildErrorHandlingPrompt(page: RawPage): string {
  const htmlSnippet = page.html.slice(0, 5000)

  return `You are a UX quality reviewer. Examine the rendered web page below and evaluate the quality of user-facing error messages.

Page URL: ${page.url}
Page Title: ${page.title}

HTML (truncated):
${htmlSnippet}

Evaluate the following:
1. Are error messages present and visible? (Look for elements with class/id containing: error, alert, warning, invalid, danger, fail)
2. Do the error messages clearly explain WHAT went wrong?
3. Do the error messages tell the user WHAT TO DO NEXT (actionable guidance)?
4. Are error messages written in user-friendly language (not technical jargon or stack traces)?
5. Are error messages specific enough (e.g., "Email is required" vs just "Error")?

Flag issues when:
- An error state exists but message is vague or generic (e.g., "An error occurred", "Something went wrong")
- An error message provides no guidance on how to fix the problem
- Error messages contain technical details inappropriate for end users (stack traces, SQL errors, etc.)
- Required field errors don't identify which field is invalid

Return JSON:
{
  "findings": [
    {
      "severity": "high" | "medium" | "low",
      "title": "short title describing the issue",
      "detail": "explanation of why this error message is inadequate",
      "evidence": "the actual error message text or HTML snippet"
    }
  ]
}

If no error messages are present on the page, or all error messages are clear and actionable, return: { "findings": [] }`
}

/**
 * Verifies error message quality: presence, clarity, and actionable guidance.
 * Uses LLM judgment for nuanced UX evaluation.
 */
export async function verifyErrorHandling(deps: ErrorHandlingDeps): Promise<VerifyFinding[]> {
  const { llm, pages } = deps

  if (pages.length === 0) {
    return []
  }

  const allFindings: VerifyFinding[] = []

  for (const page of pages) {
    try {
      // Optimization: only send to LLM pages that appear to have error content
      if (!pageHasErrorMessages(page.html)) {
        continue
      }

      const prompt = buildErrorHandlingPrompt(page)
      const result = await llm.complete('planning', prompt, ErrorHandlingFindingSchema)

      for (const f of result.findings) {
        allFindings.push({
          category: 'error-handling',
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          evidence: `[${page.url}] ${f.evidence}`,
        })
      }
    } catch (error) {
      logger.warn({ error, url: page.url }, 'errorHandling verify: LLM call failed for page — skipping')
    }
  }

  return allFindings
}

// Export helper for unit testing
export { pageHasErrorMessages }
