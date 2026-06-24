# Discovery

> `/ddd discover --analyze` で既存コードベースから逆算し、ドメインエキスパート（ユーザー）と確認したモデル。

## ビジネス概要

`loop-e2e` は **AI 駆動の E2E 検証ループ**。Web アプリをクロールしてベースラインとの差分を取り、
セキュリティ／レイアウト／データ整合性などを LLM パネルで検証し、検出結果を**敵対的に裁定**してから
GitHub Issue 化する。さらにユーザーのフィードバックから学習し、誤検出を抑制していく。

中心的な価値は「クロールできること」でも「差分が取れること」でもなく、
**生の観測を“確定バグ／不要実装”へと裁定し、ノイズの少ない実用的な指摘だけを届けること**にある。

## Core Domain

- **名前**: **Finding Adjudication（検出結果の裁定）**
- **理由**:
  - 競争優位の源泉は、生の観測（diff・5種の verify・探索的入力検証）を
    **「本物のバグか？」へと昇華させる裁定ロジック**にある。クロールや差分検出自体は
    Playwright + 定型処理で代替可能（＝Generic/Supporting）。
  - 設計上も最も練られた領域で、`RefuterVote` / `FindingVerdict` / `Feedback` という型に
    不変条件が明確に結実している。
  - 単なる「バグ検出器」ではなく、`classification` に `bug` と `unnecessary` の両方を持つ
    **「バグ／不要実装の双方を判定する裁定器」**である点が、このドメインの本質。

- **差別化要因（＝意図的な moat）**:
  **敵対的・多観点裁定（adversarial multi-lens adjudication）による低誤検出。**
  - `panelSize` 名の反証者が `correctness / security / intentionality` の観点を循環割り当てされ、
    各々が**「この指摘を論破せよ」**という refute-first プロンプトで挑む。
  - **「論破できなかった（`refuted: false`）= 確認」**という反転設計により、生き残る finding が強い。
  - 多数決（`confirmedCount >= ceil(panelSize/2)`）＋確信度ゲート（`confidence >= confidenceThreshold`、
    既定 0.8）の **2段ゲート**を通過したものだけを Issue 化する。
  - 競合の「LLM に YES/NO を1回聞く」素直な判定では、LLM の迎合性により false positive が
    そのまま Issue になる。refute-first はそこに到達できない精度を生む — これがプロダクトの“売り”そのもの。

- **品質担保としての側面（同じ仕組みの別の顔）**:
  上記 moat は同時に**ノイズ抑制の品質保証機構**としても機能する。
  - 2段ゲートに加え、**フィードバック学習**で確定した誤検出を known-state として再検出抑制し、
    シナリオの `expectedResults` を更新する学習ループを回す。
  - 結果として「指摘を信頼できる」状態を維持し続けることが、ツールの継続利用価値を担保する。

## Supporting Subdomains

- **Scenario Lifecycle（シナリオの理解・提案・承認・実行）**: `grow` / `scenario` / `approve` /
  `services/llm/proposeScenarios` / `scenario/*`。アプリを動的（クロール）＋静的（ソース/要件/git ログ）に
  理解し、未カバーの検証シナリオを提案 → 承認 → 実行する。**提案＝仮説、確認結果が SSOT** という原則。
  裁定にかける「観測」を供給する上流。
- **Exploratory Input Verification（探索的入力検証）**: `services/explore/*`
  （constraintModel / caseGen / oracle / dbProbe）。DB 列定義＋HTML から制約を割り出し、
  不正・境界値を入力してバリデーションギャップとエラーメッセージ品質を検出。
  `category: input-validation` の finding として Core の裁定へ流す。
- **Site Collection & Structure（収集・構造抽出）**: `services/browser/*` / `pipeline/collect` /
  `services/llm/structureExtract`。クロール結果から LLM で `SiteStructure` を構造化。diff の入力。
- **Findings Store & Reporting（findings ストアと集約・起票）**: `state/findings` / `pipeline/report`。
  findings を共通通貨として蓄積し、重複排除（fingerprint）→ 裁定 → レポート生成 → GitHub Issue 起票。

## Generic Subdomains

- **Browser Automation**: `services/browser`（Playwright ラッパ）— 既製品で代替可能。
- **Environment Orchestration**: `prepare` / `services/setup` / `services/seed` / `services/compose` —
  repo refresh・setup hooks・seed。汎用シェル機構のみ提供し、環境固有のグルーはユーザー設定に委ねる。
- **Config Management**: `config/*`（Zod スキーマ・load/save）。
- **LLM Plumbing**: `services/llm/client`（モデル呼び出しの土台）。裁定ロジックとは分離。
- **External Integration**: `pipeline/rdraExport`（rdra-analyzer への変換アダプタ）。

## SWOT（任意・軽め）

| Strengths | Weaknesses |
|-----------|-----------|
| 反証ゲート＋学習ループという明確な moat／型に結実した裁定モデル | 制約モデリングがまだ DB列＋HTML のみ（ソース側ルール取込は未実装） |

| Opportunities | Threats |
|-------------|---------|
| 裁定精度＝そのまま差別化。レンズ追加・学習強化で堀を深められる | LLM の迎合性・モデル変動が裁定品質に直結／API コスト |

## ユビキタス言語の芽（裁定領域）

後続フェーズ（Event Storming / Aggregates）の骨格候補:

**Finding（観測）→ Refuter（反証者）/ Lens（観点）→ Vote（票）→ Verdict（裁定）→ Gate（関門）→ Issue（起票）**

- `Verdict` がこの Aggregate の不変条件（多数決＋2段ゲート）を守る中心になりそう。
- `Feedback` は裁定結果を覆す／学習させる別の入力チャネル。

## 未解決の問い

- `Exploratory Input Verification` は独立した Bounded Context か、Core（裁定）の一部として束ねるか?
- `Feedback`（学習ループ）は Core Domain の一部か、独立した Supporting か?
  — 「裁定の信頼維持」が Core 価値なら Core 内に置くのが自然だが要検討。
- レンズ（`correctness/security/intentionality`）は固定セットか、ドメインとして拡張点にすべきか?
