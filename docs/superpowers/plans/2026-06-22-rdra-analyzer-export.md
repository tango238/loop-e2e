# rdra-analyzer-export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `loop-e2e rdra-export` that maps adopted scenarios to rdra-analyzer's OperationScenario format, merges route-matched ones into its `analysis_result.json`, and hands unmatched ones off to `loop-e2e-pending.json`.

**Architecture:** Pure data transformation (no browser/network): convert each loop-e2e `Scenario` → OperationScenario; match to an existing usecase by normalized navigate path; matched scenarios are merged (idempotent via `LE-` prefix) into the analysis file after a referential-integrity check; unmatched are written to a side pending file for rdra-analyzer's reconcile step. All fs I/O is injected for in-memory unit tests.

**Tech Stack:** TypeScript strict, ESM, Node 20+, pnpm, vitest. No new dependencies.

## Global Constraints

- TypeScript strict + ESM; every task MUST pass `pnpm build` (tsc), `pnpm test`, `pnpm lint` before commit. (vitest/esbuild does NOT type-check — run `pnpm build` per task.)
- All fs I/O injected via deps; unit tests run in-memory — no real filesystem fixtures unless the task is an integration test using a tmp dir.
- loop-e2e-origin scenarios are tagged `scenario_id = "LE-" + scenario.id`; re-export removes existing `LE-` scenarios and re-adds (idempotent). `usecases[]` and non-`LE-` scenarios are preserved untouched. Unknown top-level fields of the analysis file are preserved.
- **Agreed delta (rdra-analyzer signed off, `/tmp/loop-e2e-agreed-contract-handoff.md`):** matching uses TWO keys (navigate + API route) with a shared `normalizeRoute` (strip leading METHOD token, `ANY`=wildcard, then path-normalize), priority `navigate exact > api exact > navigate prefix > api prefix`. The merged OperationScenario's `api_endpoint` stays a SINGLE STRING (`"<METHOD> <path>"`/path/raw/`""`) — never an array (rdra reads it as a single string). `loop-e2e-pending.json` `api_endpoints` is `{ method, path, raw }[]`. API endpoints are best-effort parsed from each `kind:'api'` expectedResult's `assertion` (a structured `apiEndpoint:{method,path}` field is used if present; source-prompt structuring is a separate follow-up).
- The written `analysis_result.json` MUST be referentially valid (every `scenarios[].usecase_id` exists in `usecases[]`); validation failure throws and the file is NOT written.
- Unmatched scenarios go to `loop-e2e-pending.json` in the same directory as `--into`; if 0 unmatched, the pending file is NOT written.
- No secrets involved; `step.input` values are NOT copied into OperationScenario (ui_element = target only).
- Existing suite (405 pass + 4 skip) MUST stay green.
- Work on branch `feat/rdra-export` (already created); do not work on main.

---

### Task 1: Types + convert (Scenario → OperationScenario / PendingEntry)

> **AGREED-DELTA OVERRIDE (spec §3):** Add `ApiEndpoint = { method: string | null; path: string | null; raw: string }`. `PendingEntry.api_endpoints` is `ApiEndpoint[]` (NOT `string[]`). convert exposes `parseApiEndpoint(raw): ApiEndpoint` (best-effort: leading METHOD token + path; structured `apiEndpoint:{method,path}` on the expectedResult wins if present), `apiEndpoints(scenario): ApiEndpoint[]`, and `apiEndpointString(eps): string` = first endpoint → `"<METHOD> <path>"` (both present) / `path` / `raw` / `""`. `toOperationScenario.api_endpoint` uses `apiEndpointString` (single string, never array). `toPendingEntry.api_endpoints` uses `apiEndpoints()` (structured). The code blocks below are superseded where they conflict with this note.

**Files:**
- Create: `src/services/rdra/types.ts`
- Create: `src/services/rdra/convert.ts`
- Test: `src/services/rdra/convert.test.ts`

**Interfaces:**
- Consumes: `Scenario`, `ScenarioStep`, `ExpectedResult` from `../../scenario/schema.js`.
- Produces (types.ts):
  - `OperationStep = { step_no: number; actor: string; action: string; expected_result: string; ui_element: string }`
  - `OperationScenario = { scenario_id: string; usecase_id: string; usecase_name: string; scenario_name: string; scenario_type: string; frontend_url: string; api_endpoint: string; steps: OperationStep[]; variations: string[] }`
  - `Usecase = { id: string; name: string; related_routes?: string[]; related_pages?: string[]; [k: string]: unknown }`
  - `AnalysisResult = { metadata?: Record<string, unknown>; usecases: Usecase[]; scenarios: OperationScenario[]; [k: string]: unknown }`
  - `PendingEntry = { loop_e2e_id: string; scenario_name: string; frontend_url: string; navigate_routes: string[]; api_endpoints: string[]; steps: OperationStep[]; reason: string }`
- Produces (convert.ts):
  - `toOperationScenario(scenario: Scenario, usecase: { id: string; name: string }): OperationScenario`
  - `toPendingEntry(scenario: Scenario, navigateRoutes: string[]): PendingEntry`
  - `toOperationSteps(scenario: Scenario): OperationStep[]`
  - `firstNavigateTarget(scenario: Scenario): string | null` (raw target, not normalized)
  - `apiEndpoints(scenario: Scenario): string[]`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/rdra/convert.test.ts
import { describe, it, expect } from 'vitest'
import { toOperationScenario, toPendingEntry, toOperationSteps, firstNavigateTarget, apiEndpoints } from './convert.js'
import type { Scenario } from '../../scenario/schema.js'

const scn: Scenario = {
  id: 'grow-hotel',
  title: 'View hotel page',
  businessFlow: 'admin views hotels',
  steps: [
    { action: 'navigate', target: '/hotel', expectedOutcome: 'Hotel page loads' },
    { action: 'assert', target: 'text=Hotel', expectedOutcome: 'heading shown' },
  ],
  expectedResults: [
    { kind: 'ui', description: 'd', assertion: 'heading visible' },
    { kind: 'api', description: 'd', assertion: 'GET /api/v2/hotels returns 200' },
  ],
  expectedDbState: [],
}

