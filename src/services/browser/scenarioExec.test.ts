import { describe, it, expect, vi } from 'vitest'
import { executeScenario, executeSteps } from './scenarioExec.js'
import type { PageLike } from './crawler.js'
import type { TargetEnv } from '../../domain/types.js'
import type { Scenario } from '../../scenario/schema.js'

const target: TargetEnv = {
  name: 'admin',
  baseUrl: 'https://app.test',
  auth: { strategy: 'form', loginPath: '/login' },
}

function makePage(over: Record<string, unknown> = {}): PageLike {
  let current = (over.url as string) ?? 'https://app.test/'
  const content = (over.content as string) ?? '<html><body>Hotel list</body></html>'
  const present = (over.present as string[]) ?? []
  return {
    goto: vi.fn(async (u: string) => {
      current = u
    }),
    url: () => current,
    title: vi.fn(async () => 'T'),
    content: vi.fn(async () => content),
    evaluate: vi.fn(async () => ({})),
    screenshot: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => {}),
    locator: vi.fn((sel: string) => ({
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {}),
      count: vi.fn(async () => (present.includes(sel) ? 1 : 0)),
    })),
    newPage: vi.fn(),
  } as unknown as PageLike
}

const scn = (steps: Scenario['steps']): Scenario => ({
  id: 'grow-hotel',
  title: 'hotel',
  businessFlow: 'f',
  steps,
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }],
  expectedDbState: [],
})

const sleep = async (): Promise<void> => {}

describe('executeScenario', () => {
  it('runs navigate + assert(text) and passes', async () => {
    const page = makePage({ content: '<p>Hotel list</p>' })
    const r = await executeScenario(
      page,
      target,
      scn([
        { action: 'navigate', target: '/hotel', expectedOutcome: 'loads' },
        { action: 'assert', target: 'text=Hotel list', expectedOutcome: 'shown' },
      ]),
      { sleep },
    )
    expect(r.ok).toBe(true)
    expect(page.goto).toHaveBeenCalledWith('https://app.test/hotel', expect.anything())
  })

  it('fails on an unsatisfied assert and records the step index', async () => {
    const page = makePage({ content: '<p>nope</p>' })
    const r = await executeScenario(
      page,
      target,
      scn([
        { action: 'navigate', target: '/hotel', expectedOutcome: 'loads' },
        { action: 'assert', target: 'text=Hotel list', expectedOutcome: 'shown' },
      ]),
      { sleep, navTimeoutMs: 0 },
    )
    expect(r.ok).toBe(false)
    expect(r.failedStepIndex).toBe(1)
  })

  it('resolves {{ENV}} placeholders in fill input and never leaks them', async () => {
    const page = makePage({ present: ['#email'] })
    const filled: string[] = []
    ;(page.locator as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      fill: async (v: string) => {
        filled.push(v)
      },
      click: async () => {},
      count: async () => 1,
    }))
    const r = await executeScenario(
      page,
      target,
      scn([{ action: 'fill', target: '#email', input: '{{ADMIN_USER}}', expectedOutcome: 'filled' }]),
      { sleep, vars: { ADMIN_USER: 'secret@x' }, secrets: ['secret@x'] },
    )
    expect(r.ok).toBe(true)
    expect(filled).toContain('secret@x')
    expect(r.detail).not.toContain('secret@x')
  })

  it('resolves {{TWO_FACTOR_PIN}} via pinCommand', async () => {
    const page = makePage({ present: ['#pin'] })
    let filledPin = ''
    ;(page.locator as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      fill: async (v: string) => {
        filledPin = v
      },
      click: async () => {},
      count: async () => 1,
    }))
    const pinRunner = vi.fn(async () => ({ stdout: '654321', stderr: '' }))
    const r = await executeScenario(
      page,
      target,
      scn([{ action: 'fill', target: '#pin', input: '{{TWO_FACTOR_PIN}}', expectedOutcome: 'filled' }]),
      { sleep, pinRunner, pinCommand: 'echo 654321', secrets: [] },
    )
    expect(r.ok).toBe(true)
    expect(filledPin).toBe('654321')
    expect(r.detail).not.toContain('654321')
  })

  it("uses the scenario's own twoFactor.pinCommand run in its scriptDir (cwd)", async () => {
    const page = makePage({ present: ['#pin'] })
    ;(page.locator as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      fill: async () => {}, click: async () => {}, count: async () => 1,
    }))
    const pinRunner = vi.fn(async () => ({ stdout: '222333', stderr: '' }))
    const scenario = {
      ...scn([{ action: 'fill', target: '#pin', input: '{{TWO_FACTOR_PIN}}', expectedOutcome: 'filled' }]),
      twoFactor: { pinCommand: 'bash get-2fa-pin.sh', pinFieldSelector: '#pin', submitSelector: '#s' },
      scriptDir: '/scenarios/admin-login',
    } as unknown as Parameters<typeof executeScenario>[2]
    const r = await executeScenario(page, target, scenario, { sleep, pinRunner, secrets: [] })
    expect(r.ok).toBe(true)
    expect(pinRunner).toHaveBeenCalledWith('sh', ['-c', 'bash get-2fa-pin.sh'], { cwd: '/scenarios/admin-login' })
  })

  it('fails the step when a referenced placeholder cannot be resolved', async () => {
    const page = makePage({ present: ['#email'] })
    const r = await executeScenario(
      page,
      target,
      scn([{ action: 'fill', target: '#email', input: '{{MISSING_VAR}}', expectedOutcome: 'filled' }]),
      { sleep, vars: {} },
    )
    expect(r.ok).toBe(false)
    expect(r.failedStepIndex).toBe(0)
    expect(r.detail).toContain('MISSING_VAR')
  })

  it('fails when {{TWO_FACTOR_PIN}} is referenced but no pin can be fetched', async () => {
    const page = makePage({ present: ['#pin'] })
    const r = await executeScenario(
      page,
      target,
      scn([{ action: 'fill', target: '#pin', input: '{{TWO_FACTOR_PIN}}', expectedOutcome: 'filled' }]),
      { sleep },
    )
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('TWO_FACTOR_PIN')
  })

  it('asserts element existence via locator.count', async () => {
    const page = makePage({ present: ['table'] })
    const r = await executeScenario(
      page,
      target,
      scn([{ action: 'assert', target: 'table', expectedOutcome: 'table present' }]),
      { sleep },
    )
    expect(r.ok).toBe(true)
  })
})

