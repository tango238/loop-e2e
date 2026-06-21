# loop-e2e Local-Launch + Login-Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 専用e2eディレクトリを起点に `init` で git clone → docker compose 起動 → DBシード、`scenario` でログイン含む生成、`run` でログインシナリオを実走するまでの縦割り経路を追加する。

**Architecture:** 既存 loop-e2e（cli→pipeline→services→state、全外部I/O注入可）に、compose/readiness/seed/process の各サービスと `down` コマンドを追加し、`init` に起動オーケストレーション、`scenario` の clone 廃止、`run` のログイン実走を組み込む。docker/git/fetch/db/playwright は注入してユニットテストはモック、実機は `RUN_E2E=1` で gate。

**Tech Stack:** TypeScript strict, ESM, Node 20+, pnpm, vitest, zod, `node:child_process`(execFile) for docker/git, Playwright, pino, yaml.

## Global Constraints

- Node>=20, TS strict, ESM, pnpm。Immutable data（複製更新・破壊的変更なし）。
- 1ファイル1責務、200–400行目安・最大800行。
- 機密（ANTHROPIC_API_KEY/GITHUB_TOKEN/DBパスワード/ログイン資格）は `.env` のみ。config・ログ・レポート・エラー・コマンド表示へ漏らさない（git/dockerコマンド中のトークンは `maskSecrets`）。
- 外部呼び出し（docker/git/fetch/db/playwright/anthropic）は注入可能にし、ユニットテストでモック（実docker/network/API/chromiumなし）。実機フローは `RUN_E2E=1` で gate。
- LLM出力は zod 検証（リトライはクライアント層）。`console.log` 禁止（`logger`、テストは `test/setup.ts` で silent）。
- 既存 245 pass + 2 skip を壊さない。`pnpm build`/`pnpm test`/`pnpm lint` を常に緑に保つ。
- clone 先は **`<base>/repos/<name>`**（旧 `.loop-e2e/repos` から変更）。

参照スペック: `docs/superpowers/specs/2026-06-21-local-launch-login-design.md`

---

## ファイル構成

| 区分 | パス | 責務 |
|------|------|------|
| Config | `src/config/schema.ts`（変更） | `LaunchSchema` 追加・`Config.launch?` 追加 |
| Service | `src/services/compose/compose.ts`（新規） | `composeUp`/`composeDown`（execFile注入） |
| Service | `src/services/compose/readiness.ts`（新規） | `waitForReadiness`（fetch注入・ポーリング） |
| Service | `src/services/seed/seed.ts`（新規） | `seedDatabase`（execFile注入） |
| State | `src/state/process.ts`（新規） | `saveProcessState`/`loadProcessState`/`clearProcessState` |
| Repo | `src/services/repo/clone.ts`（変更） | clone 先を `repos/<name>` に変更 |
| Browser | `src/services/browser/login.ts`（新規） | `executeLoginScenario`（ログインステップ駆動＋判定） |
| CLI | `src/cli/commands/init.ts`（変更） | clone→up→ready→seed→状態保存 を追加 |
| CLI | `src/cli/commands/down.ts`（新規） | `down` コマンド |
| CLI | `src/cli/commands/scenario.ts`（変更） | clone 廃止・`repos/` 直接参照 |
| CLI | `src/cli/commands/run.ts`（変更） | ログイン実走経路 |
| CLI | `src/cli/index.ts`（変更） | `down` 登録・`init`/`run` 配線 |
| Docs | `README.md`（変更） | base運用・docker前提・コマンド例 |

---

## マイルストーン

1. **M1 設定＋clone先** — LaunchSchema、Config.launch、clone 先変更
2. **M2 起動サービス群** — compose / readiness / seed / process
3. **M3 init 拡張＋down** — 起動オーケストレーション、down コマンド
4. **M4 scenario 変更＋login 実走** — clone 廃止、ログインシナリオ生成、login 実走、run 配線
5. **M5 統合＋docs** — 統合テスト、RUN_E2E 実機 E2E、README

