# マルチアクト・シナリオ（Phase2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** シナリオを「段（act）ごとにペルソナのセッションを確立して実行＋段間データ受け渡し（capture/`{{VAR}}`）」へ拡張する（同一 run ターゲット上での identity 切替）。

**Architecture:** `steps↔acts` 排他スキーマ（flat steps は単一 act の糖衣、`toActs()`/`allSteps()` で吸収）。実行は `executeSteps` コア（capture＋target の `{{VAR}}` 解決）を新設し、`executeScenarios` を multi-act ループ化（act ごとに persona セッション切替＋共有 vars バッグ）。

**Tech Stack:** TypeScript strict + ESM (NodeNext, `.js` 終端 import)、vitest、zod。

## Global Constraints

- TypeScript strict + ESM。intra-repo import は `.js` 終端。Immutability（共有 vars バッグはスレッド渡しのアキュムレータとして可）。
- 全外部I/O（browser/llm/shell/env）は注入可能。ユニットテストはモック。
- 秘密値・PIN・ペルソナ creds は detail/ログでマスク。**capture 値は detail に出さない**（失敗メッセージは未解決の生 target=`{{VAR}}` を表示）。
- `{{NAME}}` プレースホルダ名は `[A-Z0-9_]+`（capture の `var` も大文字）。解決順：`{{VAR}}`（バッグ）→ `{{ENV}}`（vars/process.env）→ `{{TWO_FACTOR_PIN}}`（pinCommand）。未解決はステップ失敗（値は露出しない）。
- Phase2 は **run ターゲット限定**。`persona.target` が run 以外を指す場合は warn して run ターゲットで実行（解決は Phase3）。
- 後方互換：flat `steps` の既存シナリオ・テストは挙動不変。既存スイート（現 546 pass / 5 skip）を壊さない。
- Test: `pnpm vitest run <path>`、build: `pnpm build`、lint: `pnpm lint`。

---

### Task 1: スキーマ（Persona/Act・steps↔acts 排他・var）＋ toActs/allSteps ＋ readers 移行

**Files:**
- Modify: `src/scenario/schema.ts`
- Modify: `src/scenario/loginScenario.ts`, `src/services/grow/coverage.ts`, `src/services/browser/crawler.ts`, `src/services/browser/login.ts`, `src/services/rdra/match.ts`, `src/services/rdra/validate.ts`, `src/services/rdra/convert.ts`
- Test: `src/scenario/schema.test.ts`

**Interfaces:**
- Produces: `PersonaSchema`/`Persona`, `ActSchema`/`Act`, `ScenarioStep.var?: string`, `ScenarioSchema`（steps optional＋acts/personas＋superRefine）, `toActs(scenario): Act[]`, `allSteps(scenario): ScenarioStep[]`.

- [ ] **Step 1: Write the failing test**

`src/scenario/schema.test.ts` に追記（無ければ作成、先頭に `import { describe, it, expect } from 'vitest'` と `import { ScenarioSchema, toActs, allSteps } from './schema.js'`）:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/scenario/schema.test.ts`
Expected: FAIL（`toActs`/`allSteps` 未定義、新スキーマ未対応）。

- [ ] **Step 3: Update `schema.ts`**

`ScenarioStepSchema` に `var` を追加:
```typescript
export const ScenarioStepSchema = z.object({
  action: z.string().min(1),
  target: z.string().min(1),
  input: z.string().optional(),
  var: z.string().optional(),
  expectedOutcome: z.string().min(1),
})
```

`PreconditionSchema` の直後に Persona/Act を追加:
```typescript
// --- Persona (multi-act): a named actor with its own session (target reserved for Phase3) ---
export const PersonaSchema = z.object({
  name: z.string().min(1),
  target: z.string().optional(),
  auth: z.enum(['authenticated', 'unauthenticated']),
  loginPath: z.string().optional(),
  credEnv: z.object({ usernameEnv: z.string().min(1), passwordEnv: z.string().min(1) }).optional(),
})
export type Persona = z.infer<typeof PersonaSchema>

