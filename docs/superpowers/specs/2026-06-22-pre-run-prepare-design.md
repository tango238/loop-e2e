# loop-e2e — `run` 前処理フェーズ（repo refresh ＋ setup hooks）設計仕様書

- **ステータス**: ドラフト（レビュー待ち）
- **作成日**: 2026-06-22
- **対象**: 既存 loop-e2e CLI への増分拡張

---

## 1. 目的とスコープ

`loop-e2e run` のたびに、検証本体（collect/diff/verify/login/report）の前に**環境を一定の状態へ自動でならす「準備フェーズ」**を設ける。これにより、シナリオを育てて精度を高め、バグの自動検出を安定して行える土台を作る（環境起因の偽陽性を減らす）。

今回の動作確認で手動対応した「CORS整合（roomport の env を development に揃える）」のような環境ならしを、毎回の `run` で自動再現できるようにする。

### 準備フェーズの2ステップ（この順）
1. **リポジトリ更新**（本体組み込み）: 設定ブランチへ stash→checkout→pull で最新化。
2. **setup フック**（ユーザー定義シェルコマンド）: CORS整合・追加seed・キャッシュクリア等。

### 確定事項（2026-06-22）
- 実行タイミング: **毎回 `run` の冒頭**（検証の前）。
- 適用後: **戻さず冪等適用**（teardown はしない）。
- フック記述: **シェルコマンドのリスト**。
- 環境依存コマンドの配置: **ユーザーのワークスペース設定**（本体は汎用機構のみ）。
- リポジトリ更新: 作業ツリーに変更があれば **stash** → checkout → pull → **WIPを復元（競合なし=自動pop、競合あり=手動）**。

### スコープ外
- 起動済みアプリの再ビルド/再起動（必要ならユーザーの setup コマンドで `docker compose ... up -d --build` 等を記述）。
- teardown/revert 機構（今回は不要）。

---

## 2. 設定スキーマの追加・変更

### 2.1 リポジトリにブランチ指定（任意）
`RepositorySchema` に任意フィールドを追加:
```
branch?: string   # 設定時、run前にこのブランチへ最新化する。未設定ならスキップ。
```

### 2.2 setup フック（任意・トップレベル）
`ConfigSchema` に追加:
```
setup?: { command: string }[]   # run冒頭・repo更新の後に順次実行するシェルコマンド
```
- 各要素はシェルコマンド1つ。`sh -c "<command>"`、cwd = ワークスペース root。
- 失敗（非ゼロ終了）したら run を中断し、明確なメッセージ（秘密情報マスク）。
- 冪等性はユーザー責務。適用後は戻さない。

### 2.3 実行フラグ
- `loop-e2e run --skip-prepare`: 準備フェーズをスキップ（デバッグ/高速反復用）。

---

## 3. 準備フェーズの仕様

### 3.1 リポジトリ更新（`refreshRepos`）
対象: `repositories[]` のうち `branch` が設定されたもの（順不同・各repo独立）。各 repo に対し:
1. clone 未作成なら作成（既存の `ensureRepoClone` を `repos/<name>` に対して実行）。
2. 作業ツリーが dirty（`git status --porcelain` が非空）なら `git stash push -u -m "loop-e2e auto-stash <ISO時刻>"`（dirty かどうかを記録）。
3. `git fetch <remote> <branch>`（shallow clone を考慮し `--depth` を尊重、必要に応じ `--depth` 付き fetch）。
4. `git checkout <branch>`。
5. `git pull --ff-only`（既定。早送り不可なら手動対応を促すメッセージ。`reset --hard <remote>/<branch>` 強制最新化は設定で選べる余地として未決）。
6. **WIP の復元**（手順2で stash した場合のみ）— 「競合回避優先・競合なければ自動」:
   - `git stash apply` を試行。
   - **競合なし（成功）** → `git stash drop`。= WIP を自動復元（auto-pop 相当）。
   - **競合あり（失敗）** → `git reset --hard HEAD` で適用を取り消し（作業ツリーを最新コードのクリーンな状態に戻す）。**stash は温存**（apply は drop しない）。ログに「WIPは stash に退避中・競合のため自動復元せず。`git stash list` / `git stash pop` で手動復元してください」と出力し、**run は最新コードで続行**（中断しない）。
7. 既に該当ブランチかつ clean の場合は 2・6 を省略し fetch+pull のみ（冪等）。
- いずれかの git 操作（fetch/checkout/pull 等）が失敗した repo はエラーを集約し run を中断（部分的に最新化された状態を明示）。**stash 復元の競合は中断理由にしない**（WIPは安全に温存され、最新コードで検証は可能なため警告のみ）。トークンはマスク。