> M1・M2 は完全な bite-sized TDD で記述。M3–M5 はファイル/インターフェース/成果物/テストを確定したタスク定義とし、実行直前に同形式へ展開する。

---

## M1 設定＋clone先

### Task 1.1: LaunchSchema と Config.launch

**Files:**
- Modify: `src/config/schema.ts`
- Test: `src/config/schema.test.ts`

**Interfaces:**
- Produces: `LaunchSchema`（zod）, `Launch = z.infer<typeof LaunchSchema>`, `Config.launch?: Launch`。

- [ ] **Step 1: Write failing test（`src/config/schema.test.ts` に追記）**

```typescript
import { describe, it, expect } from 'vitest'
import { ConfigSchema } from './schema.js'

const baseValid = {
  repositories: [{ name: 'web', label: 'frontend-user', url: 'https://github.com/o/web', role: 'frontend', audience: 'user' }],
  targets: [{ name: 'local', baseUrl: 'http://localhost:3000', auth: { strategy: 'form', loginPath: '/login', usernameEnv: 'APP_USER', passwordEnv: 'APP_PASS' } }],
  databases: [],
  schedule: { intervalMinutes: 60 },
  scenarioDir: 'scenarios',
  github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
}

describe('LaunchSchema', () => {
  it('accepts a valid launch config', () => {
    const cfg = ConfigSchema.parse({ ...baseValid, launch: {
      compose: { files: ['docker-compose.yml'], projectName: 'e2e' },
      readiness: { url: 'http://localhost:3000/login' },
      seed: { command: 'docker compose exec -T backend npm run seed:test' },
      targetName: 'local',
    } })
    expect(cfg.launch?.readiness.timeoutSec).toBe(180) // default
    expect(cfg.launch?.readiness.intervalSec).toBe(3)  // default
  })
  it('omits launch when not provided', () => {
    expect(ConfigSchema.parse(baseValid).launch).toBeUndefined()
  })
  it('rejects launch with empty compose.files', () => {
    expect(() => ConfigSchema.parse({ ...baseValid, launch: {
      compose: { files: [], projectName: 'e2e' }, readiness: { url: 'http://x' }, targetName: 'local',
    } })).toThrow()
  })
})
```

- [ ] **Step 2: Run → FAIL**

Run: `pnpm vitest run src/config/schema.test.ts`
Expected: FAIL（`launch` 未定義 / 既定値なし）。

- [ ] **Step 3: Implement（`src/config/schema.ts`）**

```typescript
const LaunchSchema = z.object({
  compose: z.object({
    files: z.array(z.string().min(1)).min(1),
    projectName: z.string().min(1),
    envFile: z.string().optional(),
  }),
  readiness: z.object({
    url: z.string().url(),
    timeoutSec: z.number().int().positive().default(180),
    intervalSec: z.number().int().positive().default(3),
  }),
  seed: z.object({ command: z.string().min(1) }).optional(),
  targetName: z.string().min(1),
})
export type Launch = z.infer<typeof LaunchSchema>
```
`ConfigSchema` に `launch: LaunchSchema.optional()` を追加。

- [ ] **Step 4: Run → PASS**

Run: `pnpm vitest run src/config/schema.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts src/config/schema.test.ts
git commit -m "feat(config): add optional launch config schema"
```

### Task 1.2: clone 先を `repos/<name>` に変更

**Files:**
- Modify: `src/services/repo/clone.ts`
- Test: `src/services/repo/clone.test.ts`

**Interfaces:**
- Consumes/Produces: `ensureRepoClone(repo, token, ingestion, root, gitRunner?)` の clone 先を `join(root, 'repos', repo.name)` に変更（旧 `.loop-e2e/repos`）。シグネチャは不変。

- [ ] **Step 1: Update failing test** — `clone.test.ts` の期待パスを `repos/<name>` に変更し、clone 呼び出し引数のローカルパスが `…/repos/web` であることを assert。

