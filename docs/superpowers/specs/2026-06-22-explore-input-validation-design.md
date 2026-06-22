# loop-e2e — 探索的入力検証 `explore` 設計仕様書

- **ステータス**: ドラフト（レビュー待ち）
- **作成日**: 2026-06-22
- **対象**: 既存 loop-e2e CLI への増分拡張（新コマンド `explore`）

---

## 1. 目的とスコープ

各画面のフォームに対し、**わざと不正/境界の値を入力して何が起きるかを探索的に検証**し、結果をレポート・GitHub Issue 化する。検出したいのは2点:
1. **バリデーションギャップ** — 不正な値が入力チェックに引っかからず、通って（DBに保存されて）しまう。
2. **エラーメッセージ品質** — エラーが1つにまとめられて分かりにくい／フィールド対応が不明瞭。

制約（必須/任意・型・長さ・最小最大・形式・境界）は **DBテーブル定義 ＋ ソースのバリデーションルール** から割り出す。

### 確定事項（2026-06-22）
- 制約の出所 = **ハイブリッド（DB定義＋ソースのバリデーションルール）**。
- オラクル（gap判定）= **ハイブリッド（UI/ネットワーク信号で疑い検出 → DB照会で裏取り）**。
- 安全性 = **dev/local 前提 ＋ 実行後に再シードで初期化**（既存 `launch.seed`）。
- 制約モデリング = **LLM駆動（Opus）**。命名ズレ（フロント/DB/API）を吸収。
- ケース生成 = **ハイブリッド（ルールベース骨格 ＋ LLM 創造的エッジケース）**。
- 実行場所 = **専用コマンド `loop-e2e explore`**（重い・破壊的なので run と分離）。

### スコープ外（将来）
- 複数フィールドの相互作用バグ、ステートフルな多段フロー、ファイルアップロード。
- 全フォームの自動発見（v1 は `--screen` 明示 ＋ 採用シナリオの navigate 先）。
- `run --explore` 統合（将来）。

---

## 2. フロー（`src/pipeline/explore.ts`）

```
loop-e2e explore [--target <name>] [--screen <path>...] [--skip-prepare] [--no-reseed]
 0. prepare      run と同じ repo refresh + setup hooks（!skipPrepare && deps.prepare のとき）
 1. discover     対象フォームを特定（§3）
 2. model        各フォームの制約モデルを Opus で構造化（§4）
 3. generate     制約からケース生成（ルール＋任意LLM）（§5）
 4. execute      認証(2FA)→各ケースを fill/submit/観測（§6）
 5. classify     gap（UI/net→DB裏取り）＋ msg品質（Opus）（§7）
 6. findings     VerifyFinding(category 'input-validation') 化（§8）
 7. report       既存 writeReport（report.md/json + 反証ゲート + Issue）（§9）
 8. re-seed      launch.seed 実行（!noReseed）。変更を初期化（§10）
```

全外部I/O（browser/db/llm/shell）は注入可能。ユニットテストはモック。

---

## 3. フォーム発見（`discover`）

v1 は明示指定中心:
- `--screen <path>...` で対象パスを列挙（例 `--screen /hotel/create --screen /coupon/create`）。
- 省略時は **採用シナリオ（active）の最初の navigate 先**のうち、フォーム入力欄を持つ画面を対象。
- 各対象画面へ遷移し、**入力欄を抽出**（name/id/type/label/selector）。既存の構造抽出（`extractPageInfo` の InputItem 相当）を再利用。
- 入力欄が無い画面はスキップ（ログ）。

出力: `DiscoveredForm = { screenPath: string; submitSelector: string; fields: FormField[] }`、`FormField = { name: string; selector: string; htmlType: string; label?: string }`。

---

## 4. 制約モデリング（`src/services/explore/constraintModel.ts`, Opus）

`modelConstraints(form, dbSchema, sourceRules, llm): Promise<FieldConstraint[]>`:
- 入力: フォームの `fields`（HTML由来）＋ 関連DB列定義（§4.1）＋ ソースのバリデーションルール（§4.2）。
- Opus に統合して渡し、**フィールド毎の制約**を構造化出力（zod検証）:
  ```
  FieldConstraint = {
    field: string; selector: string;
    required: boolean;
    type: 'string'|'number'|'integer'|'boolean'|'date'|'email'|'url'|'enum'|'unknown';
    maxLength?: number; minLength?: number; min?: number; max?: number;
    format?: string;            // 正規表現/メール/電話 等の説明
    enumValues?: string[];
    evidence: string;           // 根拠（DB列 / ルール）。秘密は含めない
  }
  ```
- 命名ズレはモデルが吸収（field 名↔DB列↔ルールキー）。

