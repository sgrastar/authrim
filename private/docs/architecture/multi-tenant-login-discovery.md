---
project: Authrim
lang: ja
date: 2026-04-02
description: "作成日: 2026-03-23 更新日: 2026-04-02"
type: architecture
tags:
  - authrim
  - internal-docs
  - architecture
  - multi-tenant
  - multi-tenant-login-discovery
---
# マルチテナントのログインとディスカバリー

> 適用範囲注記（2026-07-29）: 新規Tenant D1 control-plane環境では、
> [Tenant D1 Control Plane実装計画](../implementation/tenant-d1-control-plane/README.md)が
> `email_domain`を`email_exact`へ置き換え、email候補表示前のplatform-scoped OTPを必須にする。
> 本書は既存環境と、同計画が明示的に置き換えていないlogin-entry UXの基礎仕様として残す。

作成日: 2026-03-23
更新日: 2026-04-02

## 要約

このドキュメントは、Authrim のログイン入口、tenant discovery、tenant-scoped account の正式モデル、および将来のマルチアカウント拡張余地を、現行コードと整合する形で定義する青写真である。

現時点の基本方針は次のとおり。

- tenant ごとのログイン URL を正規の認証入口とする
- 共通ログイン画面は許可するが、役割は discovery に限定する
- 認証開始前に tenant を確定する
- tenant-scoped account を正式モデルとする
- 同じメールアドレスでも tenant が違えば別アカウントでよい
- password / passkey / social linkage は tenant ごとに別でよい
- マルチアカウント UI は現時点では実装しない
- ただし将来対応できるよう、データモデルでは破壊的変更を最小化する

この方針により、single-tenant と multi-tenant の両方を壊さずに、あとから共通 discovery や将来の account switching を追加しやすくする。

---

## 現行コードとの整合

この方針は、すでに存在する次の実装と整合する。

### 1. tenant は Host ヘッダーから解決する

`packages/ar-lib-core/src/utils/tenant-context.ts` では tenant は Host ヘッダーから解決され、`tenant_hint` のような UI 起点のヒントは信頼しない前提になっている。

このため、正規の認証開始点は tenant 固有 URL に置くのが自然である。

例:

- `https://{tenant}.{baseDomain}/login`
- tenant 固有 vanity domain

single-tenant では `default` tenant を返す実装になっているため、同じモデルをそのまま使える。

### 2. メールドメインによる tenant 解決はすでに存在する

`packages/ar-lib-core/src/services/tenant-domain-resolver.ts` には、メールアドレスのドメインから `tenant_domain_mappings` を引いて tenant を解決する処理がある。

ただし現状は最高優先度の 1 件だけを返す実装であり、複数候補 chooser はまだない。

### 3. 招待リンク優先、その後に email domain routing が入る

`packages/ar-auth/src/direct-auth.ts` では、招待リンクがある場合は招待の tenant を優先し、それがない場合に Host で `default` tenant へ解決されたときだけ、メールドメインによる tenant routing を試す流れになっている。

このため、discovery は既存フローに追加しやすい。

### 4. Login UI は tenant ごとの設定を読む

`packages/ar-management/src/login-methods.ts` は `settings:tenant:{tenantId}:login-ui` や `settings:tenant:{tenantId}:login-methods` を読み、tenant ごとの branding と login method を返している。

したがって、passkey / social / email-code を tenant 確定後に出す設計は現行コードと一致する。

### 5. settings-v2 は tenant category の追加に向いている

`packages/ar-lib-core/src/types/settings/index.ts` と `packages/ar-management/src/routes/settings-v2/index.ts` により、設定カテゴリを追加すると Admin API と Admin UI に自然に統合できる。

一方で `packages/ar-lib-core/src/types/settings/discovery.ts` にはすでに OIDC Discovery 用カテゴリ `discovery` が存在する。

そのため、ログイン入口や tenant discovery 用の新カテゴリに `discovery` という名前は使わない。

### 6. Login UI のプロキシは共通 broker ではない

