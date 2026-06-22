# loop-e2e — auth前提条件つきシナリオ実行エンジン 設計仕様書

- **ステータス**: ドラフト（レビュー待ち）
- **作成日**: 2026-06-22
- **対象**: 既存 loop-e2e CLI への増分拡張

---

## 1. 目的とスコープ

採用済みシナリオの **手順（steps）を実機に対して実行**し、結果を検証・レポートする「シナリオ実行エンジン」を `run` に追加する。各シナリオには**認証前提条件**（`未ログイン / ログイン済`）を付与でき、`ログイン済` のシナリオを実行する際に未ログインなら**先にログイン（2FA込み）してから**本文を実行する。これにより、grow で育てたシナリオを実際に回してバグを検出できる。

### 確定事項（2026-06-22）
- `precondition` 未指定のシナリオ = **auth処理なし**（明示タグ必須・後方互換）。
- ログイン = **最初に1回認証 → セッション再利用**。各 authenticated シナリオ前に未ログイン判定し、落ちていれば再認証。
- 判定 = **決定的（要素/テキスト/URL）＋必要時LLM**（機械判定できない expectedResults は既存 verify に委譲）。
- 実行場所 = **`run` に統合**（collect/diff/verify の後に実行ステージ追加）。

### スコープ外（将来）
- 並列シナリオ実行（まずは逐次）。
- 任意の複雑アサーション DSL（まずは要素/テキスト/URL）。

---

## 2. スキーマ追加

`ScenarioSchema` に任意フィールド:
```
precondition?: {
  auth: 'authenticated' | 'unauthenticated'
}
```
- 未指定なら auth 処理をしない（従来挙動）。
- `grow` 生成シナリオは `authenticated`、ログインフローのシナリオ（admin-login）は `unauthenticated` を付与する想定（生成プロンプト/ユーザー設定側で付与）。

---

## 3. ステップ実行（`src/services/browser/scenarioExec.ts`）

`executeScenario(page: PageLike, target: TargetEnv, scenario: Scenario, deps): Promise<ScenarioRunResult>`

各 `step` を順に決定的実行:
| action | 実装 | 成否 |
|--------|------|------|
| `navigate` | `page.goto(resolveUrl(target.baseUrl, step.target))` ＋ load 待ち | goto 成功 |
| `click` | `page.locator(step.target).click()` | 例外なし |
| `fill` | `page.locator(step.target).fill(resolveInput(step.input))` | 例外なし |
| `submit` | `page.locator(step.target).click()` ＋ **既存のSPAナビ待ち**（URL変化をポーリング） | 例外なし |
| `wait` | `step.target` が `text=...`→テキスト出現待ち / セレクタ→可視待ち / 数値→ms待ち | タイムアウトなし |
| `assert` | `step.target` が `text=...`→テキスト存在 / `url=...`→URL一致 / セレクタ→要素存在 | 条件成立 |

- **プレースホルダ解決** `resolveInput`: `{{ENVNAME}}` → `secrets.targetAuth[ENVNAME]` or `process.env[ENVNAME]`、`{{TWO_FACTOR_PIN}}` → `target.auth.twoFactor.pinCommand` 実行で取得（無ければ空→失敗）。解決値は detail/ログに出さない（マスク）。
- いずれかのステップが失敗（例外・assert不成立・wait timeout）したら、そのシナリオを失敗とし、`failedStepIndex` と人間可読な `detail`（機密マスク）を記録して中断。
- 戻り値 `ScenarioRunResult { scenarioId, ok, failedStepIndex?, detail, finalUrl }`。

外部I/O（page/pinRunner）は注入可能。ユニットテストは fake page でモック。

---

## 4. セッション制御（認証前提条件）

`src/services/browser/session.ts`（or scenarioExec 内）:
- `ensureAuthenticated(page, target, creds, deps): Promise<{ ok, detail }>`:
  - **未ログイン判定**: 保護ページ（`target.baseUrl + '/'` など、または scenario の最初の navigate 先）へ遷移し、結果URLが `loginPath` にリダイレクトされたら未ログイン。
  - 未ログインなら `authenticate(page, target, creds, deps)`（既存の2FA込みログイン）を実行。失敗ならエラー。
  - 既ログインなら何もしない（セッション再利用）。
- `ensureUnauthenticated(page, ...)`: Cookie クリア（ログアウト状態）にしてから実行。
- 実行ステージ全体で**同一ブラウザコンテキスト**を使い、最初の authenticated シナリオで一度ログイン → 以降は再利用。

---

## 5. 実行オーケストレーション（`src/pipeline/executeScenarios.ts`）

