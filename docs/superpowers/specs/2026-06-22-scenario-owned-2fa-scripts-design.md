# シナリオ所有の 2FA ＋ スクリプト配置規約 設計仕様書

- **ステータス**: ドラフト（レビュー待ち）
- **作成日**: 2026-06-22
- **対象**: loop-e2e の認証（2FA）構成の所在を config からシナリオへ移管し、シナリオ用スクリプトの配置規約を定める。

---

## 1. 目的と原則

**原則**: loop-e2e 本体は環境非依存（高い抽象度）に保つ。「mailpit から 2FA PIN を読む」のような**環境固有の処理はシナリオ資産（スクリプト）に完全に閉じ込め**、loop-e2e は「シナリオが指定したコマンドを、そのシナリオのスクリプトディレクトリで実行する」だけにする。

達成すること:
1. 2FA 構成（`pinCommand` ＋セレクタ）を **config からシナリオへ移管**し、config からは削除する。
2. シナリオが使うスクリプトの**配置規約**を定める: `scenarios/<シナリオファイル名>/` 直下。
3. 全認証経路（run のログイン段・認証前提シナリオ・grow・explore）が、読み込み済みシナリオから**ログインシナリオを特定**して、その 2FA 構成＋スクリプトディレクトリを使う。

### 確定事項（2026-06-22）
- 2FA は**シナリオに完全移管**（`config.targets[].auth.twoFactor` を削除）。**破壊的変更**。
- スクリプトディレクトリ名 = **シナリオファイル名**（`<name>.scenario.yaml` → `scenarios/<name>/`）。

### スコープ外
- 2FA 以外の汎用「シナリオステップからの任意スクリプト実行」アクション（将来）。本仕様はディレクトリ規約を一般化して定めるが、実装する実行経路は既存の 2FA `pinCommand` のみ。

---

## 2. スキーマ変更

### 2.1 Scenario に `twoFactor` を追加（`src/scenario/schema.ts`）
config から移設する形で、シナリオに任意の 2FA ブロックを持たせる:

```ts
export const ScenarioTwoFactorSchema = z.object({
  /** PINを解決するシェルコマンド。scriptDir を cwd に実行される（例: "bash get-2fa-pin.sh"）。 */
  pinCommand: z.string().min(1),
  pinFieldSelector: z.string().default('input[name="pin_code"]'),
  submitSelector: z.string().default('button[type="submit"]'),
  successUrlPattern: z.string().optional(),
})
// ScenarioSchema に: twoFactor: ScenarioTwoFactorSchema.optional()
export type ScenarioTwoFactor = z.infer<typeof ScenarioTwoFactorSchema>
```

### 2.2 config から 2FA を削除（`src/config/schema.ts`）
- `AuthSchema` から `twoFactor` を削除。`TwoFactorSchema` も削除。
- `TargetEnv.auth.twoFactor`（`src/domain/types.ts`）を削除。

### 2.3 ロード時に `scriptDir` を付与（serialize しない）
- `LoadedScenario = Scenario & { scriptDir: string }`。
- `loadScenarios(dir)` は各ファイルの **basename**（`<name>.scenario.yaml` → `<name>`）から `scriptDir = join(dir, basename)` を計算して付与し、`LoadedScenario[]` を返す。
- `scriptDir` は **zod スキーマには含めない**（永続化形ではない）。`saveScenario`/`saveProposedScenario` は生成直後のシナリオ（scriptDir 無し）にのみ使われるため serialize されない。防御的に save 時は `scriptDir` を除外する。

---

## 3. ログインシナリオの特定（`src/scenario/loginScenario.ts`）

`run.ts` に private で存在する `isLoginScenario` を共有モジュールへ抽出し、`findLoginScenario` を追加:

```ts
export function isLoginScenario(s: Scenario, loginPath?: string): boolean   // 既存ロジックを移設
export function findLoginScenario<T extends Scenario>(scenarios: T[], loginPath?: string): T | undefined
```