- [ ] **Step 2: Run → FAIL（旧パス期待で不一致 or 新assertで未実装）**

Run: `pnpm vitest run src/services/repo/clone.test.ts`

- [ ] **Step 3: Implement** — `clone.ts` 内のローカルパス算出を `join(root, 'repos', repo.name)` に変更。`.gitignore`/状態ディレクトリ生成は変更不要。

- [ ] **Step 4: Run → PASS**

Run: `pnpm vitest run src/services/repo/clone.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/services/repo/clone.ts src/services/repo/clone.test.ts
git commit -m "feat(repo): clone repositories into base/repos/<name>"
```

---

## M2 起動サービス群

### Task 2.1: compose サービス（up/down）

**Files:**
- Create: `src/services/compose/compose.ts`
- Test: `src/services/compose/compose.test.ts`

**Interfaces:**
- Produces:
  - `type ComposeRunner = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>`
  - `composeUp(launch: Launch, root: string, runner?: ComposeRunner, secrets?: string[]): Promise<void>`
  - `composeDown(state: { projectName: string; composeFiles: string[] }, root: string, opts: { volumes?: boolean }, runner?: ComposeRunner, secrets?: string[]): Promise<void>`
- 既定 runner は `execFile('docker', ['compose', ...])`（promisified）。エラーは `maskSecrets` 後に明確メッセージで再throw。

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { composeUp } from './compose.js'

const launch = { compose: { files: ['a.yml', 'b.yml'], projectName: 'e2e', envFile: '.env' },
  readiness: { url: 'http://x', timeoutSec: 180, intervalSec: 3 }, targetName: 'local' }

describe('composeUp', () => {
  it('invokes docker compose up -d with -p, -f files and --env-file', async () => {
    const calls: string[][] = []
    const runner = vi.fn(async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { stdout: '', stderr: '' } })
    await composeUp(launch as any, '/base', runner)
    expect(runner).toHaveBeenCalledTimes(1)
    const args = calls[0]
    expect(args[0]).toBe('docker')
    expect(args).toContain('compose'); expect(args).toContain('-p'); expect(args).toContain('e2e')
    expect(args).toContain('-f'); expect(args).toContain('a.yml'); expect(args).toContain('b.yml')
    expect(args).toContain('--env-file'); expect(args).toContain('.env')
    expect(args).toContain('up'); expect(args).toContain('-d')
  })
  it('wraps runner errors with a clear message and no secret leak', async () => {
    const runner = vi.fn(async () => { throw new Error('boom token=secret123') })
    await expect(composeUp(launch as any, '/base', runner, ['secret123']))
      .rejects.toThrow(/compose up failed/)
    await expect(composeUp(launch as any, '/base', runner, ['secret123']))
      .rejects.not.toThrow(/secret123/)
  })
})
```

- [ ] **Step 2: Run → FAIL**

Run: `pnpm vitest run src/services/compose/compose.test.ts`

- [ ] **Step 3: Implement `compose.ts`**

```typescript
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { maskSecrets } from '../../util/mask.js'
import type { Launch } from '../../config/schema.js'

const pexec = promisify(execFile)
export type ComposeRunner = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>
const defaultRunner: ComposeRunner = (cmd, args, opts) => pexec(cmd, args, opts)

function baseArgs(projectName: string, files: string[], envFile?: string): string[] {
  const args = ['compose', '-p', projectName]
  for (const f of files) { args.push('-f', f) }
  if (envFile) { args.push('--env-file', envFile) }
  return args
}

export async function composeUp(launch: Launch, root: string, runner: ComposeRunner = defaultRunner, secrets: string[] = []): Promise<void> {
  const args = [...baseArgs(launch.compose.projectName, launch.compose.files, launch.compose.envFile), 'up', '-d']
  try { await runner('docker', args, { cwd: root }) }
  catch (err) { throw new Error(`compose up failed: ${maskSecrets(String((err as Error)?.message ?? err), secrets)}`) }
}

