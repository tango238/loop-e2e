# loop-e2e Scenario-Grow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `loop-e2e grow` で、2FA込みの認証ログイン後にアプリ内をBFS巡回して画面を発見し、既存シナリオ未カバーの画面に対しAIがシナリオを提案、`proposed/` にドラフト保存して `loop-e2e approve` で本採用する。

**Architecture:** 既存 loop-e2e（cli→pipeline→services、全外部I/O注入可）に、2FA対応ログイン（既存 `executeLoginScenario` 拡張＋`authenticate`）、BFS発見クロール、未カバー検出、Opus提案、proposed/承認 を追加。ブラウザ/シェル(pinCommand)/LLM は注入してユニットテストはモック。

**Tech Stack:** TypeScript strict, ESM, Node 20+, pnpm, vitest, zod, Playwright(PageLike抽象), `node:child_process`(execFile) for pinCommand, Anthropic SDK(Opus via既存LLMクライアント).

## Global Constraints

- Node>=20, TS strict, ESM, pnpm。Immutable data（複製更新）。1ファイル1責務、<800行。
- 機密（資格情報・PIN・トークン）は注入 secrets/.env のみ。pinCommand 出力・エラー、LLM/ブラウザ経路は `maskSecrets`。PIN/資格を detail/レポート/ログに出さない。
- 外部呼び出し（ブラウザ/シェル/LLM）は注入可能でユニットテストはモック（実ブラウザ/shell/APIなし）。実機は `RUN_E2E=1` gate。
- LLM出力は zod 検証（リトライはクライアント層）。`ANTHROPIC_API_KEY` 未設定で提案を呼ぶと createLlm が明確にエラー。
- `console.log` 禁止（`logger`、テストは `test/setup.ts` で silent）。
- 既存 340 pass + 3 skip を壊さない。`pnpm build`/`pnpm test`/`pnpm lint` を常に緑。
- `run` は **proposed/ を読まない**（`loadScenarios` は active のみ）。
- 発見クロール: 同一オリジン・`maxPages`/`maxDepth` 上限・`excludePaths`/`/logout`/外部/アセット除外。上限到達は無言で打ち切らずログ。

参照スペック: `docs/superpowers/specs/2026-06-22-scenario-grow-design.md`

---

## ファイル構成

| 区分 | パス | 責務 |
|------|------|------|
| Config | `src/config/schema.ts`（変更） | `AuthSchema.twoFactor?`、`ConfigSchema.grow?` |
| Browser | `src/services/browser/login.ts`（変更） | 2FAステップ＋ `authenticate()` |
| Browser | `src/services/browser/discover.ts`（新規） | `discoverPages`（BFS） |
| Grow | `src/services/grow/coverage.ts`（新規） | `findUncoveredPages` |
| LLM | `src/services/llm/proposeScenarios.ts`＋`prompts/propose.ts`（新規） | `proposeScenarios`（Opus） |
| Scenario | `src/scenario/schema.ts`（変更） | `saveProposedScenario`/`loadProposedScenarios`/`approveScenario`、proposed/規約 |
| Pipeline | `src/pipeline/grow.ts`（新規） | grow オーケストレーション |
| CLI | `src/cli/commands/grow.ts`, `approve.ts`（新規） | コマンド |
| CLI | `src/cli/index.ts`（変更） | grow/approve 登録・実deps配線 |
| Docs | `README.md`（変更） | grow/approve・twoFactor/grow 設定例 |

---

## M1 設定＋2FA（フェーズ1）

### Task 1: AuthSchema.twoFactor と ConfigSchema.grow

**Files:**
- Modify: `src/config/schema.ts`
- Test: `src/config/schema.test.ts`

**Interfaces — Produces:** `AuthSchema` に `twoFactor: TwoFactorSchema.optional()`、`ConfigSchema` に `grow: GrowSchema.optional()`。`TwoFactor`/`Grow` 型。

- [ ] **Step 1: Write failing test（`src/config/schema.test.ts` に追記）**