### 4.1 DB列定義の取得（`src/services/explore/dbIntrospect.ts`）
- 既存 DBアダプタで `INFORMATION_SCHEMA.COLUMNS` を照会し、対象テーブルの列（name/data_type/is_nullable/char_max_length/numeric_precision）を取得。
- 対象テーブルは Opus が form 文脈から推定（候補テーブル名を introspect → モデリングに供給）。テーブル不明ならソースルールのみで継続。

### 4.2 ソースのバリデーションルール
- 既存のリポジトリ取り込み（source ingestion）から、対象画面に関連するバリデーション定義（Laravel FormRequest / Zod / クラスバリデータ等）を文脈として供給。抽出は LLM（既存の取り込み資産を利用）。

---

## 5. ケース生成（`src/services/explore/caseGen.ts`）

`generateCases(constraints, llm?): Promise<InputCase[]>`:
- **ルールベース骨格（決定的）** — 各 `FieldConstraint` から:
  - `required` → 空文字 / 空白のみ（**should be rejected**）
  - `maxLength=N` → 長さ N（valid 境界）, 長さ N+1（**reject**）
  - `minLength=N` → 長さ N-1（**reject**）, 長さ N
  - `type number/integer` → 非数値・小数(integer時)・負値(unsigned時)（**reject**）
  - `min/max` 数値 → min-1, max+1（**reject**）
  - `format email` → `notanemail`, `a@`, `@b.com`（**reject**）
  - `enumValues` → 範囲外の値（**reject**）
- **valid baseline** — 全フィールド正常値を1件（other-field 充填にも使う）。
- **LLM 上乗せ（任意）** — 「見た目は正しいが弾くべき」ケース（Unicode・前後空白・意味的不正）。`llm` 省略時はルールのみ。
- 出力: `InputCase = { field: string; selector: string; value: string; expectation: 'reject'|'accept'; rationale: string; table?: string; column?: string }`。

---

## 6. 実行（`src/services/explore/execute.ts`）

`runCase(page, form, baseline, inputCase, deps): Promise<CaseOutcome>`:
- 対象フォームへ（認証は §6.1）。
- **対象フィールドだけ `inputCase.value`、他フィールドは valid baseline** で fill（他欄の required で止まらないように）。
- `submitSelector` をクリック → **既存のSPAナビ待ち**（URL/ネット沈静）を再利用。
- 観測:
  - 表示エラー: ページHTMLからエラー指標（既存 `errorHandling` の `ERROR_INDICATORS_REGEX`）でエラーメッセージ群を収集。
  - ネットワーク: 送信先 API のレスポンス status（Playwright の response リスナーを deps で注入）。
  - 遷移: 送信後の最終URL（フォームから離れたか）。
- 出力: `CaseOutcome = { errorsShown: string[]; submitStatus?: number; navigatedAway: boolean; finalUrl: string }`。
- 機密はマスク。

### 6.1 認証
- scenario-exec の `authenticate`（2FA込み）／`session` を再利用。explore 全体で1回ログイン→セッション再利用。

---

## 7. 判定（`src/services/explore/oracle.ts`）

### 7.1 バリデーションギャップ
`classifyGap(inputCase, outcome, dbProbe): { gap: boolean; confidence: 'high'|'medium' }`:
- 前提: `inputCase.expectation === 'reject'`。
- **疑い**（UI/net信号）: `errorsShown` が空 **かつ**（`submitStatus` が 2xx もしくは `navigatedAway`）。
- **裏取り**: `inputCase.table/column` があれば `wasValueSaved(dbAdapter, table, column, value)`（§7.3）で保存確認。
  - 保存確認 → `gap:true, confidence:'high'`。
  - DB照会不可（table不明） → `gap:true, confidence:'medium'`（UI信号のみ）。
- 疑い無し → `gap:false`。

### 7.2 エラーメッセージ品質（Opus）
`classifyErrorQuality(form, caseOutcomes, llm): Promise<QualityFinding[]>`:
- フォーム単位で、reject 期待ケース群の `errorsShown` を Opus に渡し評価:
  - 複数フィールドのエラーが**1つの汎用メッセージにまとめられて**いないか。
  - メッセージが**どのフィールドの何が問題か**を示しているか。
  - 曖昧・技術的すぎないか。
- 問題があれば `QualityFinding { screenPath, issue, evidence, severity }`。

### 7.3 DB照会（`src/services/explore/dbProbe.ts`）
`wasValueSaved(dbAdapter, table, column, value): Promise<boolean>`:
- `SELECT 1 FROM <table> WHERE <column> = <value> LIMIT 1`（パラメタライズ）。1件以上で true。

---

## 8. Findings（`VerifyFinding(category 'input-validation')`）