`packages/ar-login-ui/src/hooks.server.ts` は `X-Forwarded-Host` を静的な API/issuer 設定から構成する。

このため、tenant 未確定のまま共通ログイン UI が各 tenant の認証をその場で代理実行する前提には向いていない。

結論として、共通画面は「認証本体」ではなく「tenant discovery」に寄せるべきである。

---

## 正規モデル

### 基本原則

正規のログイン URL は tenant ごとに分かれているものとする。

- `https://{tenant}.{baseDomain}/login`
- tenant ごとのカスタムドメイン

ビルトイン認証方式は tenant 確定後に開始する。

### なぜ tenant 確定が先か

tenant は少なくとも次に影響する。

- ユーザー検索対象
- branding
- ログインポリシー
- 有効なログイン方法
- passkey の RP ID / origin / allowed origins
- social login の provider 構成

そのため、共通画面を認証本体にせず、tenant discovery 画面として扱い、tenant 確定後に tenant 固有ログインへ遷移させる。

---

## 対応したい利用パターン

Authrim は次の利用パターンをサポートできる設計にする。

### A. 共通ディスカバリー画面

例:

- `https://login.example.com`
- メールアドレス、tenant code、tenant slug などを入力する
- tenant を自動選択する、または候補を出す
- tenant のログイン URL にリダイレクトする

### B. tenant 個別ログインのみ

例:

- `https://acme.example.com/login`
- `https://contoso.example.com/login`

これは正規モデルであり、デフォルト運用形でもある。

### C. アプリ側が tenant を知っていて直接遷移

例:

- RP アプリや管理画面が tenant を知っており、その tenant の `/authorize` や `/login` に直接飛ばす

### D. 招待リンク起点

例:

- 招待リンクに tenant 特定情報が含まれており、discovery が不要

### E. 裸ドメイン + tenant サブドメイン

例:

- `https://example.com` は discovery または primary tenant
- `https://acme.example.com` は tenant 固有ログイン

### F. vanity domain / white-label tenant login

例:

- `https://login.customer-a.com`
- `https://auth.partner-b.net`

### 解釈

Authrim は A から F をサポートできるようにする。ただし、内部モデルとしては同列に扱わない。

- `B` が正規の認証モデル
- `A` は `B` に入る前段の discovery レイヤー
- `C` と `D` は `B` への別入口
- `E` と `F` は `B` の URL / デプロイ差分

---

## single-tenant / multi-tenant の両対応

この設計は multi-tenant 専用ではない。single-tenant でも同じ概念で動作する。

### single-tenant

- tenant は常に `default`
- discovery は無効でもよい
- discovery を有効にする場合も、最終的には `default` tenant に解決される
- Admin UI / Admin API は `default` tenant の設定を編集する

### multi-tenant

- tenant は Host から解決される
- 共通 discovery は任意機能として追加できる
- 共通 discovery は tenant 固有ログインへの前段として使う

重要なのは、single-tenant と multi-tenant で別のログインモデルを持たないことである。違うのは tenant 解決の必要性だけであり、認証開始点の考え方は同じにする。

---

## tenant-scoped account を正式モデルにする

### v1 の正式モデル

まずは tenant-scoped account を正式モデルにする。

- 同じメールアドレスでも tenant が違えば別アカウントでよい
- password は tenant ごとに別でよい
- passkey は tenant ごとに別でよい
- social linkage は tenant ごとに別でよい
- 認証前に discovery で tenant を選ばせる

### これは現行 DB と整合している

次の実装はすでにこのモデルと整合している。

- `packages/ar-lib-core/src/repositories/core/user-core.ts`
  - `users_core` は `tenant_id` を持つ
- `packages/setup/migrations/pii/001_pii_initial.sql`
  - `users_pii` は `tenant_id` を持つ
  - `users_pii(tenant_id, email_blind_index)` に unique index がある

このため、同じメールアドレスを別 tenant で持つことは、既存モデル上も自然に扱える。

### passkey と social login を tenant 後に始める理由

