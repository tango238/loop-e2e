# loop-e2e Pre-run Prepare Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `loop-e2e run` の冒頭に準備フェーズ（① branch指定repoを stash→checkout→pull で最新化＋WIP復元、② ユーザー定義 setup シェルコマンドを順次実行）を追加し、毎回同じ整った環境から検証を走らせる。

**Architecture:** 既存 loop-e2e（cli→pipeline→services、全外部I/O注入可）に `refreshRepo`（git手順）と `runSetupHooks`（シェルランナー）の2サービス、それらを順に呼ぶ `prepare` パイプラインを追加し、`run` 冒頭から `--skip-prepare` 分岐付きで呼ぶ。git/シェルは注入してユニットテストはモック。

**Tech Stack:** TypeScript strict, ESM, Node 20+, pnpm, vitest, zod, `node:child_process`(execFile) for git/shell.

## Global Constraints

- Node>=20, TS strict, ESM, pnpm。Immutable data（複製更新・破壊的変更なし）。1ファイル1責務、<800行。
- 機密は注入された secrets/.env のみ。git/シェルのコマンド・出力・エラーは `maskSecrets(全シークレット)` を通す。トークンを露出しない。
- 外部呼び出し（git/シェル）は注入可能runnerでユニットテストはモック（実 git/shell/network なし）。実機は `RUN_E2E=1` gate。
- `console.log` 禁止（`logger`、テストは `test/setup.ts` で silent）。LLM出力は zod 検証（本機能は該当なし）。
- 既存 312 pass + 3 skip を壊さない。`pnpm build`/`pnpm test`/`pnpm lint` を常に緑に保つ。
- **stash 復元ポリシー**: dirtyなら stash→checkout→pull→`git stash apply`。競合なし→`git stash drop`（自動復元）。競合あり→`git reset --hard HEAD`＋stash温存＋警告で**続行**（中断しない）。
- repo の fetch/checkout/pull 失敗は run を中断。setup コマンドの非ゼロ終了は run を中断。
- 順序: ① repo refresh → ② setup hooks → 検証本体。`--skip-prepare` で①②をスキップ。

参照スペック: `docs/superpowers/specs/2026-06-22-pre-run-prepare-design.md`

---

## ファイル構成

| 区分 | パス | 責務 |
|------|------|------|
| Config | `src/config/schema.ts`（変更） | `RepositorySchema.branch?`、`ConfigSchema.setup?` 追加 |
| Service | `src/services/repo/refresh.ts`（新規） | `refreshRepo`（stash→checkout→pull→WIP復元、gitRunner注入） |
| Service | `src/services/setup/setup.ts`（新規） | `runSetupHooks`（sh -c 順次・マスク・失敗中断） |
| Pipeline | `src/pipeline/prepare.ts`（新規） | `prepare`（①refresh→②setup） |
| CLI | `src/cli/commands/run.ts`（変更） | run冒頭で prepare 呼び出し、`--skip-prepare` 分岐、injectable |
| CLI | `src/cli/index.ts`（変更） | `run --skip-prepare` 登録、実 git/shell runner 配線 |
| Docs | `README.md`（変更） | setup/branch の設定例（CORS整合コマンド）を追記 |

`ComposeRunner` 型（`src/services/compose/compose.ts`）= `(cmd, args, opts?) => Promise<{stdout,stderr}>` を git/シェルランナーとして再利用する。

---

## M1 設定

### Task 1: RepositorySchema.branch と ConfigSchema.setup

**Files:**
- Modify: `src/config/schema.ts`
- Test: `src/config/schema.test.ts`

**Interfaces:**
- Produces: `RepositorySchema` に `branch: z.string().optional()`、`ConfigSchema` に `setup: z.array(z.object({ command: z.string().min(1) })).optional()`。`Config['setup']` 型が利用可能に。

- [ ] **Step 1: Write failing test（`src/config/schema.test.ts` に追記）**