// --- Act: a persona-scoped block of steps within a multi-act scenario ---
export const ActSchema = z.object({
  persona: z.string().optional(),
  steps: z.array(ScenarioStepSchema).min(1),
})
export type Act = z.infer<typeof ActSchema>
```

`ScenarioSchema` を置換（steps optional＋acts/personas＋superRefine）:
```typescript
export const ScenarioSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    businessFlow: z.string().min(1),
    steps: z.array(ScenarioStepSchema).min(1).optional(),
    acts: z.array(ActSchema).min(1).optional(),
    personas: z.array(PersonaSchema).optional(),
    expectedResults: z.array(ExpectedResultSchema).min(1),
    expectedDbState: z.array(ExpectedDbStateSchema),
    precondition: PreconditionSchema.optional(),
    twoFactor: ScenarioTwoFactorSchema.optional(),
  })
  .superRefine((s, ctx) => {
    if ((s.steps !== undefined) === (s.acts !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'scenario must have exactly one of `steps` or `acts`' })
    }
    const names = new Set((s.personas ?? []).map((p) => p.name))
    for (const act of s.acts ?? []) {
      if (act.persona !== undefined && !names.has(act.persona)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `act references unknown persona: ${act.persona}` })
      }
    }
    for (const st of [...(s.steps ?? []), ...(s.acts ?? []).flatMap((a) => a.steps)]) {
      if (st.action === 'capture' && !st.var) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'capture step requires `var`' })
      }
    }
  })
```

`export type Scenario = z.infer<typeof ScenarioSchema>` の直後にヘルパを追加:
```typescript
/** Acts of a scenario: explicit `acts`, or flat `steps` as one implicit (persona-less) act. */
export function toActs(scenario: Scenario): Act[] {
  return scenario.acts ?? [{ steps: scenario.steps ?? [] }]
}

/** All steps of a scenario, flattened across acts. */
export function allSteps(scenario: Scenario): ScenarioStep[] {
  return toActs(scenario).flatMap((a) => a.steps)
}
```

- [ ] **Step 4: Migrate `scenario.steps` readers to `allSteps()`**

各ファイルで `allSteps` を import（`import { allSteps } from '<rel>/scenario/schema.js'`）し、`scenario.steps`／`s.steps` の読み取りを `allSteps(scenario)`／`allSteps(s)` に置換:

- `src/scenario/loginScenario.ts:12` `scenario.steps.some(...)` → `allSteps(scenario).some(...)`、`:21` 同様。
- `src/services/grow/coverage.ts:13` `for (const step of scenario.steps)` → `for (const step of allSteps(scenario))`。
- `src/services/browser/crawler.ts:150` 同様。
- `src/services/browser/login.ts:338` 同様。
- `src/services/rdra/match.ts:50` `scenario.steps.filter(...)` → `allSteps(scenario).filter(...)`。
- `src/services/rdra/validate.ts:17` `s.steps.forEach((step, i) => ...)` → `allSteps(s).forEach((step, i) => ...)`。
- `src/services/rdra/convert.ts:8` `scenario.steps.find(...)` → `allSteps(scenario).find(...)`、`:57` `scenario.steps.map(...)` → `allSteps(scenario).map(...)`。

- [ ] **Step 5: Run tests + typecheck + lint**

Run: `pnpm vitest run src/scenario/schema.test.ts && pnpm build && pnpm lint`
Expected: PASS / PASS / clean。

- [ ] **Step 6: Commit**

```bash
git add src/scenario/schema.ts src/scenario/schema.test.ts src/scenario/loginScenario.ts src/services/grow/coverage.ts src/services/browser/crawler.ts src/services/browser/login.ts src/services/rdra/match.ts src/services/rdra/validate.ts src/services/rdra/convert.ts
git commit -m "feat(scenario): multi-act schema (personas/acts/capture var) + toActs/allSteps"
```

---

### Task 2: `executeSteps` コア（capture＋target の `{{VAR}}` 解決）＋ `executeScenario` ラッパ化

**Files:**
- Modify: `src/services/browser/scenarioExec.ts`
- Modify: `src/services/browser/crawler.ts`（PageLike.locator に textContent/inputValue）
- Test: `src/services/browser/scenarioExec.test.ts`

**Interfaces:**
- Produces: `StepsResult = { ok; failedStepIndex?; detail; finalUrl }`, `executeSteps(page, target, steps: ScenarioStep[], deps?): Promise<StepsResult>`。`executeScenario` は `executeSteps` を呼ぶラッパ（戻り値 `ScenarioRunResult` 不変）。`ScenarioExecDeps.vars` は可変共有バッグ。

- [ ] **Step 1: Write the failing test**

`src/services/browser/scenarioExec.test.ts` に追記（既存の `scn`/フェイク page を流用。新規フェイク locator が必要なら下記）:

```typescript
import { executeSteps } from './scenarioExec.js'