describe('convert', () => {
  it('maps a scenario to an OperationScenario with LE- prefix and usecase linkage', () => {
    const op = toOperationScenario(scn, { id: 'UC-012', name: 'ホテル一覧' })
    expect(op.scenario_id).toBe('LE-grow-hotel')
    expect(op.usecase_id).toBe('UC-012')
    expect(op.usecase_name).toBe('ホテル一覧')
    expect(op.scenario_name).toBe('View hotel page')
    expect(op.scenario_type).toBe('normal')
    expect(op.frontend_url).toBe('/hotel')
    expect(op.api_endpoint).toBe('GET /api/v2/hotels returns 200')
    expect(op.variations).toEqual([])
  })

  it('numbers steps from 1 and maps fields (no input leakage)', () => {
    const steps = toOperationSteps(scn)
    expect(steps[0]).toEqual({ step_no: 1, actor: 'ユーザー', action: 'navigate /hotel', expected_result: 'Hotel page loads', ui_element: '/hotel' })
    expect(steps[1].step_no).toBe(2)
  })

  it('firstNavigateTarget returns the first navigate target or null', () => {
    expect(firstNavigateTarget(scn)).toBe('/hotel')
    expect(firstNavigateTarget({ ...scn, steps: [{ action: 'click', target: '#x', expectedOutcome: 'o' }] })).toBeNull()
  })

  it('apiEndpoints collects kind=api assertions', () => {
    expect(apiEndpoints(scn)).toEqual(['GET /api/v2/hotels returns 200'])
  })

  it('toPendingEntry carries context for reconcile', () => {
    const p = toPendingEntry(scn, ['/hotel'])
    expect(p.loop_e2e_id).toBe('grow-hotel')
    expect(p.frontend_url).toBe('/hotel')
    expect(p.navigate_routes).toEqual(['/hotel'])
    expect(p.api_endpoints).toEqual(['GET /api/v2/hotels returns 200'])
    expect(p.reason).toMatch(/no matching usecase/i)
    expect(p.steps[0].step_no).toBe(1)
  })

  it('uses empty strings when no navigate / no api result', () => {
    const bare: Scenario = { ...scn, steps: [{ action: 'click', target: '#x', expectedOutcome: 'o' }], expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }] }
    const op = toOperationScenario(bare, { id: 'UC-1', name: 'n' })
    expect(op.frontend_url).toBe('')
    expect(op.api_endpoint).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/services/rdra/convert.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement types.ts**

```typescript
// src/services/rdra/types.ts
export type OperationStep = {
  step_no: number
  actor: string
  action: string
  expected_result: string
  ui_element: string
}

export type OperationScenario = {
  scenario_id: string
  usecase_id: string
  usecase_name: string
  scenario_name: string
  scenario_type: string
  frontend_url: string
  api_endpoint: string
  steps: OperationStep[]
  variations: string[]
}

export type Usecase = {
  id: string
  name: string
  related_routes?: string[]
  related_pages?: string[]
  [k: string]: unknown
}

export type AnalysisResult = {
  metadata?: Record<string, unknown>
  usecases: Usecase[]
  scenarios: OperationScenario[]
  [k: string]: unknown
}

export type PendingEntry = {
  loop_e2e_id: string
  scenario_name: string
  frontend_url: string
  navigate_routes: string[]
  api_endpoints: string[]
  steps: OperationStep[]
  reason: string
}

/** Prefix marking loop-e2e-origin scenarios in the merged analysis file. */
export const LE_PREFIX = 'LE-'
```

- [ ] **Step 4: Implement convert.ts**

```typescript
// src/services/rdra/convert.ts
import { LE_PREFIX } from './types.js'
import type { OperationScenario, OperationStep, PendingEntry } from './types.js'
import type { Scenario } from '../../scenario/schema.js'

export function firstNavigateTarget(scenario: Scenario): string | null {
  const nav = scenario.steps.find((s) => s.action === 'navigate')
  return nav ? nav.target : null
}

export function apiEndpoints(scenario: Scenario): string[] {
  return scenario.expectedResults.filter((e) => e.kind === 'api').map((e) => e.assertion)
}

export function toOperationSteps(scenario: Scenario): OperationStep[] {
  return scenario.steps.map((s, i) => ({
    step_no: i + 1,
    actor: 'ユーザー',
    action: `${s.action} ${s.target}`.trim(),
    expected_result: s.expectedOutcome,
    ui_element: s.target,
  }))
}

export function toOperationScenario(scenario: Scenario, usecase: { id: string; name: string }): OperationScenario {
  const api = apiEndpoints(scenario)
  return {
    scenario_id: `${LE_PREFIX}${scenario.id}`,
    usecase_id: usecase.id,
    usecase_name: usecase.name,
    scenario_name: scenario.title,
    scenario_type: 'normal',
    frontend_url: firstNavigateTarget(scenario) ?? '',
    api_endpoint: api[0] ?? '',
    steps: toOperationSteps(scenario),
    variations: [],
  }
}

export function toPendingEntry(scenario: Scenario, navigateRoutes: string[]): PendingEntry {
  return {
    loop_e2e_id: scenario.id,
    scenario_name: scenario.title,
    frontend_url: firstNavigateTarget(scenario) ?? '',
    navigate_routes: navigateRoutes,
    api_endpoints: apiEndpoints(scenario),
    steps: toOperationSteps(scenario),
    reason: 'no matching usecase by route',
  }
}
```

- [ ] **Step 5: Run tests + build + lint** → PASS (`pnpm vitest run src/services/rdra/convert.test.ts`, `pnpm build && pnpm lint`)

- [ ] **Step 6: Commit**

```bash
git add src/services/rdra/types.ts src/services/rdra/convert.ts src/services/rdra/convert.test.ts
git commit -m "feat(rdra): types + Scenario→OperationScenario/PendingEntry convert"
```

---

### Task 2: Route matching (two-key + shared normalizeRoute)

> **AGREED-DELTA OVERRIDE (spec §4):** Implement `normalizeRoute(s): { method, path }` (strip leading METHOD token GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS/ANY → `method` upper-cased, else `"ANY"`; then `normalizePath` the rest), `methodMatches(a,b)` (`a==="ANY" || b==="ANY" || a===b`), `routeKeyEquals(x,y)`. `matchUsecase(scenario, usecases)` matches on TWO keys: navigate key `{method:"ANY", path: normalizePath(firstNavigateTarget)}` and api keys (from `apiEndpoints(scenario)`, skipping `path===null`, method `??"ANY"`). UC candidate routes = `related_routes ∪ related_pages` each `normalizeRoute`'d. Priority across all usecases: (1) navigate exact, (2) api exact, (3) navigate prefix (`path.startsWith(route.path + "/")` + methodMatches), (4) api prefix; same priority → first usecase. The single-key code below is superseded by this note.

**Files:**
- Create: `src/services/rdra/match.ts`
- Test: `src/services/rdra/match.test.ts`

**Interfaces:**
- Consumes: `Usecase`, `Scenario`, `firstNavigateTarget`.
- Produces:
  - `normalizePath(url: string): string` — strip origin, query, fragment, trailing slash (keep `/`).
  - `navigateRoutes(scenario: Scenario): string[]` — all navigate targets, normalized.
  - `matchUsecase(scenario: Scenario, usecases: Usecase[]): Usecase | null` — exact route match first, then prefix.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/rdra/match.test.ts
import { describe, it, expect } from 'vitest'
import { normalizePath, navigateRoutes, matchUsecase } from './match.js'
import type { Usecase } from './types.js'
import type { Scenario } from '../../scenario/schema.js'

const scn = (target: string): Scenario => ({
  id: 'x', title: 'x', businessFlow: 'f',
  steps: [{ action: 'navigate', target, expectedOutcome: 'o' }],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }], expectedDbState: [],
})