```typescript
import { describe, it, expect } from 'vitest'
import { ConfigSchema } from './schema.js'

const base = {
  repositories: [{ name: 'web', label: 'l', url: 'https://github.com/o/web', role: 'frontend', audience: 'user' }],
  targets: [{ name: 'local', baseUrl: 'http://localhost:3000', auth: { strategy: 'form', loginPath: '/login', usernameEnv: 'U', passwordEnv: 'P' } }],
  databases: [], schedule: { intervalMinutes: 60 }, scenarioDir: 'scenarios',
  github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
}

describe('twoFactor + grow schema', () => {
  it('accepts twoFactor on auth and grow config with defaults', () => {
    const cfg = ConfigSchema.parse({
      ...base,
      targets: [{ ...base.targets[0], auth: { ...base.targets[0].auth, twoFactor: { pinCommand: 'echo 123456' } } }],
      grow: {},
    })
    expect(cfg.targets[0].auth?.twoFactor?.pinCommand).toBe('echo 123456')
    expect(cfg.grow?.maxPages).toBe(50)   // default
    expect(cfg.grow?.maxDepth).toBe(3)    // default
  })
  it('omits twoFactor and grow when absent', () => {
    const cfg = ConfigSchema.parse(base)
    expect(cfg.targets[0].auth?.twoFactor).toBeUndefined()
    expect(cfg.grow).toBeUndefined()
  })
  it('rejects twoFactor with empty pinCommand', () => {
    expect(() => ConfigSchema.parse({ ...base, targets: [{ ...base.targets[0], auth: { ...base.targets[0].auth, twoFactor: { pinCommand: '' } } }] })).toThrow()
  })
})
```

- [ ] **Step 2: Run → FAIL** — `pnpm vitest run src/config/schema.test.ts`

- [ ] **Step 3: Implement（`src/config/schema.ts`）**

```typescript
const TwoFactorSchema = z.object({
  pinCommand: z.string().min(1),
  pinFieldSelector: z.string().default('input[name="pin_code"]'),
  submitSelector: z.string().default('button[type="submit"]'),
  successUrlPattern: z.string().optional(),
})
const GrowSchema = z.object({
  maxPages: z.number().int().positive().default(50),
  maxDepth: z.number().int().positive().default(3),
  excludePaths: z.array(z.string()).default([]),
}).default({})
```
`AuthSchema` に `twoFactor: TwoFactorSchema.optional()`、`ConfigSchema` に `grow: GrowSchema.optional()` を追加。`export type TwoFactor`/`Grow`。

- [ ] **Step 4: Run → PASS** — `pnpm vitest run src/config/schema.test.ts`
- [ ] **Step 5: Commit** — `feat(config): add twoFactor auth and grow config`

### Task 2: 2FA対応ログイン＋authenticate

**Files:**
- Modify: `src/services/browser/login.ts`
- Test: `src/services/browser/login.test.ts`

**Interfaces:**
- Consumes: 既存 `PageLike`/`executeLoginScenario`、`maskSecrets`、`ComposeRunner`（pinCommand実行用、`src/services/compose/compose.ts`）。
- Produces: `executeLoginScenario` が `target.auth.twoFactor` 設定時に2FAステップを実行（pinCommand→PIN抽出→入力→submit→成功判定）。`authenticate(page, target, creds, deps): Promise<{ ok: boolean; detail: string; finalUrl: string }>`（成功時 page は認証済み）。`deps` に `pinRunner?: ComposeRunner; secrets?: string[]`。

