import { describe, it, expect, vi } from 'vitest'
import { summarizeIfOverBudget } from './summarize.js'
import type { Llm } from '../llm/client.js'
import type { SelectedFile } from './select.js'

function makeFile(relPath: string, content: string): SelectedFile {
  return {
    path: `/repo/${relPath}`,
    relPath,
    content,
    tokens: Math.ceil(content.length / 4),
  }
}

function makeMockLlm(responseText = 'Summarized content'): { llm: Llm; callCount: () => number } {
  let count = 0
  const llm: Llm = {
    complete: vi.fn(async () => {
      count++
      return responseText
    }) as Llm['complete'],
  }
  return { llm, callCount: () => count }
}

describe('summarizeIfOverBudget', () => {
  it('concatenates raw content when under budget', async () => {
    const files = [
      makeFile('README.md', '# Hello'),
      makeFile('src/index.ts', 'export const x = 1'),
    ]
    const { llm, callCount } = makeMockLlm()
    const budget = 1_000_000  // very large budget

    const result = await summarizeIfOverBudget(llm, files, budget)

    expect(callCount()).toBe(0)  // no LLM calls
    expect(result).toContain('README.md')
    expect(result).toContain('# Hello')
    expect(result).toContain('src/index.ts')
  })

  it('calls LLM for each file when over budget', async () => {
    const longContent = 'x'.repeat(10000)  // ~2750 tokens each
    const files = [
      makeFile('src/a.ts', longContent),
      makeFile('src/b.ts', longContent),
    ]
    const { llm, callCount } = makeMockLlm('Concise summary')
    const budget = 100  // way under the combined size

    const result = await summarizeIfOverBudget(llm, files, budget)

    expect(callCount()).toBe(2)  // one call per file
    expect(result).toContain('Concise summary')
  })

  it('marks summarized files with "(summarized)" label', async () => {
    const files = [makeFile('src/big.ts', 'x'.repeat(10000))]
    const { llm } = makeMockLlm('Summary text')
    const budget = 10

    const result = await summarizeIfOverBudget(llm, files, budget)
    expect(result).toContain('(summarized)')
  })

  it('returns empty string for empty files array', async () => {
    const { llm } = makeMockLlm()
    const result = await summarizeIfOverBudget(llm, [], 1000)
    expect(result).toBe('')
  })
})