const ucs: Usecase[] = [
  { id: 'UC-1', name: 'hotel', related_routes: ['/hotel'] },
  { id: 'UC-2', name: 'hotel detail', related_pages: ['/hotel/edit'] },
]

describe('normalizePath', () => {
  it('strips origin, query, fragment, trailing slash', () => {
    expect(normalizePath('https://app.test/hotel/?q=1#x')).toBe('/hotel')
    expect(normalizePath('/hotel/')).toBe('/hotel')
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('https://app.test/')).toBe('/')
  })
})

describe('matchUsecase', () => {
  it('matches by exact route', () => {
    expect(matchUsecase(scn('/hotel'), ucs)?.id).toBe('UC-1')
  })
  it('prefers exact over prefix', () => {
    const u = [{ id: 'P', name: 'p', related_routes: ['/hotel'] }, { id: 'E', name: 'e', related_routes: ['/hotel/edit'] }]
    expect(matchUsecase(scn('/hotel/edit'), u)?.id).toBe('E')
  })
  it('falls back to prefix match', () => {
    expect(matchUsecase(scn('/hotel/123'), ucs)?.id).toBe('UC-1')
  })
  it('returns null when nothing matches', () => {
    expect(matchUsecase(scn('/booking'), ucs)).toBeNull()
  })
  it('returns null when the scenario has no navigate step', () => {
    const noNav: Scenario = { ...scn('/hotel'), steps: [{ action: 'click', target: '#x', expectedOutcome: 'o' }] }
    expect(matchUsecase(noNav, ucs)).toBeNull()
  })
})

