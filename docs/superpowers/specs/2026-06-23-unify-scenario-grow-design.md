# scenario と grow の統一（Phase1）設計仕様書

- **ステータス**: ドラフト（レビュー待ち）
- **作成日**: 2026-06-23
- **対象**: `scenario` と `grow` を1つの「理解＆提案」コマンド `grow` に統合する（責務整理の Phase1）。

---

## 1. 目的と責務

**ツールの責務**：実際に動作確認した情報を SSOT として品質を検証する。
そのために「**アプリを理解 → 検証シナリオを提案（仮説）→ `approve` で採用 → `run` で実行・確認 → 確認結果が SSOT**」という流れにする。

`scenario`（静的＝ソース理解）と `grow`（動的＝実機クロール理解）は、本質的に同じ責務「アプリを理解して検証対象（シナリオ）を提案する」であり、違うのは**理解の source だけ**。よって1コマンド `grow` に統合し、**静的＋動的の両シグナルを融合**して提案する。

### 確定事項（2026-06-23）
- 統合コマンド名 = **`grow`**（scenario のソース理解を吸収）。
- `scenario` は **`grow --source-only` の薄いエイリアス**として残す（非推奨表示・後方互換）。
- フロー表現 = **マルチアクト・シナリオ**方向（Phase2 以降）。
- 進め方 = **段階的**（本仕様は Phase1 のみ。Phase2/3 はロードマップ）。
- **全提案を `proposed/` に統一**（現 `scenario` の「`scenarios/` へ直接保存」をやめ、提案=仮説 → `approve` で採用に一本化）。

### スコープ外（Phase2/3、ロードマップ §9）
- personas＋acts スキーマ拡張とマルチアクト実行（Phase2）。
- システム跨ぎ（複数ターゲット運用＋`capture`/`{{VAR}}`）（Phase3）。

---

## 2. 統合 `grow` の挙動

```
loop-e2e grow [--target <name>] [--max-pages <n>] [--skip-prepare]
              [--source-only] [--crawl-only]
 0. prepare          現状どおり（!skipPrepare）
 1. 静的理解（gather-source）  !crawlOnly のとき collectRequirements で repos のコード/要件/git ログを収集
 2. 動的理解（gather-crawl）   !sourceOnly のとき authenticate(2FA)→discoverPages(BFS)→未カバー判定
 3. 融合提案（propose）        未カバーページ＋要件コンテキストを融合して Opus がシナリオ提案（バッチ）
 4. 保存                       全提案を proposed/ にドラフト保存
```

- 既定（フラグ無し）= **静的＋動的の両方**。
- `--source-only` = 静的のみ（実機・認証・クロール不要＝旧 `scenario`）。
- `--crawl-only` = 動的のみ（旧 `grow` 相当）。
- `--source-only` と `--crawl-only` の同時指定はエラー。

全外部I/O（browser/llm/repo/shell）は注入可能。ユニットテストはモック。

---

## 3. 融合提案（`src/services/llm/proposeScenarios.ts` 拡張）

現状: `proposeScenarios(llm, uncovered: RawPage[], deps)`（ページ単位バッチ提案）。
統合後は **2つの寄与**を合成する:

- **(a) ページ由来提案**（クロール）: 各未カバーページの PageInfo から提案。プロンプトに**関連する要件/ソース要約も同梱**して、より機能的なシナリオを誘導。
- **(b) ソース由来提案**（要件）: 単一ページに紐づかない業務フロー等を要件/コードから提案（現 `generateScenarios` 相当）。

API（拡張）:
```ts
export type ProposeInput = {
  uncovered: RawPage[]                 // 動的（空可）
  requirements: RequirementContext[]   // 静的（空可）
  authHint?: AuthHint                  // login パス等
}
proposeScenarios(llm, input: ProposeInput, deps?): Promise<Scenario[]>
```
- `uncovered` があれば (a) を**バッチ**（既定5ページ/回、現行の堅牢化を維持）で実行。各バッチのプロンプトに `requirements` の要約を付加。
- `requirements` があれば (b) を実行（`generateScenarios` を内部利用）。
- 両者の結果を結合 → `normalizeIds`（`grow-` プレフィックス＋ユニーク化、現行流用）で id 正規化・重複排除。
- ページ抽出・各バッチ・ソース提案の**部分失敗は分離**（1つ失敗しても他は継続、現行の耐性を踏襲）。
- `uncovered` も `requirements` も空なら `[]`。

`generateScenarios`（`scenarioGen.ts`）は (b) の内部実装として存続。出力言語は `config.language`（既定日本語）。

---

## 4. パイプライン（`src/pipeline/grow.ts` 拡張）

`GrowArgs`/`GrowDeps` を拡張:
- `GrowOpts`（CLI 由来）に `sourceOnly?: boolean` / `crawlOnly?: boolean`。
- `GrowDeps` に `collectRequirements`（注入）を追加。

