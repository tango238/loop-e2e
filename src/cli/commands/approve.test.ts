import { describe, it, expect, vi } from 'vitest'
import { runApprove, type RunApproveDeps } from './approve.js'
import type { Config } from '../../config/schema.js'
import type { Scenario } from '../../scenario/schema.js'

const config = { scenarioDir: 'scenarios' } as unknown as Config
const scenario = (id: string): Scenario => ({
  id, title: id, businessFlow: 'f',
  steps: [{ action: 'navigate', target: '/x', expectedOutcome: 'o' }],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }], expectedDbState: [],
})

function makeDeps(proposed: Scenario[], over: Partial<RunApproveDeps> = {}): RunApproveDeps {
  return {
    loadConfig: vi.fn(async () => ({ config, secrets: {} as never })),
    loadProposedScenarios: vi.fn(async () => proposed),
    approveScenario: vi.fn(async () => {}),
    ...over,
  }
}

describe('runApprove', () => {
  it('approves all proposed scenarios with --all', async () => {
    const deps = makeDeps([scenario('grow-a'), scenario('grow-b')])
    const res = await runApprove('/base', { all: true }, deps)
    expect(res.approved).toEqual(['grow-a', 'grow-b'])
    expect(deps.approveScenario).toHaveBeenCalledWith('/base/scenarios', 'grow-a')
    expect(deps.approveScenario).toHaveBeenCalledWith('/base/scenarios', 'grow-b')
  })

  it('approves only the given ids', async () => {
    const deps = makeDeps([scenario('grow-a'), scenario('grow-b')])
    const res = await runApprove('/base', { ids: ['grow-b'] }, deps)
    expect(res.approved).toEqual(['grow-b'])
    expect(deps.approveScenario).toHaveBeenCalledTimes(1)
  })

  it('records a skip with reason when an approval throws', async () => {
    const deps = makeDeps([scenario('grow-a')], {
      approveScenario: vi.fn(async () => { throw new Error('active scenario already exists: grow-a') }),
    })
    const res = await runApprove('/base', { all: true }, deps)
    expect(res.approved).toEqual([])
    expect(res.skipped).toEqual([{ id: 'grow-a', reason: 'active scenario already exists: grow-a' }])
  })

  it('does nothing when there is nothing to approve', async () => {
    const deps = makeDeps([])
    const res = await runApprove('/base', { all: true }, deps)
    expect(res).toEqual({ approved: [], skipped: [] })
    expect(deps.approveScenario).not.toHaveBeenCalled()
  })
})
