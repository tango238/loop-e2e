# loop-e2e

AI-driven E2E verification loop. Crawls your web app, detects regressions against a baseline, verifies security/layout/data integrity with an LLM panel, and learns from your feedback.

## Install

```sh
npm install -g loop-e2e
# or use without global install
npx loop-e2e <command>
```

Requires Node 20+.

## Quick start

```sh
# 1. Initialise a project (creates .loop-e2e.yaml and .loop-e2e/ state dir)
loop-e2e init

# 2. Generate test scenarios from your repository requirements
loop-e2e scenario

# 3. Run the verification loop
loop-e2e run

# 4. Submit feedback on a finding
loop-e2e feedback --run <runId> --finding 0 --comment "False positive — token is in meta tag" --scenario my-scenario
```

## Subcommands

### `init`

Scaffolds `.loop-e2e.yaml` (project config) and `.loop-e2e/` (state directory) in the current working directory. Prompts interactively for target URL, GitHub repo, and database connection.

### `scenario` *(deprecated — alias of `grow --source-only`)*

`scenario` now runs `grow --source-only`: it proposes scenarios from repository source/requirements
(no live crawl). Pass `--from <file...>` to merge additional requirement files. Output goes to
`<scenarioDir>/proposed/` as **drafts** — adopt them with `loop-e2e approve`. Prefer `grow --source-only`.

```sh
loop-e2e scenario --from docs/requirements.md docs/api.md   # == grow --source-only --from ...
```

### `run`

Runs the full verification pipeline:

```
prepare (repo refresh → setup hooks) → collect → [explore] → [re-crawl] → diff → verify → (login) → (scenarios) → persist → [reseed]
```

(`[…]` stages run only with `--explore`.)

**Stages:**