- [ ] **Step 1: Write failing test** — fake `PageLike`（`url()` が submit 後に `/two-factor-auth`、PIN submit 後に `/` を返すよう段階遷移）と `pinRunner` モック（`sh -c <pinCommand>` で `{stdout:'  123456\n'}`）。検証: pinCommand 実行→`pinFieldSelector` に `123456` 入力→submit→`ok:true, finalUrl:'/'`。別テスト: pinCommand 出力に数字が無い→`ok:false`、detail にPIN/資格が出ない。`twoFactor` 未設定なら従来単段（2FA未実行）。

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement** — `executeLoginScenario` 内、フォーム submit 後に `target.auth?.twoFactor` があれば: `pinRunner('sh',['-c',pinCommand])` の stdout から `/\d{4,8}/` で PIN 抽出（無ければ `ok:false, detail:'2FA pin not found'`）、`pinFieldSelector` に入力、`submitSelector` を click、waitForLoadState、`successUrlPattern`（無ければ「loginPath と two-factor を含まないURL」）で成功判定。PIN/資格は detail に含めない。`maskSecrets` でエラー/ログをマスク。`authenticate` は `executeLoginScenario` を呼び、成功時 `{ok,detail,finalUrl}` と（呼び出し側が同一 page を保持）を返す薄いラッパ。

- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `feat(login): add 2FA step (pinCommand) and authenticate`

---

## M2 発見＋未カバー（タスク定義）

### Task 3: discoverPages（BFS発見クロール）
- **Files:** `src/services/browser/discover.ts`（新規・+ test）。
- **Interfaces — Produces:** `discoverPages(browser: BrowserLike, target: TargetEnv, opts: Grow, deps?: { extractLinks? }): Promise<RawPage[]>` — 認証済み browser から `target.baseUrl` 起点に BFS。各ページで同一オリジン `<a href>` を収集・正規化（フラグメント除去）・未訪問のみキュー。`excludePaths` 部分一致/`/logout`/外部/アセット(.js/.css/.png等)除外。`maxPages`/`maxDepth` で停止（到達時ログ）。各ページを `RawPage`（url/title/html/meta/screenshotPath）で返す。`PageLike` の `goto`/`content`/リンク抽出（`page.$$eval` 相当を抽象化、テストは fake で注入）。
- **テスト:** fake browser でリンクグラフを与え、BFS順・maxPages/maxDepth上限・excludePaths/logout/外部除外・重複排除を assert。

### Task 4: findUncoveredPages（未カバー検出）
- **Files:** `src/services/grow/coverage.ts`（新規・+ test）。
- **Interfaces — Consumes:** `RawPage[]`, `Scenario[]`。**Produces:** `findUncoveredPages(discovered: RawPage[], scenarios: Scenario[]): RawPage[]` — 既存シナリオの `steps[action==='navigate'].target` ＋ 各 target.auth.loginPath をパス正規化した集合を作り、発見ページのパスが含まれないものを返す。URL→パス正規化ユーティリティ（末尾スラッシュ・クエリ無視）。
- **テスト:** カバー済み/未カバーの混在で正しく差分、パス正規化（`/x` と `/x/` 同一、クエリ無視）。

---

## M3 提案＋承認（タスク定義）

### Task 5: proposeScenarios（Opus提案）
- **Files:** `src/services/llm/proposeScenarios.ts`、`src/services/llm/prompts/propose.ts`（新規・+ test）。
- **Interfaces — Consumes:** `Llm`（role planning=Opus）、`extractPageInfo`、`PageInfo`、`ScenarioSchema`。**Produces:** `proposeScenarios(llm, uncovered: RawPage[], deps?: { extractPageInfo? }): Promise<Scenario[]>` — 各未カバーページを `extractPageInfo` で `PageInfo` 化→Opus に渡し ScenarioSchema 準拠シナリオを生成（id `grow-<slug>`、zod配列検証）。認証済み前提の操作を含める。
- **テスト:** LLMモックで PageInfo→Scenario 生成、zod検証、id命名、資格値非混入。