export async function composeDown(state: { projectName: string; composeFiles: string[] }, root: string, opts: { volumes?: boolean }, runner: ComposeRunner = defaultRunner, secrets: string[] = []): Promise<void> {
  const args = [...baseArgs(state.projectName, state.composeFiles), 'down']
  if (opts.volumes) { args.push('--volumes') }
  try { await runner('docker', args, { cwd: root }) }
  catch (err) { throw new Error(`compose down failed: ${maskSecrets(String((err as Error)?.message ?? err), secrets)}`) }
}
```

- [ ] **Step 4: Run → PASS** — `pnpm vitest run src/services/compose/compose.test.ts`
- [ ] **Step 5: Commit** — `feat(compose): add docker compose up/down service with masking`

### Task 2.2: readiness ポーリング

**Files:**
- Create: `src/services/compose/readiness.ts`
- Test: `src/services/compose/readiness.test.ts`

**Interfaces:**
- Produces: `type FetchFn = (url: string) => Promise<{ status: number }>`; `waitForReadiness(url: string, opts: { timeoutSec: number; intervalSec: number }, fetchFn?: FetchFn, sleepFn?: (ms: number) => Promise<void>): Promise<void>` — 2xx で解決、timeout でthrow。テスト用に `sleepFn` 注入（即時解決）。

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { waitForReadiness } from './readiness.js'
const noSleep = async () => {}
describe('waitForReadiness', () => {
  it('resolves once fetch returns 2xx', async () => {
    const statuses = [503, 503, 200]
    const fetchFn = vi.fn(async () => ({ status: statuses.shift() ?? 200 }))
    await expect(waitForReadiness('http://x', { timeoutSec: 30, intervalSec: 1 }, fetchFn, noSleep)).resolves.toBeUndefined()
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })
  it('throws on timeout when never 2xx', async () => {
    const fetchFn = vi.fn(async () => ({ status: 500 }))
    await expect(waitForReadiness('http://x', { timeoutSec: 2, intervalSec: 1 }, fetchFn, noSleep)).rejects.toThrow(/not ready/)
  })
})
```
（timeout 判定はリトライ回数 = `ceil(timeoutSec/intervalSec)` で実装し、`sleepFn` 注入で時間に依存させない。）

- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** — `attempts = Math.ceil(timeoutSec/intervalSec)`、各試行で `fetchFn` を呼び status が 200–299 なら return、失敗例外は握って次試行、`sleepFn(intervalSec*1000)`。全試行失敗で `throw new Error('readiness check failed: <url> not ready within <timeoutSec>s')`。既定 `fetchFn` は `globalThis.fetch` を `{status}` に薄ラップ、既定 `sleepFn` は `setTimeout` Promise。
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `feat(compose): add readiness polling with injectable fetch/sleep`

### Task 2.3: seed サービス

**Files:**
- Create: `src/services/seed/seed.ts`
- Test: `src/services/seed/seed.test.ts`

**Interfaces:**
- Produces: `seedDatabase(seed: { command: string }, root: string, runner?: ComposeRunner, secrets?: string[]): Promise<void>` — `seed.command` をシェル実行（`execFile('sh', ['-c', command])` を runner 経由）。失敗は `maskSecrets` 後にthrow。`ComposeRunner` 型を再利用。

- [ ] **Step 1: Write failing test** — runner をモックし、`sh -c "<command>"` が `cwd: root` で呼ばれること、エラー時に `seed failed:` で包みシークレットが漏れないことを assert。
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** — 上記。
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `feat(seed): add db seed command runner with masking`

### Task 2.4: process 状態ストア

**Files:**
- Create: `src/state/process.ts`
- Test: `src/state/process.test.ts`

