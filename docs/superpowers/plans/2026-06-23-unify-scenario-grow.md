# scenario と grow の統一（Phase1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `scenario` と `grow` を1つの `grow` コマンドに統合し、静的（ソース/要件/git）＋動的（クロール）の両方からアプリ理解を構築して検証シナリオを提案する。

**Architecture:** 提案ステップ `proposeScenarios` を、未カバーページ（動的）＋要件コンテキスト（静的）を融合する `ProposeInput` 対応に拡張。`grow` パイプラインに `--source-only`/`--crawl-only` 分岐と `collectRequirements` 注入を追加。`scenario` は `grow --source-only` の薄いエイリアスに。全提案は `proposed/` ドラフトへ。

**Tech Stack:** TypeScript strict + ESM (NodeNext, `.js` 拡張)、vitest、zod、commander。

## Global Constraints

- TypeScript strict + ESM。intra-repo import は `.js` 終端。
- Immutability：入力を破壊しない。
- 全外部I/O（browser/llm/repo/shell）は注入可能。ユニットテストはモック（実 LLM/ブラウザ/リポジトリ不要）。
- 秘密値は detail/ログ/レポートでマスク（既存の挙動を維持）。
- LLM ロールは `'planning'|'report'|'verification'` のみ。提案は `'planning'`。
- 提案シナリオ id は `grow-` プレフィックス＋ファイル名安全スラッグ＋ユニーク化（既存 `normalizeIds` 流用）。
- 全提案は `proposed/`（`saveProposedScenario`）へ。`approve` で採用。
- 既存スイートを壊さない（現 545 pass / 5 skip）。Test 実行: `pnpm vitest run <path>`、build: `pnpm build`、lint: `pnpm lint`。

---

### Task 1: proposeScenarios を融合提案（ProposeInput）に拡張

**Files:**
- Modify: `src/services/llm/proposeScenarios.ts`
- Modify: `src/services/llm/prompts/propose.ts`
- Test: `src/services/llm/proposeScenarios.test.ts`

**Interfaces:**
- Consumes: `RawPage`, `PageInfo`（domain/types）、`RequirementContext`（repo/reader.js）、`AuthHint`（prompts/scenario.js）、`generateScenarios`（scenarioGen.js）、`buildProposePrompt`。
- Produces:
  - `ProposeInput = { uncovered: RawPage[]; requirements: RequirementContext[]; authHint?: AuthHint }`
  - `proposeScenarios(llm: Llm, input: ProposeInput, deps?: ProposeDeps): Promise<Scenario[]>`（**シグネチャ変更**）
  - `ProposeDeps = { extractPageInfo?; generateScenarios?; batchSize? }`
  - `summarizeRequirements(reqs: RequirementContext[], maxChars?: number): string`
  - `buildProposePrompt(pages: PageInfo[], requirementsSummary?: string): string`（**引数追加**）

- [ ] **Step 1: Write the failing test**

`src/services/llm/proposeScenarios.test.ts` を新シグネチャに書き換え（全文）:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { proposeScenarios, summarizeRequirements } from './proposeScenarios.js'
import type { Llm } from './client.js'
import type { RawPage, PageInfo } from '../../domain/types.js'
import type { Scenario } from '../../scenario/schema.js'
import type { RequirementContext } from '../repo/reader.js'

const rawPage = (url: string): RawPage => ({ url, title: 't', html: '', meta: {}, screenshotPath: '' })
const pageInfo = (url: string): PageInfo => ({
  url, title: 'Hotel list', description: 'list of hotels',
  displayItems: [{ type: 'table', label: 'hotels' }],
  inputItems: [], expectations: ['shows hotels'], capabilities: ['view hotels'],
})
const scn = (id: string): Scenario => ({
  id, title: 'T', businessFlow: 'f',
  steps: [{ action: 'navigate', target: '/x', expectedOutcome: 'o' }],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }], expectedDbState: [],
})
const req = (name: string): RequirementContext => ({
  repo: { name, label: name, url: `https://github.com/o/${name}`, role: 'frontend', audience: 'user' },
  readme: 'README body', docs: [], codeSummary: 'function buy(){}', gitlogSummary: 'abc feat: buy',
})

describe('summarizeRequirements', () => {
  it('returns a bounded summary including repo names', () => {
    const s = summarizeRequirements([req('web')], 2000)
    expect(s).toContain('web')
    expect(s.length).toBeLessThanOrEqual(2000)
  })
  it('returns empty string for no requirements', () => {
    expect(summarizeRequirements([])).toBe('')
  })
})