全認証経路はこれで「指定のログインシナリオ」を見つけ、その `twoFactor` ＋ `scriptDir` を 2FA に使う。

---

## 4. 2FA 実行（`scriptDir` を cwd に）

### 4.1 login（`src/services/browser/login.ts`）
- `runTwoFactorStep` が PIN コマンドを実行する箇所を、シナリオ由来の `twoFactor` ＋ `scriptDir` を使うよう変更:
  - `pinRunner('sh', ['-c', twoFactor.pinCommand], { cwd: scriptDir })`
- `LoginDeps` に `twoFactor?: ScenarioTwoFactor` と `scriptDir?: string` を追加。
- `executeLoginScenario(page, target, scenario, creds, deps)`:
  - `twoFactor` は **`scenario.twoFactor`**（無ければ `deps.twoFactor`）から解決。
  - `scriptDir` は **`(scenario as LoadedScenario).scriptDir`**（無ければ `deps.scriptDir`）。
- `authenticate(page, target, creds, deps)`（合成最小シナリオ）は、`deps.twoFactor`／`deps.scriptDir` を最小シナリオに載せて `executeLoginScenario` に渡す。これで両経路が `scenario.twoFactor`/`scenario.scriptDir` 経由に統一される。
- `target.auth.twoFactor` への参照（login.ts:171 等）は撤去。

### 4.2 scenarioExec（`src/services/browser/scenarioExec.ts`）
- `{{TWO_FACTOR_PIN}}` 解決で、実行中シナリオの `twoFactor.pinCommand` を **`scriptDir` を cwd** に実行:
  - `ScenarioExecDeps.scriptDir?: string` を追加。`pinRunner('sh', ['-c', pinCommand], { cwd: deps.scriptDir })`。
  - `pinCommand` は `deps.pinCommand`（後方互換）か、実行中シナリオの `twoFactor?.pinCommand` を優先。

（`ComposeRunner` は既に `opts?: { cwd? }` を受けるため変更不要。）

---

## 5. 認証経路の配線

各 CLI/パイプラインで「ログインシナリオの twoFactor ＋ scriptDir」を解決して下流に渡す。

- **run**（`src/cli/index.ts` / `src/cli/commands/run.ts`）:
  - ログイン段: 既に `loginScenario` を渡している。`executeLoginScenario` が `scenario.twoFactor`/`scenario.scriptDir` を読む（追加配線不要、ただし `loadScenarios` が `LoadedScenario` を返すこと）。
  - シナリオ段（認証前提）: `executeScenarios` → `ensureAuthenticated` → `authenticate` に、ログインシナリオの `twoFactor`＋`scriptDir` を `SessionDeps` 経由で渡す。`run.ts` で `findLoginScenario` を使い `scenarioExecDeps`/session deps に載せる。
  - `scenarioExecDeps.pinCommand = selectedTarget.auth?.twoFactor?.pinCommand` を撤去し、ログインシナリオ由来に変更。
- **grow**（`src/cli/commands/grow.ts` / `src/pipeline/grow.ts`）: 読み込み済みシナリオから `findLoginScenario` し、`authenticate` deps に `twoFactor`＋`scriptDir` を渡す。`grow.ts:89` の `twoFactor: auth.twoFactor` を撤去。
- **explore**（`src/cli/commands/explore.ts`）: シナリオを `loadScenarios` し `findLoginScenario` → `authenticate` deps に `twoFactor`＋`scriptDir`。`explore.ts:44` の config 由来 `twoFactor` を撤去。

---

## 6. 移行（検証用プロジェクト `loop-e2e-test`）

- `get-2fa-pin.sh` を `scenarios/admin-login/get-2fa-pin.sh` へ移動。
- `admin-login.scenario.yaml` に追加:
  ```yaml
  twoFactor:
    pinCommand: bash get-2fa-pin.sh   # cwd = scenarios/admin-login/
  ```
- `loop-e2e.config.yaml` の `targets[].auth.twoFactor` ブロックを削除。

（本体の README も config から 2FA を外し、シナリオ側の twoFactor とスクリプト規約を記載。）