function fakePage(opts: { captures?: Record<string, string>; contentRef?: { html: string }; urlRef?: { u: string } } = {}) {
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
      count: async () => (opts.captures && sel in opts.captures ? 1 : 1),
      textContent: async () => opts.captures?.[sel] ?? null,
      inputValue: async () => '',
    }),
  } as never
}

describe('executeSteps capture + {{VAR}}', () => {
  const target = { name: 'admin', baseUrl: 'https://app.test', auth: { strategy: 'form', loginPath: '/login' } } as never

  it('captures a value into the shared vars bag and resolves {{VAR}} in a later assert target', async () => {
    const content = { html: '' }
    const page = fakePage({ captures: { '[data-code]': 'SUMMER25' }, contentRef: content })
    const vars: Record<string, string> = {}
    // capture writes COUPON; then make the page content contain it so the assert passes
    content.html = 'order discount SUMMER25 applied'
    const r = await executeSteps(page, target, [
      { action: 'capture', target: '[data-code]', var: 'COUPON', expectedOutcome: 'got code' },
      { action: 'assert', target: 'text={{COUPON}}', expectedOutcome: 'shown' },
    ], { vars })
    expect(vars.COUPON).toBe('SUMMER25')
    expect(r.ok).toBe(true)
  })

  it('fails a capture when the target is not found', async () => {
    const page = fakePage({ captures: {} })
    const r = await executeSteps(page, target, [
      { action: 'capture', target: '#missing', var: 'X', expectedOutcome: 'x' },
    ], { vars: {} })
    expect(r.ok).toBe(false)
    expect(r.failedStepIndex).toBe(0)
  })

  it('does not leak a captured value into the failure detail (shows raw {{VAR}})', async () => {
    const content = { html: 'nothing here' }
    const page = fakePage({ captures: { '[data-code]': 'SECRET-CODE' }, contentRef: content })
    const r = await executeSteps(page, target, [
      { action: 'capture', target: '[data-code]', var: 'COUPON', expectedOutcome: 'c' },
      { action: 'assert', target: 'text={{COUPON}}', expectedOutcome: 'shown' },
    ], { vars: {} })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('{{COUPON}}')
    expect(r.detail).not.toContain('SECRET-CODE')
  })
})
```

(注: `count` は selector が `captures` にあるとき要素ありとして 1 を返す。`#missing` も 1 を返すが `textContent`→null で capture 失敗になるため、`fakePage` の `count` を `sel in (opts.captures ?? {}) ? 1 : 0` に変えてもよい。実装者は missing が null/0 のどちらでも capture 失敗になるよう `readCapture` を実装すること。)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/services/browser/scenarioExec.test.ts`
Expected: FAIL（`executeSteps` 未定義 / capture 未対応）。

- [ ] **Step 3: Extend `PageLike.locator`**

`src/services/browser/crawler.ts` の `PageLike.locator` 戻り値型に追加:
```typescript
  locator: (selector: string) => {
    fill: (value: string) => Promise<void>
    click: () => Promise<void>
    count?: () => Promise<number>
    textContent?: () => Promise<string | null>
    inputValue?: () => Promise<string>
  }
```

- [ ] **Step 4: Refactor `scenarioExec.ts` — extract `executeSteps`, add capture, resolve `{{VAR}}` in targets**

`ScenarioRunResult` の下に `StepsResult` を追加し、`executeScenario` の switch ループを `executeSteps` に移設。`executeScenario` はラッパ化:

```typescript
export type StepsResult = { ok: boolean; failedStepIndex?: number; detail: string; finalUrl: string }

/**
 * Execute a list of steps on a live page with a shared (mutable) vars bag.
 * `capture` writes `vars[step.var]`; `{{VAR}}`/`{{ENV}}`/`{{TWO_FACTOR_PIN}}` are resolved in
 * BOTH input and target. Failure detail shows the RAW (unresolved) target so captured/secret
 * values never leak. Secrets are masked.
 */
export async function executeSteps(
  page: PageLike,
  target: TargetEnv,
  steps: ScenarioStep[],
  deps: ScenarioExecDeps = {},
): Promise<StepsResult> {
  const baseUrl = target.baseUrl
  const secrets = deps.secrets ?? []
  const navTimeoutMs = deps.navTimeoutMs ?? 8000
  const sleep = deps.sleep ?? defaultSleep
  const intervalMs = 250
  const attempts = Math.max(1, Math.ceil(navTimeoutMs / intervalMs))
  const mask = (s: string): string => maskSecrets(s, secrets)

  const fail = (i: number, why: string): StepsResult => ({
    ok: false,
    failedStepIndex: i,
    detail: mask(`step ${i} (${steps[i]?.action}) failed: ${why}`),
    finalUrl: page.url(),
  })

  for (let i = 0; i < steps.length; i++) {
    const step: ScenarioStep = steps[i]
    try {
      const stepTarget = await resolveInput(step.target, deps) // resolve {{VAR}}/{{ENV}} in the target too
      switch (step.action) {
        case 'navigate': {
          await page.goto(resolveUrl(baseUrl, stepTarget), { waitUntil: 'domcontentloaded', timeout: 30_000 })
          await page.waitForLoadState('networkidle')
          break
        }
        case 'click': {
          await page.locator(stepTarget).click()
          break
        }
        case 'fill': {
          await page.locator(stepTarget).fill(await resolveInput(step.input, deps))
          break
        }
        case 'submit': {
          const before = page.url()
          await page.locator(stepTarget).click()
          await page.waitForLoadState('networkidle')
          for (let a = 0; a < attempts; a++) {
            if (page.url() !== before) break
            await sleep(intervalMs)
          }
          break
        }
        case 'wait': {
          const ok = await pollCondition(page, stepTarget, attempts, intervalMs, sleep)
          if (!ok) return fail(i, `wait condition not met: ${step.target}`)
          break
        }
        case 'assert': {
          const ok = await checkCondition(page, stepTarget)
          if (!ok) return fail(i, `assertion not satisfied: ${step.target}`)
          break
        }
        case 'capture': {
          if (!step.var) return fail(i, 'capture step requires `var`')
          const val = await readCapture(page, stepTarget)
          if (val === null) return fail(i, `capture target not found: ${step.target}`)
          if (deps.vars) deps.vars[step.var] = val
          break
        }
        default:
          return fail(i, `unsupported action: ${step.action}`)
      }
    } catch (err) {
      return fail(i, err instanceof Error ? err.message : String(err))
    }
  }
  logger.info({ finalUrl: page.url() }, 'steps passed')
  return { ok: true, detail: `passed (${steps.length} steps)`, finalUrl: page.url() }
}

/** Read a capture target: input value first, then trimmed textContent; null if absent/empty. */
async function readCapture(page: PageLike, selector: string): Promise<string | null> {
  const loc = page.locator(selector)
  if (loc.count && (await loc.count()) === 0) return null
  if (loc.inputValue) {
    try {
      const v = await loc.inputValue()
      if (v !== '') return v
    } catch {
      /* not an input — fall through to textContent */
    }
  }
  if (loc.textContent) {
    const t = await loc.textContent()
    if (t !== null && t.trim() !== '') return t.trim()
  }
  return null
}
```

`executeScenario` を置換（ラッパ）:
```typescript
export async function executeScenario(
  page: PageLike,
  target: TargetEnv,
  scenario: Scenario,
  deps: ScenarioExecDeps = {},
): Promise<ScenarioRunResult> {
  const execDeps: ScenarioExecDeps = {
    ...deps,
    pinCommand: scenario.twoFactor?.pinCommand ?? deps.pinCommand,
    scriptDir: (scenario as LoadedScenario).scriptDir ?? deps.scriptDir,
  }
  const r = await executeSteps(page, target, scenario.steps ?? [], execDeps)
  return { scenarioId: scenario.id, ...r }
}
```

(既存の `checkCondition`/`pollCondition`/`resolveUrl`/`resolveInput`/`defaultSleep` はそのまま。`logger.info` の旧 `'scenario passed'` 行は executeSteps の `'steps passed'` に統合。)

- [ ] **Step 5: Run tests + typecheck + lint**

Run: `pnpm vitest run src/services/browser/scenarioExec.test.ts && pnpm build && pnpm lint`
Expected: PASS（capture/`{{VAR}}` の新テスト＋既存テスト）/ PASS / clean。

- [ ] **Step 6: Commit**

```bash
git add src/services/browser/scenarioExec.ts src/services/browser/crawler.ts src/services/browser/scenarioExec.test.ts
git commit -m "feat(scenario-exec): executeSteps core with capture + {{VAR}} target resolution"
```

---

