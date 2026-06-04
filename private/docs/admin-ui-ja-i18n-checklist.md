---
project: Authrim
lang: ja
date: 2026-06-03
description: "Admin UIに日本語対応を追加し、多言語対応の土台を整えるためのチェックリストと実装タスク。"
type: checklist
tags:
  - authrim
  - internal-docs
  - admin-ui
  - i18n
  - localization
  - japanese
  - gakunin
---
# Admin UI 日本語化・多言語基盤チェックリスト

## 目的

来週のNII/学認イベントに向けて、Admin UIを英語だけでなく日本語でも使える状態にする。
同時に、将来 `zh-CN`、`ko`、`es`、`de` などを追加できる多言語基盤を整える。

この作業は単純な翻訳差し替えではなく、以下を含む。

- Admin UIの表示文言を辞書管理に寄せる
- 言語選択、Cookie、`html lang`、fallbackの挙動を明確にする
- 同意文、OIDC/SAML/SCIMなどのプロトコル用語を日本語UIで破綻させない
- 日本語表示でレイアウトが壊れないことを確認する
- 将来のQA用疑似ロケールやドイツ語長文テストを入れやすくする

## 現状メモ

確認日: 2026-06-03

- `packages/ar-admin-ui` は `typesafe-i18n` を導入済み。
- `packages/ar-admin-ui/src/i18n/en/index.ts` と `packages/ar-admin-ui/src/i18n/ja/index.ts` は存在する。
- 生成済みの `Locales` は `en | ja`。
- `LanguageSwitcher.svelte` は `en` / `ja` 固定。
- `/api/set-language` は `en` / `ja` のみ許可し、`preferredLanguage` Cookieに保存する。
- `+layout.svelte` はCookieから `preferredLanguage` を受け取り、`en` / `ja` の場合だけ `setLocale` している。
- 実際に `$LL` を使っているAdmin UI側の箇所はまだ少ない。確認できた主な使用箇所は `LanguageSwitcher.svelte` と `TestDialog.svelte`。
- Admin配下のSvelte画面は約105ファイル、共通コンポーネントは約61ファイルあり、直書き英語が多い前提で進める。

## スコープ

### 対象

- `packages/ar-admin-ui/src/routes/admin/**`
- `packages/ar-admin-ui/src/lib/components/**`
- `packages/ar-admin-ui/src/lib/components/admin/**`
- `packages/ar-admin-ui/src/i18n/**`
- `packages/ar-admin-ui/src/routes/api/set-language/+server.ts`
- `packages/ar-admin-ui/src/routes/+layout.svelte`
- `packages/ar-admin-ui/src/routes/+layout.server.ts`
- Admin UIで表示するエラー、空状態、確認ダイアログ、ボタン、タブ、ナビゲーション

### 対象外

- Login UI本体の多言語拡張
- setupツールの追加翻訳
- `zh-CN`、`ko`、`de` などの正式対応
- テナントやクライアントが登録する任意文字列の翻訳
- APIレスポンスに含まれる機械可読なコード、ID、scope、claim、endpoint、URLの翻訳

## 方針

### 1. 正式対応言語

最初の正式対応は `en` / `ja` のみ。

理由:

- NII/学認イベントで日本語化の価値が明確。
- OktaもAdmin Consoleは英語・日本語中心であり、Admin UIはログインUIほど多言語を広げる必要が薄い。
- 翻訳品質、サポート、スクリーンショット確認を現実的な範囲に抑えられる。

### 2. キー設計

当面は既存のflat key形式を維持する。

例:

```typescript
admin_nav_end_users: 'End Users'
admin_nav_user_sessions: 'User Sessions'
admin_clients_title: 'Client Management'
admin_clients_register_client: 'Register Client'
admin_saml_metadata_url: 'Metadata URL'
```

理由:

- 既存辞書と `typesafe-i18n` 生成物を壊さずに進められる。
- 大量移行時にSvelte側の差分を小さくできる。
- 将来、辞書が肥大化した時点でnamespace分割を検討できる。

### 3. 翻訳しないもの

以下は原則そのまま表示する。

- `client_id`, `redirect_uri`, `grant_type`, `response_type`, `scope`, `claims`
- `openid`, `profile`, `email`, `offline_access`
- `SAML`, `OIDC`, `OAuth 2.0`, `SCIM`, `JWT`, `JWK`, `JWKS`, `PKCE`, `CIBA`
- API path、Worker名、D1/KV/R2/Queue名、tenant ID、client ID
- 監査ログのevent typeやmachine-readable code

ただし、説明文では日本語の補足を付けてよい。

例:

- `redirect_uri` -> `redirect_uri（リダイレクトURI）`
- `offline_access` -> `offline_access（長期アクセス）`

### 4. 日本語の文体

- 管理画面では短い名詞句を優先する。
- ボタンは「保存」「削除」「作成」「追加」「有効化」「無効化」を基本にする。
- 破壊的操作は「削除する」「無効化する」のように動詞で明確にする。
- 「あなた」はログイン/同意画面以外ではできるだけ避ける。
- 「設定してください」より「設定」を優先する。
- 「ログ」「監査ログ」「運用ログ」は用途別に訳し分ける。

## 用語集

| English | Japanese | 備考 |
|---|---|---|
| Dashboard | ダッシュボード | 固定 |
| End Users | エンドユーザー | 管理者と区別 |
| Admin Users | 管理者ユーザー | End Usersと混同しない |
| Client | クライアント | OAuth/OIDC client |
| Session | セッション | 固定 |
| Audit Log | 監査ログ | User/Adminで必要なら接頭辞を付ける |
| Operational Logs | 運用ログ | システム運用向け |
| External IdP | 外部IdP | Identity ProviderはIdP表記 |
| Consent | 同意 | 文脈により「同意設定」 |
| Consent Statement | 同意文 | ユーザーに提示する文面 |
| Claim | クレーム | JWT/OIDC用語 |
| Scope | スコープ | OAuth/OIDC用語 |
| Tenant | テナント | 固定 |
| Organization | 組織 | Tenantとは分ける |
| Role | ロール | 固定 |
| Policy | ポリシー | 固定 |
| Attribute | 属性 | ABAC文脈 |
| Identity Mapping | IDマッピング | 「アイデンティティマッピング」より短くする |
| Signing Key | 署名鍵 | 固定 |
| Passkey | パスキー | UIではカタカナ |
| Webhook | Webhook | 固有技術名として維持 |
| SAML metadata | SAMLメタデータ / メタデータ | ラベルではメタデータ、文脈が必要な時はSAMLメタデータ |
| Metadata URL | メタデータURL | SAML文脈でも日本語化 |
| entityID | entityID | SAML属性名として原語維持。`Entity ID` にはしない |
| NameID | NameID | 原語維持 |
| NameID Format | NameID形式 | Formatだけ日本語化 |
| ACS URL | ACS URL | 原語維持 |
| Scope | スコープ | UI説明では日本語化し、実際のscope値は原文保持 |