describe('proposeScenarios', () => {
  it('returns [] when neither uncovered pages nor requirements are given', async () => {
    const llm = { complete: vi.fn() } as unknown as Llm
    const result = await proposeScenarios(llm, { uncovered: [], requirements: [] })
    expect(result).toEqual([])
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('proposes from uncovered pages only (crawl), grow-prefixing ids', async () => {
    const extractPageInfo = vi.fn(async (_l: Llm, r: RawPage) => pageInfo(r.url))
    const llm = { complete: vi.fn(async () => [scn('hotel')]) } as unknown as Llm
    const result = await proposeScenarios(llm, { uncovered: [rawPage('http://x/hotel')], requirements: [] }, { extractPageInfo })
    expect(extractPageInfo).toHaveBeenCalledTimes(1)
    expect(result[0].id).toMatch(/^grow-/)
  })

  it('proposes from requirements only (source) via generateScenarios', async () => {
    const generateScenarios = vi.fn(async () => [scn('buy-flow')])
    const llm = { complete: vi.fn() } as unknown as Llm
    const result = await proposeScenarios(llm, { uncovered: [], requirements: [req('web')] }, { generateScenarios })
    expect(generateScenarios).toHaveBeenCalledOnce()
    expect(llm.complete).not.toHaveBeenCalled() // page path not taken
    expect(result[0].id).toMatch(/^grow-/)
  })

  it('fuses both: page proposals carry the source summary, plus source-derived flows; ids deduped', async () => {
    const extractPageInfo = vi.fn(async (_l: Llm, r: RawPage) => pageInfo(r.url))
    let pagePrompt = ''
    const llm = { complete: vi.fn(async (_role: string, prompt: string) => { pagePrompt = prompt; return [scn('grow-hotel')] }) } as unknown as Llm
    const generateScenarios = vi.fn(async () => [scn('grow-hotel')]) // same id → dedup
    const result = await proposeScenarios(
      llm,
      { uncovered: [rawPage('http://x/hotel')], requirements: [req('web')] },
      { extractPageInfo, generateScenarios },
    )
    expect(pagePrompt).toContain('web') // source summary fused into the page prompt
    expect(generateScenarios).toHaveBeenCalledOnce()
    expect(result.map((s) => s.id)).toEqual(['grow-hotel', 'grow-hotel-2']) // combined + deduped
  })

  it('isolates a failing page batch but still returns source-derived scenarios', async () => {
    const extractPageInfo = vi.fn(async (_l: Llm, r: RawPage) => pageInfo(r.url))
    const llm = { complete: vi.fn(async () => { throw new Error('truncated') }) } as unknown as Llm
    const generateScenarios = vi.fn(async () => [scn('src')])
    const result = await proposeScenarios(
      llm,
      { uncovered: [rawPage('http://x/a')], requirements: [req('web')] },
      { extractPageInfo, generateScenarios },
    )
    expect(result.map((s) => s.id)).toEqual(['grow-src'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/services/llm/proposeScenarios.test.ts`
Expected: FAIL（`summarizeRequirements` 未定義、シグネチャ不一致）。

- [ ] **Step 3: Extend `buildProposePrompt`**

`src/services/llm/prompts/propose.ts` の関数シグネチャに任意のソース要約を追加し、本文に挿入:

```typescript
export function buildProposePrompt(pages: PageInfo[], requirementsSummary = ''): string {
  const sections = pages.map(buildPageSection).join('\n\n')
  const sourceBlock = requirementsSummary
    ? `\n\n--- RELEVANT SOURCE / REQUIREMENTS CONTEXT (for richer, more functional scenarios) ---\n\n${requirementsSummary}\n`
    : ''

  return `You are an expert QA engineer. The user is ALREADY LOGGED IN to an admin
application. Below are pages that were discovered by crawling the app after login
and which no existing test scenario covers yet. Propose one end-to-end test
scenario per page that exercises that page's primary purpose (viewing its key
data and/or performing its main action). Use the source/requirements context (if
provided) to make the scenarios reflect real business flows.

Each scenario must be a JSON object with this exact structure:
{
  "id": "grow-<short-kebab-slug-of-the-page>",
  "title": "<short descriptive title>",
  "businessFlow": "<one or two sentences describing the user journey, assuming already logged in>",
  "steps": [
    { "action": "<navigate|click|fill|submit|wait|assert>", "target": "<selector or URL path>", "input": "<optional value>", "expectedOutcome": "<what should happen>" }
  ],
  "expectedResults": [
    { "kind": "<ui|api|db|email|log>", "description": "<what is expected>", "assertion": "<how to verify>" }
  ],
  "expectedDbState": []
}

Rules:
- The FIRST step of every scenario must be a "navigate" to the discovered page's path.
- Assume the session is already authenticated — do NOT include login steps.
- NEVER include real credentials, passwords, tokens, or personal data — use placeholders.
- Each scenario needs at least 2 steps and at least 1 expectedResult.
- IDs must be unique and start with "grow-".
- Respond with a JSON array of scenario objects ONLY — no markdown, no prose.

--- DISCOVERED PAGES ---

${sections}
${sourceBlock}
--- END ---

Respond with a JSON array of scenario objects.`
}
```

（`buildPageSection` は変更なし。）

- [ ] **Step 4: Rewrite `proposeScenarios`**

`src/services/llm/proposeScenarios.ts`（先頭の import から `proposeScenarios` まで全置換、`chunk`/`normalizeIds`/`slugify` は既存のまま残す）:

```typescript
import { z } from 'zod'
import { ScenarioSchema, type Scenario } from '../../scenario/schema.js'
import { buildProposePrompt } from './prompts/propose.js'
import { generateScenarios as defaultGenerateScenarios } from './scenarioGen.js'
import { extractPageInfo as defaultExtractPageInfo } from './structureExtract.js'
import { logger } from '../../util/logger.js'
import type { Llm } from './client.js'
import type { RawPage, PageInfo } from '../../domain/types.js'
import type { RequirementContext } from '../repo/reader.js'
import type { AuthHint } from './prompts/scenario.js'

const ScenarioArraySchema = z.array(ScenarioSchema)

/** Default number of pages proposed per LLM call. */
const DEFAULT_BATCH_SIZE = 5

/** Inputs to a unified proposal: dynamic (crawl) + static (source/requirements). Either may be empty. */
export type ProposeInput = {
  uncovered: RawPage[]
  requirements: RequirementContext[]
  authHint?: AuthHint
}

export type ProposeDeps = {
  /** Override page-info extraction for testing */
  extractPageInfo?: (llm: Llm, raw: RawPage) => Promise<PageInfo>
  /** Override source-derived scenario generation for testing */
  generateScenarios?: (llm: Llm, contexts: RequirementContext[], authHint?: AuthHint) => Promise<Scenario[]>
  /** Pages per LLM proposal call. Bounds the response size so it isn't truncated (default 5). */
  batchSize?: number
}

/** Brief, bounded summary of source/requirement context to fuse into page-proposal prompts. */
export function summarizeRequirements(reqs: RequirementContext[], maxChars = 2000): string {
  if (reqs.length === 0) return ''
  const parts = reqs.map((r) => {
    const head = `### ${r.repo.name} (${r.repo.role}/${r.repo.audience})`
    const readme = r.readme ? r.readme.slice(0, 400) : ''
    const code = r.codeSummary ? r.codeSummary.slice(0, 600) : ''
    return [head, readme, code].filter(Boolean).join('\n')
  })
  return parts.join('\n\n').slice(0, maxChars)
}

/**
 * Propose E2E scenarios (Opus) by fusing two understanding sources:
 *  (a) crawl — one+ scenarios per uncovered page, batched (bounded response), with a brief
 *      source summary fused into the prompt for more functional scenarios;
 *  (b) source — functional flows derived from repository requirements/code (generateScenarios).
 * Page extraction, each page batch, and the source proposal fail independently — one failure
 * skips that unit instead of aborting. Returned ids are normalized (unique, `grow-` prefixed).
 */
export async function proposeScenarios(
  llm: Llm,
  input: ProposeInput,
  deps: ProposeDeps = {},
): Promise<Scenario[]> {
  const { uncovered, requirements, authHint } = input
  if (uncovered.length === 0 && requirements.length === 0) return []

  const extract = deps.extractPageInfo ?? defaultExtractPageInfo
  const generate = deps.generateScenarios ?? defaultGenerateScenarios
  const batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE)
  const reqSummary = summarizeRequirements(requirements)

  const proposed: Scenario[] = []

  // (a) page-derived proposals (crawl) — fused with the brief source summary
  if (uncovered.length > 0) {
    logger.info({ count: uncovered.length, batchSize, withSource: Boolean(reqSummary) }, 'Proposing scenarios for uncovered pages')
    const pageInfos: PageInfo[] = []
    for (const raw of uncovered) {
      try {
        pageInfos.push(await extract(llm, raw))
      } catch (err) {
        logger.warn({ err: String(err), url: raw.url }, 'page-info extraction failed — skipping page')
      }
    }
    for (const batch of chunk(pageInfos, batchSize)) {
      try {
        const prompt = buildProposePrompt(batch, reqSummary)
        const scenarios = await llm.complete('planning', prompt, ScenarioArraySchema)
        proposed.push(...scenarios)
      } catch (err) {
        logger.warn({ err: String(err), pages: batch.map((p) => p.url), size: batch.length }, 'scenario proposal batch failed — skipping batch')
      }
    }
  }

  // (b) source-derived proposals (requirements/code → functional flows)
  if (requirements.length > 0) {
    try {
      proposed.push(...(await generate(llm, requirements, authHint)))
    } catch (err) {
      logger.warn({ err: String(err) }, 'source-derived scenario proposal failed — skipping')
    }
  }

  const normalized = normalizeIds(proposed)
  logger.info({ count: normalized.length }, 'Scenarios proposed')
  return normalized
}
```

（`chunk`, `normalizeIds`, `slugify` は既存の定義をそのまま残す。）

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run src/services/llm/proposeScenarios.test.ts && pnpm build`
Note: `build` は grow パイプライン側の旧シグネチャ呼び出しで失敗する可能性あり（Task 2 で解消）。proposeScenarios の単体テストが PASS することを確認。

- [ ] **Step 6: Commit**

```bash
git add src/services/llm/proposeScenarios.ts src/services/llm/prompts/propose.ts src/services/llm/proposeScenarios.test.ts
git commit -m "feat(grow): fuse crawl + source into proposeScenarios (ProposeInput)"
```

---

### Task 2: grow パイプラインに source-only/crawl-only ＋ collectRequirements

**Files:**
- Modify: `src/pipeline/grow.ts`
- Test: `src/pipeline/grow.test.ts`

**Interfaces:**
- Consumes: `proposeScenarios`（Task 1 の新シグネチャ）、`collectRequirements`/`RequirementContext`（repo/reader.js）、`AuthHint`（prompts/scenario.js）。
- Produces:
  - `GrowArgs` に `sourceOnly?: boolean; crawlOnly?: boolean; fromPaths?: string[]` を追加。
  - `GrowDeps`：`proposeScenarios` の型を新シグネチャに、`collectRequirements` を追加。
  - `GrowResult` に `mode: 'full'|'source'|'crawl'; requirementsRepos: number` を追加。

- [ ] **Step 1: Write the failing test**

`src/pipeline/grow.test.ts` を更新（`makeDeps` と各テスト）。冒頭の `proposeScenarios`/`collectRequirements` を追加し、3テストを追記。既存テストの `proposeScenarios` 呼び出し検証は新シグネチャに合わせる。最小の追加テスト:

```typescript
// 既存 import に追記:
import type { RequirementContext } from '../services/repo/reader.js'

const reqCtx = (name: string): RequirementContext => ({
  repo: { name, label: name, url: `https://github.com/o/${name}`, role: 'frontend', audience: 'user' },
  readme: '', docs: [], codeSummary: 'code', gitlogSummary: 'log',
})

// makeDeps に追加するデフォルト:
//   proposeScenarios: vi.fn(async () => [scenario('grow-x')]),
//   collectRequirements: vi.fn(async () => [reqCtx('web')]),

describe('grow modes', () => {
  it('source-only: skips auth/crawl, collects requirements, proposes', async () => {
    const deps = makeDeps()
    const res = await grow({ ...args, sourceOnly: true }, deps)
    expect(deps.authenticate).not.toHaveBeenCalled()
    expect(deps.discoverPages).not.toHaveBeenCalled()
    expect(deps.collectRequirements).toHaveBeenCalledOnce()
    expect(res.mode).toBe('source')
    const [, input] = (deps.proposeScenarios as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(input.uncovered).toEqual([])
    expect(input.requirements.length).toBe(1)
  })

  it('crawl-only: authenticates + crawls, does NOT collect requirements', async () => {
    const deps = makeDeps()
    const res = await grow({ ...args, crawlOnly: true }, deps)
    expect(deps.authenticate).toHaveBeenCalledOnce()
    expect(deps.collectRequirements).not.toHaveBeenCalled()
    expect(res.mode).toBe('crawl')
    const [, input] = (deps.proposeScenarios as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(input.requirements).toEqual([])
  })

  it('full (default): does both and passes both into proposeScenarios', async () => {
    const deps = makeDeps()
    const res = await grow(args, deps)
    expect(deps.authenticate).toHaveBeenCalledOnce()
    expect(deps.collectRequirements).toHaveBeenCalledOnce()
    expect(res.mode).toBe('full')
    const [, input] = (deps.proposeScenarios as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(input.uncovered.length).toBeGreaterThanOrEqual(0)
    expect(input.requirements.length).toBe(1)
  })
})
```

既存テスト「returns proposed scenarios」等の `proposeScenarios` 呼び出しは `(llm, input)` 形になる点に注意（`expect(deps.proposeScenarios).toHaveBeenCalled()` 系はそのまま通る）。

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/pipeline/grow.test.ts`
Expected: FAIL（`sourceOnly`/`collectRequirements`/`mode` 未対応）。

- [ ] **Step 3: Update `grow.ts`**

型と `grow()` 本体を更新:

```typescript
// 追加 import:
import type { RequirementContext } from '../services/repo/reader.js'
import type { ProposeInput } from '../services/llm/proposeScenarios.js'
import type { AuthHint } from '../services/llm/prompts/scenario.js'

// GrowArgs に追加:
//   sourceOnly?: boolean
//   crawlOnly?: boolean
//   fromPaths?: string[]

// GrowDeps の proposeScenarios を変更し collectRequirements を追加:
//   proposeScenarios: (llm: Llm, input: ProposeInput) => Promise<Scenario[]>
//   collectRequirements: (
//     repos: Config['repositories'],
//     deps: { llm: Llm; token: string; root: string; ingestion: Config['ingestion']; fromPaths?: string[] },
//   ) => Promise<RequirementContext[]>

// GrowResult を変更:
export type GrowResult = {
  discovered: number
  uncovered: number
  proposed: Scenario[]
  mode: 'full' | 'source' | 'crawl'
  requirementsRepos: number
}
```

`grow()` 本体（全置換）:

```typescript
export async function grow(args: GrowArgs, deps: GrowDeps): Promise<GrowResult> {
  const { config, root, scenarioDir, target, creds } = args
  const sourceOnly = Boolean(args.sourceOnly)
  const crawlOnly = Boolean(args.crawlOnly)
  const mode: GrowResult['mode'] = sourceOnly ? 'source' : crawlOnly ? 'crawl' : 'full'

  if (!args.skipPrepare && deps.prepare) {
    logger.info({ root }, 'grow: prepare phase starting')
    await deps.prepare(config, root, { secrets: deps.secrets, gitToken: deps.gitToken })
    logger.info({ root }, 'grow: prepare phase complete')
  }

  const existing = await deps.loadScenarios(scenarioDir)

  // --- static understanding (source) ---
  let requirements: RequirementContext[] = []
  if (!crawlOnly) {
    try {
      requirements = await deps.collectRequirements(config.repositories, {
        llm: deps.llm,
        token: deps.gitToken ?? '',
        root,
        ingestion: config.ingestion,
        fromPaths: args.fromPaths,
      })
    } catch (err) {
      logger.warn({ err: String(err) }, 'grow: requirement collection failed — continuing without source context')
    }
  }

  // --- dynamic understanding (crawl) ---
  let uncovered: RawPage[] = []
  let discoveredCount = 0
  if (!sourceOnly) {
    const page = await deps.createPage()
    const login = findLoginScenario(existing, target.auth?.loginPath)
    logger.info({ target: target.name }, 'grow: authenticating')
    const auth = await deps.authenticate(page, target, creds, {
      pinRunner: deps.pinRunner,
      secrets: deps.secrets,
      twoFactor: login?.twoFactor,
      scriptDir: login?.scriptDir,
    })
    if (!auth.ok) {
      throw new Error(`grow: authentication failed: ${auth.detail}`)
    }
    const discovered = await deps.discoverPages(page, target, config.grow ?? DEFAULT_GROW)
    discoveredCount = discovered.length
    uncovered = deps.findUncoveredPages(discovered, existing)
    logger.info({ discovered: discovered.length, uncovered: uncovered.length }, 'grow: coverage analyzed')
  }

  // --- unified proposal ---
  const authHint: AuthHint | undefined = target.auth?.loginPath ? { loginPath: target.auth.loginPath } : undefined
  const proposed = await deps.proposeScenarios(deps.llm, { uncovered, requirements, authHint })

  const existingIds = new Set(existing.map((s) => s.id))
  const fresh = proposed.filter((s) => !existingIds.has(s.id))
  for (const scenario of fresh) {
    await deps.saveProposedScenario(scenarioDir, scenario)
  }
  logger.info({ proposed: fresh.length, mode }, 'grow: proposed scenarios saved')

  return { discovered: discoveredCount, uncovered: uncovered.length, proposed: fresh, mode, requirementsRepos: requirements.length }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run src/pipeline/grow.test.ts && pnpm build`
Note: build は CLI 配線（Task 3）の旧シグネチャで失敗しうる。grow.test の PASS を確認。

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/grow.ts src/pipeline/grow.test.ts
git commit -m "feat(grow): source-only/crawl-only modes + collectRequirements fusion"
```

---

### Task 3: CLI `grow`（フラグ＋配線＋ブラウザ条件化）

**Files:**
- Modify: `src/cli/commands/grow.ts`
- Modify: `src/cli/index.ts`
- Test: `src/cli/commands/grow.test.ts`

**Interfaces:**
- Consumes: `runGrow`（grow command）、`collectRequirements`、`proposeScenarios`。
- Produces: `RunGrowOpts` に `sourceOnly?: boolean; crawlOnly?: boolean; fromPaths?: string[]`。`runGrow` が両フラグを `GrowArgs` に通し、`sourceOnly` ではブラウザ非起動。

- [ ] **Step 1: Write the failing test**

`src/cli/commands/grow.test.ts` に追記:

```typescript
it('source-only: passes sourceOnly to grow and does not require a browser/createPage', async () => {
  const growFn = vi.fn(async () => ({ discovered: 0, uncovered: 0, proposed: [], mode: 'source' as const, requirementsRepos: 1 }))
  const deps = makeDeps({ grow: growFn })
  await runGrow('/base', { sourceOnly: true }, deps)
  const [growArgs] = growFn.mock.calls[0]
  expect(growArgs.sourceOnly).toBe(true)
})

it('rejects source-only + crawl-only together', async () => {
  const deps = makeDeps()
  await expect(runGrow('/base', { sourceOnly: true, crawlOnly: true }, deps)).rejects.toThrow(/both/i)
})
```

（`makeDeps` の `grow` デフォルトの戻り値に `mode: 'crawl' as const, requirementsRepos: 0` を追加して型を満たす。）

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/commands/grow.test.ts`
Expected: FAIL（sourceOnly 未伝播・相互排他チェック無し）。

- [ ] **Step 3: Update `grow.ts` (command)**

```typescript
// RunGrowOpts に追加:
//   sourceOnly?: boolean; crawlOnly?: boolean; fromPaths?: string[]

// runGrow 冒頭（load 後）に相互排他チェック:
//   if (opts.sourceOnly && opts.crawlOnly) throw new Error('grow: --source-only and --crawl-only cannot both be set')

// RunGrowDeps に collectRequirements を追加（注入。省略時は実装を default import）:
//   collectRequirements?: typeof import('../../services/repo/reader.js').collectRequirements

// growFn(...) 呼び出しの GrowArgs に sourceOnly/crawlOnly/fromPaths を渡す。
// grow pipeline deps に collectRequirements を渡す（deps.collectRequirements ?? 実装）。
```

`runGrow` の該当箇所（GrowArgs と deps への配線）を更新:

```typescript
  const startedAt = new Date().toISOString()
  const result = await growFn(
    { config: growConfig, root, scenarioDir, target: envTarget, creds, skipPrepare: opts.skipPrepare,
      sourceOnly: opts.sourceOnly, crawlOnly: opts.crawlOnly, fromPaths: opts.fromPaths },
    { ...deps, collectRequirements: deps.collectRequirements ?? defaultCollectRequirements, secrets: allSecrets, gitToken: secrets.githubToken },
  )
```

（`defaultCollectRequirements` は `import { collectRequirements as defaultCollectRequirements } from '../../services/repo/reader.js'`。activity の summary に `mode` を含める: `proposed N scenarios (mode <mode>, discovered D, uncovered U, source-repos R)`。）

- [ ] **Step 4: Update `index.ts` (grow command registration + wiring)**

```typescript
// grow コマンドに option 追加:
  .option('--source-only', 'Use only repository source/requirements (no live crawl)')
  .option('--crawl-only', 'Use only the live crawl (no source/requirements)')
// action 引数に sourceOnly?/crawlOnly? を受け、runGrow opts に渡す。
// deps に collectRequirements を渡す:
  const { collectRequirements } = await import('../services/repo/reader.js')
// runGrow deps へ collectRequirements を追加。
// sourceOnly のときブラウザ起動をスキップ:
  let browserCtx = null
  const browser = opts.sourceOnly ? null : (browserCtx = await launchBrowser()).browser
  // createPage は browser ? () => browser.newPage() : async () => { throw new Error('createPage unused in --source-only') }
// 出力に result.mode を含める。
```

具体配線（grow action の try ブロック先頭付近を、ブラウザ条件化に変更）:

```typescript
    let browserCtx: { browser: import('../services/browser/crawler.js').BrowserLike } | null = null
    try {
      const browser = opts.sourceOnly ? null : (browserCtx = await launchBrowser()).browser
      const result = await runGrow(
        cwd,
        { target: opts.target, maxPages: opts.maxPages, skipPrepare: opts.skipPrepare,
          sourceOnly: opts.sourceOnly, crawlOnly: opts.crawlOnly },
        {
          prepare,
          createPage: () => browser ? browser.newPage() : Promise.reject(new Error('createPage is not available in --source-only')),
          authenticate,
          discoverPages,
          findUncoveredPages,
          proposeScenarios,
          collectRequirements,
          loadScenarios,
          saveProposedScenario,
          llm,
          pinRunner: defaultComposeRunner,
          appendActivity,
        },
      )
      process.stdout.write(
        `grow(${result.mode}): discovered ${result.discovered} / uncovered ${result.uncovered} / ` +
          `source-repos ${result.requirementsRepos} → proposed ${result.proposed.length} → ${config.scenarioDir}/proposed/\n`,
      )
    } catch (err) {
      ...
    } finally {
      if (browserCtx) await browserCtx.browser.close().catch(() => {})
    }
```

（`collectRequirements`/`proposeScenarios` の dynamic import 行を grow action の import 群に追加。）

- [ ] **Step 5: Run tests + typecheck + lint**

Run: `pnpm vitest run src/cli/commands/grow.test.ts && pnpm build && pnpm lint`
Expected: PASS / PASS / clean。

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/grow.ts src/cli/index.ts src/cli/commands/grow.test.ts
git commit -m "feat(grow): --source-only/--crawl-only CLI flags + collectRequirements wiring"
```

---

### Task 4: `scenario` を `grow --source-only` のエイリアスに

**Files:**
- Modify: `src/cli/commands/scenario.ts`
- Modify: `src/cli/index.ts`
- Test: `src/cli/commands/scenario.test.ts`

**Interfaces:**
- Consumes: `runGrow`（grow command）。
- Produces: `runScenario(root, opts, deps)` が内部で `runGrow(root, { sourceOnly: true, fromPaths: opts.from }, growDeps)` を呼ぶ薄いラッパー（deprecated 警告）。

- [ ] **Step 1: Write the failing test**

`src/cli/commands/scenario.test.ts` を書き換え（runGrow 注入で検証）:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { runScenario } from './scenario.js'

describe('runScenario (alias of grow --source-only)', () => {
  it('delegates to runGrow with sourceOnly + fromPaths and warns deprecation', async () => {
    const runGrow = vi.fn(async () => ({ discovered: 0, uncovered: 0, proposed: [], mode: 'source' as const, requirementsRepos: 1 }))
    const warn = vi.fn()
    await runScenario('/cwd', { from: ['docs/a.md'] }, { runGrow, warn } as never)
    expect(runGrow).toHaveBeenCalledOnce()
    const [, opts] = runGrow.mock.calls[0]
    expect(opts.sourceOnly).toBe(true)
    expect(opts.fromPaths).toEqual(['docs/a.md'])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/deprecated|grow --source-only/i))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/commands/scenario.test.ts`
Expected: FAIL（runScenario は旧実装）。

- [ ] **Step 3: Rewrite `scenario.ts`**

`runScenario` を grow への薄いラッパーに置換（全文）:

```typescript
import { runGrow as defaultRunGrow, type RunGrowDeps, type RunGrowOpts } from './grow.js'

export type ScenarioOpts = { from?: string[] }

export type ScenarioDeps = {
  /** Injectable for tests */
  runGrow?: (root: string, opts: RunGrowOpts, deps: RunGrowDeps) => Promise<unknown>
  /** Deprecation warning sink (defaults to stderr) */
  warn?: (msg: string) => void
  /** Forwarded to grow */
  growDeps?: Partial<RunGrowDeps>
}

/** @deprecated `scenario` is now an alias of `grow --source-only`. Use that instead. */
export async function runScenario(root: string, opts: ScenarioOpts, deps: ScenarioDeps = {}): Promise<void> {
  const runGrow = deps.runGrow ?? defaultRunGrow
  const warn = deps.warn ?? ((m: string) => process.stderr.write(`${m}\n`))
  warn('`scenario` is deprecated — it now runs `grow --source-only`. Use `loop-e2e grow --source-only`.')
  await runGrow(root, { sourceOnly: true, fromPaths: opts.from }, (deps.growDeps ?? {}) as RunGrowDeps)
}
```

- [ ] **Step 4: Update `index.ts` scenario command**

`scenario` の action を、grow の実 deps を組んで `runScenario` に渡す形へ（grow action と同じ deps だが `sourceOnly` 固定なのでブラウザ不要）:

```typescript
program
  .command('scenario')
  .description('[deprecated] Alias of `grow --source-only` — generate scenarios from repository source')
  .option('--from <paths...>', 'Additional requirement files to merge into context')
  .action(async (opts: { from?: string[] }) => {
    const cwd = process.cwd()
    const { runScenario } = await import('./commands/scenario.js')
    const { runGrow } = await import('./commands/grow.js')
    const { prepare } = await import('../pipeline/prepare.js')
    const { authenticate } = await import('../services/browser/login.js')
    const { discoverPages } = await import('../services/browser/discover.js')
    const { findUncoveredPages } = await import('../services/grow/coverage.js')
    const { proposeScenarios } = await import('../services/llm/proposeScenarios.js')
    const { collectRequirements } = await import('../services/repo/reader.js')
    const { loadScenarios, saveProposedScenario } = await import('../scenario/schema.js')
    const { appendActivity } = await import('../state/findings.js')
    const loaded = await loadConfig(cwd)
    const llm = createLlm(loaded.secrets.anthropicApiKey, loaded.config.models, { language: loaded.config.language })
    await runScenario(cwd, { from: opts.from }, {
      runGrow,
      growDeps: {
        prepare,
        // source-only never crawls, so createPage is never invoked
        createPage: () => Promise.reject(new Error('createPage is not available in --source-only')),
        authenticate, discoverPages, findUncoveredPages, proposeScenarios, collectRequirements,
        loadScenarios, saveProposedScenario, llm, pinRunner: defaultComposeRunner, appendActivity,
      },
    })
  })
```

- [ ] **Step 5: Run tests + full suite + lint**

Run: `pnpm vitest run src/cli/commands/scenario.test.ts && pnpm vitest run && pnpm build && pnpm lint`
Expected: 全 PASS、build/lint clean。

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/scenario.ts src/cli/index.ts src/cli/commands/scenario.test.ts
git commit -m "feat(scenario): make scenario a deprecated alias of grow --source-only"
```

---

### Task 5: README ＋ 移行ガイド ＋ 実機確認

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README 更新**

`### scenario` と `### grow` の節を統合する。`grow` の節に以下を反映（要点）:
- `grow` は静的（ソース/要件/git）＋動的（クロール）の両理解からシナリオを提案する統合コマンド。
- `--source-only`（実機不要）／`--crawl-only`（クロールのみ）／既定は両方。
- 出力は `proposed/` ドラフト → `approve` で採用 → `run` で実行・確認。
- 移行ガイド: `scenario` は `grow --source-only` の非推奨エイリアス。**旧 `scenario` は `scenarios/` へ直接保存していたが、統合後は `proposed/` に保存され `approve` が必要**。

```markdown
### `grow` — アプリ理解 → シナリオ提案（統合）

`grow` は **実機クロール（動的）＋ リポジトリのソース/要件/git ログ（静的）** の両方からアプリ
を理解し、未カバーの検証シナリオを **`proposed/` ドラフト**として提案します（`approve` で採用、
`run` で実行・確認）。

```bash
loop-e2e grow                 # 既定：ソース＋クロール
loop-e2e grow --source-only   # ソースのみ（実機・認証不要）＝ 旧 scenario
loop-e2e grow --crawl-only    # クロールのみ ＝ 旧 grow
```

| Flag | 説明 |
|------|------|
| `--target <name>` | 対象ターゲット |
| `--max-pages <n>` | クロール最大ページ数 |
| `--source-only` | ソース/要件のみ（クロールしない） |
| `--crawl-only` | クロールのみ（ソースを使わない） |
| `--skip-prepare` | prepare 省略 |

> **移行**: `scenario` は `grow --source-only` の **非推奨エイリアス**です。従来 `scenario` は
> `scenarios/` に直接保存していましたが、統合後は **`proposed/` に保存**され、採用には
> `loop-e2e approve` が必要です（提案→承認→確認の一貫フロー）。
```

- [ ] **Step 2: 実機確認（フロント稼働時）**

Run（手動・任意、`RUN`環境が必要）:
```bash
loop-e2e grow --source-only           # 実機不要：proposed に日本語ドラフトが出ることを確認
loop-e2e grow                          # 既定：クロール＋ソース融合
loop-e2e approve --all                 # 採用
```
Expected: `proposed/` に新規 `*.scenario.yaml`（日本語 title/businessFlow）。`grow(<mode>): ...` の標準出力。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(grow): unify scenario into grow + migration guide (scenario→proposed/)"
```

---

## Self-Review

**Spec coverage:**
- §2 統合挙動・フラグ → Task 2/3。✅
- §3 融合提案（ProposeInput, (a)(b), 部分失敗分離）→ Task 1。✅
- §4 パイプライン分岐・collectRequirements・GrowResult → Task 2。✅
- §5 CLI フラグ・scenario エイリアス・proposed/ 統一・移行ガイド → Task 3/4/5。✅
- §6 相互排他エラー・静的失敗継続・マスク → Task 2/3。✅
- §7 テスト戦略 → 各 Task のテスト。✅
- §9 ロードマップ（Phase2/3）→ 本プラン対象外（spec に記載）。✅

**Placeholder scan:** なし。各 step に完全コードまたは具体的差分。CLI/scenario の index 配線は差分箇所を明示。

**Type consistency:** `proposeScenarios(llm, ProposeInput)` を Task1 で定義し、Task2 の GrowDeps・Task3 の配線で同一シグネチャを使用。`GrowResult.mode`/`requirementsRepos` を Task2 で定義し Task3 の出力・Task4 のテスト戻り値で一致。`collectRequirements` の deps 形（llm/token/root/ingestion/fromPaths）は reader.js の `CollectReaderDeps` に一致（`gitLogRunner` は任意・省略）。

**Note:** Task1/2 の中間ステップで `pnpm build` 全体は失敗しうる（下流が新シグネチャ未対応のため）。各 Task のユニットテスト緑を確認し、Task3/4 完了後に build/lint/全スイート緑を担保する。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-unify-scenario-grow.md`.