**Interfaces:**
- Consumes: `statePaths(root).base`（`.loop-e2e`）, `ensureDir`/`readJson`/fs。
- Produces: `type ProcessState = { projectName: string; composeFiles: string[]; startedAt: string; readinessUrl: string }`; `saveProcessState(root, s)`, `loadProcessState(root): Promise<ProcessState|null>`（不在で null）, `clearProcessState(root)`（`.loop-e2e/process.json` 削除、無ければ無視）。

- [ ] **Step 1: Write failing test** — 一時dirで save→load 往復、未保存で null、clear 後 null。
- [ ] **Step 2: Run → FAIL**
- [ ] **Step 3: Implement** — `process.json` を JSON で読み書き（`readJson`/`writeFile`）。
- [ ] **Step 4: Run → PASS**
- [ ] **Step 5: Commit** — `feat(state): add compose process state store`

---

## M3 init 拡張＋down（タスク定義）

### Task 3.1: init に起動オーケストレーションを追加
- **Files:** `src/cli/commands/init.ts`（+ test）, `src/cli/index.ts`（配線）。
- **Interfaces — Consumes:** `composeUp`, `waitForReadiness`, `seedDatabase`, `saveProcessState`, `ensureRepoClone`。**Produces:** `runInit` の `deps` に `{ composeUp, waitForReadiness, seedDatabase, ensureRepoClone, cloneToken }` を追加（注入可）。
- **挙動:** 既存処理の後、`config.launch` があれば: (1) 各 repo を `repos/<name>` に `ensureRepoClone`、(2) `composeUp(launch, root, …, allSecrets)`、(3) `saveProcessState`（up 成功直後）、(4) `waitForReadiness(readiness.url, …)`、(5) `seed` があれば `seedDatabase`。`launch` 無しは従来どおりスキップ。各失敗は明確メッセージ。
- **テスト:** 依存モックで「launch あり: clone→up→saveState→ready→seed の順・全呼び出し」「launch なし: スキップ」「ready 失敗で seed 未実行・エラー伝播（state は保存済みで down 可能）」。
- 本番配線（index.ts）: `loadConfig`→ 実 `composeUp`/`waitForReadiness`(fetch)/`seedDatabase`/`ensureRepoClone`(token=secrets.githubToken) を渡す。secrets マスク集合は `[anthropicApiKey, githubToken, ...db, ...targetAuth]`。

### Task 3.2: down コマンド
- **Files:** `src/cli/commands/down.ts`（新規・+ test）, `src/cli/index.ts`（登録）。
- **Interfaces — Produces:** `runDown(root, opts: { volumes?: boolean }, deps): Promise<void>` — `loadProcessState`→無ければ「起動中スタックなし」ログして return、あれば `composeDown(state, root, {volumes})`→`clearProcessState`。
- **テスト:** state あり→composeDown＋clear 呼び出し（volumes 伝播）、state なし→no-op。index.ts に `down --volumes` 登録。

---

## M4 scenario 変更＋login 実走（タスク定義）

### Task 4.1: scenario の clone 廃止・repos 直接参照
- **Files:** `src/services/repo/reader.ts`（変更）, `src/cli/commands/scenario.ts`（変更）, 関連 test。
- **Interfaces:** `collectRequirements` から `ensureRepoClone` 呼び出しを除去し、`repos/<name>`（`join(root,'repos',repo.name)`）を直接読む（init が用意済み前提）。clone が無い場合は明確エラー（「先に init を実行」）。
- **テスト:** 仮想 `repos/<name>` を用意して要件収集、clone runner が呼ばれないこと、repos 不在時のエラー。

### Task 4.2: ログインシナリオ生成（プロンプト）
- **Files:** `src/services/llm/prompts/scenario.ts`（変更）, 関連 test。
- **Interfaces:** プロンプトに「最低1件はログインシナリオ（loginPath 遷移→資格入力→submit→ログイン後状態 assert）を含める」指示を追加。`buildScenarioPrompt` の出力に target.auth 情報（loginPath）を文脈として渡す（資格値は渡さない）。
- **テスト:** プロンプト文字列にログイン要件が含まれること、資格値が含まれないこと。

