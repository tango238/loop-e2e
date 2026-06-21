import { logger } from '../../util/logger.js'
import { estimateTokens, type SelectedFile } from './select.js'
import type { Llm } from '../llm/client.js'

/**
 * If the combined token count of `files` exceeds `budget`, use the LLM
 * (planning/Opus role) to summarize each file and concatenate the summaries
 * (map-reduce).  Otherwise, concatenate the raw file contents.
 *
 * Map step: summarize each file individually with a concise technical prompt.
 * Reduce step: concatenate all summaries into a single string.
 *
 * This keeps total cost proportional to the number of files, not their size,
 * while still giving the downstream scenario generator the gist of each.
 */
export async function summarizeIfOverBudget(
  llm: Llm,
  files: SelectedFile[],
  budget: number,
): Promise<string> {
  const combined = files.map((f) => `// ${f.relPath}\n${f.content}`).join('\n\n---\n\n')
  const totalTokens = estimateTokens(combined)

  if (totalTokens <= budget) {
    logger.debug({ totalTokens, budget }, 'Under token budget — using raw content')
    return combined
  }

  logger.info({ totalTokens, budget, files: files.length }, 'Over budget — running map-reduce summarization')

  // Map: summarize each file individually
  const summaries = await Promise.all(
    files.map(async (file) => {
      const prompt = buildSummaryPrompt(file)
      const summary = await llm.complete('planning', prompt)
      return `// ${file.relPath} (summarized)\n${summary}`
    }),
  )

  return summaries.join('\n\n---\n\n')
}

function buildSummaryPrompt(file: SelectedFile): string {
  return `Summarize the following source file concisely for a technical audience.
Focus on: purpose, key exports/functions/classes, database models or API endpoints,
business-logic concepts, and notable constraints. Omit boilerplate and imports.
Keep the summary under 300 words.

File: ${file.relPath}

\`\`\`
${file.content}
\`\`\``
}
