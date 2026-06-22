# loop-e2e — rdra-analyzer-export 設計仕様書

- **ステータス**: 合意確定（rdra-analyzer 側サインオフ済み・2026-06-22 デルタ反映）
- **作成日**: 2026-06-22
- **対象**: 既存 loop-e2e CLI への増分拡張（新コマンド `rdra-export`）
- **連携契約**: `/tmp/loop-e2e-agreed-contract-handoff.md`（合意デルタ 1〜6）を §3/§4/§7 に反映済み

---

## 1. 目的とスコープ

loop-e2e の採用済みシナリオを [rdra-analyzer](https://github.com/tango238/rdra-analyzer) が消費できる形に変換し、その `analysis_result.json` に**マージ**する。これにより loop-e2e（シナリオの源泉・実行・バグ検出）と rdra-analyzer（RDRAモデリング・CRUDギャップ・ビューワー）が役割分担しつつ連携する。

### 棲み分け（確定）
- **loop-e2e** = シナリオの源泉・実行・バグ検出。
- **rdra-analyzer** = ソース解析由来の usecases/entities/情報モデル、RDRAモデル生成。
- 重複機能（rdra の `scenarios` 生成・`e2e` 実行）は loop-e2e に一本化し、rdra にはシナリオを渡す。

### 連携モード（確定）= モード1・協調型
loop-e2e は rdra の `analysis_result.json` を読み、**ルートで当たったシナリオだけ**を `scenarios[]` にマージ（usecase 紐付き）。**当たらないシナリオ**は薄い合成UCで誤魔化さず、別ファイルに「保留」として書き出し、**rdra-analyzer 側の reconcile 処理**がソースで事実確認して UC 生成・取り込みする（本specの消費契約。rdra 側の実装は別リポジトリ）。

**不変条件**: loop-e2e が書き戻す `analysis_result.json` は常に参照整合（dangling `usecase_id` 無し）。当たらないものは入れず保留に逃がす。

### スコープ外（将来）
- 発見した画面構造（SiteStructure）の `screen_specs.json` 連携。
- proposed シナリオのエクスポート。
- `scenario_type` の error/boundary 推定、`actor` のシステム/ユーザー自動判定。
- rdra-analyzer 側 reconcile 処理の実装（別リポジトリ）。

---

## 2. rdra-analyzer のデータ形式（消費先）

正典は `output/usecases/analysis_result.json`:
```jsonc
{
  "metadata": { "total_usecases": N, "total_scenarios": M },
  "usecases": [
    { "id": "UC-001", "name": "...", "actor": "...", "description": "...",
      "preconditions": [...], "postconditions": [...],
      "related_routes": [...], "related_pages": [...], "related_entities": [...],
      "related_controllers": [...], "related_views": [...],
      "category": "...", "priority": "..." }
  ],
  "scenarios": [
    { "scenario_id": "SC-001-01", "usecase_id": "UC-001", "usecase_name": "...",
      "scenario_name": "...", "scenario_type": "normal|error|boundary",
      "frontend_url": "...", "api_endpoint": "...",
      "steps": [ { "step_no": 1, "actor": "ユーザー", "action": "...",
                   "expected_result": "...", "ui_element": "..." } ],
      "variations": [...] }
  ]
}
```
`scenarios[].usecase_id` は `usecases[]` の実在IDを指す必要がある（参照整合性）。

---

> **合意デルタ（2026-06-22, rdra-analyzer 側サインオフ済み）を反映**。実出力(Spotly)では UC の
> `related_pages` が空・`related_routes` が `"<METHOD> <path>"` 形式のAPIルートのため、navigate 単独照合では
> 当たり率≒0。**APIルートを第2照合キーに追加**し、**共有 `normalizeRoute`**（先頭METHODトークン除去＋path正規化）で
> 両者同一判定する。`api_endpoint` の扱いは [C修正版]（pending のみ構造化、merged は単数文字列）。

## 3. 変換（loop-e2e Scenario → OperationScenario）

| OperationScenario | loop-e2e 由来 |
|---|---|
| `scenario_id` | `LE-<scenario.id>`（出所タグ） |
| `usecase_id` | §4 の照合結果（当たり時のみ） |
| `usecase_name` | 照合した usecase の `name` |
| `scenario_name` | `scenario.title` |
| `scenario_type` | 既定 `"normal"` |
| `frontend_url` | 最初の `navigate` ステップの target（パス） |
| `api_endpoint`（**単数 string**） | 各シナリオの最初のAPIエンドポイントから再構成: `method&path` があれば `"<METHOD> <path>"`／無ければ `path`／無ければ `raw`／最終 `""`。**配列を入れない**（rdra は `api_endpoint` を単数文字列でしか読まないため） |
| `steps[].step_no` | 1始まりの連番 |
| `steps[].actor` | 既定 `"ユーザー"` |
| `steps[].action` | `step.action` ＋ `step.target`（例: `navigate /hotel`） |
| `steps[].expected_result` | `step.expectedOutcome` |
| `steps[].ui_element` | `step.target` |
| `variations` | `[]` |

### APIエンドポイントの抽出（`ApiEndpoint = { method, path, raw }`）
loop-e2e の `expectedResults` の `kind==='api'` 各要素から `ApiEndpoint` を作る:
- 任意の構造化フィールド `apiEndpoint: { method?, path }` があればそれを優先（`method` 省略時 `"ANY"`）。`raw` には `assertion` 原文。
- 無ければ `assertion`（=`raw`）を **best-effort パース**: 先頭METHODトークン（GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS/ANY, 任意）＋続くパス（空白まで）を抽出。取れなければ `method=null, path=null`、`raw` は常に同梱。
- 生成プロンプトで源泉から構造化（`apiEndpoint:{method,path}`）するのは**別フォローアップ**（本specスコープ外）。それまでは best-effort で動く。

---

## 4. 照合（当たり/外れ判定）— 二キー＋共有正規化

`src/services/rdra/match.ts`。**loop-e2e と rdra-analyzer は同一の `normalizeRoute` を実装する**（合意）。

```
normalizePath(url): origin/query/fragment 除去・末尾"/"除去（root "/" は維持）。フルURL/相対パス両対応。
normalizeRoute(s):
  t = s.trim()
  m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s+/i に一致?
  method = 一致 ? 大文字化 : "ANY"
  path   = normalizePath(一致部分を除いた残り)
  → { method, path }
methodMatches(a,b): a==="ANY" || b==="ANY" || a===b
routeKeyEquals(x,y): methodMatches(x.method,y.method) && x.path===y.path
```

照合キー:
- **navigate キー** = `{ method:"ANY", path: normalizePath(最初のnavigate target) }`（navigate 無し→navigateキー無し）。
- **api キー** = 各 `ApiEndpoint` の `{ method:method??"ANY", path }`（`path` が null のものはスキップ）。

usecase 候補ルート = 各 UC の `related_routes ∪ related_pages` を `normalizeRoute` したタプル集合。

**優先度（同点は最初の usecase）**:
1. `navigate exact`（navigateキー と完全一致＝routeKeyEquals）
2. `api exact`（いずれかの apiキー と完全一致）
3. `navigate prefix`（UCルートが navigate path のプレフィックス: `path.startsWith(route.path + "/")` かつ method 整合）
4. `api prefix`（同上を apiキーで）

いずれも当たらなければ保留（pending）へ。

---

## 5. マージ（`src/services/rdra/merge.ts`）

`mergeIntoAnalysisResult(analysis, matched, options): { analysis, replacedCount }`:
- **出所タグで冪等**: 既存 `scenarios[]` から `scenario_id` が `LE-` で始まるものを除去 → matched を追加（再実行で重複しない）。
- **衝突方針（既定）**: rdra の analyze 由来 usecases と非LEシナリオは温存。LE由来シナリオのみ置換。
- **スキーマドリフト耐性**: 触るのは `usecases`/`scenarios`/`metadata` のみ。未知トップレベルフィールドは温存。
- `metadata.total_usecases` / `metadata.total_scenarios` を再計算して更新。

---

## 6. 参照整合性チェック（`src/services/rdra/validate.ts`）

書き戻し前に検証 → 失敗なら**書かずに throw**（ファイルを壊さない）:
- 全 `scenarios[].usecase_id` が `usecases[].id` に存在する。
- `scenario_id` が一意。
- 各シナリオの `steps[].step_no` が 1始まり連番。
- 入力 `analysis_result.json` が存在し JSON として読め、`usecases`/`scenarios` が配列。

---

## 7. 保留ハンドオフ（`loop-e2e-pending.json`）

当たらなかったシナリオを rdra-analyzer 側 reconcile が事実確認できる文脈付きで書き出す。`--into` と同じディレクトリに出力:
```jsonc
{
  "generatedBy": "loop-e2e rdra-export",
  "pending": [
    { "loop_e2e_id": "grow-hotel",
      "scenario_name": "View hotel page",
      "frontend_url": "/hotel",
      "navigate_routes": ["/hotel"],
      "api_endpoints": [ { "method": "GET", "path": "/api/v2/.../hotels", "raw": "GET /api/v2/.../hotels returns 200" } ],
      "steps": [ { "step_no": 1, "actor": "ユーザー", "action": "navigate /hotel",
                   "expected_result": "Hotel page loads", "ui_element": "/hotel" } ],
      "reason": "no matching usecase by route" }
  ]
}
```
- `api_endpoints` は **`{ method, path, raw }[]`**（構造化。reconcile が自前パース）。`method`/`path` が取れない場合は `null`、`raw` は常に同梱。`navigate_routes[]` は全 navigate を正規化して保持。
- 保留が 0 件ならこのファイルは出力しない。**既定: 0件なら出力しない**。

---

## 8. パイプライン（`src/pipeline/rdraExport.ts`）

`rdraExport(args, deps): Promise<RdraExportResult>`:
1. `loadScenarios(scenarioDir)`（active のみ。proposed 除外）。
2. `readAnalysisResult(intoPath)`（無ければ明示エラー: 「先に rdra-analyzer analyze を実行」）。
3. 各シナリオを OperationScenario へ変換（§3）。
4. ルート照合（§4）で matched / pending に振り分け。
5. matched を `mergeIntoAnalysisResult`（§5）。
6. `validate`（§6）→ OK なら `analysis_result.json` を書き戻し。
7. pending があれば `loop-e2e-pending.json` を書き出し（§7）。
8. 返り値 `{ matched, pending, replaced, intoPath, pendingPath? }`。

全I/O（fs 読み書き）は注入可能。ユニットテストはインメモリ。

---

## 9. CLI（`src/cli/commands/rdraExport.ts` + `src/cli/index.ts`）

`loop-e2e rdra-export [--into <path>] [--scenario-dir <dir>]`:
- `--into`: rdra の `analysis_result.json` パス（既定 `<cwd>/output/usecases/analysis_result.json`）。
- `--scenario-dir`: 既定 `<cwd>/<config.scenarioDir>`。
- 設定読込（loadConfig）は任意（scenarioDir 解決のみ）。秘密は不要。
- 標準出力: `matched N → <into> / pending M → <pending>`（無ければ pending 行省略）。

---

## 10. コンポーネント構成（小さく分離・全I/O注入可）

```
src/services/rdra/types.ts        # OperationScenario / AnalysisResult / PendingEntry 型
src/services/rdra/convert.ts      # Scenario → OperationScenario 変換（§3）
src/services/rdra/match.ts        # normalizePath + ルート照合（§4）
src/services/rdra/merge.ts        # mergeIntoAnalysisResult（§5）
src/services/rdra/validate.ts     # 参照整合性チェック（§6）
src/services/rdra/io.ts           # readAnalysisResult / writeAnalysisResult / writePending（注入可）
src/pipeline/rdraExport.ts        # オーケストレーション（§8）
src/cli/commands/rdraExport.ts    # runRdraExport（§9）
src/cli/index.ts                  # rdra-export コマンド登録
README.md                         # rdra-export の使い方・棲み分け・reconcile契約
```

---

## 11. エラーハンドリング
- `--into` のファイルが無い/JSON不正/`usecases`・`scenarios` が配列でない → 明示エラーで停止（書かない）。
- 参照整合性チェック失敗 → throw、`analysis_result.json` は未変更のまま。
- active シナリオ 0 件 → 何もせず「シナリオ無し」を報告。
- 機密は扱わない（シナリオ/ルートのみ）。万一 step.input に値があっても OperationScenario には input を持ち込まない（ui_element=target のみ）。

---

## 12. テスト戦略
- **単体**:
  - `convert`: フィールド対応・scenario_id プレフィックス・api_endpoint 抽出・step連番。
  - `match`: 完全一致/プレフィックス一致/外れ/navigate無し/正規化（クエリ・末尾スラッシュ・フルURL）。
  - `merge`: LE由来のみ置換（冪等）・非LE温存・未知フィールド温存・metadata再計算。
  - `validate`: dangling usecase_id 検出・scenario_id 重複・step_no連番・不正入力。
  - `rdraExport`: matched/pending 振り分け・整合性失敗で書かない・pending 0件で未出力。
  - `runRdraExport`: パス解決・into 無しでエラー。
- **統合**: サンプル analysis_result.json に対し export → matched マージ＋pending出力、再実行で冪等を確認。
- 既存 405 pass + 4 skip を壊さない。

---

## 13. 段階的実装方針
1. **型**: OperationScenario / AnalysisResult / PendingEntry。
2. **convert**: Scenario → OperationScenario。
3. **match**: normalizePath + ルート照合。
4. **merge**: 冪等マージ＋metadata再計算。
5. **validate**: 参照整合性。
6. **io**: 読み書き（注入可）。
7. **rdraExport パイプライン**＋振り分け。
8. **CLI** `rdra-export` ＋ index 登録。
9. **README**（使い方・棲み分け・reconcile消費契約）。

---

## 14. rdra-analyzer 側 reconcile（消費契約・別リポジトリ）
本specのスコープ外だが、連携を成立させるため rdra-analyzer 側に必要な処理を明記:
- `loop-e2e-pending.json` を読み、各エントリの `navigate_routes`/`api_endpoints` をソースに当てて事実確認。
- 既存 or 新規 usecase を確定し `usecase_id` を付与、`analysis_result.json` の `scenarios[]` に取り込み。
- 取り込んだエントリは pending から除去。
これにより loop-e2e（決定的ルート照合）と rdra（意味的UC確定）で整合性を保つ。
