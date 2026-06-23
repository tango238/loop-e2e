# システム跨ぎシナリオ（Phase3）設計仕様書

- **ステータス**: ドラフト（レビュー待ち）
- **作成日**: 2026-06-23
- **対象**: マルチアクト・シナリオ（Phase2）に「**複数ターゲット運用**」と「**capture の url:/db: 取得元**」を配線し、システム跨ぎフロー（管理画面で作成 → フロントで購入）を1シナリオで検証可能にする。

---

## 1. 目的

Phase2 で機構（personas/acts/capture/`{{VAR}}`/段ごとのセッション切替）は実装済み。Phase3 は**配線**：
- `persona.target` を config の**別ターゲット**に解決し、その段を別アプリ（別 baseUrl/認証）で実行。
- `capture` の取得元に `url:`（現在 URL）と `db:<connection>:<sql>`（別 DB 照会）を追加し、DOM に出ない「作成された行の ID」等を後段へ受け渡す。
- 跨ぎ `expectedDbState` 検証は既存 `registeredData` ステージが connection ごとに実施済み → config に別 DB を足すだけ。

### 確定事項（2026-06-23）
- **capture 取得元**：DOM（既存）＋ `url:` ＋ `db:<connection>:<sql>`。
- **grow による跨ぎジャーニー自動提案は後続フェーズ**（ドメイン因果の LLM 設計が別物）。本仕様の対象外。
- **実行モデル**：**1つの共有ページ**で各ターゲットの baseUrl へナビゲート。Playwright のコンテキストは cookie がドメインごとなので、複数アプリのセッションを同一ページで同時保持できる（別ページ/別コンテキスト不要）。

### スコープ外（§9）
- grow のマルチアクト・ジャーニー自動提案（Phase4）。
- ターゲットごとに異なる 2FA 機構の個別配線（当面は指定ログインシナリオの `twoFactor` を共用）。

---

## 2. マルチターゲット実行（`src/pipeline/executeScenarios.ts`）

### 2.1 ターゲット解決
`ExecuteScenariosDeps` に注入を追加：
```ts
/** Resolve a persona's target name → its TargetEnv + credentials (built from config.targets + secrets). */
resolveTarget?: (name: string) => { target: TargetEnv; creds: { username: string; password: string } } | undefined
```
- `runScenarioStage`（run）が config.targets 全件＋secrets から `resolveTarget` を構築（各ターゲットの auth から `resolveCredentials`、`TargetEnv` を組む）。
- `executeScenarios` に渡す **run ターゲット/creds は従来どおり `targets[0]`**（flat・単一 act の既定）。

### 2.2 `runMultiAct` の per-act ターゲット
各 act で：
- `const resolved = persona?.target ? deps.resolveTarget?.(persona.target) : undefined`
- `persona.target` が指定されているのに解決できない → **明確な失敗 finding**（`unknown target '<name>' (not in config.targets)`）。
- `actTarget = resolved?.target ?? runTarget`、`baseCreds = resolved?.creds ?? runCreds`。
- `personaCreds = persona.credEnv ? resolvePersonaCreds(persona, baseCreds, env) : baseCreds`（credEnv override は維持）。
- `ensureAuth` / `executeSteps` は **actTarget** を使う（その baseUrl・loginPath・creds）。
- **forceReauth の精緻化**：`ai>0 && actTarget.name === prevTargetName && persona?.name !== prevPersona`（**同一ターゲット上の identity 切替のみ**再ログイン。ターゲットが変われば別ドメインで独立セッションのため再ログイン不要）。
- Phase2 の「persona.target を warn して無視」は**削除**（解決するようになった）。

> 注：`clearCookies` はコンテキスト全体の cookie を消すため、同一ターゲットの forceReauth は他ドメインのセッションも落とす可能性がある（稀なフロー）。当面は許容しドキュメント化。

---

## 3. capture の取得元拡張（`src/services/browser/scenarioExec.ts`）

`ScenarioExecDeps` に注入を追加：
```ts
/** Run a read-only query against a named connection (for db: captures). Returns rows. */
dbQuery?: (connection: string, sql: string) => Promise<import('../db/adapter.js').Row[]>
```

`capture` ケースの取得元を**スキームで分岐**（`stepTarget` は `{{VAR}}` 解決済み）：
- `url:` … `url:<regex?>`。`page.url()` を取得。正規表現が続くときはマッチのグループ1（無ければ全体）。例 `url:/coupon/(\d+)`。マッチ無し → 失敗。
- `db:` … `db:<connection>:<sql>`。`deps.dbQuery(connection, sql)` の先頭行・先頭カラムを文字列化。`dbQuery` 未注入なら明確なエラー。0行 → 失敗。
- それ以外 … 既存の DOM 読み取り（`readCapture`：input value → textContent）。

失敗 detail は従来どおり**生 `step.target`（未解決）**を表示し、捕捉値・秘密を露出しない（マスクは vars 値も対象＝Phase2 修正済み）。

