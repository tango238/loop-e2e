# findings 共有ストア ＋ 独立 `report` コマンド 設計仕様書

- **ステータス**: ドラフト（レビュー待ち）
- **作成日**: 2026-06-23
- **対象**: パイプラインの脱結合。各コマンドは findings を共有ストアへ書き、独立 `report` が集約して単一レポート＋Issue を生成する。

---

## 1. 目的

`grow → scenario → explore → run → report` のように**各コマンドを独立実行**し、**最後の `report` が全コマンドの結果を踏まえた単一レポート＋GitHub Issue** を生成できるようにする。

**共通通貨は findings**。ステージを物理的に移動するのではなく、findings を**共有ストアに蓄積 → `report` が一括で反証ゲート→レポート化**する。

### 確定方針
- findings を生むコマンド（`run` / `explore`）は findings を**共有ストアへ書く**。
- 生成系コマンド（`grow` / `scenario`）は findings ではないため、**実施サマリ（activity）**として軽量に記録。
- **独立 `report` コマンド**が、蓄積された全 findings ＋ activity を集約 → 反証ゲート → 単一 `report.md`/`report.json` ＋ Issue。消費後はストアをアーカイブ。
- `run` / `explore` に **`--no-report`** を追加（findings 書き出しのみ、自動レポートを抑止）。
- 後方互換：`--no-report` 無しなら従来どおり各コマンド実行末尾で自動レポート（蓄積分も含めて集約）。

### スコープ外
- collect/verify/diff を他コマンドへ物理移動（データ依存上不自然なため非対象）。
- findings の再分類・重み付け等の高度集約（将来）。

---

## 2. findings 共有ストア（`src/state/findings.ts`）

レイアウト（`.loop-e2e/findings/`）:
- `findings/<source>-<runId>.json` — 1コマンド実行分の findings。
- `findings/activity.jsonl` — 追記専用の実施サマリ（1行1エントリ）。
- `report` 消費後、消費した findings ファイル＋activity を `findings/archive/<reportRunId>/` へ移動（削除ではなくアーカイブ）。

型:
```ts
export type FindingsEntry = {
  source: 'run' | 'explore'
  runId: string
  startedAt: string
  diffFindings: DiffFinding[]
  verifyFindings: VerifyFinding[]
}
export type ActivityEntry = {
  source: string      // 'grow' | 'scenario' | 'run' | 'explore'
  runId: string
  startedAt: string
  summary: string     // 例: "proposed 36 scenarios", "executed 6 scenarios"
}
```

API:
```ts
writeFindings(root: string, entry: FindingsEntry): Promise<void>      // findings/<source>-<runId>.json
readPendingFindings(root: string): Promise<FindingsEntry[]>           // 未消費の全 entry
appendActivity(root: string, entry: ActivityEntry): Promise<void>    // activity.jsonl に追記
readPendingActivity(root: string): Promise<ActivityEntry[]>
archiveConsumed(root: string, reportRunId: string): Promise<void>    // findings/*.json + activity.jsonl を archive/<reportRunId>/ へ
```

- すべて秘密値は保存前に呼び出し側でマスク済みの finding を渡す前提（finding は元から secret 値を含まない設計）。
- 破損ファイル/不正JSONは読み飛ばし（ログ）。`statePaths` に `findings` を追加。

---

## 3. `report.ts` のリファクタ

現状 `writeReport` は「本文生成＋反証ゲート＋Issue＋report書き出し＋**baseline保存**」を担う。これを分離:

- **`renderReport(root, reportRunId, deps)`**（新／既存 writeReport から baseline/currentStructure/store を除いたもの）:
  - 入力: `diffFindings`, `verifyFindings`, `activity`, `ctx`, `llm`, `adjudicate`, `upsertIssue`, `githubClient`, `repo`。
  - 処理: Sonnet本文 → Opus反証ゲート（finding毎）→ 両ゲート通過のみ Issue 起票（fingerprint重複排除）→ 「ユーザー確認要」＋**実施サマリ(activity)** を含む `report.md`/`report.json` を書き出し。**baseline は触らない**。
- **baseline 保存は `run` 側へ移動**（collect の構造を持つのは run のみ）。explore は元々 no-op なので影響なし。
- 既存の `findingPage`/反証ゲート/マスキングはそのまま流用。

集約時の重複排除: `fingerprint`（verify=category/title/detail、diff=kind/location/expected/actual）で**全 entry 横断 dedup**（explore と run で同一画面の所見が出ても1本化）。

