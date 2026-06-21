# loop-e2e — ローカル起動＋ログイン実走 拡張 設計仕様書

- **ステータス**: ドラフト（レビュー待ち）
- **作成日**: 2026-06-21
- **対象**: 既存 loop-e2e CLI への増分拡張（`docs/superpowers/specs/2026-06-21-loop-e2e-design.md` を前提）

---

## 1. 目的とスコープ

専用の e2e ディレクトリを起点に、**git clone → docker compose でローカル起動 → DB にテストユーザーをシード → シナリオ生成 → ログインシナリオを実走**するまでを一気通貫で動かす。以降はシナリオを育てて多様なテストを実行する土台とする。

### 今回のイテレーション到達点（縦割り）
`init`（clone＋起動＋シード）→ `scenario`（ログインを含む生成）→ `run`（ログインシナリオを実走しログイン成功を確認）の**1本の動く経路**を完成させる。

### スコープ外（次イテレーション）
- 全シナリオの汎用実行エンジン（ログイン以外の任意シナリオの逐次実走・育成）
- 既存の差分検出/5カテゴリ検証の本経路への全面統合（本変更では阻害しない範囲で温存）

### 確定事項（2026-06-21）
- 起動方式: **docker compose 前提**
- プロセス管理: **init がデタッチ起動（compose project）＋ `down` で停止**
- ログイン資格: **起動後に DB へテストユーザーをシード**（`.env` の資格情報）

---

## 2. ベースディレクトリモデル

専用 e2e ディレクトリ（CLI の cwd）を起点とし、全成果物をここに集約する。

```
<e2e-base>/
├─ loop-e2e.config.yaml         # 非機密設定
├─ .env / .env.example          # 機密（トークン・テスト資格情報）
├─ repos/<name>/                # git clone 先（base 直下に昇格。旧 .loop-e2e/repos から変更）
├─ scenarios/*.scenario.yaml    # シナリオ
└─ .loop-e2e/
   ├─ process.json              # 起動中スタックの状態（down 用）
   ├─ baseline/ runs/ reports/ feedback/
```

- **変更点**: clone 先を `.loop-e2e/repos/<name>` → **`repos/<name>`**（base 直下、可視・第一級）。
- `.env` と `.loop-e2e/` と `repos/` は既定で `.gitignore`（e2e 専用ディレクトリ自体を別管理する想定）。
- init は cwd を base とする。`--dir <path>` で明示指定も可（任意）。

---

## 3. 設定スキーマの追加・変更

### 3.1 新規 `launch` セクション（zod）

```
LaunchSchema {
  compose: {
    files: string[]            # compose ファイルパス（base からの相対、1個以上）
    projectName: string        # docker compose -p の値
    envFile?: string           # 任意（--env-file）
  }
  readiness: {
    url: string                # 2xx になるまでポーリングする health/ログインURL
    timeoutSec: number = 180
    intervalSec: number = 3
  }
  seed?: {
    command: string            # 起動後に実行するシードコマンド（冪等であること）
  }
  targetName: string           # この起動先に対応する config.targets[].name
}
```

- `Config.launch?: Launch` を追加（任意。未設定なら従来どおり外部起動前提で `init` は起動・シードをスキップ）。

### 3.2 既存スキーマへの影響
- `Config.targets[].baseUrl` は **ローカル起動 URL**（例 `http://localhost:3000`）を指す運用に。`auth.strategy='form'` ＋ `loginPath` ＋ `usernameEnv`/`passwordEnv` でログイン情報を `.env` から解決。
- リポジトリ clone 先パスの算出を `repos/<name>` に変更（clone サービス参照）。

---

## 4. コマンド仕様

### 4.1 `init`（拡張）
順序（各ステップは失敗時に明確なメッセージ、機密マスク）:
1. 設定生成: `loop-e2e.config.yaml` / `.env.example` / ディレクトリ / `.gitignore` / GitHub ラベル（従来どおり）。
2. **git clone**: 各 `config.repositories[]` を `repos/<name>` へ shallow clone（既存なら fetch）。トークンはマスク。
3. **起動**: `config.launch` があれば `docker compose -p <projectName> [-f files...] [--env-file] up -d`（デタッチ）。
4. **readiness 待機**: `readiness.url` を `intervalSec` 間隔で GET し、2xx を確認。`timeoutSec` 超過でエラー（直近の応答/ログ要約を提示）。
5. **DB シード**: `launch.seed.command` を実行しテストユーザーを投入（冪等想定。既存ユーザーがあっても失敗しない運用を推奨）。
6. **状態記録**: `.loop-e2e/process.json` に `{ projectName, composeFiles, startedAt, readinessUrl }` を保存。
- `launch` 未設定時は 3–6 をスキップ（従来挙動）。

### 4.2 `down`（新規）
- `.loop-e2e/process.json` を読み、`docker compose -p <projectName> [-f files...] down`（`--volumes` は `--volumes` オプション時のみ）。
- 停止後 `process.json` を削除（または stopped マーク）。
- `process.json` が無ければ「起動中スタックなし」と通知して正常終了。

