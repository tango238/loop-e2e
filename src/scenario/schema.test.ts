import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ScenarioSchema,
  loadScenarios,
  saveScenario,
  toActs,
  allSteps,
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

  it('parses an optional twoFactor block and defaults its selectors', () => {
    const r = ScenarioSchema.safeParse({ ...validScenario, twoFactor: { pinCommand: 'bash get-2fa-pin.sh' } })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.twoFactor?.pinCommand).toBe('bash get-2fa-pin.sh')
      expect(r.data.twoFactor?.pinFieldSelector).toBe('input[name="pin_code"]')
      expect(r.data.twoFactor?.submitSelector).toBe('button[type="submit"]')
    }
  })

  it('rejects a twoFactor block without pinCommand', () => {
    expect(ScenarioSchema.safeParse({ ...validScenario, twoFactor: { pinFieldSelector: '#x' } }).success).toBe(false)
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

  it('annotates each loaded scenario with its scriptDir (<dir>/<file-basename>)', async () => {
    await saveScenario(dir, validScenario)
    const result = await loadScenarios(dir)
    expect(result[0]?.scriptDir).toBe(join(dir, 'sc-001'))
  })

  it('does not persist scriptDir back into the YAML', async () => {
    await saveScenario(dir, { ...validScenario, scriptDir: '/should/not/persist' } as Scenario)
    const { readFile } = await import('node:fs/promises')
    const yaml = await readFile(join(dir, 'sc-001.scenario.yaml'), 'utf8')
    expect(yaml).not.toContain('scriptDir')
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
    // loaded carries the runtime-only scriptDir; the persisted content matches the original.
    const { scriptDir: _scriptDir, ...content } = loaded!
    expect(content).toEqual(validScenario)
    expect(_scriptDir).toBe(join(dir, 'sc-001'))
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

describe('multi-act schema', () => {
  const base = {
    id: 'm', title: 'T', businessFlow: 'f',
    expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }], expectedDbState: [],
  }
  const stp = (action: string, target = '/x', extra: Record<string, unknown> = {}) =>
    ({ action, target, expectedOutcome: 'o', ...extra })

  it('accepts a flat-steps scenario (single-act sugar)', () => {
    const s = ScenarioSchema.parse({ ...base, steps: [stp('navigate')] })
    expect(toActs(s)).toEqual([{ steps: [{ action: 'navigate', target: '/x', expectedOutcome: 'o' }] }])
    expect(allSteps(s)).toHaveLength(1)
  })

  it('accepts a multi-act scenario and flattens steps', () => {
    const s = ScenarioSchema.parse({
      ...base,
      personas: [{ name: 'a', auth: 'authenticated' }, { name: 'b', auth: 'authenticated' }],
      acts: [{ persona: 'a', steps: [stp('navigate')] }, { persona: 'b', steps: [stp('assert', 'text={{X}}')] }],
    })
    expect(toActs(s)).toHaveLength(2)
    expect(allSteps(s)).toHaveLength(2)
  })

  it('rejects having both steps and acts', () => {
    expect(() => ScenarioSchema.parse({ ...base, steps: [stp('navigate')], acts: [{ steps: [stp('navigate')] }] })).toThrow(/exactly one/)
  })

  it('rejects having neither steps nor acts', () => {
    expect(() => ScenarioSchema.parse({ ...base })).toThrow(/exactly one/)
  })

  it('rejects an act referencing an unknown persona', () => {
    expect(() => ScenarioSchema.parse({ ...base, personas: [{ name: 'a', auth: 'authenticated' }], acts: [{ persona: 'ghost', steps: [stp('navigate')] }] })).toThrow(/unknown persona/)
  })

  it('rejects a capture step without var', () => {
    expect(() => ScenarioSchema.parse({ ...base, steps: [stp('capture', '#c')] })).toThrow(/capture step requires/)
  })

  it('accepts a capture step with var', () => {
    const s = ScenarioSchema.parse({ ...base, steps: [stp('capture', '#c', { var: 'CODE' })] })
    expect(allSteps(s)[0].var).toBe('CODE')
  })
})
