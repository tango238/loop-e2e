# Model ⇔ Implementation Sync

> `--analyze` で発見した差異を判定・計画・実装し、モデルとコードを一致させる台帳。
> 関連: [[event-storming]] / [[discovery]]

## 差異台帳

| # | 由来phase | 種別 | 権威 | 決定 | 状態 | commit |
|---|-----------|------|------|------|------|--------|
| 1 | storming | gap | model | explore→verify を `run --explore` で配線（2パスクロール D-1） | done | 2773a1f |
| 2 | storming | naming | 収束 | `classification`→`validityClass`（語彙分離: Adjudication 専用語に予約） | done | 3f449bc |
| 3 | storming | mismatch | model | 収集系3ステージ（collect/explore/recrawl）で認証コンテキスト共有＝ログイン1回 | done | (pending) |

## 差異の詳細

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
