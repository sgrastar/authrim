---
project: Authrim
lang: ja
date: 2026-04-02
description: "マルチテナントログイン/ディスカバリー Phase 1: 設定モデルと正規入口の固定"
type: architecture
tags:
  - authrim
  - internal-docs
  - architecture
  - multi-tenant
  - multi-tenant-login-discovery
  - phase-1
---
# マルチテナントログイン/ディスカバリー Phase 1

## 位置づけ

この Phase は、tenant 固有ログインを正規モデルとして固定し、single-tenant / multi-tenant の両方で同じ設定モデルを使えるようにするための基盤整備である。

参照元の全体方針:

- [マルチテナントのログインとディスカバリー](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/multi-tenant-login-discovery.md)

## 目的

- tenant 固有ログインを canonical な認証入口として固定する
- tenant-scoped account を正式モデルとして扱う
- `login-entry` settings category を追加し、Admin UI / Admin API から設定可能にする
- single-tenant でも `default` tenant で同じモデルを成立させる

## 背景

現行コードでは tenant は Host ヘッダーから解決される。

- `packages/ar-lib-core/src/utils/tenant-context.ts`

また settings-v2 により tenant category の追加は自然に行える。

- `packages/ar-lib-core/src/types/settings/index.ts`
- `packages/ar-management/src/routes/settings-v2/index.ts`

一方で `discovery` というカテゴリ名はすでに OIDC Discovery 用に使われている。

- `packages/ar-lib-core/src/types/settings/discovery.ts`

このため、ログイン入口設定は別カテゴリとして持つ必要がある。

## 実装対象

- tenant-scoped account を正式モデルとして明文化する
- `login-entry` settings category を追加する
- `login-entry` の meta / GET / PATCH を settings-v2 に載せる
- Admin UI の Settings 画面に `login-entry` を追加する
- single-tenant では `default` tenant の設定として扱う

## 設定モデル

カテゴリ名:

- `login-entry`

想定キー:

```ts
interface LoginEntrySettings {
  'login-entry.mode': 'tenant_only' | 'discovery_optional' | 'discovery_required';
  'login-entry.methods': string;
  'login-entry.selection_policy':
    | 'auto_if_single'
    | 'always_select'
    | 'select_if_multiple'
    | 'manual_only';
  'login-entry.allow_manual_tenant_entry': boolean;
  'login-entry.remember_last_tenant': boolean;
}
```

この Phase では設定モデルの追加までを対象とし、discovery の実 UI はまだ作らない。

## 変更対象

- `packages/ar-lib-core/src/types/settings/`
- `packages/ar-lib-core/src/types/settings/index.ts`
- `packages/ar-management/src/routes/settings-v2/index.ts`
- `packages/ar-admin-ui/src/routes/admin/settings/+page.svelte`
- `packages/ar-admin-ui/src/lib/api/admin-settings.ts`

## 非対象

- 共通 discovery 画面の新設
- chooser UI
- 複数候補返却 API
- passkey / social の遷移変更
- account switcher

## 完了条件

- `GET /api/admin/settings/meta/login-entry` が使える
- `GET /api/admin/tenants/:tenantId/settings/login-entry` が使える
- `PATCH /api/admin/tenants/:tenantId/settings/login-entry` が使える
- Admin UI から `login-entry` を編集できる
- `default` tenant で single-tenant の設定が成立する

## 備考

この Phase が終わると、後続 Phase は設定フラグに従って discovery を有効化できるようになる。
