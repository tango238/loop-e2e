# Event Storming

> [[discovery]] で Core Domain を **Finding Adjudication（裁定）** と確定済み。本フェーズはその
> 前後のイベント駆動フローを洗い出す。`run` パイプライン（`prepare→collect→diff→verify→(login)→
> scenarios→persist→report`）と別コマンド `grow`/`explore`/`feedback` をコードから逆算。

## Domain Events（時系列）

### A. Scenario Lifecycle（理解 → 提案 → 承認）
1. `AppCrawled` — grow がログイン後のページ/フォーム/遷移を BFS クロールした
2. `SourceIngested` — リポジトリのソース/要件/直近 git ログを収集した
3. `ScenariosProposed` — 未カバー領域から Opus がシナリオ提案を生成した（`proposed/` にドラフト）
4. `ScenarioApproved` — approve で提案を active シナリオに昇格した

### B. Observation 収集（裁定にかける「観測」を作る）
5. `EnvironmentPrepared` — repo refresh + setup hooks が完了した（prepare）
6. `TargetCrawled` — collect が対象アプリをクロールした
7. `SiteStructureExtracted` — LLM が PageInfo/Transition を構造化した
8. `BaselineCompared` — diff がベースラインと比較した
9. `DiffFindingDetected` — 差分（transition/displayItem/inputItem/expectation-gap）を検出した
10. `VerificationRan` — 5カテゴリ（layout/security/conditional/registered-data/error-handling）を検証した
11. `VerifyFindingDetected` — verify が finding を検出した
12. `LoggedIn` — ログイン(+2FA)した。**run 全体で1回ではない**: `browser.newPage()` が cookie を分離するため
    ステージ単位で独立に発生し得る。ただし **collect/explore/recrawl（収集系3ステージ）は認証済み
    `BrowserContext` を共有して1回だけ**ログインする（`run --explore`、sync #3 で実装）。**login(3b)/
    scenario(3c) は意図的に独立**（3b はログイン検証そのもの、3c は authenticated↔unauthenticated を切替）。
13. `ScenarioExecuted` — adopted シナリオの steps を実機実行した
14. `ScenarioFindingRecorded` — scenario finding（pass/fail）を記録した

### B'. Exploratory Input Verification（別コマンド `explore`）
15. `ConstraintModeled` — DB列 + HTML から制約（必須/型/長さ/最小最大/形式）を割り出した
16. `InputCasesGenerated` — ルール骨格（決定的）+ LLM のエッジケースを生成した
17. `InputCaseExecuted` — 不正/境界値をフォーム送信した
18. `ValidationGapDetected` — input-validation finding を検出した
19. `DbReseeded` — `launch.seed` で DB を初期化した（破壊防止のため安全装置）

> **[M3] 発生位置はモードで変わる**: standalone `explore` では B' は独立フローで、末尾に `DbReseeded`。
> **`run --explore`** では B' イベント群が **B（collect）と verify の間**に挟まり、`DbReseeded` は
> **run 末尾へ移動して run が所有**する（reseed 遅延）。イベント自体は同じ、オーケストレーションが変わる。