### Task 3: `session.ts` に `forceReauth`（identity 切替の再ログイン）

**Files:**
- Modify: `src/services/browser/session.ts`
- Test: `src/services/browser/session.test.ts`

**Interfaces:**
- Produces: `SessionDeps.forceReauth?: boolean`。true のとき `ensureAuthenticated` は probe 前に `clearCookies` でセッションを破棄し、必ず再ログインする。

- [ ] **Step 1: Write the failing test**

`src/services/browser/session.test.ts` に追記:
```typescript
it('forceReauth clears the session and re-authenticates even if a session exists', async () => {
  const clearCookies = vi.fn(async () => {})
  const authenticate = vi.fn(async () => ({ ok: true, detail: 'logged in', finalUrl: 'https://app.test/' }))
  // page lands on the login path after cookies are cleared → triggers authenticate
  let cleared = false
  const page = {
    goto: async () => {},
    url: () => (cleared ? 'https://app.test/login' : 'https://app.test/'),
    waitForLoadState: async () => {},
  } as never
  const clear = vi.fn(async () => { cleared = true })
  const r = await ensureAuthenticated(
    page,
    { name: 'a', baseUrl: 'https://app.test', auth: { strategy: 'form', loginPath: '/login' } } as never,
    { username: 'u', password: 'p' }, '/',
    { forceReauth: true, clearCookies: clear, authenticate },
  )
  expect(clear).toHaveBeenCalledOnce()
  expect(authenticate).toHaveBeenCalledOnce()
  expect(r.ok).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/services/browser/session.test.ts`
Expected: FAIL（forceReauth 未対応 → clearCookies/authenticate 未呼び出し）。

- [ ] **Step 3: Add `forceReauth` to `session.ts`**

`SessionDeps` に追加:
```typescript
export type SessionDeps = LoginDeps & {
  authenticate?: (
    page: PageLike,
    target: TargetEnv,
    creds: { username: string; password: string },
    deps?: LoginDeps,
  ) => Promise<LoginResult>
  clearCookies?: (page: PageLike) => Promise<void>
  /** Drop the current session before probing so a different identity re-logs in. */
  forceReauth?: boolean
}
```

`ensureAuthenticated` の probe 直前に追加:
```typescript
  const loginPath = target.auth?.loginPath ?? '/login'
  const base = target.baseUrl.replace(/\/$/, '')
  const probe = /^https?:\/\//i.test(probePath) ? probePath : `${base}/${probePath.replace(/^\//, '')}`

  if (deps.forceReauth && deps.clearCookies) {
    await deps.clearCookies(page) // drop current identity so the probe redirects to login
  }

  await page.goto(probe, { waitUntil: 'domcontentloaded', timeout: 30_000 })
```

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `pnpm vitest run src/services/browser/session.test.ts && pnpm build && pnpm lint`
Expected: PASS / PASS / clean。

- [ ] **Step 5: Commit**

```bash
git add src/services/browser/session.ts src/services/browser/session.test.ts
git commit -m "feat(session): forceReauth to switch identity between acts"
```

---

### Task 4: `executeScenarios` を multi-act 化（persona セッション切替＋共有 vars＋集約）

**Files:**
- Modify: `src/pipeline/executeScenarios.ts`
- Test: `src/pipeline/executeScenarios.test.ts`

**Interfaces:**
- Consumes: `executeSteps`/`StepsResult`（Task 2）、`session.forceReauth`（Task 3）、`Persona`/`Act`（Task 1）。
- Produces: `ExecuteScenariosDeps` に `executeSteps?`・`secretsEnv?: Record<string,string|undefined>`。`resolvePersonaCreds(persona, runCreds, env)` を export。multi-act シナリオは act ごとに persona セッションを確立し共有 vars で実行、1件の `VerifyFinding` に集約。

- [ ] **Step 1: Write the failing test**

`src/pipeline/executeScenarios.test.ts` に追記:
```typescript
import { resolvePersonaCreds } from './executeScenarios.js'

const actScn = (id: string): Scenario => ({
  id, title: id, businessFlow: 'f',
  personas: [
    { name: 'creator', auth: 'authenticated' },
    { name: 'verifier', auth: 'authenticated', credEnv: { usernameEnv: 'REV_U', passwordEnv: 'REV_P' } },
  ],
  acts: [
    { persona: 'creator', steps: [{ action: 'navigate', target: '/coupon/create', expectedOutcome: 'o' }, { action: 'capture', target: '#code', var: 'COUPON', expectedOutcome: 'o' }] },
    { persona: 'verifier', steps: [{ action: 'assert', target: 'text={{COUPON}}', expectedOutcome: 'o' }] },
  ],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }], expectedDbState: [],
})