---

## 4. 跨ぎ DB 検証（既存機能の活用）

`expectedDbState[].connection` ごとの検証は既存 `verifyRegisteredData`（`registeredData.ts`）が実施済み。跨ぎフローの検証対象 DB（例 `storefront-db`）を `config.databases` に追加すれば、マルチアクト・シナリオの `expectedDbState` も自動で検証される。**追加実装は不要**（README に運用を明記）。

---

## 5. 配線（`src/cli/commands/run.ts` の `runScenarioStage`）

- **resolveTarget 構築**：config.targets 全件をマップ化。`resolveTarget(name)` は該当 target の `TargetEnv`（baseUrl/auth）＋`resolveCredentials(secrets, target.auth)` を返す（creds 無しは undefined）。execDeps に追加。
- **dbQuery 構築**：`registeredData.ts` の `resolveAdapter` を **export** して再利用。`dbQuery(connection, sql)` は接続を遅延生成（connection 名→adapter をキャッシュ）し `adapter.query(sql, [])` を実行、ステージ終了時に全 adapter を `close()`。execDeps に追加。`config.databases` が空なら dbQuery 未注入（db: capture は明確エラー）。
- run ターゲット/creds は `targets[0]`（従来どおり）。

---

## 6. エラーハンドリング・セキュリティ
- `persona.target` 未解決・`db:` 未注入/0行・`url:` マッチ無しは当該 act/step を**明確な失敗 finding/step 失敗**に（フロー中断）。
- DB パスワードは既存どおりログ/エラーに出さない（`createDbAdapter` 契約）。`dbQuery` は read-only 用途（SQL はシナリオ作者責任。秘密 env を `{{ENV}}` で渡せるがマスク対象）。
- **信頼境界（重要）**：`db:` SQL は `{{VAR}}` を**文字列補間**して構築する（パラメータ化なし）。`{{VAR}}` には DOM/URL から capture したアプリ由来の値が入り得るため、**untrusted な capture 値を `db:` SQL に補間しないこと**（SQL インジェクション）。当面は「信頼できる内部 ID 等のみ」を運用ルールとし README に明記。将来オプション：`{{VAR}}` を `$1`/`?` プレースホルダに降格し `adapter.query(sql, params)` でパラメータ化（adapter は既に params 対応、Phase4 候補）。
- 捕捉値・creds・PIN はマスク（Phase2 の vars マスク含む）。

---

## 7. テスト戦略
- **executeSteps capture sources**：`url:`（全体/正規表現グループ/マッチ無し失敗）、`db:`（先頭セル取得・`dbQuery` 未注入で失敗・0行で失敗・`{{VAR}}` 解決済み SQL が渡る）、DOM 既存挙動維持。
- **runMultiAct multi-target**：`persona.target` が別ターゲットに解決され actTarget で `ensureAuth`/`executeSteps` が呼ばれる／未解決ターゲットで明確失敗／forceReauth はターゲット変化時 false・同一ターゲット identity 変化時 true。
- **resolveTarget / dbQuery 配線**（run）：config.targets→TargetEnv＋creds、config.databases→adapter 生成・close、空 databases で dbQuery 未注入。
- 跨ぎ `expectedDbState` は既存 `registeredData` テストで担保（connection 解決）。
- 後方互換：flat・単一 act・単一ターゲットは挙動不変。既存スイート（現 563 pass / 5 skip）を壊さない。

---

## 8. コンポーネント構成
```
src/services/browser/scenarioExec.ts     # capture スキーム分岐（url:/db:/dom）、dbQuery dep、captureValue()
src/pipeline/executeScenarios.ts         # resolveTarget dep、runMultiAct の per-act ターゲット解決＋forceReauth 精緻化
src/pipeline/verify/registeredData.ts    # resolveAdapter を export（再利用）
src/cli/commands/run.ts                  # runScenarioStage に resolveTarget / dbQuery 配線（adapter 遅延生成＋close）
README.md                                # 跨ぎシナリオ記法（persona.target / url:・db: capture / 跨ぎ DB 運用）
```

---

## 9. ロードマップ（Phase4・本仕様対象外）
- grow による**跨ぎジャーニーの自動提案**（ソース＋クロール＋ドメイン因果から LLM が「admin 作成→user 利用」を提案）。
- ターゲットごとに異なる 2FA/認証機構の個別配線。
- `url:`/`db:` 以外の capture 源（API レスポンス等）。

---

## 10. 段階的実装方針（Phase3）
1. **capture スキーム**（scenarioExec：`captureValue` で url:/db:/dom 分岐、`dbQuery` dep）。
2. **マルチターゲット実行**（executeScenarios：`resolveTarget` dep、runMultiAct の per-act ターゲット＋forceReauth 精緻化、未解決失敗）。
3. **配線**（registeredData の resolveAdapter export＋run の resolveTarget/dbQuery 構築・close）。
4. **README**（跨ぎ記法・運用）。
