---
project: Authrim
lang: ja
date: 2026-04-02
description: "マルチテナントログイン/ディスカバリー Phase 3: discovery の運用強化"
type: architecture
tags:
  - authrim
  - internal-docs
  - architecture
  - multi-tenant
  - multi-tenant-login-discovery
  - phase-3
---
# マルチテナントログイン/ディスカバリー Phase 3

## 位置づけ

この Phase は、Phase 2 で導入した discovery を実運用向けに強化し、tenant 入口のバリエーションと UX を改善する段階である。

参照元の全体方針:

- [マルチテナントのログインとディスカバリー](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/multi-tenant-login-discovery.md)

## 目的

- discovery の入口を増やす
- 運用しやすい tenant 選択 UX にする
- built-in Login UI と discovery の責務分離を明確にする

## 実装対象

- `app_hint` の導入
- `rememberLastTenant` の導入
- manual tenant entry の UX 改善
- 裸ドメイン、tenant サブドメイン、vanity domain の共存整理
- built-in Login UI の遷移設計を discovery 前提で整理する

## 変更対象

- `packages/ar-login-ui/`
- `packages/ar-management/`
- 必要に応じて routing / proxy 周辺

## 非対象

- account switcher
- global person
- tenant 横断 session の共有

## 完了条件

- app 起点の tenant 指定を discovery に取り込める
- last tenant の再利用が設定で制御できる
- single-tenant と multi-tenant の両方で破綻しない
- built-in Login UI と discovery の責務分離が明確になる

## 備考

`packages/ar-login-ui/src/hooks.server.ts` は共通 broker ではないため、この Phase でも「tenant 未確定のまま各 tenant の認証を代理実行する」方向には寄せない。