describe('executeScenarios multi-act', () => {
  it('runs each act with its persona session, sharing the vars bag, and forces reauth on identity change', async () => {
    const ensureAuthenticated = vi.fn(async () => ({ ok: true, detail: 'ok' }))
    const seenVars: Array<Record<string, string>> = []
    const executeSteps = vi.fn(async (_p: unknown, _t: unknown, steps: unknown, deps: { vars?: Record<string, string> }) => {
      // creator act captures; record the shared bag identity each call
      if (deps.vars) { deps.vars.COUPON = deps.vars.COUPON ?? 'SUMMER25'; seenVars.push(deps.vars) }
      return { ok: true, detail: 'passed (n steps)', finalUrl: 'https://app.test/x' }
    })
    const findings = await executeScenarios(page, target, [actScn('flow')], creds, {
      ensureAuthenticated, executeSteps, secretsEnv: { REV_U: 'r', REV_P: 'pw' },
    })
    expect(ensureAuthenticated).toHaveBeenCalledTimes(2)
    // identity changes creator→verifier on the 2nd act → forceReauth true
    expect(ensureAuthenticated.mock.calls[1][4].forceReauth).toBe(true)
    // same shared vars object across acts
    expect(seenVars[0]).toBe(seenVars[1])
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('low')
    expect(findings[0].detail).toContain('acts')
  })

  it('maps a failed act to a high finding naming the act and persona', async () => {
    const executeSteps = vi.fn(async () => ({ ok: false, failedStepIndex: 0, detail: 'step 0 (assert) failed', finalUrl: 'https://app.test/x' }))
    const findings = await executeScenarios(page, target, [actScn('flow')], creds, {
      ensureAuthenticated: vi.fn(async () => ({ ok: true, detail: 'ok' })), executeSteps, secretsEnv: { REV_U: 'r', REV_P: 'pw' },
    })
    expect(findings[0].severity).toBe('high')
    expect(findings[0].detail).toMatch(/act 0 \(persona creator\)/)
  })
})

