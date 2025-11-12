# Phase 5: UI/UX Implementation - Planning Document 🎨

**Status:** Planning
**Timeline:** May 1-31, 2026 (4 weeks)
**Goal:** 最高のパスワードレス体験 + Auth0/Clerkを超えるUX

---

## 📋 目次

1. [概要](#概要)
2. [決定すべき事項リスト](#決定すべき事項リスト)
3. [アーキテクチャ設計](#アーキテクチャ設計)
4. [UI/UXページ一覧](#uiuxページ一覧)
5. [管理者機能領域](#管理者機能領域)
6. [技術スタック選定](#技術スタック選定)
7. [データストレージ設計](#データストレージ設計)
8. [認証フロー設計](#認証フロー設計)
9. [タイムライン](#タイムライン)

---

## 概要

Phase 5では、Hibanaに以下の機能を実装します：

- **🔐 パスワードレス認証UI** (Passkey + Magic Link)
- **📝 ユーザー登録・ログインフロー**
- **✅ OAuth同意画面**
- **👥 管理者ダッシュボード**
- **💾 データストレージ抽象化層**

### 主要な目標

1. **Auth0/Clerkを超えるUX** - より直感的で高速なUI
2. **パスワードレスファースト** - Passkey/WebAuthnを第一選択に
3. **エッジネイティブ** - Cloudflare Workersに最適化
4. **アクセシビリティ** - WCAG 2.1 AA準拠
5. **国際化対応** - 多言語サポート準備

---

## 決定すべき事項リスト

以下の項目を順番に検討・決定していきます：

### 1️⃣ フロントエンド技術スタック

#### 1.1 UIフレームワーク選定
- [ ] **選択肢の比較**
  - **React + Next.js** - 最も人気、エコシステム豊富、SSR対応
  - **Vue 3 + Nuxt 3** - シンプル、学習コスト低、SSR対応
  - **Svelte + SvelteKit** - 高速、バンドルサイズ小、モダン
  - **Solid.js + SolidStart** - React風、高パフォーマンス、新しい
  - **Vanilla TS + Lit** - 軽量、Web Components、依存少

- [ ] **評価基準**
  - ビルドサイズ（エッジ環境での制約）
  - 開発速度・生産性
  - TypeScript対応
  - SSR/SSG対応
  - エコシステム（ライブラリ、ツール）
  - Cloudflare Pagesとの統合

- [ ] **推奨**: Svelte + SvelteKit または Solid.js
  - 理由: 軽量、高速、モダン、エッジ最適化

#### 1.2 CSSフレームワーク選定
- [ ] **選択肢の比較**
  - **Tailwind CSS** - ユーティリティファースト、カスタマイズ容易
  - **UnoCSS** - Tailwind互換、高速、軽量
  - **Panda CSS** - Zero-runtime、型安全、高速
  - **Vanilla Extract** - CSS-in-TypeScript、型安全
  - **shadcn/ui + Tailwind** - コンポーネントライブラリ付き

- [ ] **評価基準**
  - バンドルサイズ
  - 開発体験（DX）
  - ダークモード対応
  - カスタマイズ性
  - パフォーマンス

- [ ] **推奨**: Tailwind CSS または UnoCSS
  - 理由: 実績、エコシステム、高速

#### 1.3 UIコンポーネントライブラリ
- [ ] **選択肢の比較**
  - **shadcn/ui** (React) - コピペ型、カスタマイズ容易
  - **Melt UI** (Svelte) - Headless、アクセシブル
  - **Kobalte** (Solid.js) - Headless、アクセシブル
  - **Radix UI** (React) - Headless、アクセシブル
  - **自作** - 完全制御、軽量

- [ ] **評価基準**
  - アクセシビリティ（ARIA対応）
  - カスタマイズ性
  - バンドルサイズ
  - ドキュメント品質
  - 必要なコンポーネント数

- [ ] **推奨**: Melt UI (Svelte) または Kobalte (Solid.js)
  - 理由: Headless、軽量、アクセシブル

### 2️⃣ バックエンドアーキテクチャ

#### 2.1 UIホスティング方式
- [ ] **選択肢の比較**
  - **Option A: Cloudflare Pages** (別デプロイ)
    - メリット: CDN最適化、独立デプロイ、静的アセット高速配信
    - デメリット: 別管理、CORS設定必要

  - **Option B: Workers内で配信** (同一Worker)
    - メリット: 統合管理、CORS不要、シンプル
    - デメリット: Workerサイズ制限、静的アセット配信非効率

  - **Option C: Hybrid** (API=Workers, UI=Pages)
    - メリット: 各技術の強み活用、最適なパフォーマンス
    - デメリット: 複雑、デプロイ管理

- [ ] **評価基準**
  - パフォーマンス
  - 管理のしやすさ
  - コスト
  - スケーラビリティ

- [ ] **推奨**: Option C (Hybrid)
  - 理由: 最適なパフォーマンス、クリーンな分離

#### 2.2 API設計
- [ ] **必要なエンドポイント追加**
  - `POST /auth/passkey/register` - Passkey登録開始
  - `POST /auth/passkey/verify` - Passkey検証
  - `POST /auth/magic-link/send` - Magic Link送信
  - `POST /auth/magic-link/verify` - Magic Link検証
  - `GET /auth/consent` - 同意画面表示用データ取得
  - `POST /auth/consent` - 同意確定
  - `GET /admin/users` - ユーザー一覧
  - `POST /admin/users` - ユーザー作成
  - `PUT /admin/users/:id` - ユーザー更新
  - `DELETE /admin/users/:id` - ユーザー削除
  - `GET /admin/clients` - クライアント一覧
  - `POST /admin/clients` - クライアント作成（既存のDCRを拡張）
  - `PUT /admin/clients/:id` - クライアント更新
  - `DELETE /admin/clients/:id` - クライアント削除
  - `GET /admin/stats` - 統計情報

- [ ] **認証方式**
  - 管理者API: Bearer Token（専用の管理者トークン）
  - セッション管理: Cookie + CSRF Token

#### 2.3 セッション管理
- [ ] **実装方式の選定**
  - **Option A: Cookie-based Sessions**
    - KV/D1/DOにセッションデータ保存
    - HttpOnly, Secure, SameSite=Lax Cookie

  - **Option B: JWT Sessions**
    - ステートレス
    - クライアント側に保存

  - **Option C: Hybrid**
    - セッションID（Cookie） + データ（KV/DO）

- [ ] **推奨**: Option C (Hybrid)
  - 理由: セキュリティとパフォーマンスのバランス

### 3️⃣ データストレージ設計

#### 3.1 ストレージ選定
- [ ] **各ストレージの用途決定**

  **Cloudflare KV**
  - 用途: セッション、一時データ、キャッシュ
  - データ例:
    - セッションデータ（TTL: 24時間）
    - Magic Linkトークン（TTL: 15分）
    - CSRF Token（TTL: 1時間）

  **Cloudflare D1 (SQLite)**
  - 用途: 永続データ、リレーショナルデータ
  - データ例:
    - ユーザー情報
    - クライアント情報（DCRで登録されたもの）
    - 認証履歴
    - Audit Log

  **Durable Objects**
  - 用途: 強い一貫性が必要なデータ、リアルタイムデータ
  - データ例:
    - キー管理（既存のKeyManager）
    - Rate Limiting（既存実装）
    - アクティブセッション管理

- [ ] **データモデル設計**
  - ER図作成
  - テーブル定義
  - インデックス設計
  - マイグレーション戦略

#### 3.2 D1データベーススキーマ

```sql
-- Users Table
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  email_verified INTEGER DEFAULT 0,
  name TEXT,
  given_name TEXT,
  family_name TEXT,
  middle_name TEXT,
  nickname TEXT,
  preferred_username TEXT,
  profile TEXT,
  picture TEXT,
  website TEXT,
  gender TEXT,
  birthdate TEXT,
  zoneinfo TEXT,
  locale TEXT,
  phone_number TEXT,
  phone_number_verified INTEGER DEFAULT 0,
  address_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_created_at ON users(created_at);

-- Passkeys/WebAuthn Credentials Table
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER DEFAULT 0,
  transports TEXT,
  device_name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_passkeys_user_id ON passkeys(user_id);
CREATE INDEX idx_passkeys_credential_id ON passkeys(credential_id);

-- OAuth Clients Table (extends existing DCR)
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret TEXT,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  response_types TEXT NOT NULL,
  scope TEXT,
  logo_uri TEXT,
  client_uri TEXT,
  policy_uri TEXT,
  tos_uri TEXT,
  contacts TEXT,
  subject_type TEXT DEFAULT 'public',
  sector_identifier_uri TEXT,
  token_endpoint_auth_method TEXT DEFAULT 'client_secret_basic',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_clients_created_at ON oauth_clients(created_at);

-- User Sessions Table
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- Audit Log Table
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);
CREATE INDEX idx_audit_log_action ON audit_log(action);
```

- [ ] **スキーマレビュー**
- [ ] **マイグレーションスクリプト作成**
- [ ] **シードデータ作成**

#### 3.3 ストレージ抽象化層
- [ ] **インターフェース設計**（Phase 4で基礎完了）
  - `IUserStore` - ユーザーCRUD
  - `IClientStore` - クライアントCRUD（既存DCRを拡張）
  - `ISessionStore` - セッション管理
  - `IPasskeyStore` - Passkey管理

- [ ] **アダプター実装**
  - `D1Adapter` - D1実装
  - `KVAdapter` - KV実装（既存を拡張）
  - `DOAdapter` - Durable Objects実装

### 4️⃣ 認証フロー設計

#### 4.1 WebAuthn/Passkey実装
- [ ] **実装要件**
  - WebAuthn API利用（navigator.credentials）
  - Relying Party (RP) 設定
  - Attestation検証
  - Assertion検証
  - Counter管理（リプレイ攻撃対策）

- [ ] **必要なライブラリ選定**
  - **@simplewebauthn/server** - サーバー側検証
  - **@simplewebauthn/browser** - クライアント側API

- [ ] **フロー**
  1. Registration (登録)
     - ユーザーがメールアドレス入力
     - サーバーがチャレンジ生成
     - ブラウザでPasskey作成
     - サーバーで検証・保存

  2. Authentication (認証)
     - ユーザーがメールアドレス入力（またはPasskey選択）
     - サーバーがチャレンジ生成
     - ブラウザでPasskey使用
     - サーバーで検証・セッション作成

#### 4.2 Magic Link実装
- [ ] **実装要件**
  - トークン生成（cryptographically secure）
  - メール送信（Cloudflare Email Routing or API）
  - トークン検証（ワンタイム、TTL: 15分）
  - セッション作成

- [ ] **メール送信方式選定**
  - **Option A: Cloudflare Email Workers**
  - **Option B: 外部API (SendGrid, Postmark, Resend)**
  - **Option C: SMTP (Nodemailer)**

- [ ] **推奨**: Option B (Resend or Postmark)
  - 理由: シンプル、信頼性、配信率高

#### 4.3 OAuth同意画面フロー
- [ ] **表示情報**
  - クライアント名・ロゴ
  - 要求されるスコープ（人間が読める形式）
  - ユーザー情報（現在ログイン中のユーザー）
  - プライバシーポリシー・利用規約リンク

- [ ] **ボタン**
  - 「許可」- 同意してリダイレクト
  - 「キャンセル」- エラーでリダイレクト
  - 「ログアウト」- 別ユーザーでログイン

- [ ] **データ永続化**
  - 同意履歴の保存（次回は自動承認するか？）
  - Audit Log記録

### 5️⃣ UIページ設計

#### 5.1 エンドユーザー向けページ

##### Page 1: ログイン画面 (`/login`)
- [ ] **デザイン要件**
  - クリーンでモダンなデザイン
  - Hibanaロゴ表示
  - メールアドレス入力フィールド
  - 「Continue with Passkey」ボタン（メイン）
  - 「Send Magic Link」ボタン（セカンダリ）
  - 「Create Account」リンク
  - 多言語切り替え（将来）

- [ ] **機能要件**
  - メールアドレスバリデーション
  - Passkey対応ブラウザの検出
  - エラーメッセージ表示
  - ローディング状態
  - アクセシビリティ（キーボード操作、スクリーンリーダー）

- [ ] **レスポンシブ対応**
  - モバイル（320px～）
  - タブレット（768px～）
  - デスクトップ（1024px～）

##### Page 2: アカウント登録画面 (`/register`)
- [ ] **デザイン要件**
  - メールアドレス入力
  - 名前入力（任意）
  - 「Create Account with Passkey」ボタン
  - 「Sign up with Magic Link」ボタン
  - 「Already have an account?」リンク

- [ ] **機能要件**
  - フォームバリデーション
  - 重複メール検出
  - Passkey登録フロー
  - 利用規約・プライバシーポリシーへの同意チェックボックス

##### Page 3: Magic Link送信完了画面 (`/magic-link-sent`)
- [ ] **デザイン要件**
  - 成功メッセージ
  - 「Check your email」
  - メールアドレス表示
  - 「Resend email」ボタン
  - 「Back to login」リンク

- [ ] **機能要件**
  - タイマー（再送信制限）
  - メール再送機能

##### Page 4: Magic Link検証画面 (`/verify-magic-link`)
- [ ] **デザイン要件**
  - ローディングスピナー
  - 「Verifying...」メッセージ
  - エラー時: エラーメッセージ + 「Request new link」ボタン

- [ ] **機能要件**
  - URLパラメータからトークン取得
  - トークン検証
  - セッション作成
  - 元のページへリダイレクト

##### Page 5: OAuth同意画面 (`/consent`)
- [ ] **デザイン要件**
  - クライアントロゴ・名前
  - 「{Client Name} wants to access your Hibana account」
  - スコープリスト（アイコン付き）
  - ユーザー情報表示（email, name）
  - 「Allow」ボタン（プライマリ）
  - 「Deny」ボタン（セカンダリ）
  - 「Not you? Switch account」リンク

- [ ] **機能要件**
  - スコープの人間が読める変換
  - クライアント情報取得
  - 同意/拒否処理
  - リダイレクト処理

##### Page 6: エラーページ (`/error`)
- [ ] **デザイン要件**
  - エラーメッセージ
  - エラーコード
  - 「Back to login」ボタン
  - サポートへの連絡先

- [ ] **機能要件**
  - 多様なエラータイプ対応
  - ユーザーフレンドリーなメッセージ

#### 5.2 管理者向けページ

##### Page 7: 管理者ダッシュボード (`/admin`)
- [ ] **デザイン要件**
  - サイドバーナビゲーション
  - トップバー（ロゴ、検索、通知、プロファイル）
  - 統計カード（ユーザー数、アクティブセッション数、今日のログイン数、クライアント数）
  - アクティビティフィード（最新のログイン、登録、エラー）
  - チャート（ログイン推移、ユーザー登録推移）

- [ ] **機能要件**
  - リアルタイム統計（または定期更新）
  - アクティビティフィルタリング
  - レスポンシブ対応

##### Page 8: ユーザー管理 (`/admin/users`)
- [ ] **デザイン要件**
  - ユーザーリストテーブル（email, name, created_at, last_login_at, status）
  - 検索バー
  - フィルター（verified/unverified, active/inactive）
  - ソート機能
  - ページネーション
  - 「Add User」ボタン
  - アクション（Edit, Delete, View）

- [ ] **機能要件**
  - ユーザー検索（email, name）
  - ユーザー作成フォーム
  - ユーザー編集フォーム
  - ユーザー削除（確認ダイアログ）
  - 詳細表示（モーダル or 別ページ）

##### Page 9: ユーザー詳細/編集 (`/admin/users/:id`)
- [ ] **デザイン要件**
  - ユーザー情報フォーム（全OIDC標準クレーム）
  - Passkey一覧（登録済みデバイス）
  - セッション一覧
  - Audit Log
  - 「Save Changes」ボタン
  - 「Delete User」ボタン（危険領域）

- [ ] **機能要件**
  - フォームバリデーション
  - 更新処理
  - Passkey削除
  - セッション無効化

##### Page 10: クライアント管理 (`/admin/clients`)
- [ ] **デザイン要件**
  - クライアントリストテーブル（client_id, client_name, created_at, grant_types）
  - 検索バー
  - 「Register Client」ボタン
  - アクション（Edit, Delete, View Secret）

- [ ] **機能要件**
  - クライアント検索
  - クライアント登録フォーム（DCR API使用）
  - クライアント編集
  - クライアント削除
  - Client Secret表示（マスク/表示トグル）

##### Page 11: クライアント詳細/編集 (`/admin/clients/:id`)
- [ ] **デザイン要件**
  - クライアント情報フォーム（RFC 7591準拠）
  - Redirect URIs管理
  - Grant Types選択
  - Scope設定
  - 「Save Changes」ボタン
  - 「Regenerate Secret」ボタン
  - 「Delete Client」ボタン

- [ ] **機能要件**
  - フォームバリデーション
  - 更新処理
  - Secret再生成
  - 削除処理

##### Page 12: 設定 (`/admin/settings`)
- [ ] **デザイン要件**
  - タブ（General, Appearance, Security, Email, Advanced）
  - General: サイト名、ロゴ、言語、タイムゾーン
  - Appearance: テーマ、カラー、ログインページカスタマイズ
  - Security: パスワードポリシー、セッションタイムアウト、MFA設定
  - Email: SMTP設定、メールテンプレート
  - Advanced: トークンTTL、Rate Limiting設定

- [ ] **機能要件**
  - 設定保存（環境変数 or D1）
  - プレビュー機能（ログインページカスタマイズ）
  - テストメール送信

##### Page 13: Audit Log (`/admin/audit-log`)
- [ ] **デザイン要件**
  - ログテーブル（timestamp, user, action, resource, IP, status）
  - フィルター（日付範囲、アクション、ユーザー）
  - 検索
  - エクスポート（CSV, JSON）

- [ ] **機能要件**
  - ログ表示・検索
  - フィルタリング
  - エクスポート機能

### 6️⃣ 管理者認証・権限管理

#### 6.1 管理者アカウント管理
- [ ] **管理者の定義**
  - D1に`user_roles`テーブル追加？
  - または`users.is_admin`フラグ？
  - または専用の`admins`テーブル？

- [ ] **推奨**: `user_roles`テーブル（拡張性）
  ```sql
  CREATE TABLE user_roles (
    user_id TEXT NOT NULL,
    role TEXT NOT NULL, -- 'admin', 'user'
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, role),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  ```

#### 6.2 管理者認証フロー
- [ ] **認証方式**
  - 通常ログインフロー + ロールチェック
  - 管理者ダッシュボードへのアクセス時に権限確認
  - ミドルウェアで`requireAdmin()`実装

#### 6.3 権限レベル
- [ ] **ロール定義**
  - **Super Admin**: 全権限（ユーザー、クライアント、設定）
  - **Admin**: ユーザー・クライアント管理のみ
  - **Viewer**: 読み取り専用

  （Phase 5では簡易的にAdmin/Userのみ実装、Phase 7でRBACを本格実装）

### 7️⃣ セキュリティ要件

#### 7.1 CSRF対策
- [ ] **実装方式**
  - Double Submit Cookie
  - または同期トークン（セッション保存）
  - 全POSTリクエストで検証

#### 7.2 XSS対策
- [ ] **実装方式**
  - CSP Header（既存実装を拡張）
  - HTMLエスケープ（フレームワークのデフォルト機能）
  - 入力サニタイゼーション

#### 7.3 セッションセキュリティ
- [ ] **要件**
  - HttpOnly Cookie
  - Secure Cookie（HTTPS）
  - SameSite=Lax
  - セッションタイムアウト（デフォルト: 24時間）
  - 絶対タイムアウト（デフォルト: 7日）

#### 7.4 Rate Limiting（既存実装を活用）
- [ ] **対象エンドポイント**
  - `/login` - 5 req/min per IP
  - `/register` - 3 req/min per IP
  - `/auth/magic-link/send` - 3 req/15min per email
  - `/admin/*` - 100 req/min per session

### 8️⃣ 国際化（i18n）対応

#### 8.1 対応言語（Phase 5）
- [ ] **初期対応**
  - 英語（en）- デフォルト
  - 日本語（ja）

- [ ] **将来追加予定**（Phase 6以降）
  - 中国語（zh）
  - スペイン語（es）
  - フランス語（fr）
  - ドイツ語（de）

#### 8.2 実装方式
- [ ] **ライブラリ選定**
  - **i18next** - 標準的、豊富な機能
  - **Paraglide** - 型安全、軽量
  - **フレームワーク標準** - SvelteKit/SolidStartの組み込み機能

- [ ] **翻訳ファイル管理**
  - JSON形式
  - `locales/en.json`, `locales/ja.json`
  - ネストした構造

#### 8.3 言語切り替え
- [ ] **検出方法**
  - `ui_locales`パラメータ（OIDC標準）
  - Cookie
  - Accept-Language Header
  - UIでの手動切り替え

### 9️⃣ パフォーマンス要件

#### 9.1 目標指標
- [ ] **ページロード時間**
  - ログインページ: < 1秒（First Contentful Paint）
  - 管理ダッシュボード: < 2秒
  - ユーザー一覧: < 1.5秒（100件表示）

- [ ] **バンドルサイズ**
  - 初期JS: < 100KB（gzip）
  - 初期CSS: < 20KB（gzip）

- [ ] **Lighthouse スコア**
  - Performance: > 90
  - Accessibility: > 95
  - Best Practices: > 90
  - SEO: > 90

#### 9.2 最適化戦略
- [ ] **フロントエンド**
  - コード分割（Route-based）
  - 遅延読み込み（画像、コンポーネント）
  - Tree Shaking
  - CDN配信（Cloudflare Pages）
  - Service Worker（将来）

- [ ] **バックエンド**
  - KVキャッシング
  - データベースクエリ最適化
  - バッチ処理（統計データ）

### 🔟 アクセシビリティ要件

#### 10.1 WCAG 2.1 AA準拠
- [ ] **必須項目**
  - キーボード操作対応（Tab, Enter, Esc）
  - スクリーンリーダー対応（ARIA属性）
  - カラーコントラスト比 4.5:1以上
  - フォーカスインジケーター
  - エラーメッセージの明確化
  - フォームラベルの適切な関連付け

#### 10.2 テスト方法
- [ ] **ツール**
  - axe DevTools
  - Lighthouse Accessibility Audit
  - NVDA/JAWSスクリーンリーダーテスト
  - キーボードのみでの操作テスト

---

## タイムライン（4週間）

### Week 1 (May 1-7): 基盤構築
- **Day 1-2**: 技術スタック最終決定
  - フレームワーク選定会議
  - プロトタイプ作成
- **Day 3-4**: プロジェクトセットアップ
  - フロントエンド環境構築
  - D1データベース作成・マイグレーション
  - ストレージ抽象化層実装
- **Day 5-7**: WebAuthn基礎実装
  - サーバー側実装
  - クライアント側実装
  - 基本的な登録・認証フロー

### Week 2 (May 8-14): 認証UI実装
- **Day 8-10**: ログイン・登録ページ
  - デザイン実装
  - Passkey統合
  - Magic Link統合
- **Day 11-12**: OAuth同意画面
  - デザイン実装
  - 同意フロー統合
- **Day 13-14**: エラーハンドリング、テスト

### Week 3 (May 15-21): 管理者ダッシュボード
- **Day 15-17**: ダッシュボードレイアウト
  - サイドバー、トップバー
  - 統計カード
  - アクティビティフィード
- **Day 18-19**: ユーザー管理
  - 一覧、検索、CRUD
- **Day 20-21**: クライアント管理
  - 一覧、検索、CRUD

### Week 4 (May 22-28): 仕上げ・テスト
- **Day 22-23**: 設定ページ、Audit Log
- **Day 24-25**: アクセシビリティ改善
- **Day 26-27**: パフォーマンス最適化
- **Day 28**: 総合テスト、ドキュメント更新

### バッファ (May 29-31): 予備日

---

## チェックリスト

### 決定事項
- [ ] フロントエンドフレームワーク決定
- [ ] CSSフレームワーク決定
- [ ] UIコンポーネントライブラリ決定
- [ ] UIホスティング方式決定
- [ ] セッション管理方式決定
- [ ] メール送信サービス決定
- [ ] D1スキーマ承認
- [ ] 管理者権限モデル決定
- [ ] i18nライブラリ決定
- [ ] パフォーマンス目標合意

### 設計完了
- [ ] D1スキーマ最終化
- [ ] API エンドポイント仕様書
- [ ] 認証フロー図
- [ ] UI/UXワイヤーフレーム（全13ページ）
- [ ] デザインシステム（カラー、タイポグラフィ、スペーシング）
- [ ] エラーハンドリング戦略
- [ ] セキュリティチェックリスト

### 実装準備
- [ ] 必要なライブラリのインストール
- [ ] D1データベース作成
- [ ] マイグレーションスクリプト作成
- [ ] シードデータ作成
- [ ] 開発環境構築ガイド更新
- [ ] CI/CDパイプライン更新（UIビルド追加）

---

## 次のステップ

1. **このドキュメントをレビュー**
   - 各セクションを順番に確認
   - 決定事項にチェックを入れる
   - 疑問点や追加事項をコメント

2. **技術選定会議**
   - フロントエンドスタックの最終決定
   - プロトタイプ作成（2-3日）

3. **詳細設計**
   - ワイヤーフレーム作成
   - デザインシステム策定
   - API仕様書作成

4. **実装開始**
   - Week 1からタイムラインに沿って進行

---

## 参考資料

### 競合分析
- [Auth0 Login Experience](https://auth0.com/)
- [Clerk UI Components](https://clerk.com/)
- [Supabase Auth UI](https://supabase.com/docs/guides/auth/auth-ui)

### WebAuthn/Passkey
- [SimpleWebAuthn Documentation](https://simplewebauthn.dev/)
- [WebAuthn Guide (web.dev)](https://web.dev/passkey-registration/)
- [FIDO2 Specifications](https://fidoalliance.org/fido2/)

### デザインインスピレーション
- [Tailwind UI](https://tailwindui.com/)
- [shadcn/ui](https://ui.shadcn.com/)
- [Refactoring UI](https://www.refactoringui.com/)

---

**Last Updated**: 2025-11-12
**Status**: Draft - Awaiting Review & Decision
**Next Review**: TBD
