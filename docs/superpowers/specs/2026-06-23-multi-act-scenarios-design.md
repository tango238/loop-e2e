# マルチアクト・シナリオ（Phase2）設計仕様書

- **ステータス**: ドラフト（レビュー待ち）
- **作成日**: 2026-06-23
- **対象**: シナリオを「段（act）ごとにペルソナのセッションを確立して実行＋段間データ受け渡し」へ拡張する（責務整理ロードマップの Phase2）。

---

## 1. 目的

機能的ユーザーフロー（複数アクター・複数ステップの業務プロセス）を1シナリオで検証できるようにする。現状は単一ページ・単一セッションで flat `steps` を実行するのみで、「管理者が作成 → 別人格が確認」のような**段をまたぐフロー**を表現できない。

Phase2 で **personas／acts／capture／`{{VAR}}`／段ごとのセッション切替**の機構を実装する。**同一ターゲット上での identity 切替**に限定し（例：管理者A作成 → 管理者B確認）、システム跨ぎ（別アプリ）の配線は Phase3 に委ねる。

### 確定事項（2026-06-23）
- **Phase2/3 境界**：マルチターゲット（システム跨ぎ）は Phase3。Phase2 は機構を**同一 run ターゲット上**で実装。`persona.target` フィールドは用意するが解決は Phase3。
- **スキーマ互換**：`steps` と `acts` を**排他**（両 optional＋zod refine で「どちらか一方」）。flat `steps` の既存シナリオはそのまま有効（単一 act の糖衣）。`toActs()` で吸収。
- **capture 取得元**：Phase2 は **DOM 由来のみ**（セレクタの text/value）。`db:`/`url:` 由来は Phase3。

### スコープ外（Phase3、§9）
- config の複数ターゲット運用、`persona.target` → 別 baseUrl/creds 解決。
- `capture` の `db:`/`url:` 取得元。
- 真のシステム跨ぎ（admin アプリ → storefront アプリ）。

---

## 2. スキーマ（`src/scenario/schema.ts`）

```yaml
id: admin-create-then-verify
title: 管理者が作成し、別人格が確認
businessFlow: 管理者がクーポンを作成し、別の管理者が一覧で確認する
personas:
  - { name: creator,  auth: authenticated }                         # target 省略 → run の対象
  - { name: verifier, auth: authenticated,
      credEnv: { usernameEnv: REVIEWER_USER, passwordEnv: REVIEWER_PASS } }
acts:
  - persona: creator
    steps:
      - { action: navigate, target: /coupon/create, expectedOutcome: フォーム表示 }
      - { action: fill, target: '[name=code]', input: SUMMER25, expectedOutcome: 入力 }
      - { action: submit, target: 'button[type=submit]', expectedOutcome: 作成完了 }
      - { action: capture, target: '[data-testid=coupon-code]', var: COUPON, expectedOutcome: コード取得 }
  - persona: verifier
    steps:
      - { action: navigate, target: /coupon, expectedOutcome: 一覧表示 }
      - { action: assert, target: 'text={{COUPON}}', expectedOutcome: 作成済みが見える }
expectedResults:
  - { kind: ui, description: クーポンが一覧に出る, assertion: 'text={{COUPON}}' }
expectedDbState: []
```

新規/変更スキーマ:
- `ScenarioStepSchema`：`var: z.string().optional()` を追加。`capture` アクションは `var` 必須（refine）。
- `PersonaSchema`（新規）：
  ```ts
  { name: z.string().min(1),
    target: z.string().optional(),                 // Phase2: 未使用（run ターゲット）/ Phase3 で解決
    auth: z.enum(['authenticated','unauthenticated']),
    loginPath: z.string().optional(),
    credEnv: z.object({ usernameEnv: z.string().min(1), passwordEnv: z.string().min(1) }).optional() }
  ```
- `ActSchema`（新規）：`{ persona: z.string().optional(), steps: z.array(ScenarioStepSchema).min(1) }`。
- `ScenarioSchema` 変更：
  - `steps` を `optional` に（`acts` がある場合は無し）。
  - `acts: z.array(ActSchema).min(1).optional()` を追加。
  - `personas: z.array(PersonaSchema).optional()`。
  - **refine**：`steps` と `acts` は排他で**どちらか必須**。`acts` の各 `persona` は `personas[].name` に存在すること（参照整合）。`capture` ステップは `var` 必須。
- `toActs(scenario): Act[]` ヘルパ：`scenario.acts ?? [{ steps: scenario.steps! }]`（flat = 単一 act・persona 無し）。

後方互換：既存 `*.scenario.yaml` は全て flat `steps` のため、`steps` を optional 化しても妥当。`steps` を読む既存箇所（rdra-export 等）は `toActs()` 経由か flat 前提のまま（acts 非対応の補助コマンドは flat のみ対象で可）。

---

## 3. 実行（`src/services/browser/scenarioExec.ts` ＋ `src/pipeline/executeScenarios.ts`）

### 3.1 ステップ実行コア
`executeSteps(page, target, steps, deps): StepsResult` を新設（現 `executeScenario` の switch を移設）。
- `StepsResult = { ok; failedStepIndex?; detail; finalUrl }`。`deps.vars` は**可変の共有変数バッグ**（capture が書き、`{{VAR}}` が読む）。
- 新ケース `capture`：`vars[step.var] = await readCapture(page, step.target)`。`readCapture`：セレクタ要素の `inputValue()`（input/textarea）→ 無ければ `textContent()`（trim）。取得不可は当該ステップ失敗。
- **`{{...}}` 解決の拡張**：従来 `fill.input` のみ → `navigate`/`assert`/`wait`/`click`/`fill` の **target でも解決**（`resolveText(raw, deps)`）。`{{VAR}}`（バッグ）→ `{{ENV}}`（vars/process.env）→ `{{TWO_FACTOR_PIN}}`（pinCommand）。未解決はステップ失敗（プレースホルダ名のみ露出、値は出さない）。秘密マスクは維持。