```typescript
import { describe, it, expect } from 'vitest'
import { ConfigSchema } from './schema.js'

const base = {
  repositories: [{ name: 'web', label: 'frontend-user', url: 'https://github.com/o/web', role: 'frontend', audience: 'user' }],
  targets: [{ name: 'local', baseUrl: 'http://localhost:3000', auth: { strategy: 'none' } }],
  databases: [],
  schedule: { intervalMinutes: 60 },
  scenarioDir: 'scenarios',
  github: { labels: { ready: 'Ready', autoDetect: 'Auto-Detect' } },
}

describe('branch + setup schema', () => {
  it('accepts optional repo branch and setup commands', () => {
    const cfg = ConfigSchema.parse({
      ...base,
      repositories: [{ ...base.repositories[0], branch: 'main' }],
      setup: [{ command: 'echo hi' }, { command: 'docker compose exec -T app true' }],
    })
    expect(cfg.repositories[0].branch).toBe('main')
    expect(cfg.setup?.length).toBe(2)
  })
  it('omits branch and setup when not provided', () => {
    const cfg = ConfigSchema.parse(base)
    expect(cfg.repositories[0].branch).toBeUndefined()
    expect(cfg.setup).toBeUndefined()
  })
  it('rejects a setup entry with empty command', () => {
    expect(() => ConfigSchema.parse({ ...base, setup: [{ command: '' }] })).toThrow()
  })
})
```

- [ ] **Step 2: Run → FAIL**

Run: `pnpm vitest run src/config/schema.test.ts`
Expected: FAIL（branch/setup 未対応）。

- [ ] **Step 3: Implement（`src/config/schema.ts`）** — `RepositorySchema` に `branch: z.string().optional()` を追加。`ConfigSchema` に `setup: z.array(z.object({ command: z.string().min(1) })).optional()` を追加。

- [ ] **Step 4: Run → PASS** — `pnpm vitest run src/config/schema.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts src/config/schema.test.ts
git commit -m "feat(config): add optional repo branch and setup hooks"
```

---

## M2 サービス

### Task 2: refreshRepo（git stash→checkout→pull→WIP復元）

**Files:**
- Create: `src/services/repo/refresh.ts`
- Test: `src/services/repo/refresh.test.ts`

**Interfaces:**
- Consumes: `ComposeRunner` 型（`src/services/compose/compose.ts` から import）, `ensureRepoClone`（`src/services/repo/clone.ts`）, `maskSecrets`, `logger`.
- Produces: `refreshRepo(repo: RepoConfig, branch: string, root: string, deps?: { gitRunner?: ComposeRunner; secrets?: string[] }): Promise<void>` — `repos/<name>` に対し git で stash→fetch→checkout→pull→WIP復元を行う。`RepoConfig = Config['repositories'][number]`。

- [ ] **Step 1: Write failing test（`src/services/repo/refresh.test.ts`）**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { refreshRepo } from './refresh.js'

const repo = { name: 'web', label: 'l', url: 'https://github.com/o/web', role: 'frontend', audience: 'user' } as const

// gitRunner mock that records the git subcommands and returns canned output per command.
function makeGit(porcelain: string, applyFails = false) {
  const calls: string[][] = []
  const runner = vi.fn(async (cmd: string, args: string[]) => {
    calls.push(args)
    if (args[0] === 'status') return { stdout: porcelain, stderr: '' }
    if (args[0] === 'stash' && args[1] === 'apply' && applyFails) throw new Error('CONFLICT (content): Merge conflict')
    return { stdout: '', stderr: '' }
  })
  return { runner, calls }
}
const sub = (calls: string[][]) => calls.map((a) => a.join(' '))