- gap=high → severity `high`、title「入力チェック漏れ: <screen> <field>」、detail（値の性質・保存確認・根拠、機密マスク）、evidence。
- gap=medium → severity `medium`。
- msg品質 → severity `medium`/`low`（反証ゲートが最終判定）。
- `VerifyFinding.category` に **`'input-validation'`** を追加（`src/domain/types.ts`）。

---

## 9. レポート（既存 `writeReport` 再利用）

- explore は `verifyFindings` を組み立て、既存 `writeReport`（Sonnet本文 + Opus反証ゲート + `upsertIssue`）を呼ぶ。
- 確証あるバグ（gap=high）はゲート通過しやすく Issue 起票。msg品質は確信度次第でレポート止まり/起票。
- `report.json`/`report.md` を `.loop-e2e/reports/<runId>/` に保存。

---

## 10. 安全性・再シード

- **dev前提ガード**: `launch.seed` が未設定 **かつ** `--no-reseed` でもない場合は、**警告して中断**（戻せない環境での破壊を防止）。明示的に `--no-reseed` を付けた場合のみシード無しで続行。
- 実行後（!noReseed）に `launch.seed.command` を実行し DB を初期化。
- 1ケースの実行失敗は全体を止めない（ログして次へ）。
- 認証情報・PIN・DB値の機密は detail/レポート/ログでマスク。

---

## 11. コンポーネント構成（小さく分離・全I/O注入可）

```
src/services/explore/types.ts            # DiscoveredForm/FormField/FieldConstraint/InputCase/CaseOutcome/QualityFinding
src/services/explore/dbIntrospect.ts     # introspectTable
src/services/explore/constraintModel.ts  # modelConstraints (Opus)
src/services/explore/caseGen.ts          # generateCases (rule + optional LLM)
src/services/explore/execute.ts          # runCase
src/services/explore/oracle.ts           # classifyGap / classifyErrorQuality
src/services/explore/dbProbe.ts          # wasValueSaved
src/pipeline/explore.ts                  # オーケストレーション → VerifyFinding[]
src/cli/commands/explore.ts              # runExplore
src/cli/index.ts                         # explore コマンド登録
src/domain/types.ts                      # VerifyFinding.category に 'input-validation'
README.md
```

---

## 12. CLI（`src/cli/commands/explore.ts` + index）

`loop-e2e explore [--target <name>] [--screen <path>...] [--skip-prepare] [--no-reseed]`:
- 設定読込（loadConfig）→ target 選択 → 認証情報解決（run/grow と同要領）。
- ブラウザ起動・DBアダプタ生成・LLM 生成・pinRunner を実deps注入（index 配線）。
- 標準出力: `forms N / cases M / gaps G(high g/medium) / message-issues Q → report <path>`。

---

## 13. エラーハンドリング
- 対象画面に到達できない/フォーム無し → スキップ（finding化せずログ）。
- 認証失敗 → explore 中断（破壊前に止める）、その旨ログ。
- DB照会不可 → gap は medium に降格（裏取り無し）。
- LLM 失敗（制約モデル/品質判定）→ そのフォーム/段をスキップしログ、他は継続。
- 機密マスク徹底。

---

## 14. テスト戦略
- **単体**: caseGen（境界/必須/型/形式の各ケース・valid baseline・LLM省略時）、oracle（gap分類 high/medium/none・msg品質）、dbProbe（保存有無）、dbIntrospect（列マッピング、モックDB）、constraintModel（LLMモック→zod検証）、execute（fake page で対象1欄不正・他baseline・観測）、explore パイプライン（段の順序・findings集約・再シード呼び出し・seed未設定ガード）。
- **統合**: サンプルフォーム＋モックDBで一巡（gap検出→finding→writeReport呼び出し）。
- **実機E2E**: `RUN_E2E=1` で spotly のいずれかの作成フォームに対し実行（既定スキップ）。
- 既存 450 pass + 4 skip を壊さない。

---

## 15. 段階的実装方針
1. **型** ＋ `VerifyFinding.category` に 'input-validation'。
2. **dbIntrospect**（列定義取得）。
3. **constraintModel**（Opus、zod）。
4. **caseGen**（ルール骨格＋任意LLM）。
5. **execute**（fill/submit/観測）。
6. **dbProbe** ＋ **oracle**（gap＋msg品質）。
7. **discover**（フォーム特定）。
8. **explore パイプライン**（段組み＋再シード＋ガード）。
9. **CLI** `explore` ＋ index 配線。
10. **README** ＋ RUN_E2E 実機。

---

## 16. 未決事項 / 実装中に詰める
- 対象テーブルの推定精度（Opus 推定＋introspect）。外す場合は gap=medium 止まり。
- valid baseline 値の生成（型/形式から妥当値を作る—ルール、必要時 LLM）。
- ネットワーク観測の対象（送信先 API のドメイン/パスのフィルタ条件）。