passkey と social login は tenant 確定前に始めない。

理由:

- どの login policy を使うか tenant に依存する
- どの upstream provider を出すか tenant に依存する
- WebAuthn は tenant ごとの運用前提で UI と policy を組み立てる方が安全である

---

## マルチアカウントは現時点では実装しない

### ここで言うマルチアカウント

本ドキュメントでの「マルチアカウント」は主に次を指す。

- 同一ブラウザで複数 tenant のアカウントを切り替える
- 同一人物に見える複数 account を横断的に束ねる
- 将来的な account switcher / linked identities / global person

これらは現時点ではプロダクト機能としては提供しない。

### ただし将来対応できるように設計する

現時点では tenant-scoped account を正式モデルに固定するが、将来の拡張で破壊的変更を避けられるよう、次を原則とする。

- 新しい認証・識別子設計で tenant 非依存の一意制約を安易に増やさない
- 画面上の account switching と、DB 上の identity linking を別問題として扱う
- v1 では tenant-scoped account だけを露出し、global person は導入しない

### 既存スキーマ上の注意点

`packages/setup/migrations/000_fresh_schema.sql` の `linked_identities` は `tenant_id` を持つ一方で、`UNIQUE(provider_id, provider_user_id)` を持っている。

また `packages/ar-bridge/src/services/linked-identity-store.ts` でも、provider / provider_user_id の検索は tenant 非考慮で行われている。

これは v1 の tenant-scoped social linkage としては動くが、将来次のどちらかへ進む場合は制約になる。

- tenant ごとに同じ upstream identity を別リンクとして持ちたい場合
- tenant 横断の global person / identity linking を導入したい場合

したがって、今後 linked identity 周辺を拡張する際は、少なくとも次のどちらかの方向に寄せる前提で考える。

- `tenant_id` を含む一意制約へ寄せる
- global person を導入し、その上位で関連付ける

v1 の段階では UI 機能としてマルチアカウントを提供しないが、DB 設計ではこの将来拡張を塞がないようにする。

---

## discovery の入力方式

共通 discovery はメールアドレスだけに依存しない。

最低限、次の入力方式をサポート対象とする。

- メールアドレス
- tenant code
- tenant slug
- invitation token
- upstream application hint

### なぜメールアドレスだけでは足りないか

ユーザーは次の状態を取りうる。

- tenant ごとに別アカウントを持つ
- tenant ごとに別メールアドレスを使う
- 同じメールアドレスを複数 tenant で使う

そのため、明示的に tenant を指示できる入力方式が必要になる。

---

## tenant 選択ポリシー

tenant の決定方法は設定可能にする。

### 最低限必要なポリシー

- `auto_if_single`
  - 1 件だけ解決したら自動でリダイレクトする
- `always_select`
  - 1 件でも chooser を表示する
- `select_if_multiple`
  - 1 件なら自動、複数なら chooser を表示する
- `manual_only`
  - メールドメイン推定は使わず、tenant code や slug の入力を必須にする

### discovery method の有効化

discovery method は個別に有効化/無効化できるようにする。

- `email_domain`
- `tenant_code`
- `tenant_slug`
- `invitation`
- `app_hint`

### 追加 API の考え方

現行の `tenant-domain-resolver` は 1 件だけ返すため、候補 chooser を出すには「候補一覧を返す API」を追加する必要がある。

v1 の青写真では次の結果種別を返せれば十分である。

- `resolved`
- `multiple`
- `manual_required`
- `not_found`

---

## Admin UI / Admin API での設定モデル

### 新しい settings category を追加する

ログイン入口と discovery 用の設定は、settings-v2 に新カテゴリとして追加する。

カテゴリ名の候補:

- `login-entry`

`discovery` という名前はすでに OIDC Discovery document 用カテゴリで使われているため、再利用しない。

### スコープ

v1 では `login-entry` を tenant settings category として扱う。

理由:

- 現行の settings-v2 は tenant category の GET/PATCH が整っている
- Admin UI も tenant settings の編集導線がある
- single-tenant では `default` tenant の設定としてそのまま使える

### built-in discovery 画面の設定解決

built-in の共通 discovery 画面では、設定を次の優先順位で読む。

1. tenant がすでに確定している場合は、その tenant の `login-entry`
2. tenant 未確定の共通入口では `default` tenant の `login-entry`

これにより、single-tenant と multi-tenant で別実装を作らずに済む。

### Admin API

既存の settings-v2 ルートに従う。

- `GET /api/admin/tenants/:tenantId/settings/login-entry`
- `PATCH /api/admin/tenants/:tenantId/settings/login-entry`
- `GET /api/admin/settings/meta/login-entry`

### Admin UI

既存の Settings 画面にカテゴリを追加して編集可能にする。

最低限必要な反映箇所:

- `packages/ar-lib-core/src/types/settings/index.ts`
- `packages/ar-admin-ui/src/routes/admin/settings/+page.svelte`
- `packages/ar-admin-ui/src/lib/api/admin-settings.ts`

generic な settings editor で十分始められるため、v1 では専用画面を必須にしない。

### 設定イメージ

```ts
interface LoginEntrySettings {
  'login-entry.mode': 'tenant_only' | 'discovery_optional' | 'discovery_required';
  'login-entry.discovery_methods': string;
  'login-entry.selection_policy':
    | 'auto_if_single'
    | 'always_select'
    | 'select_if_multiple'
    | 'manual_only';
  'login-entry.allow_manual_tenant_entry': boolean;
  'login-entry.remember_last_tenant': boolean;
}
```

`login-entry.discovery_methods` の値は JSON string で settings-v2 に載せる。

---

## Login UI の振る舞い

### ビルトイン Login UI

ビルトイン Login UI は次をサポートする。

- tenant 固有ログインルート
- 任意の共通 discovery 画面
- discovery から tenant ログインへのリダイレクト
- tenant 確定後の branding と login methods の表示

### 重要なルール

共通 discovery 画面では次を開始しない。

- passkey 認証
- social login redirect
- tenant 固有の email-code 発行

これらは tenant が決まってから始める。

---

## Phase 別実装ドキュメント

Phase ごとの実装内容は個別ファイルに分離する。

- [Phase 1: 設定モデルと正規入口の固定](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/multi-tenant-login-discovery-phase-1.md)
- [Phase 2: built-in discovery の導入](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/multi-tenant-login-discovery-phase-2.md)
- [Phase 3: discovery の運用強化](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/multi-tenant-login-discovery-phase-3.md)
- [Phase 4: 将来のマルチアカウント対応余地の整理](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/multi-tenant-login-discovery-phase-4.md)

メインのこの文書は全体方針と横断ルールを保持し、各 Phase の目的、対象、非対象、完了条件は上記個別ドキュメントで管理する。

---

## 現時点の決定事項

現時点では次を採用する。

- A から F の利用パターンをサポートできる設計にする
- tenant 固有ログインを正規の認証モデルとする
- 共通 discovery は任意機能で、後付け可能にする
- single-tenant と multi-tenant で同じログインモデルを使う
- tenant-scoped account を正式モデルとする
- 同じメールアドレスでも tenant が違えば別アカウントでよい
- password / passkey / social linkage も tenant ごとに別でよい
- discovery で tenant を先に選ばせる
- マルチアカウント機能は現時点では提供しない
- ただし将来対応できるよう、DB 設計では破壊的変更を避ける前提で進める
- 設定は Admin UI と Admin API から変更できるようにする
- 新しい設定カテゴリ名は `discovery` ではなく `login-entry` を使う

---

## 関連ドキュメント

- `private/docs/architecture/multi-tenancy.md`
- `private/docs/sdk/web-sdk-guide.md`
- `private/docs/login-ui-sdk-replacement-gap-analysis-2026-03-17.md`
- `private/docs/login-ui-sdk-replacement-coverage-matrix-2026-03-17.md`
