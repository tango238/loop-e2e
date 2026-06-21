import { describe, it, expect, vi } from 'vitest'
import { generateScenarios } from './scenarioGen.js'
import type { Llm } from './client.js'
import type { RequirementContext } from '../repo/reader.js'

const mockContext: RequirementContext = {
  repo: {
    name: 'backend',
    label: 'Backend API',
    url: 'https://github.com/acme/backend',
    role: 'backend',
    audience: 'user',
  },
  readme: '# Backend API\nHandles user authentication and data management',
  docs: ['API reference doc'],
  codeSummary: 'Express app with /api/users and /api/auth endpoints',
  gitlogSummary: 'abc123 2024-01-01 Add auth endpoint',
}

const validScenario = {
  id: 'sc-001',
  title: 'User registration flow',
  businessFlow: 'A new user registers and accesses the system',
  steps: [
    {
      action: 'navigate',
      target: '/register',
      expectedOutcome: 'Registration page displayed',
    },
    {
      action: 'fill',
      target: 'email',
      input: 'user@example.com',
      expectedOutcome: 'Email field populated',
    },
  ],
  expectedResults: [
    {
      kind: 'ui' as const,
      description: 'Success message shown',
      assertion: 'Page contains "Registration successful"',
    },
  ],
  expectedDbState: [
    {
      connection: 'main',
      table: 'users',
      match: { email: 'user@example.com' },
      expectedValues: { active: true },
    },
  ],
}

// Helper: build a mock Llm whose complete() always resolves to a scenario array.
// The overloaded Llm type requires casting via unknown.
function makeLlm(returnValue: unknown = [validScenario]): { llm: Llm; mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(async () => returnValue)
  const llm = { complete: mock } as unknown as Llm
  return { llm, mock }
}

describe('generateScenarios', () => {
  it('calls llm.complete with planning role and a schema', async () => {
    const { llm, mock } = makeLlm()

    await generateScenarios(llm, [mockContext])

    expect(mock).toHaveBeenCalledOnce()
    const callArgs = mock.mock.calls[0] as unknown[]
    const [role, prompt, schema] = callArgs
    expect(role).toBe('planning')
    expect(typeof prompt).toBe('string')
    expect((prompt as string).length).toBeGreaterThan(0)
    expect(schema).toBeDefined()
  })

  it('includes repository name and content in the prompt', async () => {
    let capturedPrompt = ''
    const mock = vi.fn(async (_role: unknown, prompt: unknown) => {
      capturedPrompt = prompt as string
      return [validScenario]
    })
    const llm = { complete: mock } as unknown as Llm

    await generateScenarios(llm, [mockContext])

    expect(capturedPrompt).toContain('backend')
    expect(capturedPrompt).toContain('Backend API')
    expect(capturedPrompt).toContain('user authentication')
  })

  it('returns zod-validated scenarios from LLM response', async () => {
    const { llm } = makeLlm()

    const result = await generateScenarios(llm, [mockContext])

    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('sc-001')
    expect(result[0]?.steps).toHaveLength(2)
    expect(result[0]?.expectedResults[0]?.kind).toBe('ui')
  })

  it('handles multiple repos in context', async () => {
    const secondCtx: RequirementContext = {
      ...mockContext,
      repo: { ...mockContext.repo, name: 'frontend', label: 'Frontend App' },
    }
    let capturedPrompt = ''
    const mock = vi.fn(async (_role: unknown, prompt: unknown) => {
      capturedPrompt = prompt as string
      return [validScenario]
    })
    const llm = { complete: mock } as unknown as Llm

    await generateScenarios(llm, [mockContext, secondCtx])

    expect(capturedPrompt).toContain('backend')
    expect(capturedPrompt).toContain('frontend')
  })

  it('returns empty array when llm returns empty array', async () => {
    const { llm } = makeLlm([])

    const result = await generateScenarios(llm, [mockContext])
    expect(result).toEqual([])
  })
})
