# システム跨ぎシナリオ（Phase3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** マルチアクト・シナリオに「複数ターゲット運用」と「capture の `url:`/`db:` 取得元」を配線し、システム跨ぎフローを1シナリオで検証可能にする。

**Architecture:** 1つの共有ページで各ターゲットの baseUrl へナビゲート（cookie はドメインごと）。`executeScenarios` に `resolveTarget`、`executeSteps` に `dbQuery` を注入。capture はスキーム（url:/db:/dom）で分岐。跨ぎ DB 検証は既存 `registeredData` を流用。

**Tech Stack:** TypeScript strict + ESM (NodeNext, `.js` 終端 import)、vitest、zod。

## Global Constraints

- TypeScript strict + ESM。intra-repo import は `.js` 終端。全外部I/O（browser/db/env）は注入可能。ユニットテストはモック。
- 秘密値・PIN・creds・捕捉値はマスク（`maskSecrets` は vars 値も対象＝Phase2 修正済み）。DB パスワードはログ/エラーに出さない（`createDbAdapter` 契約）。
- `{{NAME}}` は `[A-Z0-9_]+`。capture 失敗 detail は生 `step.target`（未解決）を表示し値を露出しない。
- 後方互換：flat・単一 act・単一ターゲットは挙動不変。既存スイート（現 563 pass / 5 skip）を壊さない。
- Test: `pnpm vitest run <path>`、build: `pnpm build`、lint: `pnpm lint`。

---

### Task 1: capture の取得元拡張（url:/db:/dom）

**Files:**
- Modify: `src/services/browser/scenarioExec.ts`
- Test: `src/services/browser/scenarioExec.test.ts`

**Interfaces:**
- Consumes: `Row`（services/db/adapter.js）。
- Produces: `ScenarioExecDeps.dbQuery?: (connection: string, sql: string) => Promise<Row[]>`。`captureValue(page, target, deps)` 内部関数。capture ケースが `captureValue` を使用。

- [ ] **Step 1: Write the failing test**

`src/services/browser/scenarioExec.test.ts` に追記（既存の `fakeCapturePage`/`capTarget`/`executeSteps` を流用）:

```typescript
describe('executeSteps capture sources (url: / db:)', () => {
  it('captures from the current URL with a regex group', async () => {
    const page = fakeCapturePage({ urlRef: { u: 'https://app.test/coupon/42' } })
    const vars: Record<string, string> = {}
    const r = await executeSteps(page, capTarget, [
      { action: 'capture', target: 'url:/coupon/(\\d+)', var: 'ID', expectedOutcome: 'id' },
    ], { vars })
    expect(r.ok).toBe(true)
    expect(vars.ID).toBe('42')
  })

  it('captures the whole URL when no regex is given', async () => {
    const page = fakeCapturePage({ urlRef: { u: 'https://app.test/x' } })
    const vars: Record<string, string> = {}
    await executeSteps(page, capTarget, [{ action: 'capture', target: 'url:', var: 'U', expectedOutcome: 'u' }], { vars })
    expect(vars.U).toBe('https://app.test/x')
  })

  it('fails a url capture when the regex does not match', async () => {
    const page = fakeCapturePage({ urlRef: { u: 'https://app.test/none' } })
    const r = await executeSteps(page, capTarget, [{ action: 'capture', target: 'url:/coupon/(\\d+)', var: 'ID', expectedOutcome: 'id' }], { vars: {} })
    expect(r.ok).toBe(false)
  })

  it('captures the first cell from a db: query with {{VAR}} resolved in the SQL', async () => {
    const page = fakeCapturePage()
    let seenSql = ''
    const dbQuery = vi.fn(async (_c: string, sql: string) => { seenSql = sql; return [{ id: 7 }] })
    const vars: Record<string, string> = { CODE: 'SUMMER25' }
    const r = await executeSteps(page, capTarget, [
      { action: 'capture', target: 'db:main:SELECT id FROM coupons WHERE code={{CODE}} LIMIT 1', var: 'CID', expectedOutcome: 'cid' },
    ], { vars, dbQuery })
    expect(r.ok).toBe(true)
    expect(vars.CID).toBe('7')
    expect(seenSql).toContain('SUMMER25')
    expect(dbQuery).toHaveBeenCalledWith('main', expect.stringContaining('SELECT id'))
  })

  it('fails a db: capture when no dbQuery is configured', async () => {
    const page = fakeCapturePage()
    const r = await executeSteps(page, capTarget, [{ action: 'capture', target: 'db:main:SELECT 1', var: 'X', expectedOutcome: 'x' }], { vars: {} })
    expect(r.ok).toBe(false)
  })

  it('fails a db: capture when the query returns no rows', async () => {
    const page = fakeCapturePage()
    const r = await executeSteps(page, capTarget, [{ action: 'capture', target: 'db:main:SELECT id', var: 'X', expectedOutcome: 'x' }], { vars: {}, dbQuery: async () => [] })
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/services/browser/scenarioExec.test.ts`
Expected: FAIL（`dbQuery`/url:/db: 未対応）。