## 優先度

| 優先度 | 意味 |
|---|---|
| P0 | NII/学認イベント前に完了したい。日本語で見られやすい導線、ナビ、SAML/OIDC/同意まわり |
| P1 | イベント後すぐに進める。主要管理機能の日本語化と基盤の完成度向上 |
| P2 | 多言語QA、疑似ロケール、将来言語追加のための整備 |

## 実装タスク

### P0: i18n基盤

- [x] `packages/ar-admin-ui/src/i18n/en/index.ts` の既存キーを棚卸しし、Admin UI専用キーとLogin由来キーを区別する。
- [x] `packages/ar-admin-ui/src/i18n/ja/index.ts` が `en` と同じキーを持つことを確認する。
- [x] `packages/ar-admin-ui/src/i18n/{en,ja}/index.ts` をカテゴリ別モジュールに分割し、`index.ts` はmerge/exportだけにする。
- [x] `pnpm --filter @authrim/ar-admin-ui typesafe-i18n` で生成物が更新できることを確認する。
- [x] `LanguageSwitcher.svelte` の表示、aria-label、エラー処理を日本語化対象にする。
- [x] `set-language` APIの許可言語を共通定数化するか、少なくともUIとAPIで重複した `['en', 'ja']` を追跡しやすくする。
- [x] `+layout.svelte` で `html lang` が現在localeに同期されることを確認する。
- [x] Cookieに不正localeが入っていた場合は `en` にfallbackする。
- [x] 翻訳キー不足をtypecheckで検出できる運用にする。

### P0: Adminシェルとナビゲーション

- [x] `/admin/+layout.svelte` のサイドナビを辞書化する。
- [x] パンくず、現在ページ名、セクション見出しを辞書化する。
- [x] `AdminHeader.svelte` のタイトル、テナント表示、ログアウト、テーマ/通知まわりの文言を辞書化する。
- [x] `FloatingNav.svelte`、`NavItem.svelte`、`NavItemGroup.svelte`、`NavGroupLabel.svelte` の表示文字列とaria-labelを確認する。
- [x] モバイルナビで日本語ラベルが折り返してもレイアウトが壊れないことを確認する。

### P0: イベントで見られやすい画面

- [x] `/admin` ダッシュボード
- [x] `/admin/login`
- [x] `/admin/users`
- [x] `/admin/users/new`
- [x] `/admin/users/[id]`
- [x] `/admin/clients`
- [x] `/admin/clients/new`
- [x] `/admin/clients/[id]`
- [x] `/admin/external-idp`
- [x] `/admin/external-idp/new`
- [x] `/admin/external-idp/[id]`
- [x] `/admin/saml`
- [x] `/admin/saml/local`
- [x] `/admin/saml/new`
- [x] `/admin/saml/[id]`
- [x] `/admin/consents`
- [x] `/admin/consent-statements`
- [x] `/admin/login-methods`
- [x] `/admin/login-ui`
- [x] `/admin/settings`
- [x] `/admin/settings/signing-keys`
- [x] `/admin/info`

### P0: 共通UI

- [x] `Button.svelte` のloading/aria文言を確認する。
- [x] `Input.svelte` のlabel、placeholder、error、help textの扱いを確認する。
- [x] `Alert.svelte` のtype表示や閉じるボタンを辞書化する。
- [x] `Dialog.svelte`、`Modal.svelte` の閉じる、キャンセル、確認、削除確認を辞書化する。
- [x] `SearchBox.svelte` のplaceholderを辞書化する。
- [x] `StatusBadge.svelte` のstatus名を辞書化する。
- [x] `ToggleSwitch.svelte` のon/offラベルとaria-labelを確認する。
- [x] `Spinner.svelte` の読み込みテキストを辞書化する。
- [x] 空状態、エラー状態、読み込み状態を共通キー化する。

### P0: 同意・学認文脈

- [x] Consent管理画面で「同意」「同意文」「スコープ」「クライアント」「有効/無効」が自然に見えることを確認する。
- [x] `consent_statement` などテナントが管理する文面はUIラベルとデータ本文を分けて扱う。
- [x] 学認・SAML文脈で使う属性名、NameID、metadata、entityID、ACS URLの訳し方を統一する。
- [x] スコープ説明は辞書化しつつ、実際のscope値は原文を保持する。

### 進捗メモ

