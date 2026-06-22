# Scenario Execution Engine (auth precondition) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute adopted scenarios' steps against the live app during `run`, logging in first (2FA) when an `authenticated` scenario finds no session, and surface pass/fail as report findings.

**Architecture:** A deterministic step executor (`executeScenario`) runs `navigate/click/fill/submit/wait/assert` via the injectable `PageLike`. A session helper (`ensureAuthenticated`/`ensureUnauthenticated`) applies each scenario's `precondition.auth` against one reused browser context. An orchestrator (`executeScenarios`) drives all active scenarios and maps results to `VerifyFinding(category:'scenario')`, joining the existing report → Opus refutation gate → Issue path. Integrated as a new `run` stage behind `--skip-scenarios`.

**Tech Stack:** TypeScript strict, ESM, Node 20+, pnpm, vitest, zod, Playwright (via injected `PageLike`).

## Global Constraints

- TypeScript strict + ESM; every task MUST pass `pnpm build` (tsc), `pnpm test`, `pnpm lint` before commit. (vitest/esbuild does NOT type-check — run `pnpm build` per task.)
- All external I/O (page, pinRunner, sleep) injected via deps; unit tests use fakes — no real network/browser.
- Credentials, PINs, tokens MUST NOT appear in any `detail`/`evidence`/log — mask with `maskSecrets(text, secrets[])`.
- `precondition` absent ⇒ NO auth handling (backward compatible with existing scenarios).
- Session model: authenticate ONCE, reuse; re-authenticate only when a protected page redirects to `loginPath`.
- Existing suite (382 pass + 3 skip) MUST stay green.
- Do not start on `main`; work on branch `feat/scenario-exec-engine` (already created).

---

### Task 1: `precondition` schema field

**Files:**
- Modify: `src/scenario/schema.ts` (add `PreconditionSchema`, `ScenarioSchema.precondition`)
- Test: `src/scenario/schema.test.ts` (add cases; create if absent)

**Interfaces:**
- Produces: `ScenarioSchema` gains optional `precondition?: { auth: 'authenticated' | 'unauthenticated' }`; exported type `Precondition = z.infer<...>`. `Scenario` type now carries optional `precondition`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/scenario/schema.test.ts (add)
import { describe, it, expect } from 'vitest'
import { ScenarioSchema } from './schema.js'

const base = {
  id: 'grow-x', title: 'X', businessFlow: 'flow',
  steps: [{ action: 'navigate', target: '/x', expectedOutcome: 'ok' }],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }],
  expectedDbState: [],
}