### 3.2 setup フック
- `setup[]` を順に `sh -c` 実行（cwd=root）。1つでも失敗したら以降を実行せず run 中断。
- stdout/stderr とエラーメッセージは `maskSecrets` で全シークレットをマスク。

### 3.3 順序とスキップ
- 順序: ① repo refresh → ② setup hooks → 検証本体。
- `--skip-prepare` 指定時は ①②を実行せず検証本体のみ。

---

## 4. コンポーネント（小さく分離・全外部I/O注入可）

```
src/services/repo/refresh.ts     # refreshRepo(repo, root, runner?) : stash→checkout→pull（gitRunner注入）
src/pipeline/prepare.ts          # prepare(ctx, deps): repo refresh → setup hooks を順に実行
src/services/setup/setup.ts      # runSetupHooks(setup[], root, runner?, secrets?) : sh -c 実行（runner注入・マスク）
src/cli/commands/run.ts          # run 冒頭で prepare を呼ぶ（--skip-prepare で分岐）。injectable。
src/cli/index.ts                 # run に --skip-prepare 登録、実 git/shell runner を配線
src/config/schema.ts             # RepositorySchema.branch?、ConfigSchema.setup? を追加
```

- git/シェルは `ComposeRunner`/`GitRunner` 系の注入可能 runner を再利用し、ユニットテストはモック（実 git/shell/network なし）。
- `prepare` は run から分離し単体テスト可能にする。失敗時は明確メッセージで中断。

---

## 5. データフロー

```
loop-e2e run [--target <name>] [--skip-prepare]
  → loadConfig
  → prepare (skip-prepare でなければ):
       ① 各 repo(branchあり): ensureClone → (dirtyならstash) → fetch → checkout <branch> → pull
       ② setup[]: sh -c <command> を順次（失敗で中断）
  → collect → diff → verify → (login実走) → report
```

---

## 6. エラーハンドリング
- repo 更新の git 失敗（fetch/checkout/pull）・setup コマンドの非ゼロ終了は run を中断し、どのステップ/どの repo/どのコマンドかを明示（秘密情報マスク）。
- **WIP は失われない**: 競合なし時は自動復元（apply→drop）、競合時は復元せず stash に温存し手動復元を促す（中断はしない）。
- `pull --ff-only` が早送りできない場合は手動対応を促すメッセージ。
- すべての git/シェル出力・エラーは `maskSecrets(全シークレット)` を通す。

---

## 7. テスト戦略
- **単体**: `refreshRepo`（dirty→stash→checkout→pull の順序、clean時はstash省略、**WIP復元: apply成功→drop（自動復元）／apply競合→reset --hard＋stash温存＋警告で続行**、fetch/checkout/pull失敗時の中断、トークンマスク）、`runSetupHooks`（順次実行・失敗で中断・マスク）、`prepare`（①→②の順、--skip-prepare で未実行）。git/shell runner はモック。
- **統合**: `run` 冒頭で prepare が呼ばれ、その後に検証本体が走ることを assert（全外部I/Oモック）。`--skip-prepare` で prepare が呼ばれないこと。
- 既存テスト（312 pass + 3 skip）を壊さない。

---

## 8. 責務分離（重要）
- **loop-e2e 本体**: 準備フェーズの**汎用機構**のみ（repo refresh の git 手順、setup コマンドランナー、--skip-prepare）。
- **ユーザーのワークスペース設定**（`loop-e2e.config.yaml`）: 各 repo の `branch`、`setup` の具体コマンド（例: roomport の CORS env を development に揃える `docker exec ... sed ... && php artisan config:clear`）。
- これにより spotly 固有/環境依存ロジックは本体に持ち込まず、他プロジェクトでも汎用フックとして使える。

---

## 9. 段階的実装方針
1. **設定**: `RepositorySchema.branch?`、`ConfigSchema.setup?`、`run --skip-prepare`。
2. **repo refresh サービス**（注入可能・テスト）。
3. **setup ランナー**（注入可能・マスク・テスト）。
4. **prepare パイプライン**（①→②）＋ run 冒頭への配線。
5. **統合テスト**＋ ユーザーワークスペース（spotly）への適用例（`branch`＋CORS setup コマンド）を README/例に追記。

---

## 10. 未決事項 / 実装中に詰める
- shallow clone でのブランチ切替・pull の具体手順（`--depth` 付き fetch、`-c remote.origin.fetch` 調整など）。実装時に検証。
- `pull --ff-only` か `reset --hard origin/<branch>` か（既定は ff-only、設定で強制最新化を選べる余地）。
- setup コマンドの実行シェル（`sh -c` 既定）。
