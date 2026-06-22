# loop-e2e — `grow`: ランタイム発見によるシナリオ自動提案 設計仕様書

- **ステータス**: ドラフト（レビュー待ち）
- **作成日**: 2026-06-22
- **対象**: 既存 loop-e2e CLI への増分拡張

---

## 1. 目的とスコープ

ログイン後の画面を**認証済みで巡回して発見**し、既存シナリオが未カバーの画面に対して**AIがシナリオを提案**、人が承認して取り込む。これにより「シナリオを育てて精度を高め、バグを自動検出する」ループのうち、ログイン以降の自動拡張を実現する。

### 2フェーズ構成
- **フェーズ1（前提）**: 2FA込みの認証ログイン実走。`run` の単段ログインを拡張し、認証セッションを確立してダッシュボードに到達する。これ自体が独立した価値（`run` のログイン実走もダッシュボードまで通る）。
- **フェーズ2**: 認証済み発見クロール → 未カバー検出 → シナリオ提案 → 承認取り込み（新コマンド `grow` / `approve`）。

### 確定事項（2026-06-22）
- 2FA PIN取得: **設定コマンド**（`pinCommand` が PIN を標準出力）。環境依存はユーザー設定側。
- 発見巡回: **リンク追跡BFS**（同一オリジン・`maxPages`/`maxDepth` 上限）。
- 新シナリオ: **提案→承認**（`proposed/` にドラフト保存、`approve` で本採用）。
- 実行場所: **専用コマンド `loop-e2e grow`**。

### スコープ外
- 提案シナリオの自動実行（承認後の通常 `run` で検証される）。
- ヘッドレス以外のブラウザ、JS実行を伴わない発見。

---

## 2. 設定スキーマの追加

### 2.1 2FA（`target.auth.twoFactor`、任意）
```
TwoFactorSchema {
  pinCommand: string            # PIN(数字)を標準出力するシェルコマンド（sh -c で実行・マスク）
  pinFieldSelector?: string     # 既定 'input[name="pin_code"]'
  submitSelector?: string       # 既定 'button[type="submit"]'
  successUrlPattern?: string    # 任意。認証成功とみなすURL正規表現（既定: /login と /two-factor-auth から離れたら成功）
}
```
`AuthSchema` に `twoFactor: TwoFactorSchema.optional()` を追加。

### 2.2 発見クロール（`grow`、任意・トップレベル）
```
GrowSchema {
  maxPages: number = 50         # 発見する最大ページ数
  maxDepth: number = 3          # BFSの最大深さ
  excludePaths?: string[]       # 除外パス（部分一致、例: ['/logout','/api']）
}
```
`ConfigSchema` に `grow: GrowSchema.optional()`（未設定なら既定値で動作）。

---

## 3. フェーズ1: 2FA込み認証ログイン

### 3.1 振る舞い（`src/services/browser/login.ts` 拡張）
`executeLoginScenario`（既存・単段フォームログイン）を拡張し、`target.auth.twoFactor` がある場合に2FAステップを実行:
1. 既存どおり loginPath へ遷移→ユーザー/パスワード入力→submit。
2. submit後、2FAページ（`/two-factor-auth` 相当 or `twoFactor` 設定あり）を検出したら:
   - `pinCommand` を `sh -c`（runner注入・マスク）で実行し、標準出力から **PIN（数字列）を抽出**。
   - `pinFieldSelector` に PIN を入力し `submitSelector` を submit。
   - ナビゲーションを待ち、`successUrlPattern`（or 既定の「loginPath/2FAパスから離れた」）で**認証成功を判定**。
3. 戻り値: `{ ok, detail, finalUrl }`（既存と同形。段階別の detail プレフィックスを維持）。資格情報・PINは detail/ログに出さない。
- `twoFactor` 未設定なら従来の単段ログイン（後方互換）。