### C. ★Core: Finding Adjudication（裁定）★
20. `FindingRecorded` — finding を共通ストア（`.loop-e2e/findings/`）に永続化した
21. `FindingsAggregated` — report が pending findings + activity を集約した
22. `FindingsDeduplicated` — fingerprint で重複排除した（run と explore の同一指摘を1件に）
23. `FindingAdjudicated` — **裁定が確定した（単一の不可分イベント）**。Verdict 集約の1トランザクション内で
    以下を実行: ①反証パネル（panelSize × lens 循環割当）が並列で票（RefuterVote）を投じる →
    ②多数決（confirmedCount ≥ ⌈panelSize/2⌉）で classification/confidence 確定 →
    ③2段ゲート（分類が bug|unnecessary ∧ confidence ≥ threshold）評価。
    **①②③は内部ステップであり独立イベントではない**（[Q1 決定](#裁定の粒度q1決定) 参照）。
24. `IssueFiled` — ゲート通過 finding を GitHub Issue に upsert した（fingerprint で冪等）
25. `ReportGenerated` — report.md/report.json を生成した（実施サマリ + ページ別 + ユーザー確認要セクション）
26. `BaselineUpdated` — クロールのベースラインを更新した（run のみ。explore は上書きしない）

#### 裁定の粒度（Q1・決定）

**(a) 不可分で確定。** `FindingAdjudicated` を単一の Domain Event とし、Verdict 集約が
`RefuterVote[]` / classification / confidence / ゲート結果を**値として内包**する。
- 判断基準: 「Domain Event = 他の部分が*反応する*出来事」。個々の票に反応する処理は無く
  （`adjudicate()` 内で `Promise.all` 同時計算）、反応するのは確定した Verdict のみ。
- 証拠: レポートは票の詳細（`verdict.rationale`/`verdict.votes`）を**集約の状態**として読む（票イベントを
  subscribe していない）。実装上すでに「票 = 集約内の値オブジェクト、Verdict = イベント」。
- (c) 3分割が勝つ唯一のケース＝「LLM 再実行なしで閾値だけ変えて再裁定」（イベントソーシング的リプレイ）。
  現時点で将来要件に含めないため不採用。必要になれば票を永続イベントへ昇格。

### D. 学習ループ（別コマンド `feedback`）
29. `FeedbackSubmitted` — ユーザーが finding に補正コメントを提出した
30. `FeedbackJudged` — Opus が **validity**（valid/invalid）を判定した（`feedbackVerify.verifyFeedback`）
31. `KnownStateRegistered` — valid 時に既知状態として再検出を抑制した（`saveKnownFinding`）
32. `ScenarioExpectationsUpdated` — valid 時に scenario の期待値を更新した。**カテゴリで分岐**:
    registered-data/DB 系 finding → `expectedDbState` に追記、それ以外 → `expectedResults` に追記
    （`feedback.ts:121-136`）。[M1]

## 🔴 発見された問題点（赤付箋）

- **[GAP→解消] explore → verify を `run --explore` で配線済み**: `registered-data`/`conditional`/
  `error-handling` は本来、入力検証で状態を作ってから検証されるべき（"あるべき依存"）だった。当初コードでは
  ① explore が `run` 外の別コマンド、② 直後に `DbReseeded` で巻き戻し、③ 3カテゴリの入力は explore 由来でない、
  という未配線状態だった。
  → **D-1（2パスクロール）で実装済み**: `run --explore` が explore を verify 前段のステージとして実行し、
  reseed を run 末尾へ遅延。collect（クリーン）→ diff、explore 後の再クロール → verify という2パスで、
  explore 生成状態を diff に混ぜずに verify へ渡す。`registered-data`（実行時 DB 照会）と `conditional`
  （再クロール HTML）が有効化。実装: `run.ts` Stage 0.4/1.5/1.6/5・`cli/index.ts` 配線・`config.explore.screens`。
  - **残課題（別赤付箋）**: `error-handling` は explore のエラー表示が送信直後の一過性で、後追いクロールでは
    再現しないため未対応。クロール時の能動的再送信など別設計が必要（別 issue）。
- **[仕様・決定済] uncertain finding の扱い**: ゲートで uncertain に落ちた finding を Issue 化しないのは
  **意図仕様**（ノイズ抑制＝moat ゆえ当然）。ただし**レポートには詳細を残す**: `report.md` の
  「## ユーザー確認要」セクションに ページ/Detail/Verdict(classification+confidence)/Rationale を出力する
  （`report.ts:250-258` で実装済み。Rationale = 各反証票の rationale を ` | ` 連結）。赤付箋ではなく確定仕様。

## Command / Event マトリクス（Step 2・素案）

| Actor | Command | Aggregate（仮） | → Event | 備考 |
|-------|---------|----------------|---------|------|
| Operator | `GrowScenarios` | ScenarioProposal | AppCrawled, SourceIngested, ScenariosProposed | grow |
| Operator | `ApproveScenario` | Scenario | ScenarioApproved | approve |
| Operator / Scheduler | `RunVerification` | Run | EnvironmentPrepared | run 起点（schedule.intervalMinutes） |
| System | `CollectSite` | SiteStructure | TargetCrawled, SiteStructureExtracted | collect |
| System | `DetectDiffs` | Diff | BaselineCompared, DiffFindingDetected | diff |
| System | `RunVerify` | Verification | VerificationRan, VerifyFindingDetected | verify 5カテゴリ |
| System | `ExecuteScenarios` | ScenarioRun | LoggedIn, ScenarioExecuted, ScenarioFindingRecorded | scenarios |
| Operator | `ExploreInputs` | InputExploration | ConstraintModeled, InputCasesGenerated, InputCaseExecuted, ValidationGapDetected, DbReseeded | explore |
| System | `RecordFinding` | Finding | FindingRecorded | findings store |
| Operator / System | `AggregateReport` | Report | FindingsAggregated, FindingsDeduplicated | report |
| System | `AdjudicateFinding` | **Verdict（Core）** | FindingAdjudicated | 反証ゲート（票→多数決→ゲートは集約内部・単一イベント） |
| System | `FileIssue` | Issue | IssueFiled | GitHub upsert |
| System | `GenerateReport` | Report | ReportGenerated, BaselineUpdated | |
| Operator | `SubmitFeedback` | Feedback | FeedbackSubmitted, FeedbackJudged, KnownStateRegistered, ScenarioExpectationsUpdated | feedback |

## ユビキタス言語の語彙分離（[M2]・決定）

「classification」が2つの別概念に使われていた衝突を解消する:
- **Adjudication**：`Verdict.classification` / `RefuterVote.classification` = `'bug'|'unnecessary'|'uncertain'`（enum）。
  → **`classification` の語は裁定（Adjudication）専用**とする。
- **Feedback/Learning**：判定結果は **`validity`**（valid/invalid）と呼ぶ。コードの
  `FeedbackVerifyResult.classification`（自由文字列）は語彙衝突だったため **`validityClass` にリネーム済**
  （`feedbackVerify.ts` / `feedback.ts` / tests）。
- 詳細は glossary フェーズで確定。

## Bounded Context 候補（Step 4・次フェーズへの橋渡し）

- **Adjudication（Core）**: Finding / Verdict / Gate / Issue
- **Learning**: Feedback / KnownFinding / ScenarioExpectation 更新（[Q2 決定]・下記）
- **Scenario Authoring**: ScenarioProposal / Scenario（grow→approve）
- **Observation**: SiteStructure / Diff / Verification / ScenarioRun / InputExploration（`run --explore` で統合）

### Learning を独立コンテキストとする根拠（[Q2]・決定）

Feedback フローは2方向に書き込む“学習”の上位概念で、単一コンテキストに収まらない:
- Adjudication 側：`saveKnownFinding` で**確定 Verdict を覆す**（再検出抑制）。
- Scenario Authoring 側：`saveScenario` で**シナリオ期待値を更新**（[M1]）。

→ **独立した Learning コンテキスト**として `contexts` フェーズに渡す。Adjudication / Scenario Authoring とは
下流向きの関係（Learning が両者の状態を補正する）になりそう。

## 解決済みの問い

- ✅ **裁定の粒度**: `FindingAdjudicated` 単一イベント・不可分（Verdict 集約が票を内包）。上記参照。
- ✅ **uncertain の扱い**: Issue 化しないのは意図仕様。詳細はレポートに残す（実装済み）。上記参照。
- ✅ **Feedback の所属**: 独立 **Learning コンテキスト**（Adjudication と Scenario Authoring の両方を補正）。[Q2]
- ✅ **Input Exploration の所属**: `run --explore` で Observation 前段に統合 → **Observation の一部**として扱う。
- ✅ **`classification` の語衝突**: Adjudication 専用語に確定、Feedback 側は `validity`。[M2]

## 発見された問題点（storming --analyze 追記 2026-06-26）

- 🔴 **[D-4] Scenario Authoring → Observation(3c) の `precondition.auth` 契約断絶**
  モデル（本書 12 番／マトリクス `ExecuteScenarios → LoggedIn`）は「3c は scenario の
  `precondition.auth` に応じて `LoggedIn` を発火し authenticated↔unauthenticated を切替」と想定。
  しかし実装では:
  - **上流 Scenario Authoring**（`prompts/propose.js`・`prompts/scenario.ts`）の生成プロンプトが
    *"The user is ALREADY LOGGED IN … Assume the session is already authenticated — do NOT include
    login steps"* と指示し、要求 JSON 構造に **`precondition` フィールドが存在しない**。
    → grow 生成シナリオは `precondition.auth` を一切持たない（採用済み13本すべて欠落を確認）。
  - **下流 Observation `executeScenarios`（3c）** は `scenario.precondition?.auth === 'authenticated'`
    の時のみ `ensureAuthenticated()` を呼ぶ。`precondition` が `undefined` だと authenticated でも
    unauthenticated でもない第3の経路に落ち、**ログインも明示ログアウトもしない**。
  - `runScenarioStage` は `createPage()` で **cookie の無い素のページ**を生成して 3c に渡す。
  - 結果：`navigate /dashboard`（未認証）→ アプリが `/login` にリダイレクト → 後続の fill/click/assert
    が 30s タイムアウト → scenario finding が `finalUrl=/login` で大量失敗。反証パネルは正しく
    *uncertain（テスト環境アーティファクト）* と判定した。
  - **収集系3ステージ（collect/explore/recrawl）は sync #3 で認証 `BrowserContext` 共有済みだが、
    3c（scenario）はその共有から意図的に除外**されており、かつ自前のログイン契機（precondition）も
    生成されないため、認証が成立する経路が存在しない。
  - スキーマ面：`PreconditionSchema` は `.optional()` でデフォルト無し → 「auth 不明」状態が表現可能
    （make illegal states unrepresentable 違反）。
  - **修正候補（→ `sync` で判定・実装）**:
    - **A（Authoring 側）**: propose/scenarioGen が grow シナリオに `precondition: { auth: authenticated }`
      を既定付与（grow はログイン後クロール由来なので意味的に正しい）。最小・的確。
    - **B（スキーマ既定）**: form ログイン構成のターゲットで `precondition` 省略時は `authenticated` を
      既定にする（`.default`）。横断的に安全側へ倒す。
    - **C（run 配線）**: `runScenarioStage` が 3c の素ページに対し実行前に1回ログインを確立（grow
      シナリオは全て「ambient 認証済み」前提のため）。収集系の共有契約と整合。
  - **authority**: model（モデルの意図＝認証付き実行が正。コード＝契約欠落を修正すべき）。

- 🔴 **[D-5] アクセス制御（未認証アクセス拒否）の検証が欠落（storming --challenge 2026-06-26）**
  指摘：「認証必須ページが未認証で閲覧できる」状態（OWASP Broken Access Control）を検出する仕組みが無い。
  コードの事実：`verify/security.ts` は **CSRF トークン検出のみ**。`verify/` 5カテゴリ
  （layout/security/conditional/registered-data/error-handling）に**未認証アクセスを能動プローブして
  ガードの有無を判定する負のテストは存在しない**。
  - **設計判断（--challenge で収束）**: チェックを `precondition.auth` に混ぜない。`precondition` は
    シナリオの **Arrange（事前状態確立）** に限定し、アクセス制御の **Assert** は **Verification 集約の
    新カテゴリ `access-control`** に置く（CSRF と同じ `security` 系の関心事・同じ反証ゲートを通す）。
  - **オラクル（認証必須の判定）**: 「ログイン後に発見された」だけでは不十分（公開ページの誤検知）。
    認証ゲート済みルートを **匿名で実プローブ**し、302→loginPath / 401 / 403 を**期待**する経験的判定にする。
  - **D-4 との対称性**: 同一信号源（認証ゲート済みルートの知識）が2消費者を持つ —
    Arrange＝`precondition.auth`（D-4）、Assert＝`access-control` 検証（D-5）。
  - **新イベント/コマンド**: `RunVerify` に `access-control` カテゴリ追加 → `AccessControlVerified` /
    `AuthGuardMissingDetected`（Verification 集約）。VerifyFinding(category:'access-control', severity:high)。
  - **authority**: model（意図＝ガード検証が必要。コード＝未実装ギャップ）。`sync` で実装予定。

## 未解決の問い（次フェーズ contexts/aggregates へ）

- 🟡 [残課題] `error-handling` カテゴリの explore 連携（一過性エラーの再現）— 別 issue。
- ✅ [D-4] `precondition.auth` 契約断絶 → 方針A（生成側 `applyDefaultAuthPrecondition`）で**実装・検証済**
  （[[sync]] #4。run3 で ok 0→6、evidence が認証後実URLに変化）。未コミット。
- ✅ [D-5] `access-control` 検証カテゴリ（未認証アクセス拒否の負テスト）を**実装・コミット・実パイプライン検証済**
  （[[sync]] #5。`verify/accessControl.ts`・各ページ HTML の `href` から決定的にルート発見し匿名プローブで
  guard 判定。open-pms に未ガード `/internal-report` を一時設置した実 run で 🔴 high finding を生成し反証パネルが
  `bug`(0.70) 裁定、ガード済み12ルートは誤検知0）。残スコープ外：ロール間の水平権限（IDOR）は別 divergence 候補。
