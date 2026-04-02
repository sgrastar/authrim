---
project: Authrim
lang: ja
date: 2026-04-02
description: "マルチテナントログイン/ディスカバリー Phase 4: 将来のマルチアカウント対応余地の整理"
type: architecture
tags:
  - authrim
  - internal-docs
  - architecture
  - multi-tenant
  - multi-tenant-login-discovery
  - phase-4
---
# マルチテナントログイン/ディスカバリー Phase 4

## 位置づけ

この Phase は、現時点ではマルチアカウント機能を提供しない前提を維持しつつ、将来拡張を妨げる制約を明文化する段階である。

参照元の全体方針:

- [マルチテナントのログインとディスカバリー](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/multi-tenant-login-discovery.md)

## 目的

- 将来の multi-account / account switching / global person の余地を残す
- 今は実装しない範囲を明確にする
- DB 設計で不要な破壊的変更を避ける

## 背景

現行スキーマでは `linked_identities` が `tenant_id` を持つ一方で、`UNIQUE(provider_id, provider_user_id)` を持っている。

- `packages/setup/migrations/000_fresh_schema.sql`

また、linked identity の検索は tenant 非考慮で行われている。

- `packages/ar-bridge/src/services/linked-identity-store.ts`

これは v1 では動くが、将来 tenant ごとに別リンクを持つ設計や global person 導入時には制約になりうる。

## 実装対象

- linked identity の tenant 非依存一意制約の見直し方針を整理する
- account switching と identity linking を別機能として設計分離する
- 必要なら global person 導入時の別設計ドキュメントを作る
- 新規実装で tenant 非依存一意制約を増やさないルールを整理する

## 変更対象

- 主にドキュメント
- 必要なら migration blueprint

## 非対象

- 実際の account switcher UI
- 同時多重ログイン UI
- tenant 横断 identity 統合ロジックの本実装

## 完了条件

- 将来の migration 方針がドキュメント化されている
- `linked_identities` の現在の制約が将来課題として明示されている
- v1 実装が将来の multi-account を完全には塞がないことが確認できる

## 備考

この Phase は機能実装ではなく、将来の拡張余地を保つための設計整理フェーズとして扱う。