- [ ] **Step 3: Implement `captureValue` + `dbQuery` dep**

`ScenarioExecDeps` に追加（`import type { Row } from '../db/adapter.js'` を先頭に）:
```typescript
  /** Run a read-only query against a named connection (for db: captures). */
  dbQuery?: (connection: string, sql: string) => Promise<Row[]>
```

`capture` ケースの `readCapture(page, stepTarget)` 呼び出しを `captureValue(page, stepTarget, deps)` に変更:
```typescript
        case 'capture': {
          if (!step.var) return fail(i, 'capture step requires `var`')
          const val = await captureValue(page, stepTarget, deps)
          if (val === null) return fail(i, `capture target not found: ${step.target}`)
          if (deps.vars) deps.vars[step.var] = val
          break
        }
```

`readCapture` の直前/直後に `captureValue` を追加:
```typescript
/**
 * Resolve a capture target by scheme:
 *  - `url:<regex?>`  → current URL (regex group 1, or whole match, or the whole URL)
 *  - `db:<conn>:<sql>` → first cell of the first row (sql already has {{VAR}} resolved)
 *  - otherwise         → DOM (input value → textContent)
 */
async function captureValue(page: PageLike, target: string, deps: ScenarioExecDeps): Promise<string | null> {
  if (target.startsWith('url:')) {
    const pat = target.slice(4)
    const url = page.url()
    if (!pat) return url
    const m = url.match(new RegExp(pat))
    return m ? (m[1] ?? m[0]) : null
  }
  if (target.startsWith('db:')) {
    const rest = target.slice(3)
    const sep = rest.indexOf(':')
    if (sep < 0) throw new Error('db: capture must be db:<connection>:<sql>')
    const connection = rest.slice(0, sep)
    const sql = rest.slice(sep + 1)
    if (!deps.dbQuery) throw new Error('db: capture requires a configured database connection')
    const rows = await deps.dbQuery(connection, sql)
    const first = rows[0]
    if (!first) return null
    const v = Object.values(first)[0]
    return v === null || v === undefined ? null : String(v)
  }
  return readCapture(page, target)
}
```

(`db:` の throw は外側 try/catch が `fail(i, err.message)` 化。`err.message` 内の解決済み SQL 値は `mask()`＝vars 値も対象でマスクされる。)

- [ ] **Step 4: Run tests + typecheck + lint**

Run: `pnpm vitest run src/services/browser/scenarioExec.test.ts && pnpm build && pnpm lint`
Expected: PASS / PASS / clean。

- [ ] **Step 5: Commit**

```bash
git add src/services/browser/scenarioExec.ts src/services/browser/scenarioExec.test.ts
git commit -m "feat(scenario-exec): capture sources url:/db: (in addition to DOM)"
```

---

### Task 2: マルチターゲット実行（runMultiAct の per-act ターゲット）

**Files:**
- Modify: `src/pipeline/executeScenarios.ts`
- Test: `src/pipeline/executeScenarios.test.ts`

**Interfaces:**
- Produces: `ExecuteScenariosDeps.resolveTarget?: (name: string) => { target: TargetEnv; creds: { username: string; password: string } } | undefined`。`runMultiAct` が act ごとに対象ターゲット/creds を解決し、`ensureAuth`/`executeSteps` に渡す。forceReauth は同一ターゲット上の identity 切替のみ。

- [ ] **Step 1: Write the failing test**

`src/pipeline/executeScenarios.test.ts` に追記（既存 `actScn` を流用、別ターゲットを使うシナリオを追加）:

```typescript
const crossScn = (): Scenario => ({
  id: 'cross', title: 'cross', businessFlow: 'f',
  personas: [
    { name: 'admin', target: 'admin', auth: 'authenticated' },
    { name: 'shopper', target: 'storefront', auth: 'authenticated' },
  ],
  acts: [
    { persona: 'admin', steps: [{ action: 'navigate', target: '/x', expectedOutcome: 'o' }] },
    { persona: 'shopper', steps: [{ action: 'navigate', target: '/buy', expectedOutcome: 'o' }] },
  ],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }], expectedDbState: [],
})

describe('executeScenarios multi-target', () => {
  const storefront = { name: 'storefront', baseUrl: 'https://shop.test', auth: { strategy: 'form', loginPath: '/login' } } as TargetEnv
  const resolveTarget = (name: string) =>
    name === 'admin' ? { target, creds } :
    name === 'storefront' ? { target: storefront, creds: { username: 's', password: 'sp' } } : undefined

  it('runs each act against its persona.target and does NOT force reauth across targets', async () => {
    const ensureAuthenticated = vi.fn(async () => ({ ok: true, detail: 'ok' }))
    const targetsSeen: string[] = []
    const executeSteps = vi.fn(async (_p: unknown, t: TargetEnv) => { targetsSeen.push(t.name); return { ok: true, detail: 'passed', finalUrl: 'u' } })
    const findings = await executeScenarios(page, target, [crossScn()], creds, { ensureAuthenticated, executeSteps, resolveTarget })
    expect(targetsSeen).toEqual(['admin', 'storefront'])
    // act 1 switches to a different target → no forceReauth
    const secondCall = ensureAuthenticated.mock.calls[1] as unknown as [unknown, TargetEnv, unknown, unknown, { forceReauth?: boolean }]
    expect(secondCall[1].name).toBe('storefront')
    expect(secondCall[4].forceReauth).toBe(false)
    expect(findings[0].severity).toBe('low')
  })

  it('fails with a clear finding when persona.target is not resolvable', async () => {
    const bad: Scenario = { ...crossScn(), personas: [{ name: 'admin', target: 'ghost', auth: 'authenticated' }], acts: [{ persona: 'admin', steps: [{ action: 'navigate', target: '/x', expectedOutcome: 'o' }] }] }
    const findings = await executeScenarios(page, target, [bad], creds, { ensureAuthenticated: vi.fn(async () => ({ ok: true, detail: 'ok' })), executeSteps: vi.fn(), resolveTarget: () => undefined })
    expect(findings[0].severity).toBe('high')
    expect(findings[0].detail).toMatch(/unknown target 'ghost'/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/pipeline/executeScenarios.test.ts`
Expected: FAIL（resolveTarget 未対応、per-act ターゲット未実装）。

- [ ] **Step 3: Update `executeScenarios.ts`**

`ExecuteScenariosDeps` に追加:
```typescript
    /** Resolve a persona's target name → its TargetEnv + credentials (built from config.targets). */
    resolveTarget?: (name: string) => { target: TargetEnv; creds: Creds } | undefined
```

`runMultiAct` のループ本体を置換（per-act ターゲット解決＋forceReauth 精緻化、deferredTarget ロジックは削除）:
```typescript
  const personas = new Map((scenario.personas ?? []).map((p) => [p.name, p]))
  const vars: Record<string, string> = { ...(deps.vars ?? {}) }
  const acts = scenario.acts ?? []
  let prevPersona: string | undefined
  let prevTargetName: string | undefined
  let lastUrl = ''

  for (let ai = 0; ai < acts.length; ai++) {
    const act = acts[ai]
    const persona = act.persona ? personas.get(act.persona) : undefined
    const label = `act ${ai} (persona ${persona?.name ?? '-'})`

    let actTarget = runTarget
    let baseCreds = runCreds
    if (persona?.target) {
      const resolved = deps.resolveTarget?.(persona.target)
      if (!resolved) {
        return scenarioFinding(scenario, false, `${label} unknown target '${persona.target}' (not in config.targets)`, lastUrl)
      }
      actTarget = resolved.target
      baseCreds = resolved.creds
    }

    const auth = persona?.auth ?? scenario.precondition?.auth ?? 'authenticated'
    let actSecrets = deps.secrets ?? []
    if (auth === 'authenticated') {
      const personaCreds = resolvePersonaCreds(persona, baseCreds, env)
      if (persona?.credEnv && (!personaCreds.username || !personaCreds.password)) {
        return scenarioFinding(
          scenario, false,
          `${label} persona credEnv not set (check ${persona.credEnv.usernameEnv}/${persona.credEnv.passwordEnv} in .env)`,
          lastUrl,
        )
      }
      actSecrets = [...(deps.secrets ?? []), personaCreds.username, personaCreds.password].filter(Boolean)
      // Re-login only when switching identity ON THE SAME target; a different target is a separate domain/session.
      const forceReauth = ai > 0 && actTarget.name === prevTargetName && persona?.name !== prevPersona
      const r = await ensureAuth(page, actTarget, personaCreds, firstNavOf(act.steps), { ...deps, secrets: actSecrets, forceReauth })
      if (!r.ok) {
        return scenarioFinding(scenario, false, `${label} auth failed: ${r.detail}`, lastUrl)
      }
    } else {
      await ensureUnauth(page, actTarget, deps)
    }
    prevPersona = persona?.name
    prevTargetName = actTarget.name

    const res = await exec(page, actTarget, act.steps, { ...deps, secrets: actSecrets, vars })
    lastUrl = res.finalUrl
    if (!res.ok) {
      return scenarioFinding(scenario, false, `${label} ${res.detail}`, res.finalUrl)
    }
    logger.info({ scenario: scenario.id, act: ai, persona: persona?.name, target: actTarget.name }, 'act executed')
  }

  const stepCount = acts.reduce((n, a) => n + a.steps.length, 0)
  return scenarioFinding(scenario, true, `passed (${acts.length} acts, ${stepCount} steps)`, lastUrl)
```