---

## 7. エラーハンドリング・セキュリティ
- `pinCommand` が無い／PIN が取れない場合は既存どおり 2FA 失敗（masked detail）。
- スクリプト実行は `cwd = scriptDir`、`sh -c`。loop-e2e はコマンド内容を解釈しない。
- 秘密値（PIN・認証情報）は従来どおり全 detail/ログ/レポートでマスク。

---

## 8. テスト戦略
- **schema**: Scenario.twoFactor の parse（デフォルトセレクタ）、config から twoFactor 削除（旧キーは無視される/型に無い）。
- **loader**: `loadScenarios` が `scriptDir = <dir>/<basename>` を付与。`saveScenario` は `scriptDir` を serialize しない。
- **loginScenario**: `findLoginScenario` がログインシナリオを返す。
- **login**: `runTwoFactorStep` が `pinRunner` を `cwd=scriptDir` で呼ぶ。`authenticate` が deps の twoFactor/scriptDir を最小シナリオに反映。
- **scenarioExec**: `{{TWO_FACTOR_PIN}}` 解決が `scriptDir` cwd で pinCommand を実行。
- **配線**: run/grow/explore が `findLoginScenario` の twoFactor/scriptDir を下流に渡す（モックで検証）。
- 既存スイートを壊さない（現行 517 pass / 5 skip を維持・更新）。
- **実機 E2E**: 移行後の `loop-e2e-test` で run → ログイン＋2FA 成功を確認。

---

## 9. コンポーネント構成

```
src/scenario/schema.ts          # ScenarioTwoFactorSchema 追加、LoadedScenario、loadScenarios が scriptDir 付与
src/scenario/loginScenario.ts   # isLoginScenario 抽出 + findLoginScenario（新規）
src/config/schema.ts            # AuthSchema から twoFactor 削除、TwoFactorSchema 削除
src/domain/types.ts             # TargetEnv.auth.twoFactor 削除
src/services/browser/login.ts   # twoFactor/scriptDir をシナリオ由来に、cwd=scriptDir、LoginDeps 拡張
src/services/browser/scenarioExec.ts  # scriptDir cwd で pinCommand 実行、ScenarioExecDeps 拡張
src/services/browser/session.ts # SessionDeps に twoFactor/scriptDir を通す
src/pipeline/executeScenarios.ts# login シナリオの twoFactor/scriptDir を session に伝播
src/cli/commands/run.ts         # isLoginScenario を loginScenario.ts へ、findLoginScenario 配線
src/cli/index.ts (run/grow)     # findLoginScenario → deps 配線、config twoFactor 撤去
src/cli/commands/grow.ts        # findLoginScenario 配線、config twoFactor 撤去
src/pipeline/grow.ts            # authenticate deps に twoFactor/scriptDir
src/cli/commands/explore.ts     # loadScenarios + findLoginScenario 配線、config twoFactor 撤去
README.md                       # 2FA をシナリオ側に、スクリプト規約を記載
```

---

## 10. 段階的実装方針
1. **schema**: Scenario.twoFactor 追加 ＋ `LoadedScenario`/`loadScenarios` の scriptDir 付与（＋ save が serialize しない）。
2. **loginScenario.ts**: `isLoginScenario` 抽出 ＋ `findLoginScenario`。
3. **login.ts**: scenario 由来 twoFactor/scriptDir、cwd=scriptDir、LoginDeps 拡張、authenticate 統一。
4. **scenarioExec.ts**: scriptDir cwd で {{TWO_FACTOR_PIN}} 解決。
5. **session.ts / executeScenarios.ts**: twoFactor/scriptDir 伝播。
6. **配線（run/grow/explore）**: findLoginScenario で下流へ。config twoFactor 撤去。
7. **config/domain 削除**: AuthSchema.twoFactor / TwoFactorSchema / TargetEnv.auth.twoFactor 削除。
8. **README** 更新。
9. **検証用プロジェクト移行** ＋ 実機 run 確認。
