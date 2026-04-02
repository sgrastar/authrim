---
project: Authrim
lang: ja
date: 2026-04-02
description: "マルチテナントログイン/ディスカバリー Phase 2: built-in discovery の導入"
type: architecture
tags:
  - authrim
  - internal-docs
  - architecture
  - multi-tenant
  - multi-tenant-login-discovery
  - phase-2
---
# マルチテナントログイン/ディスカバリー Phase 2

## 位置づけ

この Phase は、共通 discovery を optional feature として導入し、tenant 未確定の共通入口から tenant 固有ログインへ安全に遷移できるようにする段階である。

参照元の全体方針:

- [マルチテナントのログインとディスカバリー](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/multi-tenant-login-discovery.md)

## 目的

- built-in discovery 画面を追加する
- 複数の tenant 特定入力方式を受けられるようにする
- `selection_policy` に応じて自動選択か chooser 表示かを切り替えられるようにする
- 最終的に tenant 固有 `/login` へ遷移させる

## 背景

現行では、メールドメインから tenant を 1 件だけ解決する処理がある。

- `packages/ar-lib-core/src/services/tenant-domain-resolver.ts`

また、招待リンクは email domain routing より優先される。

- `packages/ar-auth/src/direct-auth.ts`

これを踏まえると、共通入口は認証本体ではなく discovery 画面として追加するのが自然である。

## 実装対象

- built-in discovery 画面を追加する
- メールアドレス、tenant code、tenant slug、invitation を入口として扱えるようにする
- `selection_policy` に応じて、自動選択か chooser 表示かを切り替える
- `tenant-domain-resolver` を複数候補取得に対応できる形へ拡張する
- discovery 結果として `resolved / multiple / manual_required / not_found` を返せるようにする
- tenant 確定後に tenant 固有 `/login` へリダイレクトする

## discovery の結果モデル

想定する結果種別:

- `resolved`
- `multiple`
- `manual_required`
- `not_found`

## 変更対象

- `packages/ar-login-ui/`
- `packages/ar-management/`
- `packages/ar-lib-core/src/services/tenant-domain-resolver.ts`
- 必要に応じて discovery 用 API ルート

## 非対象

- discovery 画面上での passkey 開始
- discovery 画面上での social redirect 開始
- tenant 未確定状態での email-code 発行
- 自作 SDK の提供

## 完了条件

- 共通入口から tenant を解決できる
- 1 件解決時に自動遷移できる
- 複数候補時に chooser を表示できる
- どの分岐でも最終的に tenant 固有ログインへ着地する
- 既存の tenant 固有ログインを壊さない

## 備考

この Phase の完了後も、正規モデルはあくまで tenant 固有ログインである。discovery はその前段に置かれる optional layer として扱う。