---

## 4. `report` コマンド（`src/cli/commands/report.ts` + index）

`loop-e2e report [--target <name>]`:
1. config/secrets ロード → ctx 構築（マスク用秘密・refutation・github ラベル）。
2. `readPendingFindings` ＋ `readPendingActivity`。
3. findings 0件かつ activity 0件なら「何もない」旨を表示して終了（レポート空生成しない）。
4. dedup → `renderReport(cwd, reportRunId, {...})`（adjudicate/upsertIssue/githubClient/repo を実配線）。
5. `archiveConsumed(cwd, reportRunId)` で消費分をアーカイブ。
6. 標準出力: `report <path> / findings F (issues I) / sources: run,explore`。

---

## 5. `run` / `explore` の変更

- 共通: 実行末尾で **findings を `writeFindings` で書き出す**＋ **`appendActivity`**。
- `--no-report` 指定時: ストア書き出しのみで終了（自動レポートしない）。
- `--no-report` 無し時: 書き出し後に **`report` 集約ロジックを自動実行**（蓄積された全 findings を消費 → レポート → アーカイブ）。これで単一コマンドのUXは従来どおり。
- `run`: **baseline 保存を run 側で実施**（collect/diff 後）。`writeReport` 直呼びは廃止。
- `explore`: `writeReport` 直呼びを廃止し findings 書き出しへ。

`grow` / `scenario`: 末尾に `appendActivity`（提案/生成件数）のみ追加（findings は無し）。

---

## 6. 後方互換・移行
- 既定（`--no-report` 無し）の `run`/`explore` の出力（report.md/json＋Issue）は従来同等。
- 既存の単発利用は壊れない。複数コマンドを `--no-report` で繋いだ時のみ集約 `report` が必要。
- `report.md` のフォーマットは「本文＋実施サマリ＋ユーザー確認要（各 finding にページ名）」に拡張。

---

## 7. エラーハンドリング・セキュリティ
- ストア読み込みの破損は読み飛ばし（ログ）、`report` は残りで継続。
- Issue 起票失敗は握りつぶし継続（現状踏襲）。
- findings は元来 secret 値を含まない。`report.md`/`json` は従来どおり全マスク。

---

## 8. テスト戦略
- **findings store**: write→readPending 往復、archive 後は readPending が空、破損ファイル読み飛ばし、activity 追記/読み出し。
- **renderReport**: findings 集約 dedup（同一 fingerprint が1本化）、activity が実施サマリに出る、baseline を触らない（store 引数が無い）。
- **report コマンド**: pending を集約しゲート→書き出し→archive、空時は何もしない。
- **run**: baseline を run 側で保存する、`--no-report` で自動レポートしない・findings は書かれる。
- **explore**: `--no-report` 同様。
- 既存スイートを壊さない（現 531 pass / 5 skip を維持・更新）。
- **実機**: `run --no-report` → `explore --no-report` → `report` で単一レポートに両方の findings が出ることを確認。

---

## 9. コンポーネント構成
```
src/state/paths.ts            # findings パス追加
src/state/findings.ts         # ストア（write/readPending/appendActivity/archiveConsumed）
src/pipeline/report.ts        # writeReport → renderReport（baseline/store除去）
src/cli/commands/report.ts    # runReport（集約コマンド）
src/cli/commands/run.ts       # findings書き出し + baseline保存をrun側へ + --no-report + 自動report
src/cli/index.ts              # report コマンド登録 / run・explore の --no-report 配線
src/pipeline/explore.ts       # writeReport直呼び廃止 → findings書き出し + 自動report
src/cli/commands/explore.ts   # --no-report 配線
src/cli/commands/grow.ts      # appendActivity（提案件数）
src/cli/commands/scenario.ts  # appendActivity（生成件数）
README.md                     # findings/report ワークフロー記載
```

---

## 10. 段階的実装方針
1. **findings ストア**（types + write/readPending/appendActivity/archiveConsumed）＋ paths。
2. **report.ts リファクタ**（renderReport：baseline/store/currentStructure 除去、activity 掲載、dedup）。
3. **`report` コマンド**（集約 → renderReport → archive）＋ index 登録。
4. **run 改修**（findings書き出し＋baseline保存をrun側へ＋`--no-report`＋自動report）。
5. **explore 改修**（findings書き出し＋`--no-report`＋自動report）。
6. **grow/scenario の appendActivity**。
7. **README** ＋ 実機検証（run --no-report → explore --no-report → report）。
