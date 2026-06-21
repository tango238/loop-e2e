# loop-e2e — AI駆動 E2E検証ループ CLI 設計仕様書

- **ステータス**: ドラフト（レビュー待ち）
- **作成日**: 2026-06-21
- **言語/ランタイム**: TypeScript / Node.js 20+ / pnpm

---

## 1. 目的とスコープ

稼働中のWebアプリケーションに対して、要件・ユースケースから自動生成した検証シナリオを定期的に実行し、

1. サイト構造を読み込んで構造化（次回以降の差分基準にする）
2. シナリオの想定結果との差分を検出
3. レイアウト・セキュリティ・条件分岐・登録データ・エラー処理を検証
4. レポート化し、問題があればGitHub Issueとして起票

までを行うCLIツール。さらにユーザーフィードバックを取り込み、検証結果とともにシナリオ・差分判定基準へ反映する学習ループを持つ。

### スコープ外（MVPでは扱わない）
- 定期実行のスケジューラ本体（外部cron/CIに委譲。CLIは単発 `run` を提供し、間隔は設定値として保持するのみ）
- SQLite等 PostgreSQL/MySQL 以外のDB（アダプタ拡張で将来対応）
- Web UI / ダッシュボード（CLI＋ファイル成果物のみ）

---

## 2. 確定した技術選定（要件確認済み）

| 領域 | 採用 | 備考 |
|------|------|------|
| LLM | **Claude (Anthropic API)** `@anthropic-ai/sdk` | シナリオ生成・ページ構造化・差分/検証の判断・フィードバック検証に使用。最新 Opus/Sonnet を既定。 |
| サイト読込/操作 | **Playwright（ヘッドレス）** | レンダリング後DOM・スクリーンショット取得、フォーム入力・ログイン自動操作。 |
| DB検証 | **PostgreSQL + MySQL（必須）** | `pg` / `mysql2`。対象システムにより接続を切替。アダプタで抽象化。 |
| 定期実行 | **設定値の保存のみ＋外部cron** | CLIは `run` を単発実行。 |
| GitHub連携 | `@octokit/rest`（トークン認証） | ラベル作成・Issue起票。 |
| CLI | `commander` ＋ 対話プロンプト（`@clack/prompts`） | |
| バリデーション | `zod` | config・シナリオ・LLM出力の検証。 |
| 設定/シナリオ形式 | `yaml`、機密は `.env`（`dotenv`） | |
| ログ | `pino` | |
| テスト | `vitest` | 単体・統合・E2E（Playwright）。 |

---

## 3. ドメインモデル（主要型）

```
RepositoryRef        { name, label, url, role: 'frontend'|'backend', audience: 'user'|'admin' }
TargetEnv            { name, baseUrl, auth?: AuthConfig }
AuthConfig           { loginPath, usernameEnv, passwordEnv, strategy: 'form'|'basic'|'none' }
DbConnection         { name, type: 'postgres'|'mysql', host, port, database, user, passwordEnv }

Config               { repositories[], targets[], databases[], schedule, scenarioDir, github }

PageInfo             { url, title, description, meta{}, displayItems[], inputItems[],
                       expectations[],   // この画面に期待すること
                       capabilities[] }  // この画面でできること
SiteStructure        { generatedAt, pages: PageInfo[], transitions: Transition[] }
Transition           { fromUrl, toUrl, trigger }

Scenario             { id, title, businessFlow, steps: ScenarioStep[],
                       expectedResults: ExpectedResult[],
                       expectedDbState: ExpectedDbRow[] }
ScenarioStep         { action, target, input?, expectedOutcome }
ExpectedResult       { kind, description, assertion }
ExpectedDbRow        { connection, table, match{}, expectedValues{} }

DiffFinding          { kind: 'transition'|'displayItem'|'inputItem'|'expectation-gap',
                       severity, expected, actual, location }
VerifyFinding        { category: 'layout'|'security'|'conditional'|'registered-data'|'error-handling',
                       severity, title, detail, evidence }
Report               { runId, startedAt, target, diffFindings[], verifyFindings[],
                       siteStructureRef, summary }
Feedback             { id, targetFindingId?, userComment, verdict?, appliedTo[] }
```

---

## 4. ファイル/ディレクトリ構成（成果物・状態）