### Task 4.3: ログイン実走（browser/login.ts）
- **Files:** `src/services/browser/login.ts`（新規・+ test）。
- **Interfaces — Produces:** `executeLoginScenario(page: PageLike, target: TargetEnv, scenario: Scenario, creds: { username: string; password: string }): Promise<{ ok: boolean; detail: string; finalUrl: string }>` — `target.auth.loginPath` へ遷移、ユーザー/パスワード欄に入力、submit、ログイン成功判定（URL 変化 / ログイン後要素 / 資格エラー非表示）。`PageLike` は既存 browser 抽象を流用。
- **テスト:** fake page で成功（リダイレクト）→`ok:true`、資格エラー表示→`ok:false`、フィールド不在→`ok:false` と detail。

### Task 4.4: run にログイン実走を組み込み
- **Files:** `src/cli/commands/run.ts`（変更）, `src/cli/index.ts`（配線）, 関連 test。
- **Interfaces:** ログインシナリオ（`scenario.title`/`steps` に login を含むもの）を検出し `executeLoginScenario` を実行、結果を `VerifyFinding`（category 拡張 or 専用フィールド）としてレポートに記録。既存 collect/diff/verify は温存。資格は `ctx.secrets.targetAuth`（usernameEnv/passwordEnv）から解決。
- **テスト:** login シナリオありで `executeLoginScenario` 実行・結果がレポートに入る、なしでスキップ。

---

## M5 統合＋docs（タスク定義）

### Task 5.1: 統合テスト
- **Files:** `test/integration/launch-login.integration.test.ts`（新規）。
- **内容:** 全外部 I/O（docker/git/fetch/db/playwright/anthropic）をモックし `init→scenario→run→down` を通す。init が compose up→ready→seed→state保存、scenario が repos から生成、run が login 実走、down が compose down→state clear することを artifact で assert。

### Task 5.2: RUN_E2E 実機 E2E ＋ README
- **Files:** `test/integration/launch-login.e2e.test.ts`（`it.runIf(process.env.RUN_E2E==='1')`）, `README.md`（変更）, サンプル `examples/` の compose＋seed 例（任意）。
- **内容:** サンプル compose スタックに対し clone→up→seed→login→down を通す実機 E2E（既定スキップ）。README に base ディレクトリ運用、docker 前提、`init`/`scenario`/`run`/`down` の例、`launch` 設定例、seed 冪等パターンを記載。

---

## Self-Review（spec突合）

- **スペック網羅:** §2 base/clone先→Task1.2,4.1 ／ §3 LaunchSchema→Task1.1 ／ §4.1 init拡張→Task3.1 ／ §4.2 down→Task3.2 ／ §4.3 scenario変更→Task4.1,4.2 ／ §4.4 run実走→Task4.3,4.4 ／ §5 コンポーネント→M2全タスク ／ §7 エラー→各サービスのmask＋明確メッセージ ／ §8 テスト→各タスク＋M5 ／ §9 段階→M1–M5。すべて対応タスクあり。
- **プレースホルダ:** M1・M2 は完全コード/コマンド/期待値入り。M3–M5 はスペック確定済みのタスク定義として実行直前展開を宣言（憶測ダミーコードを書かない）。
- **型整合:** `Launch`/`ComposeRunner`/`FetchFn`/`ProcessState` を一意定義し全タスクで同名参照。`composeUp`/`composeDown`/`waitForReadiness`/`seedDatabase`/`saveProcessState`/`loadProcessState`/`clearProcessState`/`executeLoginScenario` のシグネチャを上記で固定。clone 先 `repos/<name>` を Task1.2 と 4.1 で一致。
- **残課題（spec §10、実装中に詰める）:** compose ファイル所在（設定で両対応）、seed 冪等性（command 側責務）、readiness 対象URL（設定）。