describe('refreshRepo', () => {
  it('clean tree: fetch → checkout → pull, no stash', async () => {
    const { runner, calls } = makeGit('') // empty porcelain = clean
    await refreshRepo(repo, 'main', '/base', { gitRunner: runner })
    const seq = sub(calls)
    expect(seq.some((s) => s.startsWith('stash push'))).toBe(false)
    expect(seq).toContain('checkout main')
    expect(seq.some((s) => s.startsWith('fetch'))).toBe(true)
    expect(seq.some((s) => s.startsWith('pull'))).toBe(true)
  })

  it('dirty tree, no conflict: stash → checkout → pull → apply → drop (auto restore)', async () => {
    const { runner, calls } = makeGit(' M file.ts\n')
    await refreshRepo(repo, 'main', '/base', { gitRunner: runner })
    const seq = sub(calls)
    expect(seq.some((s) => s.startsWith('stash push'))).toBe(true)
    const iApply = seq.findIndex((s) => s === 'stash apply')
    const iDrop = seq.findIndex((s) => s === 'stash drop')
    expect(iApply).toBeGreaterThan(-1)
    expect(iDrop).toBeGreaterThan(iApply) // drop only after a successful apply
    // checkout happened before apply
    expect(seq.findIndex((s) => s === 'checkout main')).toBeLessThan(iApply)
  })

  it('dirty tree, apply conflict: reset --hard, keep stash (no drop), do not throw', async () => {
    const { runner, calls } = makeGit(' M file.ts\n', /* applyFails */ true)
    await expect(refreshRepo(repo, 'main', '/base', { gitRunner: runner })).resolves.toBeUndefined()
    const seq = sub(calls)
    expect(seq).toContain('stash apply')
    expect(seq.some((s) => s.startsWith('reset --hard'))).toBe(true)
    expect(seq).not.toContain('stash drop') // WIP preserved in stash
  })

  it('masks the token if a git error message contains it', async () => {
    const runner = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === 'status') return { stdout: '', stderr: '' }
      if (args[0] === 'pull') throw new Error('fatal: auth failed for tok-secret-123')
      return { stdout: '', stderr: '' }
    })
    await expect(refreshRepo(repo, 'main', '/base', { gitRunner: runner, secrets: ['tok-secret-123'] }))
      .rejects.not.toThrow(/tok-secret-123/)
  })
})
```

- [ ] **Step 2: Run → FAIL** — `pnpm vitest run src/services/repo/refresh.test.ts`

- [ ] **Step 3: Implement `src/services/repo/refresh.ts`**

```typescript
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { maskSecrets } from '../../util/mask.js'
import { logger } from '../../util/logger.js'
import { ensureRepoClone, type RepoConfig } from './clone.js'
import type { ComposeRunner } from '../compose/compose.js'

const pexec = promisify(execFile)
const defaultGitRunner: ComposeRunner = (cmd, args, opts) =>
  pexec(cmd, args, opts) as Promise<{ stdout: string; stderr: string }>

export type RefreshDeps = { gitRunner?: ComposeRunner; secrets?: string[] }

/**
 * Refresh a cloned repo to the latest of `branch`:
 * stash (if dirty) → fetch → checkout → pull → restore WIP
 * (auto-pop when no conflict, leave stashed + warn on conflict).
 */