```
<project-root>/
├─ loop-e2e.config.yaml      # 非機密設定（repos, targets, databases(接続先), schedule, scenarioDir）
├─ .env                      # 機密（ANTHROPIC_API_KEY, GITHUB_TOKEN, DB各パスワード, ログイン情報）
├─ .env.example              # init が生成するテンプレート
├─ <scenarioDir>/            # 既定 "scenarios/"
│   └─ *.scenario.yaml       # シナリオ＋想定結果＋想定DB状態
└─ .loop-e2e/                # 実行間で引き継ぐ状態
    ├─ baseline/
    │   └─ site-structure.json   # 差分検出の基準（前回受理済み構造）
    ├─ runs/<runId>/
    │   ├─ site-structure.json    # 当該実行のスナップショット
    │   └─ screenshots/*.png
    ├─ reports/<runId>/
    │   ├─ report.md
    │   └─ report.json
    └─ feedback/
        └─ *.feedback.yaml
```

機密は必ず `.env`、`loop-e2e.config.yaml` には参照名（`passwordEnv` 等）のみ保持。`.env` と `.loop-e2e/` は `.gitignore` 対象（baseline は運用方針により共有可。MVPは非コミット既定）。

---

## 5. ソースコード構成（多数の小ファイル方針）

```
src/
├─ cli/
│   ├─ index.ts                # commander エントリ、bin
│   └─ commands/
│       ├─ init.ts
│       ├─ scenario.ts
│       ├─ run.ts
│       └─ feedback.ts
├─ config/
│   ├─ schema.ts               # zod スキーマ
│   ├─ load.ts                 # config + .env ロード/検証
│   └─ save.ts
├─ domain/
│   └─ types.ts                # 上記ドメイン型
├─ services/
│   ├─ github/{client.ts, labels.ts, issues.ts}
│   ├─ db/{index.ts, adapter.ts, postgres.ts, mysql.ts}
│   ├─ browser/{browser.ts, crawler.ts, snapshot.ts}
│   └─ llm/
│       ├─ client.ts           # Anthropic クライアント薄ラッパ
│       ├─ scenarioGen.ts
│       ├─ structureExtract.ts
│       ├─ diffJudge.ts
│       ├─ verifyJudge.ts
│       ├─ feedbackVerify.ts
│       └─ prompts/*.ts
├─ pipeline/
│   ├─ collect.ts              # 3-1 情報収集
│   ├─ diff.ts                 # 3-2 差分検出
│   ├─ verify/
│   │   ├─ index.ts
│   │   ├─ layout.ts
│   │   ├─ security.ts
│   │   ├─ conditional.ts
│   │   ├─ registeredData.ts
│   │   └─ errorHandling.ts
│   └─ report.ts               # 3-4 レポート
├─ state/
│   ├─ paths.ts
│   └─ store.ts                # baseline/runs/reports/feedback の読み書き
└─ util/{logger.ts, fs.ts, hash.ts}
```

各サービスは「何をするか／どう使うか／何に依存するか」が単独で説明可能な単位とし、`pipeline` から呼び出す。LLM呼び出しは `services/llm` に集約し、出力は必ず zod で検証してから利用する。

---

## 6. サブコマンド詳細仕様

### 6.1 `init` — 初回セットアップ
**ユーザー設定（対話 or フラグ）**
- GitHubリポジトリ（複数）: `name` / `label` / `url` / `role(frontend|backend)` / `audience(user|admin)` / 権限（トークンスコープ）
- 検証対象環境 `targets`（複数可）: `baseUrl` / ログイン手順・認証情報（`.env` 参照）
- DB接続情報（複数可）: `type(postgres|mysql)` / host / port / database / user / passwordEnv
- 定期実行の間隔（分）: 設定値として保存のみ
- シナリオ配置ディレクトリ名（既定 `scenarios/`）

**自動設定**
- 各リポジトリに GitHub ラベルを作成: `Ready`（ユーザー確認後に自動対応する判別用）、`Auto-Detect`（本ツールがAIで自動登録したIssueの判別用）
- シナリオディレクトリ作成
- ルート直下に `loop-e2e.config.yaml` と `.env.example` を生成、`.loop-e2e/` 状態ディレクトリ作成
- 冪等性: 既存ラベル/ファイルがあればスキップ（再実行可能）

### 6.2 `scenario` — シナリオ生成
- 入力: 要件/ユースケース（`--from <path>` の要件ファイル/ディレクトリ、または対象リポジトリの README/docs）
- 処理:
  1. Claude が要件・ユースケースから**業務フロー**を洗い出す
  2. 各フローを検証用**シナリオ**（手順 `steps`）に変換
  3. 各シナリオの**想定結果**（`expectedResults`）と**想定DB状態**（`expectedDbState`、後段のDB検証に使用）を生成
- 出力: `<scenarioDir>/*.scenario.yaml`（zod検証）。既存シナリオは上書き前に差分提示。

### 6.3 `run` — 実行（4ステージ）
初回判別: `loop-e2e.config.yaml` の有無で初回かを判定。`.loop-e2e/baseline` 等の前回情報をロード。