`grow()` の流れ:
1. prepare（現状）。
2. `existing = loadScenarios(scenarioDir)`（提案の未カバー判定・id 重複回避用。現状もログイン前ロード）。
3. **静的**（`!crawlOnly`）: `requirements = collectRequirements(config.repositories, {...})`。失敗時は警告して空で継続。
4. **動的**（`!sourceOnly`）: `authenticate` → `discoverPages` → `findUncoveredPages(discovered, existing)`。`sourceOnly` のときはブラウザ起動・認証も**行わない**。
5. `proposed = proposeScenarios(llm, { uncovered, requirements, authHint }, deps)`。
6. `existing` と id 衝突するものは除外、残りを `saveProposedScenario` で `proposed/` へ。
7. `appendActivity`（提案件数。findings ストア機能と整合）。

`GrowResult` に `mode: 'full'|'source'|'crawl'` と `requirementsRepos: number` を追加（CLI 出力用）。

---

## 5. CLI（`src/cli/index.ts` / `src/cli/commands/grow.ts` / `scenario.ts`）

- `grow` コマンドに `--source-only` / `--crawl-only` を追加。`grow.ts` の `runGrow` が両フラグを `GrowOpts` に通す。`sourceOnly` のときブラウザ起動を**スキップ**（`createPage` 不要）。`collectRequirements` を実deps配線。
- `scenario` コマンドは **`grow --source-only` のエイリアス**に変更:
  - `runScenario` を deprecated 化し、内部で `runGrow(cwd, { sourceOnly: true, ... })` を呼ぶ薄いラッパーにする（`--from` は `collectRequirements` の `fromPaths` に流す → `GrowOpts.fromPaths` を追加）。
  - 標準エラーに「`scenario` は非推奨。`grow --source-only` を使ってください」を1回出す。
- `grow` の標準出力: `grow(<mode>): discovered D / uncovered U / source-repos R → proposed P 件 → proposed/`。

### 振る舞いの変更（移行ガイド）
- 旧 `scenario` は `scenarios/` に直接（採用済み）保存していたが、統合後は **`proposed/` に保存**。採用には `loop-e2e approve` が必要になる。README に明記。

---

## 6. エラーハンドリング・セキュリティ
- `--source-only` と `--crawl-only` 同時 → 明確なエラーで終了。
- 静的収集失敗（リポジトリ未取得等）→ 警告＋空 requirements で継続（動的提案は可能）。
- 動的（認証/クロール）失敗 → 現状どおり grow を中断（実機が前提のとき）。ただし `--source-only` では発生しない。
- 秘密値（認証情報・PIN・トークン）は従来どおりマスク。

---

## 7. テスト戦略
- **proposeScenarios**: uncovered のみ／requirements のみ／両方／両方空、各ケースで提案が結合・重複排除されること。ページバッチの部分失敗分離（現行テスト維持）。要件コンテキストがページ提案プロンプトに含まれること。
- **grow パイプライン**: `sourceOnly` で authenticate/discoverPages を**呼ばない**・collectRequirements を呼ぶ／`crawlOnly` で collectRequirements を呼ばない／既定で両方／既存 id 衝突の除外／`appendActivity` 呼び出し。
- **CLI**: `grow --source-only`/`--crawl-only` のフラグ伝播、同時指定エラー、`scenario` が `grow --source-only` を呼ぶ（`--from`→fromPaths）こと、非推奨警告。
- 既存スイートを壊さない（現 545 pass / 5 skip を維持・更新）。
- **実機**: フロント稼働時に `grow`（既定）で proposed が生成され、日本語であること（出力言語機能と整合）。

---

## 8. コンポーネント構成
```
src/services/llm/proposeScenarios.ts   # ProposeInput 対応（uncovered＋requirements 融合、(b) で generateScenarios 利用）
src/pipeline/grow.ts                   # sourceOnly/crawlOnly 分岐、collectRequirements 注入、GrowResult 拡張
src/cli/commands/grow.ts               # --source-only/--crawl-only、collectRequirements 配線、ブラウザ起動条件化
src/cli/commands/scenario.ts           # grow --source-only への薄いエイリアス（deprecated）
src/cli/index.ts                       # grow にフラグ追加、scenario 配線
README.md                              # 統合の説明＋移行ガイド（scenario→proposed/）
```

---

## 9. ロードマップ（合意済み・本仕様の対象外）

- **Phase2 — マルチアクト・シナリオ**: ScenarioSchema に `personas`（name/target/auth）と `acts`（persona 別 steps）を追加。実行側は段ごとに該当ペルソナのセッションを該当ターゲットで確立し手順実行。`capture` ステップ＋`{{VAR}}` 変数バッグで段間データ受け渡し。
- **Phase3 — システム跨ぎ**: config の複数ターゲット運用（admin／storefront 等）、`capture` の取得元に DOM／URL／**DB** を許可、跨ぎフロー（管理画面で作成→フロントで購入）を1シナリオで検証。`run` がペルソナ/ターゲットを切替えて実行し、確認結果（DB照合含む）を SSOT 化。

---

## 10. 段階的実装方針（Phase1）
1. **proposeScenarios 拡張**（ProposeInput＝uncovered＋requirements 融合、結合・重複排除、部分失敗分離）。
2. **grow パイプライン**（sourceOnly/crawlOnly 分岐、collectRequirements 注入、GrowResult 拡張）。
3. **CLI grow**（フラグ＋配線＋ブラウザ条件化＋同時指定エラー）。
4. **scenario エイリアス化**（grow --source-only ラッパー、--from→fromPaths、非推奨警告）。
5. **README**（統合説明＋移行ガイド）＋実機確認。