(`runMultiAct` の引数名は現状 `target`/`runCreds`。`runTarget` を使うため、シグネチャの `target: TargetEnv` を `runTarget: TargetEnv` にリネームし、呼び出し側 `runMultiAct(page, target, scenario, creds, deps)` はそのまま。`deferredTarget` 変数と末尾の note 追記は削除。)

- [ ] **Step 4: Run tests + full suite + lint**

Run: `pnpm vitest run src/pipeline/executeScenarios.test.ts && pnpm vitest run && pnpm build && pnpm lint`
Expected: 全 PASS、build/lint clean。

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/executeScenarios.ts src/pipeline/executeScenarios.test.ts
git commit -m "feat(run): per-act target resolution for cross-system multi-act scenarios"
```

---

### Task 3: 配線（resolveAdapter export ＋ run の resolveTarget/dbQuery）

**Files:**
- Modify: `src/pipeline/verify/registeredData.ts`（resolveAdapter を export）
- Modify: `src/cli/commands/run.ts`（buildTargetResolver/buildDbQuery 構築＋execDeps 配線＋close）
- Test: `src/cli/commands/run-wiring.test.ts`（新規）

**Interfaces:**
- Produces: `export function resolveAdapter(...)`。`buildTargetResolver(config, secrets)`、`buildDbQuery(config, dbSecrets, drivers?)`（`{ dbQuery, close }`）を run.ts から export。runScenarioStage が両者を execDeps に配線し、finally で adapter を close。

- [ ] **Step 1: Write the failing test**

`src/cli/commands/run-wiring.test.ts`（新規）:
```typescript
import { describe, it, expect, vi } from 'vitest'
import { buildTargetResolver, buildDbQuery } from './run.js'
import type { Config } from '../../config/schema.js'

const config = {
  targets: [
    { name: 'admin', baseUrl: 'https://admin.test', auth: { strategy: 'form', loginPath: '/login', usernameEnv: 'A_U', passwordEnv: 'A_P' } },
    { name: 'storefront', baseUrl: 'https://shop.test', auth: { strategy: 'form', loginPath: '/login', usernameEnv: 'S_U', passwordEnv: 'S_P' } },
  ],
  databases: [{ name: 'main', type: 'postgres', host: 'h', port: 5432, database: 'd', user: 'u', passwordEnv: 'DB_P' }],
} as unknown as Config

const secrets = { targetAuth: { A_U: 'a', A_P: 'ap', S_U: 's', S_P: 'sp' }, db: { DB_P: 'x' } } as never

describe('buildTargetResolver', () => {
  it('resolves a target name to TargetEnv + creds', () => {
    const r = buildTargetResolver(config, secrets)('storefront')
    expect(r?.target.baseUrl).toBe('https://shop.test')
    expect(r?.creds).toEqual({ username: 's', password: 'sp' })
  })
  it('returns undefined for an unknown or credential-less target', () => {
    expect(buildTargetResolver(config, secrets)('ghost')).toBeUndefined()
  })
})