### 3.2 認証済みコンテキストの取得（`authenticate`）
`grow`/将来の認証済みクロール用に、ログイン成功後の**認証済み page/browser コンテキスト**を返す `authenticate(browser, target, creds, deps): Promise<{ page, ok, finalUrl }>` を `login.ts` に追加（`executeLoginScenario` を内部利用、成功時に page を保持）。

---

## 4. フェーズ2: 発見 → 提案 → 承認

### 4.1 発見クロール（`src/services/browser/discover.ts`）
`discoverPages(browser, target, opts: GrowConfig, deps): Promise<RawPage[]>`:
- 認証済み page から開始。ログイン後ルート（`target.baseUrl`）を起点に **BFS**:
  - 現ページの同一オリジン `<a href>` を収集→正規化（フラグメント除去・クエリ正規化）→未訪問のみキュー。
  - `excludePaths` 部分一致・`/logout`・外部オリジン・アセット（画像/JS/CSS）を除外。
  - `maxPages`/`maxDepth` 上限で停止。各ページを `RawPage`（url/title/html/meta/screenshot）として収集。
- 認証セッションは同一 browser コンテキストで維持。

### 4.2 未カバー検出（`src/pipeline/grow.ts` 内 or `src/services/grow/coverage.ts`）
`findUncoveredPages(discovered: RawPage[], scenarios: Scenario[]): RawPage[]`:
- 既存シナリオが踏むパス集合 = 各 `scenario.steps` の `action==='navigate'` の `target`（パス正規化）の和集合 ＋ `loginPath`。
- 発見ページのパスがこの集合に**含まれないもの**を未カバーとして返す（パス正規化で比較）。

### 4.3 シナリオ提案（`src/services/llm/proposeScenarios.ts`）
`proposeScenarios(llm, uncovered: PageInfo[]): Promise<Scenario[]>`:
- 未カバーページを `structureExtract` で `PageInfo`（表示/入力項目・期待）に構造化（role=planning）。
- Opus に各未カバーページの構造を渡し、`ScenarioSchema` 準拠のシナリオを提案生成（id は `grow-<slug>` 等、重複回避）。zod検証。
- 認証前提の操作（ログイン済みである前提）として、各提案に最初の navigate ステップ＋主要操作を含める。

### 4.4 ドラフト保存と承認（`src/scenario/schema.ts` 拡張）
- `saveProposedScenario(dir, s)`: `<scenarioDir>/proposed/<id>.scenario.yaml` に保存。
- `loadProposedScenarios(dir)`: proposed の一覧。
- `loadScenarios(dir)`（既存）は **proposed/ を読まない**（run は未承認を実行しない）。
- `approveScenario(dir, id)`: `proposed/<id>.scenario.yaml` → `<scenarioDir>/<id>.scenario.yaml` へ移動。既存と衝突する場合は差分提示し確認（既定は上書きしない）。

### 4.5 コマンド
- **`loop-e2e grow [--target <name>] [--max-pages N] [--skip-prepare]`**:
  1. prepare（既存・`--skip-prepare` で省略）。
  2. `authenticate`（2FA込み）→ 失敗ならエラー終了。
  3. `discoverPages`。
  4. `findUncoveredPages`（`loadScenarios` の既存と比較）。
  5. `proposeScenarios` → `saveProposedScenario`。
  6. レポート: 発見N件・未カバーM件・提案K件と保存先を表示。
- **`loop-e2e approve [--all | <id...>]`**: proposed を本採用（移動）。一覧表示も。

---

## 5. コンポーネント構成（小さく分離・全外部I/O注入可）

```
src/config/schema.ts                  # AuthSchema.twoFactor?、ConfigSchema.grow? 追加
src/services/browser/login.ts（拡張）  # 2FAステップ＋ authenticate()
src/services/browser/discover.ts       # discoverPages（BFS、browser注入）
src/services/grow/coverage.ts          # findUncoveredPages
src/services/llm/proposeScenarios.ts   # proposeScenarios（Opus）＋ prompts/propose.ts
src/scenario/schema.ts（拡張）         # saveProposed/loadProposed/approveScenario, proposed/ 規約
src/pipeline/grow.ts                    # grow オーケストレーション（authenticate→discover→coverage→propose→save）
src/cli/commands/grow.ts, approve.ts    # 新コマンド
src/cli/index.ts                        # grow/approve 登録・実deps配線
```

