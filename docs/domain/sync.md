# Model ⇔ Implementation Sync

> `--analyze` で発見した差異を判定・計画・実装し、モデルとコードを一致させる台帳。
> 関連: [[event-storming]] / [[discovery]]

## 差異台帳

| # | 由来phase | 種別 | 権威 | 決定 | 状態 | commit |
|---|-----------|------|------|------|------|--------|
| 1 | storming | gap | model | explore→verify を `run --explore` で配線（2パスクロール D-1） | done | 2773a1f |
| 2 | storming | naming | 収束 | `classification`→`validityClass`（語彙分離: Adjudication 専用語に予約） | done | 3f449bc |
| 3 | storming | mismatch | model | 収集系3ステージ（collect/explore/recrawl）で認証コンテキスト共有＝ログイン1回 | done | (pending) |
| 4 | storming | gap | model | grow 生成シナリオに `precondition.auth=authenticated` を既定付与（方針A・生成側） | done | (uncommitted) |
| 5 | storming | gap | model | `access-control` 検証カテゴリ新設（未認証アクセス拒否の負テスト）。precondition と分離 | pending | — |

## 差異の詳細

### #4 scenario(3c) の `precondition.auth` 契約断絶（生成側で既定付与）

- **発見**（storming --analyze）: `run` のシナリオ実行(3c)で adopted シナリオが全滅し、反証パネルが
  evidence URL=`/login` を根拠に *uncertain（テスト環境アーティファクト）* と判定。
- **コードの事実**: 上流の生成プロンプト（`prompts/propose.js`・`prompts/scenario.ts`）は
  *"already authenticated, do NOT include login steps"* と指示するのに、要求 JSON 構造に
  **`precondition` フィールドが無い** → grow 生成シナリオは `precondition.auth` を一切持たない。
  下流 `executeScenarios`(3c) は `precondition?.auth === 'authenticated'` の時のみ `ensureAuthenticated`。
  `runScenarioStage` は `createPage()` で cookie 無しの素ページを渡すため、未認証で `/dashboard` へ →
  アプリが `/login` にリダイレクト → 後続ステップが30sタイムアウト。「生成(Arrange宣言)」と「実行(認証契機)」の
  契約断絶。**収集系の共有認証(#3)からは 3c は意図的に除外**されており、自前のログイン契機も生成されない。
- **権威と判断**: model（意図＝認証付き実行が正）。コードを寄せる。
- **方針分岐（承認: A 採用）**: A=生成側で既定付与／B=schema 既定／C=run 配線で実行前ログイン。
  A を選択（grow はログイン後クロール由来なので意味的に正しく、最小・決定的。LLM 応答に依存しない）。
- **実装結果**: `services/llm/proposeScenarios.ts` に純粋関数 `applyDefaultAuthPrecondition(scenarios, loginPath)`
  を追加（`precondition` 欠落かつ非ログインのシナリオに `{auth:'authenticated'}` を付与・イミュータブル）、
  `proposeScenarios` の `normalizeIds` 後に適用。`isLoginScenario` でログインシナリオは除外（未認証開始を保持）。
  TDD: 単体4件追加（既定付与／明示 precondition 保持／ログイン除外／統合）。全 **587 緑** / tsc / eslint / build クリーン。
- **end-to-end 検証**（open-pms・既存13シナリオに precondition 注入＝修正後の生成出力を再現して run）:
  - 修正前(run2): scenario **ok 0/13**（evidence 全件 `/login` 張り付き）。
  - 修正後(run3): scenario **ok 6/13**・evidence が `/users/new`・`/reservations/new`・`/facility/room-types/new`
    等の**認証後実URL**に変化。残る7失敗は実フォーム項目差異（例: room-types/new に `input[name='basePrice']`
    が出現せずタイムアウト）等の**真の所見**で、認証リダイレクトではない。
- **モデル再整合**: [[event-storming]] 赤付箋 D-4 を解消に更新。`ExecuteScenarios → LoggedIn`(マトリクス)が
  grow シナリオでも実発火するようになり、モデルの想定とコードが一致。

### #3 収集系ステージの認証コンテキスト共有

- **発見**（storming --analyze, Codex 修正後）: `LoggedIn` はモデル上「1回・セッション再利用」だが、
  コードでは `browser.newPage()` が cookie を分離するため collect / explore / recrawl が**各々独立にログイン**。
  Codex 修正で recrawl にもログインを追加した結果、`run --explore` 内で **2FA ログインが 3〜4 回**走る状態が顕在化。
- **コードの事実**: ステージごとの独立は2種類に分かれる。
  - **本質的に独立が必要**: `login`(3b) はログイン成否の検証そのもの／`scenario`(3c) は
    authenticated↔unauthenticated を切替（cookie クリア）するため、共有セッションだと壊れる。
  - **副作用としての独立（共有可能）**: `collect`/`explore`/`recrawl` は「認証済みでページを読む/操作する」
    だけが目的で、独立は `newPage()` の実装都合に過ぎない。
- **権威と判断**: model（意図＝収集系は1回ログインで足りる）。コードを実装で寄せる。
- **方針**: `BrowserContext.newPage()` が cookie を共有する性質を使い、**遅延生成の共有認証コンテキスト**を
  1つ持ち、collect/explore/recrawl はそこから `newPage()`。ログインは初回（＝prepare 後の collect）で1回だけ
  （シナリオ対応・2FA）。collect は `skipLogin`、explore は `authenticate` を no-op 化、recrawl は `skipLogin`。
  3b/3c は無改造。スコープは `--explore` 時のみ（非 explore は後方互換）。共有ログイン失敗時は abort。
- **実装結果**: `crawler.ts`（`CrawlOpts.skipLogin`）/ `cli/index.ts`（遅延共有コンテキスト + 3ステージ配線 +
  finally で close）。テスト: crawler に skipLogin 1件追加。全 583 テスト green / tsc / eslint / build クリーン。
  Codex 修正の per-recrawl auth フックは上位互換で置換（hook 機能自体は crawler に残置・テスト済み）。
- **モデル再整合**: [[event-storming]] `LoggedIn`(#12) を「run 全体で1回ではない。収集系3ステージは共有
  コンテキストで1回／3b・3c は意図的に独立」に更新。

## 効果

- `run --explore` 内の 2FA ログイン: **3〜4 回 → 1 回**（PIN 単回性・レート制限リスクを解消）。
- 副次効果: collect が共有コンテキスト経由で **2FA 認証済みページに到達可能**に（従来は汎用フォームログインのみ）。

## 残課題（新しい赤付箋）

- 🟡 `error-handling` カテゴリの explore 連携（一過性エラーの再現）— 別 issue。