- 2026-06-03: `/admin/saml` 一覧画面のタイトル、説明、ボタン、loading/error/empty state、テーブル見出し、status、metadata状態、federation trust profilesの表示を辞書化した。`/admin/saml/local`、`/admin/saml/new`、`/admin/saml/[id]` は未着手。
- 2026-06-03: `/admin/saml/local` のSAML Entity Info画面を辞書化した。endpoint、entityID、metadata、証明書、interactive login redirect、metadata publication、signing rolloverのUI文言を日本語対応した。
- 2026-06-03: `/admin/dr-backup` のDRバックアップ保存先とSAML Signing DR BundleのUI文言、成功/失敗メッセージを辞書化した。
- 2026-06-03: `/admin/saml/[id]` のSAML provider詳細編集画面を辞書化した。基本情報、証明書検証、IdP/SP policy、signing rollover、保存/削除メッセージを日本語対応した。
- 2026-06-03: `src/i18n/en` と `src/i18n/ja` の辞書を `core`、`auth`、`admin-shell`、`admin-dashboard`、`admin-users`、`admin-clients`、`admin-saml`、`admin-dr-backup`、`admin-other` に分割した。`index.ts` は各モジュールをmergeしてexportするだけにした。
- 2026-06-03: `/admin/saml/new` のSAML provider/federation作成画面を辞書化した。metadata import、aggregate import、trust profile作成/編集、証明書preview、IdP/SP policy、保存状態メッセージを日本語対応した。
- 2026-06-03: `/admin/clients/new` のOAuth client作成画面を辞書化した。preset選択、redirect URI、applied settings、advanced settings、OIDC claims/ASC、downstream grant、作成成功/secret/CORS origin statusを日本語対応した。
- 2026-06-03: `/admin/clients/[id]` の辞書化に着手した。共通エラー、header、tab label、General tab（usage/basic info/OAuth settings/scopes/redirect URI/timestamps/danger zone）とTokens tabを日本語対応した。Security/Scopes/Claims/Session/Metadata/Advanced tabは継続作業。
- 2026-06-04: `/admin/clients/[id]` の残りタブを辞書化した。Security、Scopes & Permissions、Claims & ASC、Session & Logout、Client Metadata、Advanced、delete modal、client secret regenerate modalを日本語対応した。`prettier`、`typesafe-i18n`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。
- 2026-06-04: `/admin/users/[id]` のユーザー詳細画面を辞書化した。overview、roles、consents、actions、role assignment modal、remove role modal、consent history modal、withdraw consent modal、session revoke/suspend/lock/activate/delete confirmationを日本語対応した。`prettier`、`typesafe-i18n`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。
- 2026-06-04: `/admin/external-idp` の外部IdP一覧画面を辞書化した。一覧タイトル、説明、empty state、provider table、status、delete confirmation modalを日本語対応し、`admin-external-idp` 辞書モジュールを追加した。`prettier`、`typesafe-i18n`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。
- 2026-06-04: `/admin/external-idp/new` と `/admin/external-idp/[id]` の外部IdP作成/編集画面を辞書化した。template selection、basic information、redirect URL、OIDC discovery、OAuth/OIDC configuration、behavior settings、UI customization、SSO toggle、保存/作成状態、validation/error文言を日本語対応した。`prettier`、`typesafe-i18n`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。
- 2026-06-04: `/admin/consents` と `/admin/consent-statements` を辞書化した。`/admin/consents` は設定メタデータ由来のlabel/description/enum値をデータとして残し、ページ見出し、セクション、状態、保存/競合/権限メッセージを日本語対応した。`/admin/consent-statements` は同意文本文と管理UIラベルを分け、項目、バージョン、多言語コンテンツ、要件のCRUD UI、確認文、成功/失敗メッセージを日本語対応した。`prettier`、`typesafe-i18n`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。
- 2026-06-04: `/admin/login-methods` と `/admin/login-ui` を辞書化した。`/admin/login-methods` は外部ログインプロバイダの一覧、追加/編集フォーム、保存状態、validation文言、操作titleを日本語対応した。`/admin/login-ui` は設定メタデータ由来のlabel/description/enum値をデータとして残し、ページ見出し、スコープバッジ、Global UI Configuration、Trusted Origins、保存/競合/権限メッセージ、Coming Soon説明を日本語対応した。`prettier`、`typesafe-i18n`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。
- 2026-06-04: `/admin/settings`、`/admin/settings/signing-keys`、`/admin/info` を辞書化した。`/admin/settings` はページ見出し、特別設定カード、読み込み/エラー状態、設定件数を日本語対応し、設定API由来のcategory label/descriptionはデータとして残した。`/admin/settings/signing-keys` は署名鍵の状態、ローテーションカード、履歴、確認モーダル、警告、理由入力を日本語対応した。`/admin/info` はセクション見出し、ラベル、状態値、コピーtitleを日本語対応し、endpoint値やOIDC/SAML/SCIMなどのプロトコル識別子は原文を保持した。`prettier`、`typesafe-i18n`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。
- 2026-06-04: P0共通UIの固定文言を辞書化した。`Alert`、`Modal`、`Dialog`、`SearchBox`、`StatusBadge`、`ToggleSwitch`、`Spinner`、`DangerConfirmationModal` のデフォルト文言/aria-label/読み上げ文言を日本語対応し、`Button` はloading時の `aria-busy` とspinnerの `aria-hidden` を補強した。`Input` はlabel/placeholder/error/help textを呼び出し側から受け取る構造のため、共通コンポーネント本体に固定文言がないことを確認した。空状態/エラー状態の横断的な共通キー化はページ単位の文脈差が大きいため継続タスクとして残した。`prettier`、`typesafe-i18n`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。
- 2026-06-04: P0残タスクを整理した。共通の空状態/エラー状態/再試行キーを追加し、SAML/学認用語を `メタデータ`、`entityID`、`NameID形式`、`ACS URL` に統一した。SAML作成/編集画面の `SSO URL`、`ACS URL`、`SLO URL` ラベルも辞書化した。scope説明は「スコープ」に寄せ、実際のscope値は翻訳しない方針を維持した。`preferredLanguage` CookieはSSR初期描画にも反映されるようにし、`html lang` もserver hookで同期した。認証後ナビの実ブラウザ確認はローカルBFF/API proxy未設定で未実施だが、ナビCSSは日本語ラベルをnowrap/ellipsisで収める構造であることを確認し、FloatingNavのaria-labelも辞書化した。`prettier`、`typesafe-i18n`、`typecheck`、`lint`、`test`、`build` を実行し、`typecheck` は0 errors/0 warnings、`test` は140 tests passed、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。
- 2026-06-04: 認証skipを入れずにAdmin UIを手動確認するため、`tools/admin-ui-session` に短命Admin UI session発行ツールを追加した。生成環境の `DB_ADMIN` に一時 `admin_users`、`admin_role_assignments`、`admin_sessions` を作り、`authrim_admin_session` Cookie値とcleanupコマンドを出力する。作成後はverification SELECTで3テーブルの行を確認し、失敗時はbest-effort cleanupする。`test` 環境のremote D1で発行、verification、cleanupを実行し、cleanup後にtool prefixの一時行が0件であることを確認した。
- 2026-06-04: `/admin/account-settings` のLanguage & Regionを実際の言語設定に接続した。`SUPPORTED_LOCALES` 由来の `en` / `ja` を表示し、変更時に `/api/set-language` で `preferredLanguage` Cookieを保存してreloadする。保存失敗時は元の選択値に戻し、エラーメッセージを表示する。`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。
- 2026-06-04: `/admin/account-settings` のページ全体を辞書化した。見出し、PassKey一覧/編集/削除、PassKey登録モーダル、テーマ設定、言語設定、アカウント/logout、日付/相対時刻、WebAuthn/PassKeyエラー文言を日本語対応した。`admin-account` 辞書モジュールを追加し、テーマ色名もlocaleに応じて表示する。`prettier`、`typesafe-i18n`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。
- 2026-06-04: P1 Identity Mappingの多言語対応に着手した。`admin-identity-mapping` 辞書モジュールを追加し、`/admin/identity-mapping`、`/admin/identity-mapping/overview`、`/admin/identity-mapping/profiles`、`/admin/identity-mapping/mapping-policies`、`/admin/identity-mapping/resolution-center`、`/admin/identity-mapping/schema-readiness`、`/admin/identity-mapping/federation-trust` を辞書化した。`IdentityMappingPageShell.svelte` はpolicy version操作、profile selector、policy name、control-plane statusを日本語対応した。`IdentityMappingFlowEditor.svelte` はtoolbar、view mode、empty state、lane label、edge/node aria-label、node info overlay、Inspectorの主要ラベル、未保存確認、auto-map結果メッセージを辞書化した。`/admin/identity-mapping/profiles/edit`、FlowEditor内のtransform操作説明・rule/diffサンプル本文・詳細profile editorフォームは継続作業。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build`、Identity Mapping UI smoke/flow-data/auto-map targeted testを実行し、`typecheck` は0 errors/0 warnings、targeted testは19 tests passed、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。
- 2026-06-04: P1 Identity Mappingの残りを進め、`/admin/identity-mapping/profiles/edit` のsource/destination profile editorを辞書化した。CSV parser、manual columns、destination template browser、OIDC/CSV/SAML destination profile、release consent、attribute registry、template preview modal、保存/レビュー/有効化/削除/コピー/CSV解析/registry保存メッセージを日本語対応した。`IdentityMappingFlowEditor.svelte` はtransform operation/parameter説明、node multiplicity/nullability、policy復元時のrule detail、compile draft状態、fallback rule/dry-run/diff本文を辞書化した。`/admin/identity-mapping/edit` は既存の辞書キー接続を確認した。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、Identity Mapping UI smoke/flow-data/auto-map targeted test、`build` を実行し、`typecheck` は0 errors/0 warnings、targeted testは19 tests passed、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1のうち `/admin/scale` を先行して辞書化した。`admin-scale` 辞書モジュールを追加し、ページ見出し、current badge、読み込み/保存/失敗メッセージ、system scale説明、region distribution説明、advanced settings、estimation model、client-based coefficient、diff confirmation modal、WorldMap凡例/aria fallbackを日本語対応した。上部の `Auth`、`Token`、`Session`、`Challenge`、`Revoke`、`AuthCode`、`RefreshToken`、`PAR`、`CIBA`、`DPoP`、`LPS/RPS`、リージョンコード/都市名はプロトコル・リソース・データ表記として原文保持した。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1主要管理画面の `/admin/sessions` を辞書化した。`admin-sessions` 辞書モジュールを追加し、ページ見出し、filter、session table、status badge、device/browser/OS表示、relative time、pagination、empty/error/loading state、revoke confirmation modal、revoke成功/失敗メッセージを日本語対応した。ユーザーID、IP、session ID、user agent解析後のブラウザ/OS名は識別子・データ表記として原文保持した。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1主要管理画面の `/admin/audit-logs` と `/admin/audit-logs/[id]` を辞書化した。`admin-audit-logs` 辞書モジュールを追加し、一覧のページ見出し、filter、action dropdown、table、pagination、empty/error/loading state、詳細の戻るリンク、basic/actor/resource/metadata sections、user agent表示、既知のaudit action labelを日本語対応した。未知のaction、resource type/id、entry ID、user ID、IP、user agent本文、metadata JSONは監査データとして原文保持する。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1主要管理画面の `/admin/organizations` を辞書化した。`admin-organizations` 辞書モジュールを追加し、hierarchy tab、search/expand/collapse、summary、empty/loading/error state、domain mappings tab、mapping table、作成/検証/削除モーダル、membership/status/verification表示、`OrganizationTree.svelte` のaria-label/Inactive/Members titleを日本語対応した。組織名、組織ID、domain hash、DNS TXT record値、resource由来のエラー本文はデータとして原文保持する。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1主要管理画面の `/admin/roles`、`/admin/roles/new`、`/admin/roles/[id]`、`/admin/roles/[id]/edit` を辞書化した。`admin-roles` 辞書モジュールと `roles-i18n` helperを追加し、roles list、RBAC info banner、filter、delete modal、create/edit role form、role detail、assigned users、permission category/permission label/permission description、role type/scope表示、`RoleAssignmentRules.svelte` のlist/create/test/delete dialogを日本語対応した。ロール名、ロールID、permission ID、rule condition、claims JSON、action payloadはデータとして原文保持する。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1主要管理画面の `/admin/access-control` を辞書化した。`admin-access-control` 辞書モジュールを追加し、End User Access Control banner、hub title/description、loading/error state、RBAC/ABAC/ReBAC/Policies cardのsubtitle/description/stat、Related Toolsのリンク文言を日本語対応した。RBAC、ABAC、ReBAC、Policy、Admin Access Control Hub、Access Traceなどの機能名・略称は製品用語として原文保持した。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1主要管理画面の `/admin/access-trace` を辞書化した。`admin-access-trace` 辞書モジュールを追加し、ページ見出し、stats、timeline、period tabs、filters、access decisions table、pagination、top denied panels、detail modalを日本語対応した。API helperが返すdecision/resolved_via/periodの英語ラベルはページ側のlocale helperへ置き換えた。subject ID、permission文字列、resolved_viaの未知値、reason、API key ID、client ID、parsed permission JSONはデータとして原文保持する。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1主要管理画面の `/admin/attributes` を辞書化した。`admin-attributes` 辞書モジュールを追加し、End User ABAC banner、ABAC Engine toggle、stats、source distribution、filters、attributes table、pagination、create/delete/cleanup modal、source type表示、expiration status表示を日本語対応した。User ID、attribute name/value、user email、VC/SAMLなどの識別子・プロトコル用語、APIレスポンス由来のエラー本文はデータとして原文保持する。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1主要管理画面の `/admin/policies` を辞書化した。`admin-policies` 辞書モジュールを追加し、Policy Rules一覧、Custom Policy Rules toggle、filters、policy card、pagination、create/edit/delete modal、condition builder、policy simulator、condition type/category/param label、condition summary表示を日本語対応した。Policy名/説明、resource/action値、condition params、simulation resultのreason/decided_byなどAPI・ユーザー入力由来の値はデータとして原文保持する。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1主要管理画面の `/admin/rebac` hubを辞書化した。`admin-rebac` 辞書モジュールを追加し、End User ReBAC banner、ReBAC Engine toggle、management cards、object types summary、permission check tool、permission check result labelを日本語対応した。Object type名、resolved_via、path、relationship tuple由来の値はデータとして原文保持する。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1主要管理画面の `/admin/rebac/tuples`、`/admin/rebac/definitions`、`/admin/rebac/definitions/[id]` を辞書化した。`admin-rebac` 辞書モジュールを拡張し、relationship tuples一覧/filters/create/delete modal、relation definitions一覧/filters/create/delete modal、definition detail/edit/expression JSON/test panel/referenceを日本語対応した。tuple値、object type、relation name、expression DSL、JSON本文、resolved_via/pathはデータとして原文保持する。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1主要管理画面の `/admin/scim-tokens` を辞書化した。`admin-scim-tokens` 辞書モジュールを追加し、SCIM Tokens一覧、empty/loading/error state、create token modal、token created success modal、copy button、revoke confirmation modalを日本語対応した。token値、token hash、descriptionなどAPI・ユーザー入力由来の値はデータとして原文保持する。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1主要管理画面の `/admin/custom-claims` と `/admin/custom-claims/[id]` を辞書化した。`admin-custom-claims` 辞書モジュールを追加し、schema一覧、stats、filters、group header、pagination、preset適用modal、schema作成modal、rename/delete modal、schema詳細のidentity/token/validation/advanced/registration/danger/sidebarを日本語対応した。field key、display label、description、claim namespace、required scopes、operation detail、created_by、preset label/descriptionなどAPI・ユーザー入力由来の値はデータとして原文保持する。API helperのfield type/status英語label依存をページ側locale helperへ置き換えた。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1主要管理画面の `/admin/email-settings` を辞書化した。`admin-email-settings` 辞書モジュールを追加し、ページ見出し、保存/読み込み/失敗/成功メッセージ、summary、provider priority、empty state、provider settings link、move up/down buttonを日本語対応した。provider名、provider説明、provider ID、config source、default From addressはAPI・設定データとして原文保持する。
- 2026-06-04: P1主要管理画面の `/admin/tenant-discovery` を辞書化した。`admin-tenant-discovery` 辞書モジュールを追加し、single-tenant state、Common Entry Login Behavior、Tenant Entry Override、Common Entry Screen Content、Tenant Override Screen Content、entry mode/email resolution/selection policyの説明、discovery method toggles、screen content form labels、validation/save/load/conflict messagesを日本語対応した。tenant名、discover URL、brand/logo/page title/kicker/title/subtitleなど設定値、theme/variantの保存値、`/login`・`/discover` などroute値はデータ・識別子として原文保持する。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1主要管理画面の `/admin/webhooks` と `/admin/webhooks/[id]/deliveries` を辞書化した。`admin-webhooks` 辞書モジュールを追加し、webhook一覧、create/test/delete modal、event pattern tooltip、active toggle、delivery history filters/table/detail modal、payload copy/replay/load moreを日本語対応した。webhook名、URL、event type/id、scope、payload、response/error本文などAPI・ユーザー入力由来の値はデータとして原文保持する。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成後watcherをSIGTERMで停止した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 Platform/Admin管理画面の `/admin/tenants`、`/admin/tenants/new`、`/admin/tenants/[id]`、`/admin/tenants/[id]/invitations` を辞書化した。`admin-tenants` 辞書モジュールを追加し、tenant一覧、single-tenant notice、D1 slot summary、新規作成validation/provisioning step、tenant detail/edit/lifecycle/default設定、provisioning cleanup/retry、vanity domain作成/同期/primary/verify/delete、login entry summary、danger zone、invitation一覧/create/result/cancelを日本語対応した。tenant ID/code/name/description、hostname、domain status、validation records、role/org ID、invite URL、API由来のエラー本文はデータとして原文保持する。`typesafe-i18n`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`typesafe-i18n` は生成完了後watcher停止の外部承認が使用量制限で拒否され、stdinも閉じていたためwatcherが残っている。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 Platform/Admin管理画面の `/admin/admins` と `/admin/admins/[id]` を辞書化した。`admin-admins` 辞書モジュールを追加し、admin user一覧/search/status/MFA filters/pagination/create modal、detailのbasic/login information、状態操作、role assignment一覧、assign/edit/remove modal、platform admin lockout確認文を日本語対応した。admin email、admin ID、role名/display name、scope ID、tenant ID、IP、MFA methodなどAPI・ユーザー入力由来の値はデータとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 Platform/Admin管理画面の `/admin/admin-access-control` を辞書化した。`admin-admin-access-control` 辞書モジュールを追加し、管理者向けAccess Control Hubのページ見出し、loading/error/retry、Admin RBAC/ABAC/ReBAC/Policies card、統計表示、関連ツールリンクを日本語対応した。RBAC、ABAC、ReBAC、Policy-based access control、IP Allowlistなどの機能名・略称は製品用語として一部原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 Platform/Admin管理画面の `/admin/admin-rbac`、`/admin/admin-rbac/new`、`/admin/admin-rbac/[id]` を辞書化した。`admin-admin-rbac` 辞書モジュールと `admin-admin-rbac-i18n` helperを追加し、管理者ロール一覧、作成フォーム、詳細の基本情報、ロール割り当てtable、assign/edit/remove modal、role type/status/scope表示、permission category名/説明を日本語対応した。role名/display name/description、permission key、admin user ID/email、scope ID、tenant ID、API由来のエラー本文はデータとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 Platform/Admin管理画面の `/admin/admin-abac` を辞書化した。`admin-admin-abac` 辞書モジュールを追加し、管理者属性一覧、検索/system属性filter、attribute type/system/required/multi-valued badge、allowed values/range表示、create/edit modal、delete確認、load/create/save/delete fallbackを日本語対応した。属性名/display name/description、allowed values、regex pattern、API由来のエラー本文はデータとして原文保持する。regex placeholderの `{}` は `typesafe-i18n` の補間構文と衝突するため、翻訳文では安全な例示表現へ置き換えた。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 Platform/Admin管理画面の `/admin/admin-rebac` hubを辞書化した。`admin-admin-rebac` 辞書モジュールを追加し、Admin ReBAC見出し、definitions/tuples card、loading/error、overview説明、recent definitions/relationships、system/transitive/priority表示を日本語対応した。relation name/display name、relationship type、from/to ID、permission levelはデータとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。`/admin/admin-rebac/tuples` と `/admin/admin-rebac/definitions` は継続作業。
- 2026-06-04: P1 Platform/Admin管理画面の `/admin/admin-rebac/tuples` と `/admin/admin-rebac/definitions` を辞書化した。`admin-admin-rebac` 辞書モジュールを拡張し、relationship tuple一覧、検索/type filter、結果件数、create/delete dialog、permission level/transitive/bidirectional/expires表示、relationship definition一覧、system-protected表示、create/edit/delete dialog、fallback errorを日本語対応した。relation name/display name/description、relationship type、from/to ID、tenant ID、permission level値、API由来のエラー本文はデータとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 Platform/Admin管理画面の `/admin/admin-policies` を辞書化した。`admin-admin-policies` 辞書モジュールを追加し、Admin Policies一覧、検索/status filter、active/effect/system badge、create policy dialog、policy simulation dialog、decision/evaluated count、load/create/update/delete/toggle/simulation fallback errorを日本語対応した。policy名/display name/description、resource pattern、actions、priority、API由来のエラー本文はデータとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 Platform/Admin管理画面の `/admin/admin-audit` を辞書化した。`admin-admin-audit` 辞書モジュールを追加し、Admin Audit Logs見出し、stats panel、filters、loading/empty/error、audit log table、pagination、detail modal、result/severity表示、change details/metadata sectionを日本語対応した。action、resource type/id、admin user ID、machine principal/client/credential ID、IP、user agent、request ID、before/after/metadata JSON、API由来のエラー本文は監査データとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 Platform/Admin管理画面の `/admin/admin-logging` を辞書化した。`admin-admin-logging` 辞書モジュールを追加し、Admin Logging overview、window selector、summary stats、Audit Coverage、Catalog Repairs、Critical Protection、Sensitive Detail、Key Registry、Message Jobs、Rewrap Jobs、Recent Critical Changes、Archive Chunks、Delivery Health、danger confirmation、fallback errorを日本語対応した。permission文字列、log type/plane/status/job kind、catalog/object/key/job ID、resource/actor/source値、JSON summary、API由来のエラー本文は運用データとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 Platform/Admin管理画面の `/admin/ip-allowlist` を辞書化した。`admin-ip-allowlist` 辞書モジュールを追加し、ページ見出し、status banner、filters、loading/empty/error、IP allowlist table、create/edit/check modal、delete confirmation、IP/CIDR validation fallbackを日本語対応した。IP/CIDR値、IPv4/IPv6表示、description、API由来のエラー本文はデータとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 Platform/Admin管理画面の `/admin/machine-access` を辞書化した。`admin-machine-access` 辞書モジュールを追加し、ページ見出し、status filter、summary、principal list/create/edit grant form、credential list/detail/create/rotate form、principal type/status/credential status表示、notice、fallback error、Public JWK validation fallbackを日本語対応した。client ID、principal/credential ID、kid、JWK、algorithm、permissions、tenant scopes、IP、display name/description、API由来のエラー本文はデータ・設定値として原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 Platform/Admin管理画面の `/admin/operational-logs` を辞書化した。`admin-operational-logs` 辞書モジュールを追加し、ページ見出し、filters、entries table、loading/empty/error、detail modal、reason detail section、fallback errorを日本語対応した。action、subject type/id、actor ID、request ID、reason detail、API由来のエラー本文は運用ログデータとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 運用・高度機能の `/admin/security` を辞書化した。`admin-security` 辞書モジュールを追加し、ページ見出し、tabs、status/severity filter、alerts/activities/threats cardのbadge表示、empty/loading/error、acknowledge操作、IP Reputation Check、risk level/stat labels、blocked status、recommendations、fallback errorを日本語対応した。alert/threat/activityのtitle/description、source IP、user email、indicator、IP reputation recommendation、API由来のエラー本文はセキュリティ運用データとして原文保持する。API helper由来のalert/threat type英語表示はページ側locale helperへ置き換えた。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 運用・高度機能の `/admin/compliance` を辞書化した。`admin-compliance` 辞書モジュールを追加し、overview/reviews/reports/data retention tabs、access review作成、cleanup確認、framework detail modal、retention policy edit dialogを日本語対応した。framework ID、review/report名、download URL、run ID、live check details、未知のcategory/status/API由来エラー本文は運用・監査データとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint` を実行し、`typecheck` は0 errors/0 warnings、`lint` は成功した。`build` は既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告の後、ディスク空き容量不足（`ENOSPC`）で未完了。
- 2026-06-04: P1 運用・高度機能の `/admin/storage-destinations` を辞書化した。`admin-storage-destinations` 辞書モジュールを追加し、storage destination registry、platform destination作成、credential更新、control plane destination一覧/detail drawer、health check、lifecycle/credential操作、diff previewを日本語対応した。provider名、destination名/ID、scope、status、runtime/health/lifecycle値、config JSON、diff JSON、confirmation phrase、API由来エラー本文は運用データとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 運用・高度機能の `/admin/logging-policies` を辞書化した。`admin-logging-policies` 辞書モジュールを追加し、logging assignments/fallbacks/snapshots、runtime resolver、tenant DB health/probe、usage/quota、delivery summary/events、export、message jobs/repairs、operational alerts、DLQ操作を日本語対応した。log type、plane、status、job kind、runtime binding、tenant/database identifiers、JSON preview、DLQ/export artifact、confirmation phrase、API由来エラー本文は運用データとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 運用・高度機能の `/admin/notifications` を辞書化した。`admin-notifications` 辞書モジュールを追加し、Notification Centerのfilter、summary、table、delivery/resolve操作、category/status/severity option、fallback errorを日本語対応した。notification category/status/severity/event type、tenant ID、payload preview、last error、delivery route情報は運用データとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 運用・高度機能の `/admin/database-connections` と `/admin/database-connections/[id]` を辞書化した。`admin-database-connections` 辞書モジュールを追加し、一覧、作成、詳細、provider settings、credential更新、metadata、delete/test操作を日本語対応した。connection ID/name/display name/provider/status/config JSON/credential data/tenant assignments/API由来エラー本文はデータとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 運用・高度機能の `/admin/jobs` を辞書化した。`admin-jobs` 辞書モジュールを追加し、job queue、summary、filter、creatable job type catalog、tenant DB request、user import、report job作成、job type detail、job detail/result/log表示を日本語対応した。job ID、job type/status code、processor status、result JSON、parameters、failure/log本文、CSV header key、storage destination名/API由来エラー本文は運用データとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 運用・高度機能の `/admin/approvals` を辞書化した。`admin-approvals` 辞書モジュールを追加し、approval request一覧/detail/create form、operator action、transport evidence、decision receipts、elevation grants、subject token発行、preview panel、completion/step/grant guide、service integration cardを日本語対応した。request ID、investigation ID、reason code、scope JSON、transport JSON、artifact/grant/token ID、API由来エラー本文、コードスニペット本文は監査・運用データとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 運用・高度機能の `/admin/support-ops` を辞書化した。`admin-support-ops` 辞書モジュールを追加し、Support Ops header、tabs、resource/action toolbar、selector、aggregate、cohort preview/create、action request/approval/execute、success/fallback error、aria-labelを日本語対応した。resource/field/operator名、resource displayName、support case ID、cohort/action ID、selector hash、risk level、privacy `min_count`、JSON resultは運用データとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 運用・高度機能の `/admin/diagnostic-logging` と `/admin/diagnostic-logging/export` を辞書化した。`admin-diagnostic-logging` 辞書モジュールを追加し、settings/export/storage tabs、logging toggles、export filters、client/category/format/storage mode、storage connection test、移動済みexportページの案内を日本語対応した。tenant/client ID、diagnosticSessionId、R2 binding、path prefix、category key、format/sort/export mode値、filename、storage destination名/API由来エラー本文は運用データとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 運用・高度機能の `/admin/external-token-refresh` を辞書化した。`admin-external-token-refresh` 辞書モジュールを追加し、ページ見出し、refresh/run操作、loading/success/fallback error、settings form、run metrics、run history table、trigger/status表示、date formattingを日本語対応した。tenant ID、run status原文を含むmanual run結果、token count、API由来エラー本文、run error messageは運用データとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 運用・高度機能の `/admin/iat-tokens` を辞書化した。`admin-iat-tokens` 辞書モジュールを追加し、IAT一覧、empty/loading state、create token modal、token created modal、copy button、revoke confirmation modal、date formatting、fallback errorを日本語対応した。IAT、Dynamic Client Registration、RFC 7591、token hash、token値、description、API由来エラー本文は仕様用語・運用データとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: P1 運用・高度機能の `/admin/plugins` を辞書化した。`admin-plugins` 辞書モジュールを追加し、ページ見出し、filters、empty/loading state、enabled/disabled、health check、detail dialog、community warning、configuration操作、test email操作、fallback errorを日本語対応した。plugin名/説明/icon、source identifier、version、capability/category値、schema property key/description/default/enum、config JSON、author/documentation URL、API由来エラー本文はplugin提供メタデータ・運用データとして原文保持する。`typesafe-i18n --no-watch`、`prettier`、`typecheck`、`lint`、`build` を実行し、`typecheck` は0 errors/0 warnings、`lint` と `build` は成功した。`build` では既存のRollup `codeSplitting` unknown option警告と `@xyflow` unused import警告が残るが、ビルド自体は成功した。
- 2026-06-04: Flow UIは機能自体をAdmin UIからomitする可能性があるため、多言語化対象から保留した。`/admin/flows`、`/admin/flows/[id]/edit`、`flow-designer/index.ts` に英語のproduct noteを追加し、Flowの新規i18n作業はproduct direction確定まで停止する方針を明記した。
- [x] ユーザーに表示される同意文と管理者向け説明文を混同しない。

### P1: 主要管理画面

- [x] `/admin/sessions`
- [x] `/admin/audit-logs`
- [x] `/admin/audit-logs/[id]`
- [x] `/admin/organizations`
- [x] `/admin/roles`
- [x] `/admin/roles/new`
- [x] `/admin/roles/[id]`
- [x] `/admin/roles/[id]/edit`
- [x] `/admin/access-control`
- [x] `/admin/access-trace`
- [x] `/admin/attributes`
- [x] `/admin/policies`
- [x] `/admin/rebac`
- [x] `/admin/rebac/tuples`
- [x] `/admin/rebac/definitions`
- [x] `/admin/rebac/definitions/[id]`
- [x] `/admin/scim-tokens`
- [x] `/admin/custom-claims`
- [x] `/admin/custom-claims/[id]`
- [x] `/admin/tenant-discovery`
- [x] `/admin/email-settings`
- [x] `/admin/webhooks`
- [x] `/admin/webhooks/[id]/deliveries`

### P1: Platform/Admin管理画面

- [x] `/admin/tenants`
- [x] `/admin/tenants/new`
- [x] `/admin/tenants/[id]`
- [x] `/admin/tenants/[id]/invitations`
- [x] `/admin/admins`
- [x] `/admin/admins/[id]`
- [x] `/admin/admin-access-control`
- [x] `/admin/admin-rbac`
- [x] `/admin/admin-rbac/new`
- [x] `/admin/admin-rbac/[id]`
- [x] `/admin/admin-abac`
- [x] `/admin/admin-rebac`
- [x] `/admin/admin-rebac/tuples`
- [x] `/admin/admin-rebac/definitions`
- [x] `/admin/admin-policies`
- [x] `/admin/admin-audit`
- [x] `/admin/admin-logging`
- [x] `/admin/ip-allowlist`
- [x] `/admin/machine-access`
- [x] `/admin/operational-logs`

### P1: 運用・高度機能

- [x] `/admin/security`
- [x] `/admin/compliance`
- [x] `/admin/scale`
- [x] `/admin/storage-destinations`
- [x] `/admin/logging-policies`
- [x] `/admin/notifications`
- [x] `/admin/database-connections`
- [x] `/admin/database-connections/[id]`
- [x] `/admin/dr-backup`
- [x] `/admin/jobs`
- [x] `/admin/approvals`
- [x] `/admin/support-ops`
- [x] `/admin/diagnostic-logging`
- [x] `/admin/diagnostic-logging/export`
- [x] `/admin/external-token-refresh`
- [x] `/admin/iat-tokens`
- [x] `/admin/plugins`
- [x] `/admin/account-settings`

### P1: Identity Mapping / Flow UI

- [x] `/admin/identity-mapping`
- [x] `/admin/identity-mapping/overview`
- [x] `/admin/identity-mapping/profiles`
- [x] `/admin/identity-mapping/profiles/edit`
- [x] `/admin/identity-mapping/mapping-policies`
- [x] `/admin/identity-mapping/resolution-center`
- [x] `/admin/identity-mapping/schema-readiness`
- [x] `/admin/identity-mapping/federation-trust`
- [x] `/admin/identity-mapping/edit`
- [x] `IdentityMappingPageShell.svelte`
- [x] `IdentityMappingFlowEditor.svelte`
- [x] `/admin/identity-mapping/profiles/edit` のplaceholder、select表示、Resolution Center fallback文言の残りスイープ
- [x] flow designer nodes: Start/Login/Identifier/UserInput/Mfa/Consent/Decision/Switch/Action/Redirect/Error/End は機能omit検討中のため保留。
- [x] Node palette、properties panel、config modalのラベルとhelp textは機能omit検討中のため保留。

### P2: 多言語QA基盤

- [x] 疑似ロケール `en-XA` の導入可否を検討する。今回は見送り。
- [x] RTL疑似ロケール `ar-XB` の導入可否を検討する。今回は見送り。
- [x] `de` を正式言語ではなくQA用長文localeとして使うか判断する。今回は見送り。
- [x] 翻訳キーの未使用/未定義検出スクリプトを追加する。
- [x] Svelteファイル内の直書き英語検出ルールを追加する。
- [ ] スクリーンショット比較対象に日本語localeを追加する。
- [ ] Playwrightで `preferredLanguage=ja` の主要画面smokeを追加する。

## 翻訳チェックリスト

各画面で以下を確認する。

- [ ] ページタイトル
- [ ] 説明文
- [ ] セクション見出し
- [ ] タブ
- [ ] テーブルヘッダー
- [ ] フィルターラベル
- [ ] 検索placeholder
- [ ] 空状態
- [ ] 読み込み状態
- [ ] エラー状態
- [ ] 成功メッセージ
- [ ] 警告メッセージ
- [ ] 破壊的操作の確認文
- [ ] ボタン
- [ ] aria-label
- [ ] title属性
- [ ] tooltip
- [ ] form label
- [ ] help text
- [ ] validation message
- [ ] API由来エラーの表示
- [ ] date/time/relative time
- [ ] number/count単位
- [ ] status badge
- [ ] feature flag名と説明

## レイアウトチェックリスト

- [ ] サイドナビで日本語が1行に収まらない場合も崩れない。
- [ ] モバイル幅でナビ項目が重ならない。
- [ ] ボタン内テキストがはみ出さない。
- [ ] テーブルヘッダーが不自然に潰れない。
- [ ] タブが横スクロールまたは折り返しで破綻しない。
- [ ] カード内の説明文が隣の要素と重ならない。
- [ ] モーダルのタイトルと本文が画面外にはみ出さない。
- [ ] 日本語フォントfallbackで行高が不足しない。
- [ ] 英数字、URL、ID、UUID、メールアドレスが日本語文中で読める。
- [ ] 長いクライアント名やテナント名が日本語ラベルと組み合わさっても崩れない。

## テスト・検証タスク

- [x] `pnpm --filter @authrim/ar-admin-ui typesafe-i18n`
- [x] `pnpm --filter @authrim/ar-admin-ui typecheck`
- [x] `pnpm --filter @authrim/ar-admin-ui lint`
- [x] `pnpm --filter @authrim/ar-admin-ui test`
- [x] `pnpm --filter @authrim/ar-admin-ui build`
- [x] Admin UI確認用の短命session発行ツールを追加する。
- [ ] `pnpm test:e2e` のうちAdmin UIに関係するケースを確認する。
- [ ] ブラウザで `en` から `ja` へ切り替え、Cookie永続化を確認する。
- [ ] ブラウザで `ja` から `en` へ戻せることを確認する。
- [x] `/admin/account-settings` のLanguage & Regionから言語を切り替えられるようにする。
- [x] `preferredLanguage` に不正値を入れてfallbackを確認する。
- [ ] 日本語localeで主要P0画面を手動確認する。
- [ ] mobile viewportでP0画面を手動確認する。
- [ ] スクリーンショットをイベントデモ用に保存する。

## 完了条件

### イベント前の完了条件

- [ ] Admin UIのナビゲーション、ヘッダー、主要P0画面が日本語で表示される。
- [ ] SAML/OIDC/Consentまわりの画面が日本語で説明可能な状態になっている。
- [ ] 言語切り替えがCookieに保存され、リロード後も維持される。
- [ ] 日本語で主要P0導線を操作してもレイアウトが破綻しない。
- [x] `typecheck` と `build` が通る。

### 多言語基盤としての完了条件

- [ ] 新しい表示文言を追加するときのキー命名ルールが明文化されている。
- [ ] `en` と `ja` のキー不一致がCIまたはtypecheckで検出できる。
- [x] 翻訳しないプロトコル用語の方針が守られている。
- [ ] 将来localeを増やす時の変更箇所が明確になっている。
- [ ] 疑似ロケールまたはQA locale導入の方針が決まっている。

## 将来の追加言語メモ

正式対応の次候補は事業理由が出てから決める。

候補:

- `zh-CN`: アジアでの到達範囲が大きい。
- `ko`: アジアB2B/SaaS向けには自然だが、導入理由が必要。
- `es`: アジア限定でなければ到達範囲が大きい。
- `de`: 正式対応というより、長文ラベルQAに有用。

現時点では、Admin UIの正式対応は `en` / `ja` に絞る。
