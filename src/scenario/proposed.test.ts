import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  saveScenario,
  saveProposedScenario,
  loadProposedScenarios,
  loadScenarios,
  approveScenario,
  PROPOSED_SUBDIR,
  type Scenario,
} from './schema.js'

const scenario = (id: string): Scenario => ({
  id,
  title: id,
  businessFlow: 'flow',
  steps: [{ action: 'navigate', target: '/x', expectedOutcome: 'shown' }],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }],
  expectedDbState: [],
})

describe('proposed scenarios + approve', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'le2e-prop-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('saves a proposed scenario under proposed/ and loadScenarios ignores it', async () => {
    await saveProposedScenario(dir, scenario('grow-hotel'))
    const active = await loadScenarios(dir)
    expect(active.length).toBe(0) // run does not see proposed
    const proposed = await loadProposedScenarios(dir)
    expect(proposed.map((s) => s.id)).toEqual(['grow-hotel'])
    await access(join(dir, PROPOSED_SUBDIR, 'grow-hotel.scenario.yaml'))
  })

  it('approve moves a proposed scenario to active', async () => {
    await saveProposedScenario(dir, scenario('grow-hotel'))
    await approveScenario(dir, 'grow-hotel')
    const active = await loadScenarios(dir)
    expect(active.map((s) => s.id)).toEqual(['grow-hotel'])
    const proposed = await loadProposedScenarios(dir)
    expect(proposed.length).toBe(0) // moved out of proposed
  })

  it('approve refuses to overwrite an existing active scenario', async () => {
    await saveScenario(dir, scenario('grow-hotel'))
    await saveProposedScenario(dir, scenario('grow-hotel'))
    await expect(approveScenario(dir, 'grow-hotel')).rejects.toThrow(/already exists/)
    // proposed file remains
    const proposed = await loadProposedScenarios(dir)
    expect(proposed.length).toBe(1)
  })

  it('approve throws when the proposed scenario does not exist', async () => {
    await expect(approveScenario(dir, 'nope')).rejects.toThrow(/not found/)
  })
})
