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
12. `LoggedIn` — 認証要シナリオの前にログイン(+2FA)した（1回・セッション再利用）
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

## 未解決の問い（次フェーズ contexts/aggregates へ）

- 🟡 [残課題] `error-handling` カテゴリの explore 連携（一過性エラーの再現）— 別 issue。