`executeScenarios(ctx, deps): Promise<VerifyFinding[]>`:
1. アクティブシナリオを `loadScenarios`（既存。proposed は対象外）。
2. ブラウザ起動・page取得（注入）。
3. 各シナリオを逐次:
   - `precondition.auth === 'authenticated'` → `ensureAuthenticated`（必要時ログイン）。
   - `precondition.auth === 'unauthenticated'` → `ensureUnauthenticated`。
   - `precondition` 無し → そのまま。
   - `executeScenario` 実行 → `ScenarioRunResult`。
4. 各結果を `VerifyFinding`（**category 追加: `'scenario'`**、severity: 失敗=high/成功=low、title=scenario.title、detail）に変換して返す。
5. **必要時LLM**: assert で機械判定できない `expectedResults`（api/db/曖昧なui）は、実行後の最終ページ＋expectedResults を既存 `runVerify`/Opus 判定に渡して補完（任意レイヤ。第一段は決定的結果を主、LLM判定は available とする）。

---

## 6. run 統合（`src/cli/commands/run.ts`）

- collect → diff → verify の後に **executeScenarios ステージ**を追加（注入可能、`--skip-prepare` とは別。スキップフラグ `--skip-scenarios` を任意で用意）。
- 実行に使うブラウザ/認証情報/pinRunner は index.ts の run 配線で実deps注入（grow と同じ要領）。
- 結果の `VerifyFinding[]` を既存 `verifyFindings` に合流し、`writeReport`（反証ゲート→Issue）に乗せる。
- 認証情報は `secrets.targetAuth`、2FA pin は `target.auth.twoFactor.pinCommand`。

---

## 7. コンポーネント構成（小さく分離・全外部I/O注入可）

```
src/config/schema.ts                    # ScenarioSchema.precondition 追加（src/scenario/schema.ts）
src/services/browser/scenarioExec.ts    # executeScenario（ステップ実行）
src/services/browser/session.ts         # ensureAuthenticated / ensureUnauthenticated
src/pipeline/executeScenarios.ts        # オーケストレーション → VerifyFinding[]
src/domain/types.ts                     # VerifyFinding.category に 'scenario' 追加、ScenarioRunResult
src/cli/commands/run.ts                 # 実行ステージ統合（--skip-scenarios）
src/cli/index.ts                        # run 配線に実deps追加
README.md                               # precondition / 実行ステージ / --skip-scenarios
```

---

## 8. エラーハンドリング
- ステップ失敗（例外/assert不成立/timeout）→ そのシナリオを失敗(high)として記録し中断。run 全体は継続（他シナリオ・他ステージは走る）。
- `ensureAuthenticated` 失敗（ログイン不能）→ authenticated シナリオ群をスキップし、その旨を finding/ログに残す（run は中断しない）。
- プレースホルダ解決失敗（env/pin 取得不可）→ そのシナリオ失敗、機密はマスク。
- 認証情報・PIN・トークンは detail/レポート/ログに出さない（`maskSecrets`）。

---

## 9. テスト戦略
- **単体**: `executeScenario`（各action実行・assert成否・placeholder解決・失敗中断・機密マスク、fake page）、`ensureAuthenticated`（未ログイン判定→authenticate呼び出し/既ログインでスキップ）、`ensureUnauthenticated`（cookieクリア）、`executeScenarios`（precondition分岐・findings集約・auth-once再利用・順序）。
- **統合**: run に実行ステージが入り、authenticated シナリオで未ログイン→ログイン→実行→finding、precondition無しは素通し、を全I/Oモックで検証。`--skip-scenarios` で未実行。
- **実機E2E**: `RUN_E2E=1` で spotly admin に対し authenticated シナリオ（grow-hotel 等）を実行（既定スキップ）。
- 既存 382 pass + 3 skip を壊さない。

---

## 10. 段階的実装方針
1. **スキーマ**: `precondition`。
2. **ステップ実行**: `executeScenario`（placeholder解決含む）。
3. **セッション制御**: `ensureAuthenticated`/`ensureUnauthenticated`。
4. **オーケストレーション**: `executeScenarios` ＋ `VerifyFinding('scenario')`。
5. **run 統合**＋`--skip-scenarios`＋index 配線。
6. **必要時LLM**: 未充足 expectedResults を verify(Opus) へ委譲。
7. **統合テスト**＋ `RUN_E2E` 実機＋README。

---

## 11. 未決事項 / 実装中に詰める
- 「未ログイン判定」に使う保護ページURL（既定 `baseUrl + '/'`、シナリオ最初の navigate 先を使う案）。
- `assert` の `text=` / `url=` / セレクタ 記法の最終仕様（既定: 接頭辞 `text=`/`url=`、それ以外はセレクタ存在）。
- 必要時LLM の発火条件（expectedResults の kind が api/db、または assert で表現できないもの）。
