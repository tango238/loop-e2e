import { z } from 'zod'
import { logger } from '../../util/logger.js'
import type { VerifyFinding, RawPage } from '../../domain/types.js'
import type { Llm } from '../../services/llm/client.js'

export type LayoutDeps = {
  llm: Llm
  pages: RawPage[]
}

const LayoutFindingSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.enum(['high', 'medium', 'low']),
      title: z.string(),
      detail: z.string(),
      evidence: z.string(),
    }),
  ),
})

function buildLayoutPrompt(page: RawPage): string {
  // Truncate HTML to avoid token overflow; first 4000 chars captures structure
  const htmlSnippet = page.html.slice(0, 4000)

  return `You are a visual QA inspector. Examine the rendered web page below for layout problems.

Page URL: ${page.url}
Page Title: ${page.title}
Screenshot path: ${page.screenshotPath}

HTML (truncated):
${htmlSnippet}

Look for:
1. Content overflow (elements wider than their container, text cut off, horizontal scrollbar indicators)
2. Element overlaps (UI elements covering each other unintentionally)
3. Broken flex/grid layouts (misaligned columns, collapsed containers)
4. Images or icons missing or broken (src="" or broken img tags)
5. Text that is not readable (too small, invisible color, clipped)

Return JSON with this exact structure:
{
  "findings": [
    {
      "severity": "high" | "medium" | "low",
      "title": "short title describing the issue",
      "detail": "detailed explanation of what is wrong",
      "evidence": "CSS selector, HTML snippet, or observable symptom"
    }
  ]
}

If no layout issues are found, return: { "findings": [] }`
}

/**
 * Verifies layout quality: overflow, overlaps, broken structure.
 * Uses LLM visual judgment on DOM snapshot + screenshot path.
 */
export async function verifyLayout(deps: LayoutDeps): Promise<VerifyFinding[]> {
  const { llm, pages } = deps

  if (pages.length === 0) {
    return []
  }

  const allFindings: VerifyFinding[] = []

  for (const page of pages) {
    try {
      const prompt = buildLayoutPrompt(page)
      const result = await llm.complete('planning', prompt, LayoutFindingSchema)

      for (const f of result.findings) {
        allFindings.push({
          category: 'layout',
          severity: f.severity,
          title: f.title,
          detail: f.detail,
          evidence: `[${page.url}] ${f.evidence}`,
        })
      }
    } catch (error) {
      logger.warn({ error, url: page.url }, 'layout verify: LLM call failed for page — skipping')
    }
  }

  return allFindings
}