describe('ScenarioSchema.precondition', () => {
  it('accepts a scenario without precondition (backward compatible)', () => {
    expect(ScenarioSchema.parse(base).precondition).toBeUndefined()
  })
  it('accepts authenticated / unauthenticated', () => {
    expect(ScenarioSchema.parse({ ...base, precondition: { auth: 'authenticated' } }).precondition?.auth).toBe('authenticated')
    expect(ScenarioSchema.parse({ ...base, precondition: { auth: 'unauthenticated' } }).precondition?.auth).toBe('unauthenticated')
  })
  it('rejects an invalid auth value', () => {
    expect(ScenarioSchema.safeParse({ ...base, precondition: { auth: 'maybe' } }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/scenario/schema.test.ts`
Expected: FAIL (precondition not in schema / invalid value accepted).

- [ ] **Step 3: Implement minimal schema**

```typescript
// src/scenario/schema.ts — add before ScenarioSchema
export const PreconditionSchema = z.object({
  auth: z.enum(['authenticated', 'unauthenticated']),
})
export type Precondition = z.infer<typeof PreconditionSchema>
```
Add the field inside `ScenarioSchema = z.object({ ... })`:
```typescript
  expectedDbState: z.array(ExpectedDbStateSchema),
  precondition: PreconditionSchema.optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/scenario/schema.test.ts` → PASS

- [ ] **Step 5: Build + lint + commit**

```bash
pnpm build && pnpm lint
git add src/scenario/schema.ts src/scenario/schema.test.ts
git commit -m "feat(scenario): add optional precondition.auth field"
```

---

### Task 2: `executeScenario` step executor

**Files:**
- Create: `src/services/browser/scenarioExec.ts`
- Test: `src/services/browser/scenarioExec.test.ts`
- Modify: `src/services/browser/crawler.ts` (add optional `count` to `PageLike.locator` return)

**Interfaces:**
- Consumes: `PageLike` (from `crawler.js`), `Scenario`/`ScenarioStep` (from `scenario/schema.js`), `TargetEnv` (from `domain/types.js`), `ComposeRunner` (from `compose/compose.js`), `maskSecrets`.
- Produces:
  - `ScenarioRunResult = { scenarioId: string; ok: boolean; failedStepIndex?: number; detail: string; finalUrl: string }`
  - `ScenarioExecDeps = { pinRunner?: ComposeRunner; vars?: Record<string,string>; pinCommand?: string; secrets?: string[]; navTimeoutMs?: number; sleep?: (ms:number)=>Promise<void> }`
  - `executeScenario(page: PageLike, target: TargetEnv, scenario: Scenario, deps?: ScenarioExecDeps): Promise<ScenarioRunResult>`

**Step semantics (deterministic):**
- `navigate`: `page.goto(resolveUrl(target.baseUrl, step.target))` + `waitForLoadState('networkidle')`. Fail if goto throws.
- `click`: `page.locator(step.target).click()`. Fail on throw.
- `fill`: `page.locator(step.target).fill(resolveInput(step.input, deps))`. Fail on throw.
- `submit`: `page.locator(step.target).click()` then poll until URL changes from the pre-click URL (reuse sleep/navTimeoutMs). Fail on throw.
- `wait`: `text=X` → poll `page.content()` includes `X`; bare integer → `sleep(n)`; else selector → poll `locator(sel).count() > 0`. Fail on timeout.
- `assert`: `text=X` → `page.content()` includes `X`; `url=Y` → `page.url()` includes `Y`; else selector → `locator(sel).count() > 0`. Fail if condition false.

First failing step ⇒ stop, return `{ ok:false, failedStepIndex:i, detail: masked }`.

- [ ] **Step 1: Add `count` to PageLike.locator**

In `src/services/browser/crawler.ts`, change the `locator` return type:
```typescript
  locator: (selector: string) => {
    fill: (value: string) => Promise<void>
    click: () => Promise<void>
    count?: () => Promise<number>
  }
```
(Real Playwright locators already provide `count()`; this only types it.)

- [ ] **Step 2: Write the failing test**

```typescript
// src/services/browser/scenarioExec.test.ts
import { describe, it, expect, vi } from 'vitest'
import { executeScenario } from './scenarioExec.js'
import type { PageLike } from './crawler.js'
import type { TargetEnv } from '../../domain/types.js'
import type { Scenario } from '../../scenario/schema.js'

const target: TargetEnv = { name: 'admin', baseUrl: 'https://app.test', auth: { strategy: 'form', loginPath: '/login' } }

function makePage(over: Partial<Record<string, any>> = {}): PageLike {
  let current = over.url ?? 'https://app.test/'
  const content = over.content ?? '<html><body>Hotel list</body></html>'
  return {
    goto: vi.fn(async (u: string) => { current = u }),
    url: () => current,
    title: vi.fn(async () => 'T'),
    content: vi.fn(async () => content),
    evaluate: vi.fn(async () => ({})),
    screenshot: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => {}),
    locator: vi.fn((sel: string) => ({
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {}),
      count: vi.fn(async () => (over.present?.includes(sel) ? 1 : 0)),
    })),
    newPage: vi.fn(),
  } as unknown as PageLike
}

const scn = (steps: any[]): Scenario => ({
  id: 'grow-hotel', title: 'hotel', businessFlow: 'f', steps,
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }], expectedDbState: [],
})

describe('executeScenario', () => {
  const sleep = async () => {}

  it('runs navigate + assert(text) and passes', async () => {
    const page = makePage({ content: '<p>Hotel list</p>' })
    const r = await executeScenario(page, target, scn([
      { action: 'navigate', target: '/hotel', expectedOutcome: 'loads' },
      { action: 'assert', target: 'text=Hotel list', expectedOutcome: 'shown' },
    ]), { sleep })
    expect(r.ok).toBe(true)
    expect(page.goto).toHaveBeenCalledWith('https://app.test/hotel', expect.anything())
  })

  it('fails on an unsatisfied assert and records the step index', async () => {
    const page = makePage({ content: '<p>nope</p>' })
    const r = await executeScenario(page, target, scn([
      { action: 'navigate', target: '/hotel', expectedOutcome: 'loads' },
      { action: 'assert', target: 'text=Hotel list', expectedOutcome: 'shown' },
    ]), { sleep, navTimeoutMs: 0 })
    expect(r.ok).toBe(false)
    expect(r.failedStepIndex).toBe(1)
  })

  it('resolves {{ENV}} placeholders in fill input and never leaks them', async () => {
    const page = makePage({ present: ['#email'] })
    const filled: string[] = []
    ;(page.locator as any).mockImplementation(() => ({ fill: async (v: string) => { filled.push(v) }, click: async () => {}, count: async () => 1 }))
    const r = await executeScenario(page, target, scn([
      { action: 'fill', target: '#email', input: '{{ADMIN_USER}}', expectedOutcome: 'filled' },
    ]), { sleep, vars: { ADMIN_USER: 'secret@x' }, secrets: ['secret@x'] })
    expect(r.ok).toBe(true)
    expect(filled).toContain('secret@x')
    expect(r.detail).not.toContain('secret@x')
  })

  it('resolves {{TWO_FACTOR_PIN}} via pinCommand', async () => {
    const page = makePage({ present: ['#pin'] })
    let filledPin = ''
    ;(page.locator as any).mockImplementation(() => ({ fill: async (v: string) => { filledPin = v }, click: async () => {}, count: async () => 1 }))
    const pinRunner = vi.fn(async () => ({ stdout: '654321', stderr: '' }))
    const r = await executeScenario(page, target, scn([
      { action: 'fill', target: '#pin', input: '{{TWO_FACTOR_PIN}}', expectedOutcome: 'filled' },
    ]), { sleep, pinRunner, pinCommand: 'echo 654321', secrets: [] })
    expect(r.ok).toBe(true)
    expect(filledPin).toBe('654321')
    expect(r.detail).not.toContain('654321')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/services/browser/scenarioExec.test.ts`
Expected: FAIL ("executeScenario is not a function").

- [ ] **Step 4: Implement `executeScenario`**

```typescript
// src/services/browser/scenarioExec.ts
import { logger } from '../../util/logger.js'
import { maskSecrets } from '../../util/mask.js'
import type { PageLike } from './crawler.js'
import type { TargetEnv } from '../../domain/types.js'
import type { Scenario, ScenarioStep } from '../../scenario/schema.js'
import type { ComposeRunner } from '../compose/compose.js'

export type ScenarioRunResult = {
  scenarioId: string
  ok: boolean
  failedStepIndex?: number
  detail: string
  finalUrl: string
}

export type ScenarioExecDeps = {
  pinRunner?: ComposeRunner
  /** {{ENVNAME}} resolution source */
  vars?: Record<string, string>
  /** command run to resolve {{TWO_FACTOR_PIN}} */
  pinCommand?: string
  /** values to mask out of detail/logs */
  secrets?: string[]
  /** max ms for wait/submit polling (default 8000) */
  navTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function resolveUrl(baseUrl: string, target: string): string {
  if (/^https?:\/\//i.test(target)) return target
  return `${baseUrl.replace(/\/$/, '')}/${target.replace(/^\//, '')}`
}

async function resolveInput(raw: string | undefined, deps: ScenarioExecDeps): Promise<string> {
  if (!raw) return ''
  let out = raw
  // {{TWO_FACTOR_PIN}} → run pinCommand, take first 4-8 digit run
  if (out.includes('{{TWO_FACTOR_PIN}}')) {
    let pin = ''
    if (deps.pinRunner && deps.pinCommand) {
      const { stdout } = await deps.pinRunner('sh', ['-c', deps.pinCommand])
      pin = (stdout.match(/\d{4,8}/) ?? [''])[0]
    }
    out = out.replaceAll('{{TWO_FACTOR_PIN}}', pin)
  }
  // {{ENVNAME}} → vars then process.env
  out = out.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, name: string) => deps.vars?.[name] ?? process.env[name] ?? '')
  return out
}

export async function executeScenario(
  page: PageLike,
  target: TargetEnv,
  scenario: Scenario,
  deps: ScenarioExecDeps = {},
): Promise<ScenarioRunResult> {
  const baseUrl = target.baseUrl
  const secrets = deps.secrets ?? []
  const navTimeoutMs = deps.navTimeoutMs ?? 8000
  const sleep = deps.sleep ?? defaultSleep
  const intervalMs = 250
  const attempts = Math.max(1, Math.ceil(navTimeoutMs / intervalMs))
  const mask = (s: string): string => maskSecrets(s, secrets)

  const fail = (i: number, why: string): ScenarioRunResult => ({
    scenarioId: scenario.id, ok: false, failedStepIndex: i,
    detail: mask(`step ${i} (${scenario.steps[i]?.action}) failed: ${why}`), finalUrl: page.url(),
  })

  for (let i = 0; i < scenario.steps.length; i++) {
    const step: ScenarioStep = scenario.steps[i]
    try {
      switch (step.action) {
        case 'navigate': {
          await page.goto(resolveUrl(baseUrl, step.target), { waitUntil: 'domcontentloaded', timeout: 30_000 })
          await page.waitForLoadState('networkidle')
          break
        }
        case 'click': {
          await page.locator(step.target).click()
          break
        }
        case 'fill': {
          await page.locator(step.target).fill(await resolveInput(step.input, deps))
          break
        }
        case 'submit': {
          const before = page.url()
          await page.locator(step.target).click()
          await page.waitForLoadState('networkidle')
          for (let a = 0; a < attempts; a++) { if (page.url() !== before) break; await sleep(intervalMs) }
          break
        }
        case 'wait': {
          const ok = await pollCondition(page, step.target, attempts, intervalMs, sleep)
          if (!ok) return fail(i, `wait condition not met: ${step.target}`)
          break
        }
        case 'assert': {
          const ok = await checkCondition(page, step.target)
          if (!ok) return fail(i, `assertion not satisfied: ${step.target}`)
          break
        }
        default:
          return fail(i, `unsupported action: ${step.action}`)
      }
    } catch (err) {
      return fail(i, err instanceof Error ? err.message : String(err))
    }
  }
  logger.info({ scenario: scenario.id, finalUrl: page.url() }, 'scenario passed')
  return { scenarioId: scenario.id, ok: true, detail: `passed (${scenario.steps.length} steps)`, finalUrl: page.url() }
}

async function checkCondition(page: PageLike, target: string): Promise<boolean> {
  if (target.startsWith('text=')) return (await page.content()).includes(target.slice(5))
  if (target.startsWith('url=')) return page.url().includes(target.slice(4))
  const loc = page.locator(target)
  return loc.count ? (await loc.count()) > 0 : (await page.content()).includes(target)
}

async function pollCondition(
  page: PageLike, target: string, attempts: number, intervalMs: number, sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const ms = Number(target)
  if (Number.isFinite(ms) && String(ms) === target.trim()) { await sleep(ms); return true }
  for (let a = 0; a < attempts; a++) { if (await checkCondition(page, target)) return true; await sleep(intervalMs) }
  return false
}
```

- [ ] **Step 5: Run tests + build + lint**

Run: `pnpm vitest run src/services/browser/scenarioExec.test.ts` → PASS
Run: `pnpm build && pnpm lint` → PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/browser/scenarioExec.ts src/services/browser/scenarioExec.test.ts src/services/browser/crawler.ts
git commit -m "feat(scenario): deterministic executeScenario step engine"
```

---

### Task 3: Session control (`ensureAuthenticated` / `ensureUnauthenticated`)

**Files:**
- Create: `src/services/browser/session.ts`
- Test: `src/services/browser/session.test.ts`

**Interfaces:**
- Consumes: `PageLike`, `TargetEnv`, `authenticate` (from `login.js`), `LoginDeps`.
- Produces:
  - `SessionDeps = { authenticate?: typeof authenticate; clearCookies?: (page: PageLike) => Promise<void> } & LoginDeps`
  - `ensureAuthenticated(page, target, creds, probePath, deps?): Promise<{ ok: boolean; detail: string }>` — navigate to `probePath`; if redirected to `loginPath`, call `authenticate`; if already authed, no-op `ok:true`.
  - `ensureUnauthenticated(page, target, deps?): Promise<void>` — `clearCookies(page)` if provided.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/browser/session.test.ts
import { describe, it, expect, vi } from 'vitest'
import { ensureAuthenticated, ensureUnauthenticated } from './session.js'
import type { PageLike } from './crawler.js'
import type { TargetEnv } from '../../domain/types.js'

const target: TargetEnv = { name: 'admin', baseUrl: 'https://app.test', auth: { strategy: 'form', loginPath: '/login', username: 'u', password: 'p' } }
const creds = { username: 'u', password: 'p' }

function makePage(url: string): PageLike {
  let current = url
  return {
    goto: vi.fn(async (u: string) => { current = u }),
    url: () => current, title: vi.fn(async () => 'T'), content: vi.fn(async () => ''),
    evaluate: vi.fn(async () => ({})), screenshot: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => {}), locator: vi.fn(() => ({ fill: vi.fn(), click: vi.fn() })), newPage: vi.fn(),
  } as unknown as PageLike
}

describe('ensureAuthenticated', () => {
  it('skips login when the protected page does not redirect to login', async () => {
    const page = makePage('https://app.test/dashboard')
    const authenticate = vi.fn()
    const r = await ensureAuthenticated(page, target, creds, '/dashboard', { authenticate })
    expect(authenticate).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
  })

  it('logs in when the protected page redirects to loginPath', async () => {
    const page = makePage('https://app.test/dashboard')
    ;(page.goto as any).mockImplementation(async () => { (page.url as any) = () => 'https://app.test/login' })
    const authenticate = vi.fn(async () => ({ ok: true, detail: 'ok', finalUrl: 'https://app.test/' }))
    const r = await ensureAuthenticated(page, target, creds, '/dashboard', { authenticate })
    expect(authenticate).toHaveBeenCalledOnce()
    expect(r.ok).toBe(true)
  })

  it('returns ok:false when login fails', async () => {
    const page = makePage('https://app.test/login')
    const authenticate = vi.fn(async () => ({ ok: false, detail: 'bad', finalUrl: 'https://app.test/login' }))
    const r = await ensureAuthenticated(page, target, creds, '/dashboard', { authenticate })
    expect(r.ok).toBe(false)
  })
})

describe('ensureUnauthenticated', () => {
  it('clears cookies when a clearer is provided', async () => {
    const page = makePage('https://app.test/')
    const clearCookies = vi.fn(async () => {})
    await ensureUnauthenticated(page, target, { clearCookies })
    expect(clearCookies).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/services/browser/session.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `session.ts`**

```typescript
// src/services/browser/session.ts
import { authenticate as defaultAuthenticate } from './login.js'
import type { LoginDeps, LoginResult } from './login.js'
import type { PageLike } from './crawler.js'
import type { TargetEnv } from '../../domain/types.js'

export type SessionDeps = LoginDeps & {
  authenticate?: (page: PageLike, target: TargetEnv, creds: { username: string; password: string }, deps?: LoginDeps) => Promise<LoginResult>
  clearCookies?: (page: PageLike) => Promise<void>
}

function urlIsLoginPath(url: string, loginPath: string): boolean {
  try { const p = new URL(url).pathname; return p === loginPath || p.startsWith(loginPath + '/') }
  catch { return url.includes(loginPath) }
}

/** Ensure the page has an authenticated session; log in if the protected page redirects to login. */
export async function ensureAuthenticated(
  page: PageLike, target: TargetEnv, creds: { username: string; password: string },
  probePath: string, deps: SessionDeps = {},
): Promise<{ ok: boolean; detail: string }> {
  const loginPath = target.auth?.loginPath ?? '/login'
  const base = target.baseUrl.replace(/\/$/, '')
  const probe = /^https?:\/\//i.test(probePath) ? probePath : `${base}/${probePath.replace(/^\//, '')}`
  await page.goto(probe, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForLoadState('networkidle')
  if (!urlIsLoginPath(page.url(), loginPath)) return { ok: true, detail: 'session reused' }
  const auth = deps.authenticate ?? defaultAuthenticate
  const res = await auth(page, target, creds, deps)
  return { ok: res.ok, detail: res.detail }
}

/** Put the page in a logged-out state before running an unauthenticated scenario. */
export async function ensureUnauthenticated(page: PageLike, _target: TargetEnv, deps: SessionDeps = {}): Promise<void> {
  if (deps.clearCookies) await deps.clearCookies(page)
}
```

- [ ] **Step 4: Run tests + build + lint** → PASS (`pnpm vitest run src/services/browser/session.test.ts`, `pnpm build && pnpm lint`)

- [ ] **Step 5: Commit**

```bash
git add src/services/browser/session.ts src/services/browser/session.test.ts
git commit -m "feat(scenario): session control (ensureAuthenticated/ensureUnauthenticated)"
```

---

### Task 4: Orchestration `executeScenarios` → `VerifyFinding[]`

**Files:**
- Create: `src/pipeline/executeScenarios.ts`
- Test: `src/pipeline/executeScenarios.test.ts`
- Modify: `src/domain/types.ts` (`VerifyFinding.category` add `'scenario'`)

**Interfaces:**
- Consumes: `executeScenario`/`ScenarioExecDeps`/`ScenarioRunResult`, `ensureAuthenticated`/`ensureUnauthenticated`/`SessionDeps`, `Scenario`, `TargetEnv`, `PageLike`, `VerifyFinding`.
- Produces:
  - `ExecuteScenariosDeps = ScenarioExecDeps & SessionDeps & { executeScenario?: typeof executeScenario; ensureAuthenticated?: typeof ensureAuthenticated; ensureUnauthenticated?: typeof ensureUnauthenticated }`
  - `executeScenarios(page: PageLike, target: TargetEnv, scenarios: Scenario[], creds: {username:string;password:string}, deps?: ExecuteScenariosDeps): Promise<VerifyFinding[]>`

**Behavior:** For each scenario in order — apply precondition (authenticated → ensureAuthenticated with the scenario's first navigate target as probe, default `/`; unauthenticated → ensureUnauthenticated; absent → nothing). If `ensureAuthenticated` fails, emit ONE high finding and skip remaining authenticated scenarios. Run `executeScenario`; map to `VerifyFinding(category:'scenario')` (fail → high; pass → low). For a passed scenario whose `expectedResults` include kind `api`/`db` (not deterministically checked), append a note to `detail` so the existing report Opus gate can judge them.

- [ ] **Step 1: Add `'scenario'` to VerifyFinding.category** in `src/domain/types.ts`:
```typescript
  category: 'layout' | 'security' | 'conditional' | 'registered-data' | 'error-handling' | 'login' | 'scenario'
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/pipeline/executeScenarios.test.ts
import { describe, it, expect, vi } from 'vitest'
import { executeScenarios } from './executeScenarios.js'
import type { Scenario } from '../scenario/schema.js'
import type { TargetEnv } from '../domain/types.js'

const target: TargetEnv = { name: 'admin', baseUrl: 'https://app.test', auth: { strategy: 'form', loginPath: '/login' } }
const creds = { username: 'u', password: 'p' }
const page = {} as any
const scn = (id: string, pre?: 'authenticated' | 'unauthenticated', results: any[] = [{ kind: 'ui', description: 'd', assertion: 'a' }]): Scenario => ({
  id, title: id, businessFlow: 'f',
  steps: [{ action: 'navigate', target: '/x', expectedOutcome: 'ok' }],
  expectedResults: results, expectedDbState: [],
  ...(pre ? { precondition: { auth: pre } } : {}),
})

describe('executeScenarios', () => {
  it('runs ensureAuthenticated once and reuses for later authenticated scenarios', async () => {
    const ensureAuthenticated = vi.fn(async () => ({ ok: true, detail: 'ok' }))
    const ensureUnauthenticated = vi.fn(async () => {})
    const executeScenario = vi.fn(async (_p, _t, s) => ({ scenarioId: s.id, ok: true, detail: 'passed', finalUrl: 'https://app.test/x' }))
    const findings = await executeScenarios(page, target, [scn('a', 'authenticated'), scn('b', 'authenticated')], creds, { ensureAuthenticated, ensureUnauthenticated, executeScenario })
    expect(ensureAuthenticated).toHaveBeenCalledTimes(2) // probes each, but session reused inside
    expect(executeScenario).toHaveBeenCalledTimes(2)
    expect(findings.every((f) => f.category === 'scenario')).toBe(true)
    expect(findings.every((f) => f.severity === 'low')).toBe(true)
  })

  it('maps a failed scenario to a high finding', async () => {
    const executeScenario = vi.fn(async (_p, _t, s) => ({ scenarioId: s.id, ok: false, failedStepIndex: 0, detail: 'boom', finalUrl: 'https://app.test/x' }))
    const findings = await executeScenarios(page, target, [scn('a')], creds, { executeScenario })
    expect(findings[0].severity).toBe('high')
    expect(findings[0].detail).toContain('boom')
  })

  it('skips remaining authenticated scenarios when login fails (one finding)', async () => {
    const ensureAuthenticated = vi.fn(async () => ({ ok: false, detail: 'login failed' }))
    const executeScenario = vi.fn()
    const findings = await executeScenarios(page, target, [scn('a', 'authenticated'), scn('b', 'authenticated')], creds, { ensureAuthenticated, executeScenario })
    expect(executeScenario).not.toHaveBeenCalled()
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('high')
  })

  it('does not auth when precondition is absent', async () => {
    const ensureAuthenticated = vi.fn()
    const ensureUnauthenticated = vi.fn()
    const executeScenario = vi.fn(async (_p, _t, s) => ({ scenarioId: s.id, ok: true, detail: 'passed', finalUrl: 'u' }))
    await executeScenarios(page, target, [scn('a')], creds, { ensureAuthenticated, ensureUnauthenticated, executeScenario })
    expect(ensureAuthenticated).not.toHaveBeenCalled()
    expect(ensureUnauthenticated).not.toHaveBeenCalled()
  })

  it('notes unverified api/db expectedResults in a passed finding detail', async () => {
    const executeScenario = vi.fn(async (_p, _t, s) => ({ scenarioId: s.id, ok: true, detail: 'passed', finalUrl: 'u' }))
    const findings = await executeScenarios(page, target, [scn('a', undefined, [{ kind: 'api', description: 'GET ok', assertion: '200' }])], creds, { executeScenario })
    expect(findings[0].detail.toLowerCase()).toContain('expectedresults')
  })
})
```

- [ ] **Step 3: Run test to verify it fails** → FAIL (module not found).

- [ ] **Step 4: Implement `executeScenarios.ts`**

```typescript
// src/pipeline/executeScenarios.ts
import { logger } from '../util/logger.js'
import { executeScenario as defaultExecuteScenario } from '../services/browser/scenarioExec.js'
import type { ScenarioExecDeps } from '../services/browser/scenarioExec.js'
import { ensureAuthenticated as defaultEnsureAuth, ensureUnauthenticated as defaultEnsureUnauth } from '../services/browser/session.js'
import type { SessionDeps } from '../services/browser/session.js'
import type { PageLike } from '../services/browser/crawler.js'
import type { Scenario } from '../scenario/schema.js'
import type { TargetEnv, VerifyFinding } from '../domain/types.js'

export type ExecuteScenariosDeps = ScenarioExecDeps & SessionDeps & {
  executeScenario?: typeof defaultExecuteScenario
  ensureAuthenticated?: typeof defaultEnsureAuth
  ensureUnauthenticated?: typeof defaultEnsureUnauth
}

function firstNavigateTarget(s: Scenario): string {
  const nav = s.steps.find((st) => st.action === 'navigate')
  return nav?.target ?? '/'
}

export async function executeScenarios(
  page: PageLike, target: TargetEnv, scenarios: Scenario[],
  creds: { username: string; password: string }, deps: ExecuteScenariosDeps = {},
): Promise<VerifyFinding[]> {
  const exec = deps.executeScenario ?? defaultExecuteScenario
  const ensureAuth = deps.ensureAuthenticated ?? defaultEnsureAuth
  const ensureUnauth = deps.ensureUnauthenticated ?? defaultEnsureUnauth
  const findings: VerifyFinding[] = []
  let authBlocked = false

  for (const scenario of scenarios) {
    const auth = scenario.precondition?.auth
    if (auth === 'authenticated') {
      if (authBlocked) continue
      const r = await ensureAuth(page, target, creds, firstNavigateTarget(scenario), deps)
      if (!r.ok) {
        authBlocked = true
        findings.push({ category: 'scenario', severity: 'high', title: 'authentication failed', detail: `could not establish a session for authenticated scenarios: ${r.detail}`, evidence: scenario.id })
        continue
      }
    } else if (auth === 'unauthenticated') {
      await ensureUnauth(page, target, deps)
    }

    const result = await exec(page, target, scenario, deps)
    const unverified = scenario.expectedResults.filter((e) => e.kind === 'api' || e.kind === 'db')
    let detail = result.detail
    if (result.ok && unverified.length > 0) {
      detail += ` | unverified expectedResults (needs LLM/manual): ${unverified.map((e) => `${e.kind}:${e.assertion}`).join('; ')}`
    }
    findings.push({
      category: 'scenario', severity: result.ok ? 'low' : 'high',
      title: scenario.title, detail, evidence: `${scenario.id} @ ${result.finalUrl}`,
    })
    logger.info({ scenario: scenario.id, ok: result.ok }, 'scenario executed')
  }
  return findings
}
```

- [ ] **Step 5: Run tests + build + lint** → PASS

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/executeScenarios.ts src/pipeline/executeScenarios.test.ts src/domain/types.ts
git commit -m "feat(scenario): executeScenarios orchestration with auth precondition + findings"
```

---

### Task 5: `run` integration + `--skip-scenarios` + index wiring

**Files:**
- Modify: `src/cli/commands/run.ts` (new stage, `RunOpts.skipScenarios`, `RunDeps.executeScenarios`)
- Modify: `src/cli/index.ts` (wire real deps + `--skip-scenarios` flag)
- Test: `src/cli/commands/run.test.ts` (add stage cases)

**Interfaces:**
- Consumes: `executeScenarios` (from `pipeline/executeScenarios.js`), `loadScenarios`, `authenticate`, `defaultComposeRunner`, credential resolution (mirror grow command).
- Produces: `RunDeps.executeScenarios?: ExecuteScenariosFn`; when present and `!opts.skipScenarios`, runRun calls it and merges results into `verifyFindings` before `writeReport`.

- [ ] **Step 1: Write the failing test** (add to `src/cli/commands/run.test.ts`)

```typescript
it('runs the scenario execution stage and merges findings into the report', async () => {
  const executeScenarios = vi.fn(async () => ([{ category: 'scenario', severity: 'high', title: 'grow-hotel', detail: 'failed', evidence: 'grow-hotel' }]))
  const writeReport = vi.fn(async () => {})
  await runRun(root, { target: 'admin' }, makeRunDeps({ executeScenarios, writeReport, createPage: makeCreatePage(), executeLogin: vi.fn(async () => ({ ok: true, detail: 'ok', finalUrl: 'u' })) }))
  expect(executeScenarios).toHaveBeenCalledOnce()
  const reportArg = writeReport.mock.calls[0][2]
  expect(reportArg.verifyFindings.some((f: any) => f.category === 'scenario')).toBe(true)
})

it('skips the scenario stage when --skip-scenarios is set', async () => {
  const executeScenarios = vi.fn()
  await runRun(root, { target: 'admin', skipScenarios: true }, makeRunDeps({ executeScenarios, writeReport: vi.fn(async () => {}) }))
  expect(executeScenarios).not.toHaveBeenCalled()
})
```
(Reuse the file's existing `makeRunDeps`/`root` helpers; add `executeScenarios` to the deps factory. If helpers differ, adapt names to the existing test's conventions — read the file first.)

- [ ] **Step 2: Run test to verify it fails** → FAIL (`executeScenarios` not invoked / option unknown).

- [ ] **Step 3: Implement run stage**

In `src/cli/commands/run.ts`: add to `RunOpts` `skipScenarios?: boolean`; add to `RunDeps`:
```typescript
  executeScenarios?: (page: PageLike, target: TargetEnv, scenarios: Scenario[], creds: { username: string; password: string }, deps?: unknown) => Promise<VerifyFinding[]>
  loadScenarios?: (dir: string) => Promise<Scenario[]>
```
After `verifyFindings = [...verifyFindings, ...loginFindings]` and before `writeReport`, add:
```typescript
  if (!opts.skipScenarios && deps.executeScenarios && deps.createPage && deps.loadScenarios) {
    try {
      const scenarios = await deps.loadScenarios(scenarioDir)
      if (scenarios.length > 0) {
        const page = await deps.createPage()
        try {
          const scenarioFindings = await deps.executeScenarios(page, target, scenarios, creds, deps.scenarioExecDeps)
          verifyFindings = [...verifyFindings, ...scenarioFindings]
        } finally { await page.close?.() }
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'scenario execution stage failed; continuing')
    }
  }
```
(Use the same `target`, `creds`, `scenarioDir` already resolved in runRun for the login stage. If those locals are scoped inside the login block, lift them to the function scope — read run.ts and reuse existing resolution rather than duplicating.)

- [ ] **Step 4: Wire index.ts** — in the `run` command registration add `.option('--skip-scenarios', ...)`, and pass `executeScenarios` (from pipeline), `loadScenarios`, and `scenarioExecDeps` (`{ pinRunner: defaultComposeRunner, pinCommand: target.auth?.twoFactor?.pinCommand, vars: secrets.targetAuth, secrets: allSecrets, authenticate, clearCookies: (p) => p.context?.().clearCookies?.() }`). Mirror the grow command's dep construction.

- [ ] **Step 5: Run tests + build + lint** → PASS (`pnpm vitest run src/cli/commands/run.test.ts`, then full `pnpm test`, `pnpm build`, `pnpm lint`).

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/run.ts src/cli/commands/run.test.ts src/cli/index.ts
git commit -m "feat(scenario): integrate scenario execution stage into run (--skip-scenarios)"
```

---

### Task 6: Docs + real-machine E2E + ledger

**Files:**
- Modify: `README.md` (precondition field, run scenario stage, `--skip-scenarios`)
- Create: `src/services/browser/scenarioExec.e2e.test.ts` (gated by `RUN_E2E`)
- Modify: `.superpowers/sdd/progress.md`

- [ ] **Step 1: README** — document under the config section: `precondition.auth` (`authenticated`/`unauthenticated`, absent = no auth handling), how `run` executes adopted scenarios after verify, `{{ENV}}`/`{{TWO_FACTOR_PIN}}` placeholders in `fill` inputs, and `loop-e2e run --skip-scenarios`. Use placeholder secrets only.

- [ ] **Step 2: RUN_E2E test** — `describe.skipIf(!process.env.RUN_E2E)` that launches a real browser, runs `executeScenarios` against the configured admin target for an `authenticated` scenario (navigate `/hotel` + assert), expects a low-severity finding. Document in the test header that it needs the local stack + `.env`.

- [ ] **Step 3: Verify full gates**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: build PASS, tests pass (prior 382 + new, 3 skipped + any RUN_E2E skipped), lint PASS.

- [ ] **Step 4: Commit + ledger**

```bash
git add README.md src/services/browser/scenarioExec.e2e.test.ts .superpowers/sdd/progress.md
git commit -m "docs(scenario): document precondition + run scenario stage; add RUN_E2E test"
```

---

## Self-Review

**Spec coverage:** §2 schema → Task 1. §3 executeScenario (all 6 actions, placeholder resolution, masking, fail-abort) → Task 2. §4 ensureAuthenticated/ensureUnauthenticated → Task 3. §5 orchestration + VerifyFinding('scenario') + 必要時LLM-handoff (unverified expectedResults noted for the existing Opus gate) → Task 4. §6 run integration + --skip-scenarios + index wiring → Task 5. §9 tests (unit per task, RUN_E2E) + §10 staging order → Tasks 1-6. README → Task 6. No gaps.

**Placeholder scan:** No TBD/"handle errors"/"similar to" — each step has concrete code or commands.

**Type consistency:** `ScenarioRunResult`, `ScenarioExecDeps`, `executeScenario`, `ensureAuthenticated(page,target,creds,probePath,deps)`, `executeScenarios(page,target,scenarios,creds,deps)`, `VerifyFinding(category:'scenario')` consistent across Tasks 2→3→4→5. `PageLike.locator().count?` added in Task 2 and consumed there. `firstNavigateTarget` used as the auth probe in Task 4 matches `ensureAuthenticated`'s `probePath` param in Task 3.