1. **prepare** — Runs at the start of every `loop-e2e run` (see [Prepare phase](#prepare-phase) below).
2. **collect** — Crawls the target app with Playwright, extracts structured page info with Claude. This is the **clean, pre-explore** crawl used by `diff`.
3. **explore** *(only with `--explore`)* — Runs the exploratory input-verification stage (see [`explore`](#explore--探索的入力検証)) to produce UI/DB state, persisting its own `input-validation` findings. **Reseed is deferred** to the end of the run.
4. **re-crawl** *(only with `--explore`)* — A second crawl **after** explore so `verify`'s `conditional`/`error-handling` categories see the produced UI state. `diff` keeps using the clean Stage-2 structure (so explore-produced state never shows up as a false diff).
5. **diff** — Compares the clean structure against baseline; detects missing transitions, changed items, expectation gaps.
6. **verify** — Runs 5 verify categories: layout, security, conditional rendering, registered data, error handling. With `--explore`, `registered-data` (queries the runtime DB) and `conditional` (reads the re-crawled pages) become meaningful because explore's writes are still present (reseed deferred).
7. **scenarios** — Executes adopted scenarios' steps against the live app (see [Scenario execution](#scenario-execution-auth-preconditions) below). Skipped with `--skip-scenarios`.
8. **persist** — Writes the run's findings to the shared **findings store** (`.loop-e2e/findings/`) + the baseline, then (unless `--no-report`) invokes the `report` aggregation. See [Findings store & report](#findings-store--report).
9. **reseed** *(only with `--explore`, unless `--no-reseed`)* — Restores the DB via `launch.seed` after explore's destructive writes. `run` owns this reseed (the standalone `explore` command reseeds itself).

```sh
loop-e2e run --target staging
loop-e2e run --skip-prepare     # Skip repo refresh and setup hooks
loop-e2e run --skip-scenarios   # Skip executing adopted scenarios
loop-e2e run --no-report        # Write findings only; aggregate later with `loop-e2e report`
loop-e2e run --explore --screen /user/create   # + exploratory input verification (destructive; reseeds after)
```

#### `run --explore` (integrated exploratory input verification)

`--explore` folds the standalone [`explore`](#explore--探索的入力検証) stage into `run`, **before** verify, so the
data-dependent verify categories observe the state it produces:

- **Destructive + reseed:** explore submits invalid/boundary input, so it writes to the DB. `run`
  re-seeds the DB at the very end (`launch.seed`). If `launch.seed` is not configured and you do not
  pass `--no-reseed`, `run --explore` **aborts before any write** (same dev-guard as `explore`).
- **Two-pass crawl:** `collect` (clean) feeds `diff`; a second crawl after explore feeds the
  `conditional`/`error-handling` verify categories. This keeps explore-produced state out of `diff`.
  The second crawl reuses the **same scenario-aware login** as the explore stage (2FA / custom
  selectors via the designated login scenario), so it actually observes the authenticated
  post-explore state; if that login fails it falls back to the pre-explore pages.
- **Screens:** `--screen <path...>` selects the forms to explore; falls back to `config.explore.screens`.
- **`error-handling` caveat:** explore's error messages are shown immediately after submit and are
  transient — a later crawl does not reproduce them. So `error-handling` does **not** yet benefit from
  `--explore` (tracked as a follow-up); `registered-data` and `conditional` do.

### Scenario execution (auth preconditions)

After `verify`, `run` executes each adopted scenario's `steps` against the live app and
records a pass/fail finding (`category: scenario`) that flows through the same report →
Opus refutation gate → GitHub issue path. Findings from failed scenarios are high severity.

A scenario declares whether it needs a login session via `precondition.auth`:

```yaml
precondition:
  auth: authenticated     # or: unauthenticated
```

- **`authenticated`** — before running, `run` checks the session by visiting the scenario's
  first `navigate` target; if the app redirects to the login path, it logs in (form + 2FA)
  first, then runs the steps. The login happens **once** and the session is reused across
  all `authenticated` scenarios in the run. If login fails, the remaining `authenticated`
  scenarios are skipped with a single high finding.
- **`unauthenticated`** — cookies are cleared (logged-out state) before the steps run.
- **absent** — no auth handling (backward compatible with untagged scenarios).

Supported step actions: `navigate`, `click`, `fill`, `submit`, `wait`, `assert`, `capture`.
`wait`/`assert` targets use `text=…` (text present), `url=…` (current URL contains), a bare
integer (milliseconds, `wait` only), or a CSS selector (element exists). `fill` inputs may
reference secrets as `{{ENV_NAME}}` (resolved from `.env`/process env) or `{{TWO_FACTOR_PIN}}`
(resolved by running the scenario's own `twoFactor.pinCommand` in its script dir — a scenario
that references `{{TWO_FACTOR_PIN}}` must therefore declare a `twoFactor` block). Resolved
secret values are masked out of all findings and logs; a referenced placeholder that cannot be
resolved fails the scenario.

### マルチアクト・シナリオ（複数アクターのフロー）

1シナリオで複数の人格（persona）が順に操作するフローを表現できます。`personas` でアクターを宣言し、
`acts` で人格ごとの手順ブロックを並べます。段の境界で人格が変わると再ログインします。`capture` で
DOM の値を変数に取り込み、後続ステップで `{{VAR}}`（大文字）として `input`・`target` の両方で参照できます。

```yaml
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
```

- `steps`（フラット・単一アクター）と `acts`（マルチアクター）は**排他**。`steps` の既存シナリオはそのまま動きます。
- `capture` の取得元：`'<selector>'`（DOM: input value → textContent）、`'url:<regex?>'`（現在 URL のグループ1/全体）、`'db:<connection>:<sql>'`（別 DB の先頭セル。`{{VAR}}` は SQL 内でも解決。read-only 用途）。
- `persona.credEnv` でアクター別の認証情報（`.env` のキー名）を指定。未指定なら（解決した）ターゲットの認証情報を使います。

#### システム跨ぎ（複数ターゲット）

`persona.target` に `config.targets` の別ターゲット名を指定すると、その段は別アプリ（別 `baseUrl`/認証）で
実行されます。1つのブラウザで各ドメインのセッションを保持するため、admin と storefront をまたぐ
フローを1シナリオで検証できます。**段の境界でターゲットが変わると再ログインしません**（別ドメインで
独立セッション）。同一ターゲット上で人格だけ変わる場合のみ再ログインします。

```yaml
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
```

- 跨ぎ `expectedDbState` は対象 DB を `config.databases` に追加すれば既存の検証ステージが照合します。
- **`db:` SQL はシナリオ作者が書く信頼入力**です（read-only 用途）。`db:` SQL に渡せる `{{VAR}}` には
  DOM/URL から `capture` した**アプリ由来の値**が入り得るため、SQL は文字列補間されます。**アプリ由来の
  untrusted な値を `db:` SQL に直接補間しないでください**（SQL インジェクションになり得ます）。内部 ID 等の
  信頼できる値の照合に限って使ってください。
- **A→B→A フロー**（同一ターゲット A 上で人格だけ切替）では再ログイン時にコンテキスト全体の cookie を
  消すため、間に挟んだ別ターゲット B のセッションも失われます（稀なケース）。

**Writing reliable scenarios:**

- **Start each scenario with a `navigate` step.** The browser page is reused across scenarios,
  so a scenario that begins with `click`/`assert` runs against whatever page the previous
  scenario (or a failed login) left behind. A leading `navigate` makes each scenario
  self-contained. (`grow`-generated scenarios already do this.)
- **Pair `submit` with a following `assert`.** A `submit` step only clicks and waits for a
  client-side navigation; it does **not** fail when the form is rejected and the page stays
  put. To actually catch a broken submission, follow it with an `assert` (e.g.
  `assert url=/dashboard` or `assert text=Saved`) that confirms the expected outcome.

`grow`-generated scenarios are post-login pages — tag them `authenticated`; tag a login-flow
scenario `unauthenticated`.

### Prepare phase

The prepare phase runs automatically at the start of every `loop-e2e run` (before collect/diff/verify) to ensure repositories are up-to-date and environment-specific configuration is applied. It consists of two parts: **repo refresh** and **setup hooks**.

#### Repository branch refresh

If a repository has a `branch` set in the config, `loop-e2e run` will refresh it to the latest of that branch:

1. Stash any local changes (if the repository is dirty)
2. Checkout the branch
3. Pull the latest changes
4. Restore the stashed changes (WIP)

If a stash conflict occurs, the WIP remains in the stash for manual resolution via `git stash pop`, and the run continues on the latest code.

Example config with branch refresh:

```yaml
repositories:
  - name: frontend
    label: Frontend
    url: https://github.com/org/frontend
    role: frontend
    audience: user
    branch: main           # Refresh to latest of main on each run
```

#### Setup hooks

After repos are refreshed, setup hooks run in order. These are shell commands (specified with `command`) that run from the workspace root as `sh -c`. Use setup hooks for environment-specific preparation (CORS config, API endpoints, database setup, etc.). The first failure aborts the run; secrets are masked in logs and error messages.

Example config with setup hooks:

```yaml
setup:
  - command: "docker exec myproject-app-1 sh -c 'sed -i \"s#^FRONT_URL=.*#FRONT_URL=https://dev.example.com:3100#\" /var/www/.env && php artisan config:clear'"
  - command: "docker exec myproject-db-1 psql -U postgres -d myapp -c \"UPDATE config SET env_mode = 'test' WHERE id = 1;\""
```

Environment-specific preparation (database state, API mocking, auth setup, etc.) belongs in your own config file, not in loop-e2e core — loop-e2e only provides the generic shell command mechanism.

#### Skipping prepare

To skip the entire prepare phase (useful for fast iteration during debugging):

```sh
loop-e2e run --skip-prepare
```

This bypasses both repo refresh and setup hooks.

### `feedback`

Submits a correction on a finding from a previous run. The LLM (Opus) judges whether the comment is a valid correction or a misunderstanding.

- **Valid feedback:** registers the finding as known-state (suppresses future re-detection) and updates the referenced scenario's `expectedResults`.
- **Invalid feedback:** recorded for audit but no state is mutated.

```sh
loop-e2e feedback \
  --run 2024-01-15T10-00-00-000Z \
  --finding 0 \
  --comment "CSRF token is served via meta tag, not form field — false positive" \
  --scenario login-flow
```

Options:

| Flag | Description |
|------|-------------|
| `--run <runId>` | Run ID (required) |
| `--finding <n>` | Zero-based index into `verifyFindings` (default: 0) |
| `--comment <text>` | Free-text correction (required) |
| `--scenario <id>` | Scenario ID to update on valid feedback |
| `--scenario-dir <dir>` | Scenario directory (default: `<cwd>/scenarios`) |

### `grow` — アプリ理解 → シナリオ提案（統合）

`grow` は **実機クロール（動的）** と **リポジトリのソース/要件/git ログ（静的）** の両方からアプリ
を理解し、未カバーの検証シナリオを提案します。提案は `<scenarioDir>/proposed/` の**ドラフト**として
保存され、`loop-e2e approve` で採用 → `run` で実行・確認します（提案=仮説、確認結果が SSOT）。

- 動的：認証（2FA込み）→ ログイン後のページ/フォーム/遷移を BFS クロール → 未カバー判定
- 静的：設定リポジトリのコード/要件/直近 git ログを収集
- 提案：未カバーページ＋ソース要約を融合して Opus がシナリオ提案（バッチ・部分失敗分離）

```sh
loop-e2e grow                 # 既定：ソース＋クロール
loop-e2e grow --source-only   # ソースのみ（実機・認証不要）＝ 旧 scenario
loop-e2e grow --crawl-only    # クロールのみ ＝ 旧 grow
loop-e2e grow --target admin --max-pages 30
loop-e2e grow --skip-prepare
```

| Flag | Description |
|------|-------------|
| `--target <name>` | 対象ターゲット（default: 先頭） |
| `--max-pages <n>` | クロール最大ページ数（`grow.maxPages` を上書き） |
| `--source-only` | ソース/要件のみ（クロールしない・認証不要） |
| `--crawl-only` | クロールのみ（ソースを使わない） |
| `--skip-prepare` | prepare 省略 |

`grow` は `ANTHROPIC_API_KEY` を必要とし、クロール時はログインシナリオの
`twoFactor.pinCommand`（2FA がある場合、[2FA](#2fa--owned-by-the-login-scenario-not-config) 参照）を使います。

> **移行**: `scenario` は `grow --source-only` の**非推奨エイリアス**です。従来 `scenario` は
> `scenarios/` に直接保存していましたが、統合後は **`proposed/` に保存**され、採用には
> `loop-e2e approve` が必要です（提案 → 承認 → 確認の一貫フロー）。

### `approve`

Promotes proposed drafts (from `grow`) to active scenarios. Active scenarios are
what `run` executes; proposals under `proposed/` are ignored by `run` until approved.
Approval refuses to overwrite an existing active scenario of the same id (skipped with a reason).

```sh
loop-e2e approve --all            # adopt every proposed scenario
loop-e2e approve grow-hotel-list  # adopt specific ids
```

### `rdra-export`

Exports adopted scenarios into an [rdra-analyzer](https://github.com/tango238/rdra-analyzer)
`analysis_result.json` so its RDRA modelling / CRUD-gap / viewer steps can run on loop-e2e's
scenarios. loop-e2e owns the scenarios; rdra-analyzer owns the usecases (from its `analyze`).

```
rdra-analyzer analyze          # rdra produces usecases in analysis_result.json
loop-e2e rdra-export           # merge route-matched scenarios in; hand off the rest
rdra-analyzer reconcile        # rdra fact-checks unmatched scenarios → creates/links usecases
rdra-analyzer rdra / verify / gap
```

```sh
loop-e2e rdra-export
loop-e2e rdra-export --into /path/to/output/usecases/analysis_result.json
```

Behaviour:
- Each scenario is matched to a usecase by **route** — its first `navigate` path and its API
  endpoints (`kind:'api'` expectedResults) are compared against the usecase's
  `related_pages` / `related_routes` using a shared `normalizeRoute` (leading `GET/POST/…`
  method token stripped, `ANY` = wildcard, path normalized). Priority:
  navigate-exact > api-exact > navigate-prefix > api-prefix.
- **Matched** scenarios are merged into `analysis_result.json` `scenarios[]`, tagged
  `scenario_id = "LE-<id>"`. Re-running replaces only `LE-` scenarios (idempotent); usecases,
  non-`LE-` scenarios, and unknown fields are preserved. The merged `api_endpoint` is a single
  string (rdra reads it as a scalar).
- **Unmatched** scenarios are written to `loop-e2e-pending.json` (same dir as `--into`) with
  structured `api_endpoints` (`{method,path,raw}[]`) for rdra-analyzer's reconcile step to
  fact-check against source and link to a usecase. If none are unmatched, no pending file.
- The written `analysis_result.json` is always referentially valid (no dangling `usecase_id`);
  a validation failure aborts the write.

| Flag | Description |
|------|-------------|
| `--into <path>` | rdra-analyzer `analysis_result.json` (default: `<cwd>/output/usecases/analysis_result.json`) |
| `--scenario-dir <dir>` | Scenario directory (default: `<cwd>/<config.scenarioDir>`) |

### `explore` — 探索的入力検証

各画面のフォームに、わざと不正/境界の値を入力して何が起きるかを探索的に検証し、
(1) **バリデーションギャップ**（不正値が拒否されず DB に保存される）と
(2) **エラーメッセージ品質**（1つにまとめられて分かりにくい等）を検出します。

```bash
loop-e2e explore --screen /user/create --screen /coupon/create
loop-e2e explore --target spotly --screen /hotel/create
loop-e2e explore --screen /user/create --no-reseed   # 再シードしない（dev ガードを外す）
```

Behaviour:
- 制約（必須/型/長さ/最小最大/形式）は **DB テーブル定義**（および将来はソースのバリデーション
  ルール）から Opus が割り出します（フロント/DB/API の命名ズレを吸収）。
  > 注: ソース側ルール（Laravel FormRequest / Zod 等）の取り込み（spec §4.2）は**未実装の後続課題**で、
  > 現状の制約モデリングは DB 列 ＋ HTML のみを使用します。
- ケースは **ルールベース骨格（決定的）＋ LLM の創造的エッジケース**で生成します。
- gap 判定は **UI/ネットワーク信号で疑い検出 → DB 照会で裏取り**：保存を確認できれば `high`、
  DB 照会不可なら `medium`。エラーメッセージ品質は Opus が評価します。
- 結果は `category: 'input-validation'` の finding として、既存のレポート
  （`report.md`/`report.json`）＋反証ゲート経由で GitHub Issue 化されます。
  クロールのベースラインは上書きしません。
- **安全性**: dev/local 前提。実行後に `launch.seed` で DB を初期化します。`launch.seed` が
  未設定かつ `--no-reseed` でもない場合は、破壊防止のため**中断**します。認証失敗時もフォーム送信前に中断します。

| Flag | Description |
|------|-------------|
| `--target <name>` | Target name to run against (default: first target) |
| `--screen <path...>` | Screen path(s) to explore (repeatable) |
| `--skip-prepare` | Skip the pre-run prepare phase (repo refresh + setup hooks) |
| `--no-reseed` | Do not re-seed after the run (skips the dev-guard) |
| `--no-report` | Write findings to the store only; aggregate later with `loop-e2e report` |

### Findings store & report

Findings are the common currency. `run` and `explore` each write their findings to a shared
**findings store** (`.loop-e2e/findings/`); `grow` and `scenario` record a one-line **activity**
summary. The standalone **`report`** command aggregates everything into a single report:

- reads all pending findings + activity,
- de-duplicates across sources (by fingerprint — e.g. the same page flagged by both `run` and
  `explore` collapses to one),
- runs the Opus refutation gate once, files GitHub issues for high-confidence bugs,
- writes one `report.md`/`report.json` (with a 実施サマリ section + a **ページ** line per finding),
- archives the consumed entries so the next `report` starts clean.

By default `run`/`explore` auto-invoke `report` at the end (single-command UX, unchanged). Pass
`--no-report` to decouple, then aggregate once at the end:

```sh
loop-e2e run --no-report
loop-e2e explore --screen /user/create --no-report
loop-e2e report          # one report + issues covering both run and explore
```

```sh
loop-e2e report                 # aggregate all pending findings/activity
loop-e2e report --target staging
```

## Config file

`.loop-e2e.yaml` in the project root:

```yaml
repositories:
  - name: frontend
    label: Frontend
    url: https://github.com/org/frontend
    role: frontend
    audience: user

targets:
  - name: staging
    baseUrl: https://staging.example.com
    auth:
      strategy: form          # form | basic | none
      loginPath: /login
      usernameEnv: APP_USER
      passwordEnv: APP_PASS

databases:
  - name: main
    type: postgres            # postgres | mysql
    host: localhost
    port: 5432
    database: myapp
    user: postgres
    passwordEnv: DB_PASSWORD

schedule:
  intervalMinutes: 60

scenarioDir: scenarios

# Language for AI-generated human-readable text — scenarios (grow/scenario),
# the run report body, and GitHub-issue finding details/rationale.
# Unset → Japanese. Set to "en" (or any language name) to change it.
# Code, selectors, URLs, identifiers and JSON keys are never translated.
language: ja

github:
  owner: org
  repo: frontend
  labels:
    ready: Ready
    autoDetect: Auto-Detect

baseline:
  commit: false               # true = pin baseline to a specific git commit

models:
  planning: claude-opus-4-8
  report: claude-sonnet-4-6
  verification: claude-opus-4-8

ingestion:
  cloneDepth: 50
  tokenBudgetPerRepo: 120000
  gitLogCount: 50

refutation:
  panelSize: 3
  confidenceThreshold: 0.8
  lenses:
    - correctness
    - security
    - intentionality
```

### 2FA — owned by the login scenario (not config)

2-factor login is **environment-specific glue**, so it lives with the **login scenario**, not
in config. loop-e2e core stays env-agnostic: it just runs the command the scenario specifies,
in the scenario's script directory.

**Script placement convention:** scripts a scenario uses live in
`scenarios/<scenario-file-name>/` (the directory named after the scenario file, minus
`.scenario.yaml`). For `scenarios/admin-login.scenario.yaml`, that's `scenarios/admin-login/`.

Add a `twoFactor` block to the login scenario. `pinCommand` is a shell command that prints the
current PIN to stdout (loop-e2e extracts the first 4–8 digit run); it runs with **cwd = the
scenario's script dir**, so it can reference scripts placed alongside the scenario:

```
scenarios/
  admin-login.scenario.yaml
  admin-login/
    get-2fa-pin.sh          # reads the PIN from a dev mail catcher, app DB, etc.
```

```yaml
# scenarios/admin-login.scenario.yaml
id: admin-login
title: 管理画面ログイン
businessFlow: メール・パスワードでログインし、2FA の PIN を入力してダッシュボードに到達する。
steps:
  - { action: navigate, target: /login, expectedOutcome: ログインフォーム表示 }
  # … fill credentials, submit, fill {{TWO_FACTOR_PIN}}, submit …
expectedResults:
  - { kind: ui, description: ダッシュボード表示, assertion: /login と /two-factor-auth から離れている }
expectedDbState: []
precondition:
  auth: unauthenticated
twoFactor:
  pinCommand: bash get-2fa-pin.sh        # cwd = scenarios/admin-login/
  pinFieldSelector: 'input[name="pin_code"]'   # default
  submitSelector: 'button[type="submit"]'      # default
  # successUrlPattern: '/dashboard'            # optional; default = moved off /login and /two-factor
```

Authenticated-precondition scenarios (and `grow`/`explore`) reuse this designated login
scenario's 2FA automatically — they find it among the loaded scenarios by its login path.

### grow config

```yaml
# Discovery crawl limits for `grow` (all optional; defaults shown)
grow:
  maxPages: 50
  maxDepth: 3
  excludePaths: ['/logout', '/api']
```

The PIN value and credentials are never written to logs, reports, or the
`detail` of a login result. Proposed scenarios from `grow` are saved under
`<scenarioDir>/proposed/` and adopted with `loop-e2e approve`.

## Environment variables (`.env`)

```dotenv
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...

# Database passwords (names match passwordEnv in config)
DB_PASSWORD=secret

# Target auth (names match usernameEnv/passwordEnv in config)
APP_USER=admin
APP_PASS=pass
```

## Local-launch workflow

`loop-e2e` can manage a local Docker Compose stack so you can run the full E2E
loop on your laptop without a deployed staging environment. The stack lifecycle
(`up`, readiness poll, seed, `down`) is wired into the four CLI commands:

```
loop-e2e init      # clone repos → docker compose up -d → readiness → seed
loop-e2e scenario  # generate scenarios from cloned source
loop-e2e run       # execute login + verify against the live local stack
loop-e2e down      # docker compose down → clear state
```

### Base directory layout

```
<project-root>/
  loop-e2e.config.yaml      # project config (includes launch block)
  .env                      # secrets — never commit this
  repos/
    <name>/                 # shallow clones (one per repository)
  scenarios/
    *.scenario.yaml         # generated scenario files
  .loop-e2e/
    process.json            # running stack state (projectName, composeFiles, …)
    baseline/               # site structure baseline
    reports/                # per-run reports
    feedback/               # feedback items
    known-findings/         # acknowledged false-positives
```

### `launch` config block

Add a `launch` section to `loop-e2e.config.yaml`:

```yaml
launch:
  compose:
    files:
      - docker-compose.yml        # relative to the project root, or absolute
    projectName: my-app-local
    envFile: .env                 # optional — passed as --env-file to compose

  readiness:
    url: http://localhost:3000/health
    timeoutSec: 180               # how long to wait for the stack (default 180)
    intervalSec: 3                # poll interval (default 3)

  seed:
    command: docker exec my-app-db psql -U postgres -d app -f /seed.sql

  targetName: local               # must match a name in targets[]
```

Full config example with `launch`:

```yaml
repositories:
  - name: frontend
    label: Frontend
    url: https://github.com/org/frontend
    role: frontend
    audience: user

targets:
  - name: local
    baseUrl: http://localhost:3000
    auth:
      strategy: form
      loginPath: /login
      usernameEnv: APP_USER
      passwordEnv: APP_PASS

databases:
  - name: main
    type: postgres
    host: localhost
    port: 5432
    database: app
    user: postgres
    passwordEnv: DB_PASS

schedule:
  intervalMinutes: 60

scenarioDir: scenarios

github:
  labels:
    ready: e2e-ready
    autoDetect: e2e-auto

baseline:
  commit: false

models:
  planning: claude-opus-4-8
  report: claude-sonnet-4-6
  verification: claude-opus-4-8

ingestion:
  cloneDepth: 50
  tokenBudgetPerRepo: 120000
  gitLogCount: 50

refutation:
  panelSize: 3
  confidenceThreshold: 0.8
  lenses:
    - correctness
    - security
    - intentionality

launch:
  compose:
    files:
      - docker-compose.yml
    projectName: my-app-local
  readiness:
    url: http://localhost:3000/health
    timeoutSec: 180
    intervalSec: 3
  seed:
    command: docker exec my-app-db psql -U postgres -d app -f /seed.sql
  targetName: local
```

### `.env` keys for local launch

```dotenv
# Anthropic and GitHub (required by all commands)
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...

# Database password — name must match passwordEnv in databases[]
DB_PASS=secret

# Target auth credentials — names must match usernameEnv/passwordEnv in targets[].auth
APP_USER=admin@example.com
APP_PASS=changeme
```

### Seed idempotency

The `seed.command` is run by `loop-e2e init` every time it is called. Your seed
script must be safe to run more than once. Use `INSERT … ON CONFLICT DO NOTHING`
(Postgres) or equivalent, or gate on `IF NOT EXISTS`. The sample seed in
`examples/sample-stack/seed.sql` demonstrates this pattern.

### Scheduling

Run `loop-e2e init` once to bring the stack up, then schedule `loop-e2e run`
to repeat the verify loop. Call `loop-e2e down` to tear down when done. See
[Scheduling with cron](#scheduling-with-cron) for cron and CI examples.

### Sample stack

`examples/sample-stack/` contains a minimal nginx + postgres compose stack you
can use to smoke-test the local-launch workflow without a real application. See
the `.env.example` there for the required variables.

## Scheduling with cron

`loop-e2e` has no built-in scheduler. Use your OS cron or any job runner:

```cron
# Run every 30 minutes
*/30 * * * * cd /path/to/project && loop-e2e run >> /var/log/loop-e2e.log 2>&1
```

Docker / CI example:

```yaml
# GitHub Actions — scheduled run
on:
  schedule:
    - cron: '0 */2 * * *'   # every 2 hours
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx loop-e2e run
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          DB_PASSWORD: ${{ secrets.DB_PASSWORD }}
```

## State files

All state lives under `.loop-e2e/` (add to `.gitignore` unless you want to commit the baseline):

```
.loop-e2e/
  baseline/baseline.yaml          # Site structure baseline
  runs/<runId>.yaml               # Per-run site structure snapshots
  reports/<runId>/report.json     # Machine-readable report
  reports/<runId>/report.md       # Human-readable report
  feedback/<id>.feedback.yaml     # Per-feedback-item files
  known-findings/<fp>.yaml        # Acknowledged false-positives (suppressed in future runs)
  scenarios/                      # Generated scenario files (*.scenario.yaml)
```
