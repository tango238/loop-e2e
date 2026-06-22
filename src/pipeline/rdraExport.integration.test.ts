import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rdraExport } from './rdraExport.js'
import type { Scenario } from '../scenario/schema.js'

const scn = (id: string, target: string, api: string[] = []): Scenario => ({
  id,
  title: id,
  businessFlow: 'f',
  steps: [{ action: 'navigate', target, expectedOutcome: 'o' }],
  expectedResults: [
    { kind: 'ui', description: 'd', assertion: 'a' },
    ...api.map((a) => ({ kind: 'api' as const, description: 'd', assertion: a })),
  ],
  expectedDbState: [],
})

describe('rdraExport (real fs round trip)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rdra-'))
    await mkdir(join(dir, 'usecases'), { recursive: true })
    // related_pages empty (Spotly-like), related_routes are API routes → api-key match.
    await writeFile(
      join(dir, 'usecases', 'analysis_result.json'),
      JSON.stringify({
        metadata: {},
        usecases: [{ id: 'UC-1', name: 'hotel', related_pages: [], related_routes: ['GET /api/v2/hotels'] }],
        scenarios: [],
      }),
    )
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('merges matched (by API route) + writes pending + is idempotent', async () => {
    const into = join(dir, 'usecases', 'analysis_result.json')
    const deps = {
      loadScenarios: async () => [
        scn('grow-hotel', '/hotel', ['GET /api/v2/hotels returns 200']),
        scn('grow-booking', '/booking'),
      ],
    }
    const r1 = await rdraExport({ scenarioDir: '/unused', intoPath: into }, deps)
    expect(r1.matched).toBe(1)
    expect(r1.pending).toBe(1)

    const after1 = JSON.parse(await readFile(into, 'utf8'))
    const le = after1.scenarios.filter((s: { scenario_id: string }) => s.scenario_id === 'LE-grow-hotel')
    expect(le).toHaveLength(1)
    expect(le[0].usecase_id).toBe('UC-1')
    expect(le[0].api_endpoint).toBe('GET /api/v2/hotels') // single string
    expect(after1.metadata.total_scenarios).toBe(1)

    const pending = JSON.parse(await readFile(join(dir, 'usecases', 'loop-e2e-pending.json'), 'utf8'))
    expect(pending.pending[0].loop_e2e_id).toBe('grow-booking')

    // Re-run → idempotent (no duplicate LE scenario)
    const r2 = await rdraExport({ scenarioDir: '/unused', intoPath: into }, deps)
    expect(r2.replaced).toBe(1)
    const after2 = JSON.parse(await readFile(into, 'utf8'))
    expect(after2.scenarios.filter((s: { scenario_id: string }) => s.scenario_id === 'LE-grow-hotel')).toHaveLength(1)
  })
})