### Task 6: proposed保存＋承認
- **Files:** `src/scenario/schema.ts`（変更・+ test）。
- **Interfaces — Produces:** `PROPOSED_SUBDIR='proposed'`、`saveProposedScenario(dir, s)`（`<dir>/proposed/<id>.scenario.yaml`）、`loadProposedScenarios(dir)`、`approveScenario(dir, id)`（proposed→active 移動。active に同id存在時は上書きせずエラー/確認）。`loadScenarios`（既存）は `proposed/` を読まないことを保証（既存はディレクトリ直下のみ列挙のはず—確認しテスト追加）。
- **テスト:** proposed 保存/列挙、approve 移動、衝突時の非上書き、loadScenarios が proposed を無視。

---

## M4 コマンド＋仕上げ（タスク定義）

### Task 7: grow パイプライン＋コマンド
- **Files:** `src/pipeline/grow.ts`、`src/cli/commands/grow.ts`（新規・+ test）、`src/cli/index.ts`（登録・配線）。
- **Interfaces — Produces:** `grow(config, root, deps): Promise<{ discovered: number; uncovered: number; proposed: Scenario[] }>` — prepare（既存・`--skip-prepare`）→`authenticate`（2FA込み）→`discoverPages`→`findUncoveredPages`（`loadScenarios` と比較）→`proposeScenarios`→`saveProposedScenario`。`runGrow(root, opts, deps)` CLIラッパ。認証失敗で中断。`grow` を index.ts に登録（`--target`/`--max-pages`/`--skip-prepare`、実 browser/llm/pinRunner/prepare 配線、creds は `secrets.targetAuth`）。
- **テスト:** 全deps注入で authenticate→discover→coverage→propose→save の順・認証失敗中断・proposed保存。

### Task 8: approve コマンド＋README
- **Files:** `src/cli/commands/approve.ts`（新規・+ test）、`src/cli/index.ts`（登録）、`README.md`（変更）。
- **Interfaces — Produces:** `runApprove(root, opts:{ all?: boolean; ids?: string[] }, deps): Promise<void>` — `loadProposedScenarios`→指定（or 全）を `approveScenario` で移動、一覧/結果表示。index.ts に `approve [--all] [ids...]` 登録。
- **README:** `loop-e2e grow`/`approve` の使い方、`target.auth.twoFactor`（pinCommand 例: mailpit/DB から PIN 取得・プレースホルダ）、`grow`（maxPages/maxDepth/excludePaths）設定例、`proposed/` ワークフロー、`RUN_E2E` 実機例。秘密値は載せない。
- **テスト:** approve（all/指定）で proposed→active 移動、対象なし時の通知。

---

## Self-Review（spec突合）

- **スペック網羅:** §2.1 twoFactor→Task1 ／ §2.2 grow→Task1 ／ §3 2FA認証→Task2 ／ §4.1 discover→Task3 ／ §4.2 coverage→Task4 ／ §4.3 propose→Task5 ／ §4.4 proposed/approve→Task6 ／ §4.5 コマンド→Task7,8 ／ §5 コンポーネント→全タスク ／ §6 エラー/マスク→Task2,3,5,6 ／ §7 テスト→各タスク＋Task8(RUN_E2E/README) ／ §9 段階→M1–M4。すべて対応タスクあり。
- **プレースホルダ:** Task1・2 は完全コード/テスト記述。Task3–8 はファイル/インターフェース/テストを確定したタスク定義として実行直前展開を宣言。
- **型整合:** `executeLoginScenario`(2FA拡張)/`authenticate`/`discoverPages`/`findUncoveredPages`/`proposeScenarios`/`saveProposedScenario`/`loadProposedScenarios`/`approveScenario`/`grow`/`runGrow`/`runApprove` を一意定義。`RawPage`/`PageInfo`/`Scenario`/`TwoFactor`/`Grow`/`ComposeRunner`/`PageLike`/`BrowserLike` を既存から再利用。`PROPOSED_SUBDIR='proposed'`。
- **残課題（spec §10、実装中に詰める）:** PIN抽出正規表現 `/\d{4,8}/`、id命名 `grow-<slug>`、SPAリンク取得方式、run のログイン実走が2FA対応 executeLoginScenario を使う配線（既定: 使う）。