**3-1 情報収集（collect）**
- 前回情報ロード: 直近レポート・フィードバック・サイト構造（baseline）
- Playwright で対象を巡回し、シナリオの遷移に沿ってページを構造化:
  - `title` / `url` / `description` / `meta` / 表示項目 / 入力項目 / この画面に期待すること / この画面でできること
  - ページ遷移（`transitions`）
- 構造化は Claude（`structureExtract`）＋DOM抽出の併用。`runs/<runId>/site-structure.json` に保存。

**3-2 差分検出（diff）**
- シナリオの想定結果 vs 実際、および 現在構造 vs baseline を比較:
  - ページ遷移の差分
  - 表示項目・入力項目（シナリオ想定とのギャップ）
  - 「期待すること」と「できること」のギャップ
- 出力: `DiffFinding[]`（Claude `diffJudge` で意味的差分も判定）

**3-3 検証（verify）**
- **レイアウト**: 画面崩れ（スクリーンショット＋オーバーフロー/重なり検査、Claude視覚判断）
- **セキュリティ**: パスワード/クレジットカード番号の平文表示有無、CSRF対策（トークン/ヘッダ）の有無
- **条件分岐**: 大人/子供料金、利用時間・割引による価格表示などがシナリオ想定通りか
- **登録データ**: DB照会し、登録内容の存在・計算/加工の妥当性を `expectedDbState` と突合
- **エラー処理**: 入力エラーメッセージの提示、ユーザーが次に取るべき行動が分かる適切な案内か
- 出力: `VerifyFinding[]`（カテゴリ・重大度付き）

**3-4 レポート（report）**
- 結果を `reports/<runId>/report.md` ＋ `report.json` に保存
- 差分結果・サイト構造を整理し、`baseline/site-structure.json` を更新（次回差分の基準）
- 問題（一定重大度以上）があれば GitHub Issue を起票し `Auto-Detect` ラベル付与。重複起票防止のため既存Issue（タイトル/フィンガープリント）と突合。

### 6.4 `feedback` — フィードバック
- **ユーザーフィードバック取込**: レポート/フィンディングIDを参照しコメント付与（CLI対話 or `*.feedback.yaml`）
- **フィードバックの検証**: Claude が妥当性を検証（誤検知か、対応すべき指摘か）
- **反映**:
  - 次回以降の差分検出・検証で再検出しないよう既知状態として登録（許容/期待値の更新）
  - シナリオ（想定結果・想定DB状態）へ反映

---

## 7. エラーハンドリング方針
- 外部依存（GitHub/DB/ブラウザ/LLM）呼び出しは try/catch で握り、ユーザー向けの明確なメッセージへ変換（機密を漏らさない）。
- LLM出力は zod 検証し、不正時はリトライ（指数バックオフ、最大N回）後にフェイル。
- `run` は各ステージを分離し、途中失敗でも収集済み成果物と部分レポートを保存。
- 機密（APIキー・パスワード）はログ・レポート・Issueへ出力しない（マスキング）。

---

## 8. テスト戦略
- **単体**: config スキーマ、各アダプタ、差分/検証ロジック（LLMはモック）。
- **統合**: DBアダプタ（テスト用コンテナ）、GitHub（Octokitモック/録画）、状態ストア入出力。
- **E2E**: Playwright でサンプル対象アプリに対し `init→scenario→run→feedback` を通す。
- LLM呼び出しはプロンプト/スキーマ境界をモックし、出力検証ロジックをテスト対象にする。
- 目標カバレッジ 80%+。

---

## 9. 段階的実装方針（MVP→拡張）
1. **基盤**: プロジェクト雛形、config スキーマ/ロード、ログ、`init`（ファイル/ラベル生成）
2. **収集**: Playwright 巡回＋構造化、状態ストア、baseline 保存
3. **シナリオ**: Claude シナリオ生成（`scenario`）
4. **差分＋レポート**: `diff` と `report`（md/json）＋ GitHub Issue 起票
5. **検証**: verify 5カテゴリ（layout/security/conditional/registered-data/error-handling）
6. **フィードバック**: `feedback` 取込・検証・反映ループ
7. **仕上げ**: 統合/E2E テスト、ドキュメント、外部cron運用例

---

## 10. 未決事項 / 確認したい点
- `scenario` の要件入力ソース: 専用要件ファイル指定を既定とするか、リポジトリのREADME/docs自動読込も含めるか。
- baseline を git 管理対象にするか（チームでの差分基準共有可否）。
- Issue 起票の重大度しきい値（どのレベルから自動起票するか）。
- Claude のモデル既定値（精度重視 Opus / コスト重視 Sonnet の使い分け方針）。