describe('buildDbQuery', () => {
  it('lazily creates one adapter per connection and closes all', async () => {
    const query = vi.fn(async () => [{ id: 1 }])
    const close = vi.fn(async () => {})
    const createDbAdapter = vi.fn(() => ({ query, close }))
    const { dbQuery, close: closeAll } = buildDbQuery(config, { DB_P: 'x' }, undefined, createDbAdapter as never)
    await dbQuery!('main', 'SELECT 1')
    await dbQuery!('main', 'SELECT 2') // reuses the same adapter
    expect(createDbAdapter).toHaveBeenCalledTimes(1)
    await closeAll()
    expect(close).toHaveBeenCalledOnce()
  })
  it('returns undefined dbQuery when no databases are configured', () => {
    const { dbQuery } = buildDbQuery({ ...config, databases: [] } as Config, {}, undefined)
    expect(dbQuery).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/commands/run-wiring.test.ts`
Expected: FAIL（`buildTargetResolver`/`buildDbQuery` 未定義）。

- [ ] **Step 3: Export `resolveAdapter`**

`src/pipeline/verify/registeredData.ts`: `function resolveAdapter(` → `export function resolveAdapter(`。

- [ ] **Step 4: Add `buildTargetResolver` / `buildDbQuery` to `run.ts` and wire into `runScenarioStage`**

import を追加:
```typescript
import { resolveAdapter } from '../../pipeline/verify/registeredData.js'
import { createDbAdapter as defaultCreateDbAdapter, type DbDriverOptions } from '../../services/db/index.js'
import type { DbAdapter } from '../../services/db/adapter.js'
```

export ヘルパを追加（resolveCredentials の近く）:
```typescript
/** Build a persona-target resolver from config.targets + secrets (name → TargetEnv + creds). */
export function buildTargetResolver(
  config: RunContext['config'],
  secrets: RunContext['secrets'],
): (name: string) => { target: TargetEnv; creds: { username: string; password: string } } | undefined {
  return (name) => {
    const t = config.targets.find((x) => x.name === name)
    if (!t?.auth) return undefined
    const c = resolveCredentials(secrets, t.auth)
    if (!c) return undefined
    return {
      target: {
        name: t.name,
        baseUrl: t.baseUrl,
        auth: { strategy: t.auth.strategy, loginPath: t.auth.loginPath, username: c.username, password: c.password },
      },
      creds: c,
    }
  }
}

/** Build a lazy db query helper (one adapter per connection) for db: captures, plus a close-all. */
export function buildDbQuery(
  config: RunContext['config'],
  dbSecrets: Record<string, string>,
  drivers?: DbDriverOptions,
  createAdapter: typeof defaultCreateDbAdapter = defaultCreateDbAdapter,
): { dbQuery?: (connection: string, sql: string) => Promise<import('../../services/db/adapter.js').Row[]>; close: () => Promise<void> } {
  if (config.databases.length === 0) return { dbQuery: undefined, close: async () => {} }
  const adapters = new Map<string, DbAdapter>()
  const dbQuery = async (connection: string, sql: string) => {
    let a = adapters.get(connection)
    if (!a) {
      const conf = config.databases.find((d) => d.name === connection)
      if (!conf) throw new Error(`db: capture references unknown connection '${connection}'`)
      a = createAdapter(conf, dbSecrets[conf.passwordEnv] ?? '', drivers)
      adapters.set(connection, a)
    }
    return a.query(sql, [])
  }
  const close = async (): Promise<void> => {
    for (const a of adapters.values()) await a.close().catch(() => {})
  }
  return { dbQuery, close }
}
```

`runScenarioStage` の execDeps 構築と finally を更新:
```typescript
  const login = findLoginScenario(scenarios as LoadedScenario[], loginPath)
  const { dbQuery, close: closeDb } = buildDbQuery(ctx.config, ctx.secrets.db, deps.dbDrivers)
  const execDeps = {
    ...deps.scenarioExecDeps,
    twoFactor: login?.twoFactor,
    scriptDir: login?.scriptDir,
    resolveTarget: buildTargetResolver(ctx.config, ctx.secrets),
    dbQuery,
  }

  try {
    return await deps.executeScenarios(page, target, toRun, creds, execDeps)
  } catch (err) {
    logger.warn({ err: String(err) }, 'Scenario execution stage failed — continuing')
    return []
  } finally {
    await page.close?.().catch(() => {})
    await closeDb()
  }
```

(`resolveAdapter` は registeredData 側でそのまま使われ続ける。run 側は `buildDbQuery` が自前で `createAdapter` を呼ぶ — export した `resolveAdapter` は registeredData 内の利用のみで、run の dbQuery は config.databases から直接生成して接続名の解決を一元化する。`resolveAdapter` の export はテスト容易化と将来の共有のため。)

- [ ] **Step 5: Run tests + full suite + lint**

Run: `pnpm vitest run src/cli/commands/run-wiring.test.ts && pnpm vitest run && pnpm build && pnpm lint`
Expected: 全 PASS、build/lint clean。

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/verify/registeredData.ts src/cli/commands/run.ts src/cli/commands/run-wiring.test.ts
git commit -m "feat(run): wire resolveTarget + db: capture (dbQuery) into the scenario stage"
```

---

### Task 4: README（跨ぎ記法・運用）

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README にシステム跨ぎ節を追加**

マルチアクト・シナリオ節の直後に追記:

```markdown
#### システム跨ぎ（複数ターゲット）

`persona.target` に `config.targets` の別ターゲット名を指定すると、その段は別アプリ（別 `baseUrl`/
認証）で実行されます。1つのブラウザで各ドメインのセッションを保持するため、admin と storefront を
またぐフローを1シナリオで検証できます。`capture` は DOM に加え、現在 URL や別 DB から値を取れます。

​```yaml
personas:
  - { name: admin,   target: admin,      auth: authenticated }
  - { name: shopper, target: storefront, auth: authenticated, credEnv: { usernameEnv: SHOP_USER, passwordEnv: SHOP_PASS } }
acts:
  - persona: admin
    steps:
      - { action: navigate, target: /coupon/create, expectedOutcome: 作成フォーム }
      - { action: submit, target: 'button[type=submit]', expectedOutcome: 作成 }
      - { action: capture, target: 'url:/coupon/(\d+)', var: COUPON_ID, expectedOutcome: 採番ID }
      - { action: capture, target: 'db:main:SELECT code FROM coupons WHERE id={{COUPON_ID}} LIMIT 1', var: CODE, expectedOutcome: コード }
  - persona: shopper
    steps:
      - { action: navigate, target: /checkout, expectedOutcome: 購入画面 }
      - { action: fill, target: '[name=coupon]', input: '{{CODE}}', expectedOutcome: 適用 }
      - { action: assert, target: 'text=割引', expectedOutcome: 反映 }
expectedDbState:
  - { connection: storefront-db, table: orders, match: { coupon_code: '{{CODE}}' }, expectedValues: { status: paid } }
​```

- `capture` 取得元：`'<selector>'`（DOM）、`'url:<regex?>'`（現在 URL のグループ1/全体）、
  `'db:<connection>:<sql>'`（別 DB の先頭セル。`{{VAR}}` は SQL 内でも解決。read-only 用途）。
- 跨ぎ `expectedDbState` は対象 DB を `config.databases` に追加すれば既存の検証ステージが照合します。
- 段の境界で**ターゲットが変わると再ログインしません**（別ドメインで独立セッション）。同一ターゲット上で
  人格だけ変わる場合のみ再ログインします。
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document cross-system scenarios (persona.target, url:/db: capture)"
```

---

## Self-Review

**Spec coverage:**
- §2 マルチターゲット（resolveTarget・per-act・forceReauth 精緻化・未解決失敗）→ Task 2。✅
- §3 capture url:/db:（dbQuery・captureValue）→ Task 1。✅
- §4 跨ぎ DB 検証（既存 registeredData）→ 追加実装不要、README 明記（Task 4）。✅
- §5 配線（resolveAdapter export・resolveTarget/dbQuery 構築・close）→ Task 3。✅
- §6 エラー/セキュリティ（未解決・0行・マスク・DB パスワード）→ Task 1/2/3。✅
- §7 テスト戦略 → 各 Task。✅
- §9 ロードマップ（grow ジャーニー＝Phase4）→ 対象外。✅

**Placeholder scan:** なし。各 step に完全コード/具体差分。

**Type consistency:** `dbQuery: (connection, sql) => Promise<Row[]>`（Task1 で ScenarioExecDeps、Task3 の buildDbQuery が同型を返す）。`resolveTarget: (name) => { target; creds } | undefined`（Task2 で型定義、Task3 の buildTargetResolver が一致）。`Creds` は executeScenarios.ts の既存 type。`resolveAdapter` export は registeredData の既存シグネチャ不変。

**Note:** Task1/2 は後方互換（既存 flat/単一 act は不変）。Task2 の `runMultiAct` 引数リネーム（target→runTarget）は内部のみ。Task3 完了で全スイート緑を担保。