export async function refreshRepo(
  repo: RepoConfig,
  branch: string,
  root: string,
  deps: RefreshDeps = {},
): Promise<void> {
  const git = deps.gitRunner ?? defaultGitRunner
  const secrets = deps.secrets ?? []
  const cwd = join(root, 'repos', repo.name)
  const run = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await git('git', args, { cwd })
      return stdout
    } catch (err) {
      throw new Error(`git ${args[0]} failed: ${maskSecrets(String((err as Error)?.message ?? err), secrets)}`)
    }
  }

  // ensure the clone exists (token only used here, masked inside ensureRepoClone)
  await ensureRepoClone(repo, deps.secrets?.[0] ?? '', { cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 }, root, deps.gitRunner)

  const porcelain = await run(['status', '--porcelain'])
  const dirty = porcelain.trim().length > 0
  if (dirty) {
    await run(['stash', 'push', '-u', '-m', `loop-e2e auto-stash ${repo.name}`])
    logger.info({ repo: repo.name }, 'stashed local changes before refresh')
  }

  await run(['fetch', 'origin', branch])
  await run(['checkout', branch])
  await run(['pull', '--ff-only', 'origin', branch])

  if (dirty) {
    // Restore WIP. apply (not pop) so a conflict leaves the stash intact.
    try {
      await git('git', ['stash', 'apply'], { cwd })
      await git('git', ['stash', 'drop'], { cwd })
      logger.info({ repo: repo.name }, 'restored stashed changes (no conflict)')
    } catch {
      // Conflict: undo the partial apply, keep the stash, warn and continue.
      await git('git', ['reset', '--hard', 'HEAD'], { cwd }).catch(() => {})
      logger.warn(
        { repo: repo.name },
        'stash conflict on auto-restore — WIP kept in stash; run `git stash pop` manually to restore',
      )
    }
  }
}
```
（注: `ensureRepoClone` の引数順・型は `src/services/repo/clone.ts` の実シグネチャに合わせること。`ingestion` を引数に取るなら `deps` 経由で受け取る形に調整可。テストで `ensureRepoClone` が clone 済みなら fetch しないことを前提にモックする。）

- [ ] **Step 4: Run → PASS** — `pnpm vitest run src/services/repo/refresh.test.ts`

- [ ] **Step 5: Commit** — `feat(repo): add refreshRepo (stash/checkout/pull/restore)`

### Task 3: runSetupHooks（シェルコマンド順次実行）

**Files:**
- Create: `src/services/setup/setup.ts`
- Test: `src/services/setup/setup.test.ts`

**Interfaces:**
- Consumes: `ComposeRunner`, `maskSecrets`, `logger`.
- Produces: `runSetupHooks(setup: { command: string }[], root: string, deps?: { runner?: ComposeRunner; secrets?: string[] }): Promise<void>` — 各 command を `sh -c "<command>"`（cwd=root）で順次実行。失敗で中断、エラーはマスク。

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { runSetupHooks } from './setup.js'

describe('runSetupHooks', () => {
  it('runs each command in order via sh -c with cwd=root', async () => {
    const calls: string[][] = []
    const runner = vi.fn(async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { stdout: '', stderr: '' } })
    await runSetupHooks([{ command: 'echo a' }, { command: 'echo b' }], '/base', { runner })
    expect(runner).toHaveBeenCalledTimes(2)
    expect(calls[0]).toEqual(['sh', '-c', 'echo a'])
    expect(calls[1]).toEqual(['sh', '-c', 'echo b'])
  })
  it('aborts on first failure and does not run later commands', async () => {
    const runner = vi.fn(async (_c: string, args: string[]) => { if (args[1] === '-c' && args[2] === 'bad') throw new Error('boom secret-xyz'); return { stdout: '', stderr: '' } })
    await expect(runSetupHooks([{ command: 'bad' }, { command: 'echo never' }], '/base', { runner, secrets: ['secret-xyz'] }))
      .rejects.toThrow(/setup command failed/)
    expect(runner).toHaveBeenCalledTimes(1) // second command not reached
  })
  it('does not leak a secret in the error message', async () => {
    const runner = vi.fn(async () => { throw new Error('fail secret-xyz') })
    await expect(runSetupHooks([{ command: 'x' }], '/base', { runner, secrets: ['secret-xyz'] }))
      .rejects.not.toThrow(/secret-xyz/)
  })
  it('is a no-op for empty/undefined setup', async () => {
    const runner = vi.fn()
    await runSetupHooks([], '/base', { runner })
    expect(runner).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement `src/services/setup/setup.ts`**

```typescript
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { maskSecrets } from '../../util/mask.js'
import { logger } from '../../util/logger.js'
import type { ComposeRunner } from '../compose/compose.js'

const pexec = promisify(execFile)
const defaultRunner: ComposeRunner = (cmd, args, opts) =>
  pexec(cmd, args, opts) as Promise<{ stdout: string; stderr: string }>

export type SetupDeps = { runner?: ComposeRunner; secrets?: string[] }