- ブラウザ/シェル(pinCommand)/LLM はすべて注入可能でユニットテストはモック（実ブラウザ/シェル/APIなし）。実機は `RUN_E2E=1` gate。

---

## 6. データフロー
```
loop-e2e grow
  → prepare（repo refresh + setup）
  → authenticate: form login → 2FA(pinCommand→PIN→submit) → dashboard（認証済みpage）
  → discoverPages: BFS（同一オリジン・上限）→ RawPage[]
  → findUncoveredPages: 既存シナリオの navigate パス と比較 → 未カバー RawPage[]
  → proposeScenarios: structureExtract → Opus → Scenario[]（zod検証）
  → saveProposedScenario: <scenarioDir>/proposed/*.scenario.yaml
loop-e2e approve --all | <id>
  → proposed/<id> を <scenarioDir>/ へ移動（衝突は確認）
```

---

## 7. エラーハンドリング
- `pinCommand` 失敗・PIN抽出失敗（数字が取れない）→ 認証失敗として明確なメッセージ（マスク）。
- 認証失敗（ダッシュボード未到達）→ grow を中断し loginPath・到達URLを報告。
- 発見クロール: ページ取得失敗は当該ページをスキップしログ、全体は継続。上限到達は明示ログ（無言の打ち切りにしない）。
- 提案生成のLLM出力は zod 検証（失敗はクライアント層でリトライ）。`ANTHROPIC_API_KEY` 未設定時は明確なエラー（提案にLLMが要る）。
- 承認の衝突は上書きせず確認。すべての pinCommand 出力・エラーは `maskSecrets`。

---

## 8. テスト戦略
- **単体**: 2FAステップ（pinCommand実行→PIN入力→成功/失敗判定、PIN/資格の非漏洩）、`discoverPages`（fake browser でBFS・上限・除外・重複排除）、`findUncoveredPages`（既存シナリオ踏破パスとの差分）、`proposeScenarios`（LLMモック→zod検証）、`approveScenario`（移動・衝突）。
- **統合**: `grow` を全外部I/Oモックで通し、authenticate→discover→coverage→propose→proposed保存 を artifact で assert。`approve` で active へ移動。
- **実機E2E**: `RUN_E2E=1` で spotly admin に対し 2FA(pinCommand=mailpit/DB)→発見→提案 を通す（既定スキップ）。
- 既存 340 pass + 3 skip を壊さない。

---

## 9. 段階的実装方針
1. **設定**: `AuthSchema.twoFactor?`、`ConfigSchema.grow?`。
2. **フェーズ1**: login.ts に2FAステップ＋`authenticate`（＋ run のログイン実走が2FAを使う配線）。
3. **発見**: `discoverPages`（BFS）。
4. **未カバー検出**: `findUncoveredPages`。
5. **提案**: `proposeScenarios`（Opus）。
6. **承認/保存**: `saveProposed`/`approveScenario`、`proposed/` 規約。
7. **コマンド**: `grow` / `approve` ＋ 配線。
8. **統合テスト**＋ `RUN_E2E` 実機＋ README（grow/approve・twoFactor/grow 設定例、spotly の pinCommand 例）。

---

## 10. 未決事項 / 実装中に詰める
- PIN抽出の正規表現（`pinCommand` 出力から数字列を取る。例 `/\d{4,8}/`）。
- 提案シナリオの id 命名（`grow-<path-slug>` 等の重複回避規則）。
- 発見クロールの SPA リンク取得（`<a href>` に加えクライアントルーティングの考慮要否は実装時に検証）。
- `run` のログイン実走が `authenticate`（2FA込み）を使うよう切替えるか、`grow` 専用に留めるか（既定: フェーズ1で `executeLoginScenario` 自体を2FA対応にし両方が恩恵を受ける）。