`executeScenario`（既存・後方互換）：`executeSteps(page, target, scenario.steps, {...})` を呼ぶ薄いラッパに。シグネチャ/戻り値は不変（既存テストを壊さない）。

### 3.2 マルチアクト実行
`executeScenarios` を拡張：
- 各シナリオで `acts = toActs(scenario)`、`vars: Record<string,string> = {}`（シナリオ単位で acts 間共有）。
- **flat（acts 無し）**：現行どおり（`precondition.auth` で ensureAuth/Unauth → `executeScenario`）。挙動不変。
- **multi-act**：各 act で
  1. `persona = personas.find(p => p.name === act.persona)`。`persona.target` が run ターゲット以外を指す場合は **warn**（Phase2 は run ターゲットで実行）。
  2. **セッション確立**：`auth==='authenticated'` → `resolvePersonaCreds(persona, runCreds, secretsEnv)` で creds 解決し `ensureAuthenticated(page, target, creds, firstNav, { ...deps, forceReauth })`。前 act とペルソナが変わるとき（creds 差）は **forceReauth=true**（ログアウト→再ログイン）。`auth==='unauthenticated'` → `ensureUnauthenticated`。
  3. `executeSteps(page, target, act.steps, { ...deps, vars })`。失敗時はその act で停止しシナリオ失敗。
- **セッション切替**：`session.ts` の `ensureAuthenticated` に `forceReauth?: boolean` を追加。true のとき現セッションを破棄（ログアウト URL 遷移 or storage クリア）してから login。実装は既存 login フローを再利用。
- `resolvePersonaCreds`：`persona.credEnv` があれば `secretsEnv[usernameEnv]/[passwordEnv]`（無ければ process.env）から解決、無ければ run の creds。解決した creds 値は **secrets に加えてマスク**。

### 3.3 結果集約
- 成否を従来どおり `VerifyFinding(category:'scenario')` に1件/シナリオ。
- multi-act 失敗時の detail：`act <i> (persona <name>) step <j> (<action>) failed: <why>`（マスク済み）。
- 成功時：`passed (<actCount> acts, <stepCount> steps)`。`expectedResults` の api/db 未検証注記は現行どおり。

---

## 4. エラーハンドリング・セキュリティ
- スキーマ refine 違反（steps/acts 同時 or 双方欠落、未知 persona 参照、capture の var 欠落）は明確なバリデーションエラー。
- `{{VAR}}` 未解決・capture 失敗は当該ステップ失敗（フロー中断、後続 act スキップ）。
- ペルソナ creds・PIN・取得した capture 値が機密になり得る場合も**マスク**（capture 値は detail に出さない；必要時は変数名のみ）。
- Phase2 は run ターゲット限定：`persona.target` が別ターゲットを指す場合は warn して run ターゲットで実行（誤解防止）。

---

## 5. テスト戦略
- **schema**：steps↔acts 排他 refine（両方/どちらも無しで失敗）、未知 persona 参照で失敗、capture の var 必須、`toActs()`（flat→単一act / acts→そのまま）。
- **executeSteps**：capture が変数バッグへ格納、`{{VAR}}` を後続 target/input で解決、未解決で失敗、capture 値がマスクされ detail に出ない、{{ENV}}/{{TWO_FACTOR_PIN}} 既存挙動維持。
- **executeScenarios（multi-act）**：act ごとに persona セッション確立（creds 切替で forceReauth）、acts 間で vars 共有、ある act 失敗で以降スキップ＋detail に act/persona/step、flat シナリオは挙動不変（既存テスト緑）。
- **resolvePersonaCreds**：credEnv 解決、未指定で run creds フォールバック、値マスク。
- 既存スイート（現 546 pass / 5 skip）を壊さない。

---

## 6. コンポーネント構成
```
src/scenario/schema.ts                       # Persona/Act スキーマ、steps↔acts refine、toActs()、var フィールド
src/services/browser/scenarioExec.ts         # executeSteps コア（capture・{{VAR}} target 解決）、executeScenario ラッパ化、resolveText/readCapture
src/services/browser/session.ts              # ensureAuthenticated に forceReauth 追加
src/pipeline/executeScenarios.ts             # multi-act ループ（persona セッション切替＋共有 vars）、resolvePersonaCreds、結果集約
README.md                                    # マルチアクト・シナリオの記法と例
```

---

## 7. ロードマップ（Phase3・本仕様対象外）
- config の複数ターゲット運用、`persona.target` → 別ターゲットの baseUrl/creds 解決（真のシステム跨ぎ）。
- `capture` の `db:`/`url:` 取得元（作成した行の値・URL のリソース ID）。
- `expectedDbState` の跨ぎ検証（storefront-db 等）。
- grow/proposeScenarios によるマルチアクト・ジャーニーの自動提案（ドメイン因果の理解）。

---

## 8. 段階的実装方針（Phase2）
1. **スキーマ**（Persona/Act、steps↔acts refine、var、toActs）。
2. **executeSteps コア**（switch 移設＋capture＋`{{VAR}}` target 解決）、`executeScenario` ラッパ化。
3. **session.forceReauth**（identity 切替の再ログイン）。
4. **executeScenarios multi-act**（persona セッション切替、共有 vars、resolvePersonaCreds、結果集約）。
5. **README**（記法・例）。