export async function runSetupHooks(
  setup: { command: string }[],
  root: string,
  deps: SetupDeps = {},
): Promise<void> {
  const runner = deps.runner ?? defaultRunner
  const secrets = deps.secrets ?? []
  for (const { command } of setup) {
    logger.info({ command: maskSecrets(command, secrets) }, 'running setup hook')
    try {
      await runner('sh', ['-c', command], { cwd: root })
    } catch (err) {
      throw new Error(`setup command failed: ${maskSecrets(String((err as Error)?.message ?? err), secrets)}`)
    }
  }
}
```

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Commit** — `feat(setup): add setup hook runner with masking`

---

## M3 パイプライン＋CLI（タスク定義）

### Task 4: prepare パイプライン
- **Files:** `src/pipeline/prepare.ts`（新規・+ test）。
- **Interfaces — Produces:** `prepare(config: Config, root: string, deps: { refreshRepo?, runSetupHooks?, secrets?: string[] }): Promise<void>` — ① `config.repositories` のうち `branch` ありを順に `refreshRepo`、② `config.setup` を `runSetupHooks`。①→②の順。両関数は注入可能（既定は実実装）。
- **テスト:** 注入モックで「branchありrepoのみ refreshRepo 呼ばれる」「refresh→setup の順」「setup未設定なら runSetupHooks 呼ばれない（or 空配列）」。

### Task 5: run へ配線＋--skip-prepare
- **Files:** `src/cli/commands/run.ts`（変更・+ test）, `src/cli/index.ts`（登録・配線）。
- **Interfaces:** `runRun(root, opts:{target?,skipPrepare?}, deps)` の冒頭で `opts.skipPrepare` でなければ `deps.prepare(config, root, {secrets})` を呼ぶ（loadConfig 後・collect 前）。`prepare` は deps 注入。index.ts の `run` コマンドに `--skip-prepare` を追加し、実 `prepare`（実 refreshRepo/runSetupHooks）と allSecrets を配線。
- **テスト:** prepare をモックし「skip-prepareなし→collect前にprepare呼ばれる」「--skip-prepare→prepare呼ばれない」。既存 run テストの deps 形に追従。

### Task 6: README ＋ ワークスペース適用例
- **Files:** `README.md`（変更）。
- **内容:** `repositories[].branch` と `setup: [{command}]` の設定例を追記。CORS整合の setup 例（例: `docker exec <project>-app-1 sh -c 'sed -i ... SPOTLY_ADMIN_FRONT_URL ... && php artisan config:clear'`）と「環境依存コマンドはユーザー設定に置く」方針、`--skip-prepare` を記載。秘密値は載せない。

---

## Self-Review（spec突合）

- **スペック網羅:** §2.1 branch→Task1 ／ §2.2 setup→Task1 ／ §2.3 --skip-prepare→Task5 ／ §3.1 repo refresh(stash/apply/drop/conflict-reset)→Task2 ／ §3.2 setup runner→Task3 ／ §3.3 順序＋skip→Task4,5 ／ §4 コンポーネント→全タスク ／ §6 エラー/マスク→Task2,3 ／ §7 テスト→各タスク ／ §8 責務分離→Task6(README) ／ §9 段階→M1–M3。すべて対応タスクあり。
- **プレースホルダ:** M1・M2 は完全コード/コマンド/期待値入り。M3 はファイル/インターフェース/テストを確定したタスク定義として実行直前展開を宣言。
- **型整合:** `refreshRepo(repo,branch,root,deps)`／`runSetupHooks(setup,root,deps)`／`prepare(config,root,deps)` を一意に定義。`ComposeRunner` 型を git/シェル双方で再利用。`RepoConfig=Config['repositories'][number]`。`branch?`/`setup?` を Task1 と後続で一致。
- **残課題（spec §10、実装中に詰める）:** shallow clone のブランチ fetch/pull 具体手順（`ensureRepoClone` 実シグネチャに合わせ、`--depth` 付き fetch の要否を実装時に検証）、ff-only vs reset --hard（既定ff-only）、実行シェル（sh -c）。