describe('navigateRoutes', () => {
  it('collects normalized navigate targets', () => {
    const s: Scenario = { ...scn('/hotel/'), steps: [{ action: 'navigate', target: '/hotel/', expectedOutcome: 'o' }, { action: 'navigate', target: 'https://app.test/booking?x=1', expectedOutcome: 'o' }] }
    expect(navigateRoutes(s)).toEqual(['/hotel', '/booking'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails** → FAIL (module not found).

- [ ] **Step 3: Implement match.ts**

```typescript
// src/services/rdra/match.ts
import { firstNavigateTarget } from './convert.js'
import type { Usecase } from './types.js'
import type { Scenario } from '../../scenario/schema.js'

export function normalizePath(url: string): string {
  let path = url
  try {
    path = new URL(url).pathname
  } catch {
    // relative path: strip query/fragment manually
    path = url.split('#')[0].split('?')[0]
  }
  if (path.length > 1) path = path.replace(/\/+$/, '')
  return path === '' ? '/' : path
}

export function navigateRoutes(scenario: Scenario): string[] {
  return scenario.steps.filter((s) => s.action === 'navigate').map((s) => normalizePath(s.target))
}

function usecaseRoutes(uc: Usecase): string[] {
  return [...(uc.related_routes ?? []), ...(uc.related_pages ?? [])].map(normalizePath)
}

export function matchUsecase(scenario: Scenario, usecases: Usecase[]): Usecase | null {
  const navTarget = firstNavigateTarget(scenario)
  if (navTarget === null) return null
  const path = normalizePath(navTarget)

  // Pass 1: exact route match
  for (const uc of usecases) {
    if (usecaseRoutes(uc).includes(path)) return uc
  }
  // Pass 2: prefix match (scenario path is under a usecase route)
  for (const uc of usecases) {
    if (usecaseRoutes(uc).some((r) => r !== '/' && path.startsWith(r + '/'))) return uc
  }
  return null
}
```

- [ ] **Step 4: Run tests + build + lint** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/rdra/match.ts src/services/rdra/match.test.ts
git commit -m "feat(rdra): route matching (normalizePath + matchUsecase)"
```

---

### Task 3: Idempotent merge

**Files:**
- Create: `src/services/rdra/merge.ts`
- Test: `src/services/rdra/merge.test.ts`

**Interfaces:**
- Consumes: `AnalysisResult`, `OperationScenario`, `LE_PREFIX`.
- Produces: `mergeIntoAnalysisResult(analysis: AnalysisResult, leScenarios: OperationScenario[]): { analysis: AnalysisResult; replaced: number }` — removes existing `LE-` scenarios, appends `leScenarios`, recomputes metadata counts, preserves usecases / non-LE scenarios / unknown top-level fields. `replaced` = count of removed LE scenarios.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/rdra/merge.test.ts
import { describe, it, expect } from 'vitest'
import { mergeIntoAnalysisResult } from './merge.js'
import type { AnalysisResult, OperationScenario } from './types.js'

const op = (id: string, uc = 'UC-1'): OperationScenario => ({
  scenario_id: id, usecase_id: uc, usecase_name: 'n', scenario_name: id, scenario_type: 'normal',
  frontend_url: '/x', api_endpoint: '', steps: [], variations: [],
})

const base = (): AnalysisResult => ({
  metadata: { total_usecases: 1, total_scenarios: 2, note: 'keep me' },
  usecases: [{ id: 'UC-1', name: 'n' }],
  scenarios: [op('SC-001-01'), op('LE-old')],
  extra_top_level: 'preserve',
})

describe('mergeIntoAnalysisResult', () => {
  it('replaces LE- scenarios, preserves rdra scenarios + usecases + unknown fields', () => {
    const { analysis, replaced } = mergeIntoAnalysisResult(base(), [op('LE-grow-hotel')])
    expect(replaced).toBe(1)
    const ids = analysis.scenarios.map((s) => s.scenario_id)
    expect(ids).toContain('SC-001-01')
    expect(ids).toContain('LE-grow-hotel')
    expect(ids).not.toContain('LE-old')
    expect(analysis.usecases).toHaveLength(1)
    expect(analysis.extra_top_level).toBe('preserve')
  })

  it('recomputes metadata counts', () => {
    const { analysis } = mergeIntoAnalysisResult(base(), [op('LE-a'), op('LE-b')])
    expect(analysis.metadata?.total_scenarios).toBe(3) // SC-001-01 + LE-a + LE-b
    expect(analysis.metadata?.total_usecases).toBe(1)
    expect(analysis.metadata?.note).toBe('keep me')
  })

  it('is idempotent across re-runs', () => {
    const first = mergeIntoAnalysisResult(base(), [op('LE-grow-hotel')]).analysis
    const second = mergeIntoAnalysisResult(first, [op('LE-grow-hotel')]).analysis
    expect(second.scenarios.filter((s) => s.scenario_id === 'LE-grow-hotel')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails** → FAIL (module not found).

- [ ] **Step 3: Implement merge.ts**

```typescript
// src/services/rdra/merge.ts
import { LE_PREFIX } from './types.js'
import type { AnalysisResult, OperationScenario } from './types.js'

export function mergeIntoAnalysisResult(
  analysis: AnalysisResult,
  leScenarios: OperationScenario[],
): { analysis: AnalysisResult; replaced: number } {
  const existingNonLe = analysis.scenarios.filter((s) => !s.scenario_id.startsWith(LE_PREFIX))
  const replaced = analysis.scenarios.length - existingNonLe.length
  const scenarios = [...existingNonLe, ...leScenarios]
  const merged: AnalysisResult = {
    ...analysis,
    usecases: analysis.usecases,
    scenarios,
    metadata: {
      ...(analysis.metadata ?? {}),
      total_usecases: analysis.usecases.length,
      total_scenarios: scenarios.length,
    },
  }
  return { analysis: merged, replaced }
}
```

- [ ] **Step 4: Run tests + build + lint** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/rdra/merge.ts src/services/rdra/merge.test.ts
git commit -m "feat(rdra): idempotent merge into analysis_result (LE- replace + metadata)"
```

---

### Task 4: Referential-integrity validation

**Files:**
- Create: `src/services/rdra/validate.ts`
- Test: `src/services/rdra/validate.test.ts`

**Interfaces:**
- Consumes: `AnalysisResult`.
- Produces: `validateAnalysisResult(analysis: AnalysisResult): void` — throws `Error` on: a `scenarios[].usecase_id` not in `usecases[]`; duplicate `scenario_id`; non-sequential `step_no` (must be 1..n). Returns void on success.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/rdra/validate.test.ts
import { describe, it, expect } from 'vitest'
import { validateAnalysisResult } from './validate.js'
import type { AnalysisResult, OperationScenario } from './types.js'

const op = (id: string, uc: string, steps = [{ step_no: 1, actor: 'ユーザー', action: 'a', expected_result: 'r', ui_element: 'u' }]): OperationScenario => ({
  scenario_id: id, usecase_id: uc, usecase_name: 'n', scenario_name: id, scenario_type: 'normal', frontend_url: '', api_endpoint: '', steps, variations: [],
})
const wrap = (scenarios: OperationScenario[]): AnalysisResult => ({ usecases: [{ id: 'UC-1', name: 'n' }], scenarios })

describe('validateAnalysisResult', () => {
  it('passes for a referentially valid file', () => {
    expect(() => validateAnalysisResult(wrap([op('LE-a', 'UC-1')]))).not.toThrow()
  })
  it('throws on a dangling usecase_id', () => {
    expect(() => validateAnalysisResult(wrap([op('LE-a', 'UC-X')]))).toThrow(/usecase_id/i)
  })
  it('throws on duplicate scenario_id', () => {
    expect(() => validateAnalysisResult(wrap([op('LE-a', 'UC-1'), op('LE-a', 'UC-1')]))).toThrow(/duplicate/i)
  })
  it('throws on non-sequential step_no', () => {
    const bad = op('LE-a', 'UC-1', [{ step_no: 2, actor: 'ユーザー', action: 'a', expected_result: 'r', ui_element: 'u' }])
    expect(() => validateAnalysisResult(wrap([bad]))).toThrow(/step_no/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails** → FAIL (module not found).

- [ ] **Step 3: Implement validate.ts**

```typescript
// src/services/rdra/validate.ts
import type { AnalysisResult } from './types.js'

export function validateAnalysisResult(analysis: AnalysisResult): void {
  const ucIds = new Set(analysis.usecases.map((u) => u.id))
  const seen = new Set<string>()
  for (const s of analysis.scenarios) {
    if (!ucIds.has(s.usecase_id)) {
      throw new Error(`dangling usecase_id "${s.usecase_id}" in scenario "${s.scenario_id}"`)
    }
    if (seen.has(s.scenario_id)) throw new Error(`duplicate scenario_id "${s.scenario_id}"`)
    seen.add(s.scenario_id)
    s.steps.forEach((step, i) => {
      if (step.step_no !== i + 1) {
        throw new Error(`non-sequential step_no in scenario "${s.scenario_id}": expected ${i + 1}, got ${step.step_no}`)
      }
    })
  }
}
```

- [ ] **Step 4: Run tests + build + lint** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/rdra/validate.ts src/services/rdra/validate.test.ts
git commit -m "feat(rdra): referential-integrity validation"
```

---

### Task 5: File I/O (read/write analysis + pending)

**Files:**
- Create: `src/services/rdra/io.ts`
- Test: `src/services/rdra/io.test.ts`

**Interfaces:**
- Consumes: `AnalysisResult`, `PendingEntry`.
- Produces:
  - `IoDeps = { readFile?: (p: string) => Promise<string>; writeFile?: (p: string, data: string) => Promise<void> }`
  - `readAnalysisResult(path: string, deps?: IoDeps): Promise<AnalysisResult>` — JSON.parse; throw clear error if file unreadable or `usecases`/`scenarios` not arrays.
  - `writeAnalysisResult(path: string, analysis: AnalysisResult, deps?: IoDeps): Promise<void>` — JSON.stringify(2)+trailing newline.
  - `writePending(path: string, pending: PendingEntry[], deps?: IoDeps): Promise<void>` — wraps `{ generatedBy: 'loop-e2e rdra-export', pending }`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/rdra/io.test.ts
import { describe, it, expect, vi } from 'vitest'
import { readAnalysisResult, writeAnalysisResult, writePending } from './io.js'

describe('readAnalysisResult', () => {
  it('parses a valid file', async () => {
    const readFile = vi.fn(async () => JSON.stringify({ usecases: [], scenarios: [] }))
    const a = await readAnalysisResult('/p', { readFile })
    expect(a.scenarios).toEqual([])
  })
  it('throws a clear error when the file is missing', async () => {
    const readFile = vi.fn(async () => { throw new Error('ENOENT') })
    await expect(readAnalysisResult('/p', { readFile })).rejects.toThrow(/analysis_result|not found|read/i)
  })
  it('throws when usecases/scenarios are not arrays', async () => {
    const readFile = vi.fn(async () => JSON.stringify({ usecases: {}, scenarios: [] }))
    await expect(readAnalysisResult('/p', { readFile })).rejects.toThrow(/usecases|scenarios|array/i)
  })
})

describe('writeAnalysisResult / writePending', () => {
  it('writes pretty JSON for the analysis', async () => {
    let written = ''
    const writeFile = vi.fn(async (_p: string, d: string) => { written = d })
    await writeAnalysisResult('/p', { usecases: [], scenarios: [] }, { writeFile })
    expect(written).toContain('"scenarios"')
    expect(written.endsWith('\n')).toBe(true)
  })
  it('wraps pending entries under generatedBy/pending', async () => {
    let written = ''
    const writeFile = vi.fn(async (_p: string, d: string) => { written = d })
    await writePending('/p', [{ loop_e2e_id: 'x', scenario_name: 'x', frontend_url: '/x', navigate_routes: ['/x'], api_endpoints: [], steps: [], reason: 'r' }], { writeFile })
    const parsed = JSON.parse(written)
    expect(parsed.generatedBy).toBe('loop-e2e rdra-export')
    expect(parsed.pending).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails** → FAIL (module not found).

- [ ] **Step 3: Implement io.ts**

```typescript
// src/services/rdra/io.ts
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises'
import type { AnalysisResult, PendingEntry } from './types.js'

export type IoDeps = {
  readFile?: (p: string) => Promise<string>
  writeFile?: (p: string, data: string) => Promise<void>
}

export async function readAnalysisResult(path: string, deps: IoDeps = {}): Promise<AnalysisResult> {
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p, 'utf8'))
  let raw: string
  try {
    raw = await readFile(path)
  } catch (err) {
    throw new Error(`cannot read analysis_result.json at ${path} (run rdra-analyzer analyze first): ${err instanceof Error ? err.message : String(err)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`analysis_result.json at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const obj = parsed as AnalysisResult
  if (!Array.isArray(obj.usecases) || !Array.isArray(obj.scenarios)) {
    throw new Error(`analysis_result.json at ${path} must have array "usecases" and "scenarios"`)
  }
  return obj
}

export async function writeAnalysisResult(path: string, analysis: AnalysisResult, deps: IoDeps = {}): Promise<void> {
  const writeFile = deps.writeFile ?? ((p: string, d: string) => fsWriteFile(p, d, 'utf8'))
  await writeFile(path, JSON.stringify(analysis, null, 2) + '\n')
}

export async function writePending(path: string, pending: PendingEntry[], deps: IoDeps = {}): Promise<void> {
  const writeFile = deps.writeFile ?? ((p: string, d: string) => fsWriteFile(p, d, 'utf8'))
  await writeFile(path, JSON.stringify({ generatedBy: 'loop-e2e rdra-export', pending }, null, 2) + '\n')
}
```

- [ ] **Step 4: Run tests + build + lint** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/rdra/io.ts src/services/rdra/io.test.ts
git commit -m "feat(rdra): file io (read/write analysis + write pending)"
```

---

### Task 6: Export pipeline

**Files:**
- Create: `src/pipeline/rdraExport.ts`
- Test: `src/pipeline/rdraExport.test.ts`

**Interfaces:**
- Consumes: `toOperationScenario`/`toPendingEntry`, `matchUsecase`/`navigateRoutes`, `mergeIntoAnalysisResult`, `validateAnalysisResult`, `readAnalysisResult`/`writeAnalysisResult`/`writePending`, `Scenario`.
- Produces:
  - `RdraExportArgs = { scenarioDir: string; intoPath: string }`
  - `RdraExportDeps = { loadScenarios?: (dir: string) => Promise<Scenario[]>; readAnalysisResult?: typeof readAnalysisResult; writeAnalysisResult?: typeof writeAnalysisResult; writePending?: typeof writePending }`
  - `RdraExportResult = { matched: number; pending: number; replaced: number; intoPath: string; pendingPath?: string }`
  - `rdraExport(args: RdraExportArgs, deps?: RdraExportDeps): Promise<RdraExportResult>`

**Behavior:** load active scenarios; if 0 → return zeros (no write). Read analysis. For each scenario, `matchUsecase` → matched (convert with usecase) or pending (convert with `navigateRoutes`). Merge matched, `validateAnalysisResult` (throws → nothing written), write analysis. If pending non-empty, write `loop-e2e-pending.json` in the same dir as `intoPath` and set `pendingPath`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/pipeline/rdraExport.test.ts
import { describe, it, expect, vi } from 'vitest'
import { rdraExport } from './rdraExport.js'
import type { Scenario } from '../scenario/schema.js'
import type { AnalysisResult } from '../services/rdra/types.js'

const scn = (id: string, target: string): Scenario => ({
  id, title: id, businessFlow: 'f',
  steps: [{ action: 'navigate', target, expectedOutcome: 'o' }],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }], expectedDbState: [],
})
const analysis = (): AnalysisResult => ({ metadata: {}, usecases: [{ id: 'UC-1', name: 'hotel', related_routes: ['/hotel'] }], scenarios: [] })

describe('rdraExport', () => {
  it('merges matched scenarios and writes pending for unmatched', async () => {
    let writtenAnalysis: AnalysisResult | null = null
    let writtenPending: unknown = null
    const result = await rdraExport({ scenarioDir: '/s', intoPath: '/out/usecases/analysis_result.json' }, {
      loadScenarios: async () => [scn('grow-hotel', '/hotel'), scn('grow-booking', '/booking')],
      readAnalysisResult: async () => analysis(),
      writeAnalysisResult: async (_p, a) => { writtenAnalysis = a },
      writePending: async (_p, pend) => { writtenPending = pend },
    })
    expect(result.matched).toBe(1)
    expect(result.pending).toBe(1)
    expect(result.pendingPath).toBe('/out/usecases/loop-e2e-pending.json')
    expect(writtenAnalysis!.scenarios.map((s) => s.scenario_id)).toContain('LE-grow-hotel')
    expect((writtenPending as { loop_e2e_id: string }[])[0].loop_e2e_id).toBe('grow-booking')
  })

  it('does not write pending when all match', async () => {
    const writePending = vi.fn()
    const result = await rdraExport({ scenarioDir: '/s', intoPath: '/out/analysis_result.json' }, {
      loadScenarios: async () => [scn('grow-hotel', '/hotel')],
      readAnalysisResult: async () => analysis(),
      writeAnalysisResult: async () => {},
      writePending,
    })
    expect(result.pending).toBe(0)
    expect(result.pendingPath).toBeUndefined()
    expect(writePending).not.toHaveBeenCalled()
  })

  it('returns zeros and writes nothing when there are no scenarios', async () => {
    const writeAnalysisResult = vi.fn()
    const result = await rdraExport({ scenarioDir: '/s', intoPath: '/out/analysis_result.json' }, {
      loadScenarios: async () => [],
      readAnalysisResult: async () => analysis(),
      writeAnalysisResult,
    })
    expect(result.matched).toBe(0)
    expect(writeAnalysisResult).not.toHaveBeenCalled()
  })

  it('does not write when validation fails (dangling usecase_id is impossible here, so simulate via bad usecase)', async () => {
    // A matched scenario links to UC-1; corrupt the analysis so UC-1 is absent → validation throws.
    const writeAnalysisResult = vi.fn()
    await expect(rdraExport({ scenarioDir: '/s', intoPath: '/o/a.json' }, {
      loadScenarios: async () => [scn('grow-hotel', '/hotel')],
      readAnalysisResult: async () => ({ metadata: {}, usecases: [{ id: 'UC-1', name: 'hotel', related_routes: ['/hotel'] }], scenarios: [{ scenario_id: 'SC-x', usecase_id: 'GHOST', usecase_name: '', scenario_name: '', scenario_type: 'normal', frontend_url: '', api_endpoint: '', steps: [], variations: [] }] }),
      writeAnalysisResult,
    })).rejects.toThrow(/usecase_id/i)
    expect(writeAnalysisResult).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails** → FAIL (module not found).

- [ ] **Step 3: Implement rdraExport.ts**

```typescript
// src/pipeline/rdraExport.ts
import { dirname, join } from 'node:path'
import { logger } from '../util/logger.js'
import { loadScenarios as defaultLoadScenarios } from '../scenario/schema.js'
import { toOperationScenario, toPendingEntry } from '../services/rdra/convert.js'
import { matchUsecase, navigateRoutes } from '../services/rdra/match.js'
import { mergeIntoAnalysisResult } from '../services/rdra/merge.js'
import { validateAnalysisResult } from '../services/rdra/validate.js'
import {
  readAnalysisResult as defaultReadAnalysis,
  writeAnalysisResult as defaultWriteAnalysis,
  writePending as defaultWritePending,
} from '../services/rdra/io.js'
import type { OperationScenario, PendingEntry } from '../services/rdra/types.js'
import type { Scenario } from '../scenario/schema.js'

export type RdraExportArgs = { scenarioDir: string; intoPath: string }
export type RdraExportDeps = {
  loadScenarios?: (dir: string) => Promise<Scenario[]>
  readAnalysisResult?: typeof defaultReadAnalysis
  writeAnalysisResult?: typeof defaultWriteAnalysis
  writePending?: typeof defaultWritePending
}
export type RdraExportResult = {
  matched: number
  pending: number
  replaced: number
  intoPath: string
  pendingPath?: string
}

const PENDING_FILENAME = 'loop-e2e-pending.json'

export async function rdraExport(args: RdraExportArgs, deps: RdraExportDeps = {}): Promise<RdraExportResult> {
  const loadScenarios = deps.loadScenarios ?? defaultLoadScenarios
  const readAnalysis = deps.readAnalysisResult ?? defaultReadAnalysis
  const writeAnalysis = deps.writeAnalysisResult ?? defaultWriteAnalysis
  const writePending = deps.writePending ?? defaultWritePending

  const scenarios = await loadScenarios(args.scenarioDir)
  if (scenarios.length === 0) {
    logger.info({ scenarioDir: args.scenarioDir }, 'rdra-export: no scenarios to export')
    return { matched: 0, pending: 0, replaced: 0, intoPath: args.intoPath }
  }

  const analysis = await readAnalysis(args.intoPath)

  const matched: OperationScenario[] = []
  const pending: PendingEntry[] = []
  for (const scenario of scenarios) {
    const uc = matchUsecase(scenario, analysis.usecases)
    if (uc) matched.push(toOperationScenario(scenario, uc))
    else pending.push(toPendingEntry(scenario, navigateRoutes(scenario)))
  }

  const { analysis: merged, replaced } = mergeIntoAnalysisResult(analysis, matched)
  validateAnalysisResult(merged) // throws → nothing written
  await writeAnalysis(args.intoPath, merged)

  let pendingPath: string | undefined
  if (pending.length > 0) {
    pendingPath = join(dirname(args.intoPath), PENDING_FILENAME)
    await writePending(pendingPath, pending)
  }

  logger.info({ matched: matched.length, pending: pending.length, replaced }, 'rdra-export complete')
  return { matched: matched.length, pending: pending.length, replaced, intoPath: args.intoPath, pendingPath }
}
```

- [ ] **Step 4: Run tests + build + lint** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/rdraExport.ts src/pipeline/rdraExport.test.ts
git commit -m "feat(rdra): export pipeline (match → merge → validate → write + pending)"
```

---

### Task 7: CLI command + index wiring

**Files:**
- Create: `src/cli/commands/rdraExport.ts`
- Test: `src/cli/commands/rdraExport.test.ts`
- Modify: `src/cli/index.ts`

**Interfaces:**
- Consumes: `rdraExport`/`RdraExportResult`, `loadConfig`.
- Produces: `runRdraExport(root: string, opts: { into?: string; scenarioDir?: string }, deps: { rdraExport: typeof rdraExport; loadConfig?: (root: string) => Promise<{ config: { scenarioDir: string } }> }): Promise<RdraExportResult>` — resolves scenarioDir (opts → config.scenarioDir → `'scenarios'`, absolutized under root) and intoPath (opts.into → `<root>/output/usecases/analysis_result.json`), calls `rdraExport`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/cli/commands/rdraExport.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runRdraExport } from './rdraExport.js'

describe('runRdraExport', () => {
  it('resolves default into path and config scenarioDir, calls rdraExport', async () => {
    const rdraExport = vi.fn(async (args) => ({ matched: 1, pending: 0, replaced: 0, intoPath: args.intoPath }))
    const loadConfig = vi.fn(async () => ({ config: { scenarioDir: 'scenarios' } }))
    const r = await runRdraExport('/root', {}, { rdraExport, loadConfig })
    expect(rdraExport).toHaveBeenCalledWith({ scenarioDir: '/root/scenarios', intoPath: '/root/output/usecases/analysis_result.json' }, undefined)
    expect(r.matched).toBe(1)
  })

  it('honours --into and --scenario-dir overrides', async () => {
    const rdraExport = vi.fn(async (args) => ({ matched: 0, pending: 0, replaced: 0, intoPath: args.intoPath }))
    const loadConfig = vi.fn(async () => ({ config: { scenarioDir: 'scenarios' } }))
    await runRdraExport('/root', { into: '/abs/a.json', scenarioDir: '/abs/scn' }, { rdraExport, loadConfig })
    expect(rdraExport).toHaveBeenCalledWith({ scenarioDir: '/abs/scn', intoPath: '/abs/a.json' }, undefined)
  })

  it('falls back to scenarios dir when config load fails', async () => {
    const rdraExport = vi.fn(async (args) => ({ matched: 0, pending: 0, replaced: 0, intoPath: args.intoPath }))
    const loadConfig = vi.fn(async () => { throw new Error('no config') })
    await runRdraExport('/root', {}, { rdraExport, loadConfig })
    expect(rdraExport).toHaveBeenCalledWith({ scenarioDir: '/root/scenarios', intoPath: '/root/output/usecases/analysis_result.json' }, undefined)
  })
})
```

- [ ] **Step 2: Run test to verify it fails** → FAIL (module not found).

- [ ] **Step 3: Implement rdraExport.ts command**

```typescript
// src/cli/commands/rdraExport.ts
import { isAbsolute, join } from 'node:path'
import { rdraExport as defaultRdraExport } from '../../pipeline/rdraExport.js'
import type { RdraExportResult } from '../../pipeline/rdraExport.js'

export type RunRdraExportDeps = {
  rdraExport: typeof defaultRdraExport
  loadConfig?: (root: string) => Promise<{ config: { scenarioDir: string } }>
}

function absolutize(root: string, p: string): string {
  return isAbsolute(p) ? p : join(root, p)
}

export async function runRdraExport(
  root: string,
  opts: { into?: string; scenarioDir?: string },
  deps: RunRdraExportDeps,
): Promise<RdraExportResult> {
  let configScenarioDir = 'scenarios'
  if (deps.loadConfig) {
    try {
      const { config } = await deps.loadConfig(root)
      configScenarioDir = config.scenarioDir || 'scenarios'
    } catch {
      // no config — fall back to default scenarios dir
    }
  }
  const scenarioDir = opts.scenarioDir ? absolutize(root, opts.scenarioDir) : absolutize(root, configScenarioDir)
  const intoPath = opts.into ? absolutize(root, opts.into) : join(root, 'output', 'usecases', 'analysis_result.json')
  return deps.rdraExport({ scenarioDir, intoPath })
}
```

- [ ] **Step 4: Wire index.ts** — register the command (mirror the `approve` command's structure):

```typescript
program
  .command('rdra-export')
  .description('Export adopted scenarios into an rdra-analyzer analysis_result.json (route-matched merge + pending handoff)')
  .option('--into <path>', 'Path to rdra-analyzer analysis_result.json (default: <cwd>/output/usecases/analysis_result.json)')
  .option('--scenario-dir <dir>', 'Scenario directory (default: <cwd>/<config.scenarioDir>)')
  .action(async (opts: { into?: string; scenarioDir?: string }) => {
    const cwd = process.cwd()
    const { runRdraExport } = await import('./commands/rdraExport.js')
    const { rdraExport } = await import('../pipeline/rdraExport.js')
    try {
      const r = await runRdraExport(cwd, opts, { rdraExport, loadConfig })
      process.stdout.write(`matched ${r.matched} → ${r.intoPath}\n`)
      if (r.pendingPath) process.stdout.write(`pending ${r.pending} → ${r.pendingPath}\n`)
    } catch (err) {
      process.stderr.write(`rdra-export failed: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
  })
```
(`loadConfig` is already imported at the top of index.ts — reuse it. If the import name differs, match the existing import.)

- [ ] **Step 5: Run tests + build + lint** → PASS (`pnpm vitest run src/cli/commands/rdraExport.test.ts`, full `pnpm test`, `pnpm build`, `pnpm lint`). Verify `node dist/cli/index.js rdra-export --help` lists `--into`/`--scenario-dir`.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/rdraExport.ts src/cli/commands/rdraExport.test.ts src/cli/index.ts
git commit -m "feat(rdra): rdra-export CLI command + index wiring"
```

---

### Task 8: Docs + integration test + ledger

**Files:**
- Modify: `README.md`
- Create: `src/pipeline/rdraExport.integration.test.ts`
- Modify: `.superpowers/sdd/progress.md`

- [ ] **Step 1: README** — add a `### \`rdra-export\`` section under the commands: the cooperative mode-1 flow (`rdra-analyzer analyze` → `loop-e2e rdra-export` → rdra-analyzer reconcile → rdra/verify/gap), `--into`/`--scenario-dir`, that matched scenarios merge (tagged `LE-`, idempotent) and unmatched go to `loop-e2e-pending.json` for rdra-analyzer's reconcile, and that loop-e2e never writes a dangling `usecase_id`. Use placeholder paths only.

- [ ] **Step 2: Integration test** — write a real-fs round trip in a tmp dir: write a sample `analysis_result.json` (one usecase `/hotel`), run `rdraExport` with real io (only `loadScenarios` faked to return one matched + one unmatched scenario), assert the written file contains `LE-` scenario + is re-readable + `loop-e2e-pending.json` exists; run again and assert idempotency (no duplicate LE scenario).

```typescript
// src/pipeline/rdraExport.integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rdraExport } from './rdraExport.js'
import type { Scenario } from '../scenario/schema.js'

const scn = (id: string, target: string): Scenario => ({
  id, title: id, businessFlow: 'f',
  steps: [{ action: 'navigate', target, expectedOutcome: 'o' }],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }], expectedDbState: [],
})

describe('rdraExport (real fs round trip)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rdra-'))
    await mkdir(join(dir, 'usecases'), { recursive: true })
    await writeFile(join(dir, 'usecases', 'analysis_result.json'), JSON.stringify({ metadata: {}, usecases: [{ id: 'UC-1', name: 'hotel', related_routes: ['/hotel'] }], scenarios: [] }))
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('merges matched + writes pending + is idempotent', async () => {
    const into = join(dir, 'usecases', 'analysis_result.json')
    const deps = { loadScenarios: async () => [scn('grow-hotel', '/hotel'), scn('grow-booking', '/booking')] }
    const r1 = await rdraExport({ scenarioDir: '/unused', intoPath: into }, deps)
    expect(r1.matched).toBe(1)
    expect(r1.pending).toBe(1)
    const after1 = JSON.parse(await readFile(into, 'utf8'))
    expect(after1.scenarios.filter((s: { scenario_id: string }) => s.scenario_id === 'LE-grow-hotel')).toHaveLength(1)
    const pending = JSON.parse(await readFile(join(dir, 'usecases', 'loop-e2e-pending.json'), 'utf8'))
    expect(pending.pending[0].loop_e2e_id).toBe('grow-booking')

    const r2 = await rdraExport({ scenarioDir: '/unused', intoPath: into }, deps)
    expect(r2.replaced).toBe(1)
    const after2 = JSON.parse(await readFile(into, 'utf8'))
    expect(after2.scenarios.filter((s: { scenario_id: string }) => s.scenario_id === 'LE-grow-hotel')).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Verify full gates**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: build PASS, all tests pass (prior 405 + new, 4 skipped), lint PASS.

- [ ] **Step 4: Commit + ledger**

```bash
git add README.md src/pipeline/rdraExport.integration.test.ts
git commit -m "docs(rdra): document rdra-export; add integration round-trip test"
```

---

## Self-Review

**Spec coverage:** §2 rdra format → Task 1 types. §3 convert → Task 1. §4 match → Task 2. §5 merge → Task 3. §6 validate → Task 4. §7 pending handoff → Tasks 1 (PendingEntry/toPendingEntry) + 5 (writePending) + 6 (pipeline writes it). §8 pipeline → Task 6. §9 CLI → Task 7. §10 component layout → matches files across tasks. §11 error handling → Task 5 (read errors), Task 4/6 (validation-before-write), Task 6 (0 scenarios). §12 tests → unit per task + Task 8 integration. §13 staged order → Tasks 1-8. §14 reconcile contract → README (Task 8) + the /tmp contract already delivered. No gaps.

**Placeholder scan:** No TBD/"handle errors"/"similar to" — every step has concrete code or commands.

**Type consistency:** `OperationScenario`/`OperationStep`/`Usecase`/`AnalysisResult`/`PendingEntry`/`LE_PREFIX` defined in Task 1, consumed unchanged in Tasks 2-7. `toOperationScenario(scenario, {id,name})`, `matchUsecase(scenario, usecases)`, `mergeIntoAnalysisResult(analysis, leScenarios) → {analysis, replaced}`, `validateAnalysisResult(analysis): void`, `readAnalysisResult(path, deps)`, `rdraExport(args, deps) → RdraExportResult`, `runRdraExport(root, opts, deps)` are referenced identically across tasks. `firstNavigateTarget` (convert.ts) is reused by match.ts. `navigateRoutes` (match.ts) is used by the pipeline for pending entries.