function fakeCapturePage(opts: { captures?: Record<string, string>; contentRef?: { html: string }; urlRef?: { u: string } } = {}) {
  const content = opts.contentRef ?? { html: '' }
  const urlRef = opts.urlRef ?? { u: 'https://app.test/start' }
  return {
    goto: async (u: string) => { urlRef.u = u },
    url: () => urlRef.u,
    title: async () => 't',
    content: async () => content.html,
    evaluate: async () => ({}),
    screenshot: async () => undefined,
    waitForLoadState: async () => {},
    locator: (sel: string) => ({
      fill: async () => {},
      click: async () => {},
      count: async () => (opts.captures && sel in opts.captures ? 1 : 0),
      textContent: async () => opts.captures?.[sel] ?? null,
      inputValue: async () => '',
    }),
  } as unknown as PageLike
}

const capTarget = { name: 'admin', baseUrl: 'https://app.test', auth: { strategy: 'form', loginPath: '/login' } } as TargetEnv

describe('executeSteps capture + {{VAR}}', () => {
  it('captures a value into the shared vars bag and resolves {{VAR}} in a later assert target', async () => {
    const content = { html: 'order discount SUMMER25 applied' }
    const page = fakeCapturePage({ captures: { '[data-code]': 'SUMMER25' }, contentRef: content })
    const vars: Record<string, string> = {}
    const r = await executeSteps(page, capTarget, [
      { action: 'capture', target: '[data-code]', var: 'COUPON', expectedOutcome: 'got code' },
      { action: 'assert', target: 'text={{COUPON}}', expectedOutcome: 'shown' },
    ], { vars })
    expect(vars.COUPON).toBe('SUMMER25')
    expect(r.ok).toBe(true)
  })

  it('fails a capture when the target is not found', async () => {
    const page = fakeCapturePage({ captures: {} })
    const r = await executeSteps(page, capTarget, [
      { action: 'capture', target: '#missing', var: 'X', expectedOutcome: 'x' },
    ], { vars: {} })
    expect(r.ok).toBe(false)
    expect(r.failedStepIndex).toBe(0)
  })

  it('does not leak a captured value into the failure detail (shows raw {{VAR}})', async () => {
    const content = { html: 'nothing here' }
    const page = fakeCapturePage({ captures: { '[data-code]': 'SECRET-CODE' }, contentRef: content })
    const r = await executeSteps(page, capTarget, [
      { action: 'capture', target: '[data-code]', var: 'COUPON', expectedOutcome: 'c' },
      { action: 'assert', target: 'text={{COUPON}}', expectedOutcome: 'shown' },
    ], { vars: {} })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('{{COUPON}}')
    expect(r.detail).not.toContain('SECRET-CODE')
  })
})