describe('resolvePersonaCreds', () => {
  it('uses credEnv from env when present, else run creds', () => {
    expect(resolvePersonaCreds({ name: 'v', auth: 'authenticated', credEnv: { usernameEnv: 'U', passwordEnv: 'P' } } as never, creds, { U: 'x', P: 'y' })).toEqual({ username: 'x', password: 'y' })
    expect(resolvePersonaCreds(undefined, creds, {})).toEqual(creds)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/pipeline/executeScenarios.test.ts`
Expected: FAIL（`resolvePersonaCreds`/multi-act 未実装）。

- [ ] **Step 3: Implement multi-act in `executeScenarios.ts`**

import を追加:
```typescript
import { executeScenario as defaultExecuteScenario, executeSteps as defaultExecuteSteps } from '../services/browser/scenarioExec.js'
import type { Scenario, Persona } from '../scenario/schema.js'
```

`ExecuteScenariosDeps` に追加:
```typescript
export type ExecuteScenariosDeps = ScenarioExecDeps &
  SessionDeps & {
    executeScenario?: typeof defaultExecuteScenario
    executeSteps?: typeof defaultExecuteSteps
    ensureAuthenticated?: typeof defaultEnsureAuth
    ensureUnauthenticated?: typeof defaultEnsureUnauth
    /** env source for persona credEnv resolution (defaults to process.env) */
    secretsEnv?: Record<string, string | undefined>
  }
```

`firstNavigateTarget` を steps-optional 安全に:
```typescript
function firstNavigateTarget(s: Scenario): string {
  const nav = (s.steps ?? []).find((st) => st.action === 'navigate')
  return nav?.target ?? '/'
}
function firstNavOf(steps: Scenario['steps'] & object): string {
  return steps.find((st) => st.action === 'navigate')?.target ?? '/'
}
```

`resolvePersonaCreds` と `scenarioFinding` を追加:
```typescript
export function resolvePersonaCreds(
  persona: Persona | undefined,
  runCreds: { username: string; password: string },
  env: Record<string, string | undefined>,
): { username: string; password: string } {
  if (persona?.credEnv) {
    return { username: env[persona.credEnv.usernameEnv] ?? '', password: env[persona.credEnv.passwordEnv] ?? '' }
  }
  return runCreds
}

function scenarioFinding(scenario: Scenario, ok: boolean, detail: string, finalUrl: string): VerifyFinding {
  const unverified = scenario.expectedResults.filter((e) => e.kind === 'api' || e.kind === 'db')
  let d = detail
  if (ok && unverified.length > 0) {
    d += ` | unverified expectedResults (needs LLM/manual): ${unverified.map((e) => `${e.kind}:${e.assertion}`).join('; ')}`
  }
  return { category: 'scenario', severity: ok ? 'low' : 'high', title: scenario.title, detail: d, evidence: `${scenario.id} @ ${finalUrl}` }
}
```

`runMultiAct` を追加:
```typescript
async function runMultiAct(
  page: PageLike,
  target: TargetEnv,
  scenario: Scenario,
  runCreds: { username: string; password: string },
  deps: ExecuteScenariosDeps,
): Promise<VerifyFinding> {
  const exec = deps.executeSteps ?? defaultExecuteSteps
  const ensureAuth = deps.ensureAuthenticated ?? defaultEnsureAuth
  const ensureUnauth = deps.ensureUnauthenticated ?? defaultEnsureUnauth
  const env = deps.secretsEnv ?? process.env
  const personas = new Map((scenario.personas ?? []).map((p) => [p.name, p]))
  const vars: Record<string, string> = {}
  const acts = scenario.acts ?? []
  let prevPersona: string | undefined

  for (let ai = 0; ai < acts.length; ai++) {
    const act = acts[ai]
    const persona = act.persona ? personas.get(act.persona) : undefined
    if (persona?.target && persona.target !== target.name) {
      logger.warn({ scenario: scenario.id, persona: persona.name, target: persona.target },
        'multi-act: persona.target other than the run target is deferred to Phase3 — using run target')
    }
    const auth = persona?.auth ?? scenario.precondition?.auth ?? 'authenticated'
    const firstNav = firstNavOf(act.steps)
    if (auth === 'authenticated') {
      const creds = resolvePersonaCreds(persona, runCreds, env)
      const actSecrets = [...(deps.secrets ?? []), creds.username, creds.password].filter(Boolean)
      const forceReauth = ai > 0 && persona?.name !== prevPersona
      const r = await ensureAuth(page, target, creds, firstNav, { ...deps, secrets: actSecrets, forceReauth })
      if (!r.ok) {
        return scenarioFinding(scenario, false, `act ${ai} (persona ${persona?.name ?? '-'}) auth failed: ${r.detail}`, page.url())
      }
      prevPersona = persona?.name
      const res = await exec(page, target, act.steps, { ...deps, secrets: actSecrets, vars })
      if (!res.ok) {
        return scenarioFinding(scenario, false, `act ${ai} (persona ${persona?.name ?? '-'}) ${res.detail}`, res.finalUrl)
      }
    } else {
      await ensureUnauth(page, target, deps)
      prevPersona = persona?.name
      const res = await exec(page, target, act.steps, { ...deps, vars })
      if (!res.ok) {
        return scenarioFinding(scenario, false, `act ${ai} (persona ${persona?.name ?? '-'}) ${res.detail}`, res.finalUrl)
      }
    }
  }
  const stepCount = acts.reduce((n, a) => n + a.steps.length, 0)
  return scenarioFinding(scenario, true, `passed (${acts.length} acts, ${stepCount} steps)`, page.url())
}
```

`executeScenarios` のループ先頭で multi-act を分岐（既存 flat 経路は `scenarioFinding` を使うよう DRY 化）:
```typescript
  for (const scenario of scenarios) {
    if (scenario.acts && scenario.acts.length > 0) {
      findings.push(await runMultiAct(page, target, scenario, creds, deps))
      continue
    }

    const auth = scenario.precondition?.auth
    if (auth === 'authenticated') {
      if (authBlocked) continue
      const r = await ensureAuth(page, target, creds, firstNavigateTarget(scenario), deps)
      if (!r.ok) {
        authBlocked = true
        findings.push({
          category: 'scenario', severity: 'high', title: 'authentication failed',
          detail: `could not establish a session for authenticated scenarios: ${r.detail}`, evidence: scenario.id,
        })
        continue
      }
    } else if (auth === 'unauthenticated') {
      await ensureUnauth(page, target, deps)
    }
    const result = await exec(page, target, scenario, deps)
    findings.push(scenarioFinding(scenario, result.ok, result.detail, result.finalUrl))
    logger.info({ scenario: scenario.id, ok: result.ok }, 'scenario executed')
  }
  return findings
```
(注: 既存テスト「maps a failed scenario to a high finding」は detail に `boom` を含むこと、成功は severity low を検証。`scenarioFinding` はこれを満たす。)

- [ ] **Step 4: Run tests + full suite + lint**

Run: `pnpm vitest run src/pipeline/executeScenarios.test.ts && pnpm vitest run && pnpm build && pnpm lint`
Expected: 全 PASS、build/lint clean。

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/executeScenarios.ts src/pipeline/executeScenarios.test.ts
git commit -m "feat(run): multi-act scenario execution with per-act persona sessions + shared vars"
```

---

### Task 5: README（記法・例）

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README にマルチアクト節を追加**

シナリオ記法の節に以下を追記:

```markdown
### マルチアクト・シナリオ（複数アクターのフロー）

1シナリオで複数の人格（persona）が順に操作するフローを表現できます。`personas` でアクターを宣言し、
`acts` で人格ごとの手順ブロックを並べます。段の境界で人格が変わると再ログインします。`capture` で
DOM の値を変数に取り込み、後続ステップで `{{VAR}}`（大文字）として参照できます（input と target の両方）。

​```yaml
id: admin-create-then-verify
title: 管理者が作成し、別人格が確認
businessFlow: 管理者がクーポンを作成し、別の管理者が一覧で確認する
personas:
  - { name: creator,  auth: authenticated }
  - { name: verifier, auth: authenticated, credEnv: { usernameEnv: REVIEWER_USER, passwordEnv: REVIEWER_PASS } }
acts:
  - persona: creator
    steps:
      - { action: navigate, target: /coupon/create, expectedOutcome: フォーム表示 }
      - { action: fill, target: '[name=code]', input: SUMMER25, expectedOutcome: 入力 }
      - { action: submit, target: 'button[type=submit]', expectedOutcome: 作成完了 }
      - { action: capture, target: '[data-testid=coupon-code]', var: COUPON, expectedOutcome: コード取得 }
  - persona: verifier
    steps:
      - { action: navigate, target: /coupon, expectedOutcome: 一覧表示 }
      - { action: assert, target: 'text={{COUPON}}', expectedOutcome: 作成済みが見える }
expectedResults:
  - { kind: ui, description: クーポンが一覧に出る, assertion: 'text={{COUPON}}' }
expectedDbState: []
​```

- `steps`（フラット・単一アクター）と `acts`（マルチアクター）は**排他**。`steps` の既存シナリオはそのまま動きます。
- `capture` の取得元は **DOM のみ**（現状）。同一 run ターゲット上での人格切替に対応（別アプリ跨ぎは今後対応）。
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document multi-act scenarios (personas/acts/capture/{{VAR}})"
```

---

## Self-Review

**Spec coverage:**
- §2 スキーマ（Persona/Act/var/steps↔acts refine/toActs）→ Task 1。✅
- §3.1 executeSteps（capture・target の `{{VAR}}` 解決・マスク）→ Task 2。✅
- §3.2 multi-act 実行（persona セッション切替・共有 vars・forceReauth・resolvePersonaCreds）→ Task 3＋4。✅
- §3.3 結果集約（act/persona/step 明記）→ Task 4。✅
- §4 エラー/セキュリティ（refine 違反・未解決・capture 値非露出・persona.target warn）→ Task 1/2/4。✅
- §5 テスト戦略 → 各 Task。✅
- §7 Phase3 ロードマップ → 対象外（spec 記載）。✅

**Placeholder scan:** なし。各 step に完全コード/具体差分。

**Type consistency:** `executeSteps`/`StepsResult`（Task2）を Task4 が同一シグネチャで使用。`toActs`/`allSteps`/`Persona`/`Act`（Task1）を Task4 が使用。`forceReauth`（Task3 の SessionDeps）を Task4 が `ensureAuth` 呼び出しで渡す。`resolvePersonaCreds(persona, runCreds, env)` を Task4 で定義しテストと一致。`ScenarioStep.var` を Task1 で追加し Task2 の capture で参照。

**Note:** Task1 は readers 移行込みで build green に保つ。Task2〜4 の中間 build は基本 green（後方互換）。Task4 完了で全スイート緑を担保。
