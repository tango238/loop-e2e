import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ScenarioSchema,
  loadScenarios,
  saveScenario,
  type Scenario,
} from './schema.js'

const validScenario: Scenario = {
  id: 'sc-001',
  title: 'User login flow',
  businessFlow: 'A user authenticates and accesses the dashboard',
  steps: [
    {
      action: 'navigate',
      target: '/login',
      expectedOutcome: 'Login page is displayed',
    },
    {
      action: 'fill',
      target: 'email',
      input: 'user@example.com',
      expectedOutcome: 'Email field filled',
    },
  ],
  expectedResults: [
    {
      kind: 'ui',
      description: 'Dashboard is visible',
      assertion: 'Page title contains "Dashboard"',
    },
  ],
  expectedDbState: [
    {
      connection: 'main',
      table: 'sessions',
      match: { user_email: 'user@example.com' },
      expectedValues: { active: true },
    },
  ],
}

describe('ScenarioSchema', () => {
  it('parses a valid scenario', () => {
    const result = ScenarioSchema.safeParse(validScenario)
    expect(result.success).toBe(true)
  })

  it('rejects scenario missing id', () => {
    const bad = { ...validScenario, id: '' }
    expect(ScenarioSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects scenario with no steps', () => {
    const bad = { ...validScenario, steps: [] }
    expect(ScenarioSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects scenario with no expectedResults', () => {
    const bad = { ...validScenario, expectedResults: [] }
    expect(ScenarioSchema.safeParse(bad).success).toBe(false)
  })

  it('allows empty expectedDbState', () => {
    const ok = { ...validScenario, expectedDbState: [] }
    expect(ScenarioSchema.safeParse(ok).success).toBe(true)
  })

  it('rejects invalid expectedResult kind', () => {
    const bad = {
      ...validScenario,
      expectedResults: [{ kind: 'unknown', description: 'd', assertion: 'a' }],
    }
    expect(ScenarioSchema.safeParse(bad).success).toBe(false)
  })
})

describe('loadScenarios', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loop-e2e-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns empty array for an empty directory', async () => {
    const result = await loadScenarios(dir)
    expect(result).toEqual([])
  })

  it('returns empty array for a non-existent directory', async () => {
    const result = await loadScenarios('/tmp/does-not-exist-xyzzy')
    expect(result).toEqual([])
  })

  it('loads saved scenarios', async () => {
    await saveScenario(dir, validScenario)
    const result = await loadScenarios(dir)
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('sc-001')
  })

  it('skips files that are not *.scenario.yaml', async () => {
    await saveScenario(dir, validScenario)
    // Write a non-scenario file
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'notes.txt'), 'ignore me')
    const result = await loadScenarios(dir)
    expect(result).toHaveLength(1)
  })
})

describe('saveScenario', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'loop-e2e-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('saves and reloads a scenario round-trip', async () => {
    await saveScenario(dir, validScenario)
    const [loaded] = await loadScenarios(dir)
    expect(loaded).toEqual(validScenario)
  })

  it('creates parent directory if it does not exist', async () => {
    const nested = join(dir, 'nested', 'dir')
    await saveScenario(nested, validScenario)
    const result = await loadScenarios(nested)
    expect(result).toHaveLength(1)
  })
})

describe('ScenarioSchema.precondition', () => {
  const base = {
    id: 'grow-x',
    title: 'X',
    businessFlow: 'flow',
    steps: [{ action: 'navigate', target: '/x', expectedOutcome: 'ok' }],
    expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }],
    expectedDbState: [],
  }

  it('accepts a scenario without precondition (backward compatible)', () => {
    expect(ScenarioSchema.parse(base).precondition).toBeUndefined()
  })

  it('accepts authenticated / unauthenticated', () => {
    expect(ScenarioSchema.parse({ ...base, precondition: { auth: 'authenticated' } }).precondition?.auth).toBe(
      'authenticated',
    )
    expect(ScenarioSchema.parse({ ...base, precondition: { auth: 'unauthenticated' } }).precondition?.auth).toBe(
      'unauthenticated',
    )
  })

  it('rejects an invalid auth value', () => {
    expect(ScenarioSchema.safeParse({ ...base, precondition: { auth: 'maybe' } }).success).toBe(false)
  })
})