### 4.3 `scenario`（変更）
- **clone を行わない**（init が `repos/<name>` に用意済み）。要件収集は `repos/<name>` を直接読む（既存 `selectFiles`/`readGitLog`/`summarizeIfOverBudget` を流用、clone ステップのみ除去）。
- 生成物に**ログインシナリオ**（loginPath 遷移→資格入力→submit→ログイン後状態の assert）を含める（プロンプトで明示）。

### 4.4 `run`（縦割りの実走）
- 対象 = ローカル起動アプリ（`targets[targetName].baseUrl`）。
- **ログインシナリオを実走**: Playwright で `loginPath` へ遷移→`.env` 資格でフォーム入力→submit→ログイン成功判定（ログイン後 URL/要素/Cookie のいずれかで `expectedOutcome` を満たすか）。
- 結果をレポート（`report.md`/`report.json`）に保存。失敗時は理由を明示。
- 既存の collect/diff/verify 経路は温存（本実走を阻害しない範囲）。ログイン実走は**シナリオ実行**の最初の一歩であり、次イテレーションで任意シナリオへ一般化する。

---

## 5. コンポーネント（小さく分離・全外部I/O注入可能）

```
src/services/compose/
  ├─ compose.ts        # composeUp(launch, runner) / composeDown(launch, runner)（docker compose を execFile ラップ、runner 注入）
  └─ readiness.ts      # waitForReadiness(url, {timeoutSec,intervalSec}, fetchFn) — 2xx までポーリング
src/services/seed/
  └─ seed.ts           # seedDatabase(seed, runner) — seed.command 実行（冪等）
src/state/
  └─ process.ts        # saveProcessState / loadProcessState / clearProcessState（.loop-e2e/process.json）
src/cli/commands/
  ├─ init.ts           # 起動オーケストレーション追加（clone→up→ready→seed→状態保存）
  ├─ down.ts           # 新規
  └─ scenario.ts       # clone 廃止、repos/ を直接参照
src/services/browser/
  └─ login.ts          # executeLoginScenario(page, target, scenario, creds) — ログインステップ駆動＋成功判定
src/services/repo/
  └─ clone.ts          # clone 先を repos/<name> に変更（init から利用、scenario からは呼ばない）
src/config/schema.ts   # LaunchSchema 追加、Config.launch 追加
```

- docker/git/fetch/DB/Playwright はすべて runner/クライアント注入でユニットテスト可能（実 docker/network/API/chromium なし）。
- 実機フローは `RUN_E2E=1` で gate する E2E に限定。

---

## 6. データフロー（縦割り）

```
loop-e2e init
  → clone repos/<name>
  → docker compose up -d  (backend + frontend + db)
  → waitForReadiness(readiness.url)
  → seed test user (seed.command)  →  .env の usernameEnv/passwordEnv が有効化
  → process.json 保存
loop-e2e scenario
  → repos/<name> から要件収集 → Opus 生成（ログインシナリオ含む）→ scenarios/*.scenario.yaml
loop-e2e run
  → target.baseUrl に対しログインシナリオ実走（form login）→ 成功判定 → report 保存
loop-e2e down
  → docker compose down → process.json 削除
```

---

## 7. エラーハンドリング
- docker compose / git / seed / readiness はラップし、ユーザー向け明確メッセージ（機密マスク）。
- readiness タイムアウト時は「起動失敗の可能性」を示し、`docker compose logs` の取得方法を案内（または直近ログ要約）。
- seed 失敗時は init を失敗させ、`down` で後始末できる状態にする（process.json は up 成功直後に記録）。
- ログイン実走失敗時はレポートに loginPath・到達 URL・想定との差分を記録。

---

## 8. テスト戦略
- **単体**: LaunchSchema 検証、compose/readiness/seed/process の各サービス（runner/fetch をモック）、login 実走（fake page）、scenario の clone 廃止後の要件収集。
- **統合**: `init→scenario→run→down` を全外部 I/O モックで通す（実 docker/DB/API/chromium なし）。
- **実機 E2E**: `RUN_E2E=1` で、サンプル compose スタックに対し clone→up→seed→login→down を通す（任意・CI 既定スキップ）。
- 既存 245 テストを壊さない（clone 先変更・scenario の clone 廃止に伴うテスト更新を含む）。

---

## 9. 段階的実装方針（本イテレーション）
1. **設定**: LaunchSchema＋Config.launch、clone 先を `repos/<name>` に変更。
2. **compose/readiness/seed/process サービス**（注入可能・テスト）。
3. **init 拡張**: clone→up→ready→seed→状態保存。
4. **down コマンド**。
5. **scenario 変更**: clone 廃止、repos 直接参照、ログインシナリオ生成。
6. **run のログイン実走**＋レポート。
7. **統合テスト**＋ `RUN_E2E` 実機 E2E＋README 更新（base ディレクトリ運用・docker 前提・コマンド例）。

---

## 10. 未決事項 / 実装中に詰める
- compose ファイルの所在（各 repo 同梱 vs e2e ディレクトリに用意する集約 compose）— 設定 `compose.files[]` で両対応。初期は「e2e ディレクトリに集約 compose を置く」運用例を README に示す。
- seed の冪等性担保（テストユーザー既存時の扱い）— seed.command 側の責務とし、推奨パターンを README に記載。
- readiness 判定の対象 URL（ヘルスエンドポイント vs ログインページ）— `readiness.url` で設定、既定はログインページで可。
