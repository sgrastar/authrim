# Phase 5: UI/UX Implementation - Planning Document 🎨

**Status:** Planning
**Timeline:** May 1-31, 2026 (4 weeks)
**Goal:** Best Passwordless and User Experience

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Decision Items List](#decision-items-list)
3. [Architecture Design](#architecture-design)
4. [UI/UX Page List](#uiux-page-list)
5. [Admin Features](#admin-features)
6. [Technology Stack Selection](#technology-stack-selection)
7. [Data Storage Design](#data-storage-design)
8. [Authentication Flow Design](#authentication-flow-design)
9. [Timeline](#timeline)

---

## Overview

Phase 5 implements the following features in Enrai:

- **🔐 Passwordless Authentication UI** (Passkey + Magic Link)
- **📝 User Registration & Login Flow**
- **✅ OAuth Consent Screen**
- **👥 Admin Dashboard**
- **💾 Data Storage Abstraction Layer**

### Key Goals

1. **Intuitive & Fast UI** - Prioritize user experience
2. **Passwordless First** - Passkey/WebAuthn as primary option
3. **Edge Native** - Optimized for Cloudflare Workers
4. **Accessibility** - WCAG 2.1 AA compliant
5. **Internationalization** - Prepare for multilingual support

---

## Decision Items List

The following items will be reviewed and decided in order:

### 1️⃣ Frontend Technology Stack

#### 1.1 UI Framework Selection
- [ ] **Comparison of Options**
  - **React + Next.js** - Most popular, rich ecosystem, SSR support
  - **Vue 3 + Nuxt 3** - Simple, low learning cost, SSR support
  - **Svelte + SvelteKit** - Fast, small bundle size, modern
  - **Solid.js + SolidStart** - React-like, high performance, new
  - **Vanilla TS + Lit** - Lightweight, Web Components, few dependencies

- [ ] **Evaluation Criteria**
  - Build size (constraints in edge environment)
  - Development speed & productivity
  - TypeScript support
  - SSR/SSG support
  - Ecosystem (libraries, tools)
  - Cloudflare Pages integration

- [ ] **Recommendation**: Svelte + SvelteKit or Solid.js
  - Reason: Lightweight, fast, modern, edge-optimized

- Comment: We'll use Svelte + SvelteKit Ver.5.

#### 1.2 CSS Framework Selection
- [ ] **Comparison of Options**
  - **Tailwind CSS** - Utility-first, easy to customize
  - **UnoCSS** - Tailwind-compatible, fast, lightweight
  - **Panda CSS** - Zero-runtime, type-safe, fast
  - **Vanilla Extract** - CSS-in-TypeScript, type-safe
  - **shadcn/ui + Tailwind** - With component library

- [ ] **Evaluation Criteria**
  - Bundle size
  - Developer experience (DX)
  - Dark mode support
  - Customizability
  - Performance

- [ ] **Recommendation**: Tailwind CSS or UnoCSS
  - Reason: Proven track record, ecosystem, fast

- Comment: We'll use UnoCSS

#### 1.3 UI Component Library
- [ ] **Comparison of Options**
  - **shadcn/ui** (React) - Copy-paste type, easy to customize
  - **Melt UI** (Svelte) - Headless, accessible
  - **Kobalte** (Solid.js) - Headless, accessible
  - **Radix UI** (React) - Headless, accessible
  - **Custom** - Full control, lightweight

- [ ] **Evaluation Criteria**
  - Accessibility (ARIA support)
  - Customizability
  - Bundle size
  - Documentation quality
  - Number of required components

- [ ] **Recommendation**: Melt UI (Svelte) or Kobalte (Solid.js)
  - Reason: Headless, lightweight, accessible

- Comment: We'll use Melt UI.

### 2️⃣ Backend Architecture

#### 2.1 UI Hosting Method
- [ ] **Comparison of Options**
  - **Option A: Cloudflare Pages** (Separate deployment)
    - Pros: CDN optimization, independent deployment, fast static asset delivery
    - Cons: Separate management, CORS configuration required

  - **Option B: Serve from Workers** (Same Worker)
    - Pros: Unified management, no CORS needed, simple
    - Cons: Worker size limits, inefficient static asset delivery

  - **Option C: Hybrid** (API=Workers, UI=Pages)
    - Pros: Leverage strengths of each technology, optimal performance
    - Cons: Complex, deployment management

- [ ] **Evaluation Criteria**
  - Performance
  - Ease of management
  - Cost
  - Scalability

- [ ] **Recommendation**: Option C (Hybrid)
  - Reason: Optimal performance, clean separation

- Comment: We'll use Option C

#### 2.2 API Design
- [ ] **Additional Endpoints Required**
  - `POST /auth/passkey/register` - Start Passkey registration
  - `POST /auth/passkey/verify` - Verify Passkey
  - `POST /auth/magic-link/send` - Send Magic Link
  - `POST /auth/magic-link/verify` - Verify Magic Link
  - `GET /auth/consent` - Get consent screen data
  - `POST /auth/consent` - Confirm consent
  - `GET /admin/users` - List users
  - `POST /admin/users` - Create user
  - `PUT /admin/users/:id` - Update user
  - `DELETE /admin/users/:id` - Delete user
  - `GET /admin/clients` - List clients
  - `POST /admin/clients` - Create client (extend existing DCR)
  - `PUT /admin/clients/:id` - Update client
  - `DELETE /admin/clients/:id` - Delete client
  - `GET /admin/stats` - Statistics

  **ITP-Compatible Cross-Domain SSO (Added 2025-11-12)**
  - `POST /auth/session/token` - Issue short-lived token (5min TTL, single-use)
  - `POST /auth/session/verify` - Verify short-lived token & establish RP session
  - `GET /session/status` - Check IdP session validity (iframe check_session_iframe alternative)
  - `POST /session/refresh` - Extend session (Active TTL-based session)

  **Logout Functionality (Added 2025-11-12)**
  - `GET /logout` - Front-channel Logout (Browser → OP)
  - `POST /logout/backchannel` - Back-channel Logout (OP → RP, RFC recommended)

  **Admin Session Management (Added 2025-11-12)**
  - `GET /admin/sessions` - List sessions (by User/Device)
  - `POST /admin/sessions/:id/revoke` - Force logout individual session

- Comment: What about user search?
  - **Answer**: Add the following endpoint
    - `GET /admin/users?q={query}&filter={status}&sort={field}&page={n}&limit={limit}`
      - `q`: Search query (search by email, name)
      - `filter`: `verified`, `unverified`, `active`, `inactive`
      - `sort`: `created_at`, `last_login_at`, `email`, `name` (default: `-created_at`)
      - `page`: Page number (default: 1)
      - `limit`: Items per page (default: 50, max: 100)

- [ ] **Authentication Methods**
  - Admin API: Bearer Token (dedicated admin token)
  - Session management: Cookie + CSRF Token

- Comment: Good, but leave room for SAML/LDAP authentication later.
  - **Answer**: Phase 5 implements Bearer Token + Cookie + CSRF. Add the following for future extensibility:
    - `identity_providers` table (store SAML/LDAP configurations)
    - `users.identity_provider_id` column (link to external authentication)
    - SAML/LDAP implementation planned for Phase 7

- [ ] **トークン交換系API（検討中・2025-11-12追加）**
  - **現在の実装状況**:
    - `POST /token` (grant_type=authorization_code) ✅ 実装済み
    - `POST /token` (grant_type=refresh_token) ✅ 実装済み
  - **将来検討すべきトークン交換メカニズム**:
    - **RFC 8693 Token Exchange** - 標準的なトークン交換プロトコル（最も柔軟）
      - セッショントークン → アクセストークン（ITP対応SSO用）
      - アクセストークン → アクセストークン（スコープ変更）
      - IDトークン → アクセストークン（トークン変換）
      - Delegation、Impersonation対応
    - **専用セッション交換API** - ITP対応SSO特化のシンプルなAPI
      - `POST /auth/session/exchange` - セッショントークンをアクセストークンに交換
    - **Hybrid アプローチ** - RFC 8693（汎用）+ 専用API（使いやすさ）の両方をサポート
  - **決定**: Phase 5実装時に要件を整理して最終決定
  - **メモ**: 上記の `/auth/session/token` と `/auth/session/verify` は Token Exchange の一形態として実装可能

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

- コメント：異なるドメインでのSSOに対応できる形がいい。要検討
  - **決定**: **サーバー側セッション + トークン交換方式**
    - 同一ドメイン: HttpOnly Cookie でセッション管理
    - クロスドメインSSO: トークン交換方式
      1. IdP側でセッション保持（KV/DO）
      2. クライアントアプリは`/auth/session/token`にリダイレクト
      3. IdPが短命トークン（5分TTL）を発行してクライアントへリダイレクト
      4. クライアントがトークンを検証してセッションCookie発行
    - **メリット**: ITP完全対応（サードパーティCookie不使用）、即座にセッション無効化可能、セキュリティ高
    - セッションデータ: KV（短期）+ DO（強い一貫性が必要な場合）

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

- コメント：まだ全然考えてないけど、AzureやAWSにも入れられるように抽象化はしてほしい。
  - **回答**: アダプターパターンで実装
    ```typescript
    interface IStorageAdapter {
      // KV-like operations
      get(key: string): Promise<any>
      set(key: string, value: any, ttl?: number): Promise<void>
      delete(key: string): Promise<void>

      // SQL-like operations
      query(sql: string, params: any[]): Promise<any[]>
      execute(sql: string, params: any[]): Promise<void>
    }

    // 実装例
    class CloudflareAdapter implements IStorageAdapter { ... }
    class AzureCosmosAdapter implements IStorageAdapter { ... }
    class AWSRDSAdapter implements IStorageAdapter { ... }
    class PostgreSQLAdapter implements IStorageAdapter { ... }
    ```

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

- コメント：管理者が好きなカラムを設置できるように。例えばバーコード番号など。あとアカウント間で親子関係が作れるようにしてほしい。
  - **決定**: **Hybrid方式**（専用テーブル + JSONカラム）
    ```sql
    -- 親子関係
    ALTER TABLE users ADD COLUMN parent_user_id TEXT REFERENCES users(id);
    CREATE INDEX idx_users_parent_user_id ON users(parent_user_id);

    -- カスタムフィールド（検索不要なデータ用）
    ALTER TABLE users ADD COLUMN custom_attributes_json TEXT;
    -- 例: '{"social_provider_data": {...}, "preferences": {...}}'

    -- カスタムフィールド（検索可能にしたいデータ用）
    CREATE TABLE user_custom_fields (
      user_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      field_value TEXT,
      field_type TEXT, -- 'string', 'number', 'date', 'boolean'
      searchable INTEGER DEFAULT 1,
      PRIMARY KEY (user_id, field_name),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_user_custom_fields_search ON user_custom_fields(field_name, field_value);
    ```
  - **使い分け**:
    - JSON: ソーシャルプロバイダーの生データ、検索不要なメタデータ
    - 専用テーブル: 検索可能にしたいフィールド（barcode、employee_idなど）
  - **コスト**: ほぼ同じ（D1は行数ベース課金、必要な部分だけ専用テーブル使用で最適化）

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

- コメント：この辺のスキーマーは後から変更できるの？追加、削除、変更の制約を教えて。
  - **回答**: D1 (SQLite) のスキーマ変更制約
    - ✅ **追加**: 新しいカラム追加は可能 (`ALTER TABLE ADD COLUMN`)
    - ✅ **削除**: カラム削除は制限あり (SQLite 3.35.0+ で `DROP COLUMN` 対応、D1も対応予定)
    - ⚠️ **変更**: カラム型変更は直接不可（新カラム作成→データコピー→旧カラム削除）
    - ✅ **インデックス**: 追加・削除は自由（`CREATE INDEX`, `DROP INDEX`）
  - **マイグレーション戦略**:
    - バージョン管理されたSQLマイグレーションファイル（`migrations/001_initial.sql`等）
    - Rollback用のダウンマイグレーション
    - テスト環境での事前検証
    - ゼロダウンタイムマイグレーション（Blue-Green Deployment）

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

- コメント：基本Bでいいのですが、Option Aも使えるようにしてほしい。
  - **決定**: アダプターパターンで実装
    ```typescript
    interface IEmailProvider {
      send(to: string, subject: string, html: string, from?: string): Promise<void>
    }

    class ResendProvider implements IEmailProvider { ... }
    class PostmarkProvider implements IEmailProvider { ... }
    class CloudflareEmailProvider implements IEmailProvider { ... }
    class SMTPProvider implements IEmailProvider { ... }
    ```
  - 環境変数で切り替え: `EMAIL_PROVIDER=resend|cloudflare|smtp`
  - Phase 5では Resend をデフォルト実装、他プロバイダーは管理画面から設定可能に

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
  - Enraiロゴ表示
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

- コメント：多言語対応か最初から実施。テンプレート的なものもいいけど、Auth0とかだと背景とかデザインとかの自由度が低いという話も聞く。自由にリンクや画像、動画、CSS,Javascriptなどが書ける環境にしたい。これは他の画面でも同様。モダンかつ自由度があるものは何か？要検討。reCapchaはCloudflareのやつを使いましょう。
  - **決定**:
    - **Phase 5実装**: テーマシステム（基本カスタマイズ）
      ```sql
      CREATE TABLE branding_settings (
        id TEXT PRIMARY KEY DEFAULT 'default',
        custom_css TEXT,
        custom_html_header TEXT,
        custom_html_footer TEXT,
        logo_url TEXT,
        background_image_url TEXT,
        primary_color TEXT DEFAULT '#3B82F6',
        secondary_color TEXT DEFAULT '#10B981',
        font_family TEXT DEFAULT 'Inter',
        updated_at INTEGER NOT NULL
      );
      ```
    - **Phase 7実装**: WebSDK（高度なカスタマイズ）
      - Web Components として提供
      - カスタマイズ可能なプレースホルダー（`<$$$LoginEmailInput$$$>`等）
      - 完全にスタイリング可能
      - イベントハンドラー対応
    - **Captcha**: Cloudflare Turnstile を使用（reCAPTCHA互換、プライバシー重視）
    - **多言語**: Phase 5から実装（英語・日本語）、Paraglide使用（型安全、軽量）

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
  - 「{Client Name} wants to access your Enrai account」
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

- コメント：利用規約やプライバシーポリシーの掲載ができるように。
  - **回答**: `oauth_clients`テーブルに既に以下が定義済み:
    - `policy_uri` - プライバシーポリシーURL
    - `tos_uri` - 利用規約URL
  - これらを同意画面に表示し、ユーザーがクリックできるようにリンク表示

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

- コメント：Just Ideaだけど、シムシティみたいなUIはどうかな？入り口と出口があり、どのようなパーツ（認証方式）を選ぶか、建物を設置する。RPやSAMLなど外部認証は港や空港で示す。どこを経由して、またはどこに任意で何かしらのアクションをするのか、建物をクリックすると詳細画面に。シムシティ2000みたいなUI.
  - **回答**: 素晴らしいアイデア！Phase 5では標準的なダッシュボードUIを実装し、Phase 7で視覚的な実験を実施。
  - **Phase 7実装予定**:
    - ビジュアル認証フロービルダー（SimCity風UI）
    - ドラッグ&ドロップで認証フローを構築
    - 各コンポーネント（Passkey、Magic Link、Social Login等）を「建物」として配置
    - フロー全体を視覚化（入口→認証→出口）
  - **ロードマップに記載**: Phase 7の高度な管理機能として追加

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

- コメント：外部からのデータインポート、ETL機能をつけたい。後でもいいけど。
  - **回答**: Phase 6または7で実装予定
    - CSV/JSONインポート/エクスポート
    - SCIM 2.0 プロトコル対応（Phase 7）
    - Webhook連携
    - バルクユーザー操作API
  - **ロードマップに記載**: Phase 7のエンタープライズ機能として追加

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

- コメント：スコープはDB上の好きなスキーマを取得してclaimを作れるようにする。
  - **決定**:
    ```sql
    CREATE TABLE scope_mappings (
      scope TEXT PRIMARY KEY,
      claim_name TEXT NOT NULL,
      source_table TEXT NOT NULL, -- 'users', 'user_custom_fields'
      source_column TEXT NOT NULL, -- 'email', 'custom_attributes_json.employee_id'
      transformation TEXT, -- 'uppercase', 'lowercase', 'hash', 'mask'
      condition TEXT, -- SQL WHERE条件（オプション）
      created_at INTEGER NOT NULL
    );
    ```
  - **例**:
    - `scope=employee_id` → `claim: { employee_id: users.custom_attributes_json.employee_id }`
    - `scope=department` → `claim: { department: user_custom_fields[department] }`
  - 管理画面でスコープとクレームのマッピングを設定可能に

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

- コメント：データはExportできるように。
  - **回答**: 管理画面に以下を追加
    - CSV/JSONエクスポート（全テーブル）
    - GDPR対応（個人データエクスポート、消去権）
    - バックアップ/リストア機能
    - 自動バックアップ設定
  - **Phase 5実装**: 基本的なエクスポート機能
  - **Phase 7拡張**: GDPRオートメーション、コンプライアンスツール
  - **ロードマップに記載**: Phase 7のコンプライアンス機能として追加

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

- コメント：管理者のロールを設定できるようにして下さい。
  - **決定**: RBAC (Role-Based Access Control) 実装
    ```sql
    CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      permissions_json TEXT NOT NULL, -- ['users:read', 'users:write', 'clients:read', 'clients:write', 'settings:write']
      created_at INTEGER NOT NULL
    );

    CREATE TABLE user_roles (
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, role_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
    );
    ```
  - **デフォルトロール**:
    - **Super Admin**: 全権限
    - **Admin**: ユーザー・クライアント管理のみ
    - **Viewer**: 読み取り専用
    - **Support**: ユーザーサポート（パスワードリセット等）
  - Phase 5では簡易RBAC実装、Phase 7でABAC（Attribute-Based Access Control）に拡張

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

- コメント：これって誰の何を守るためのRate limitかな？
  - **回答**: 各エンドポイントの保護目的
    - `/login`, `/register`: **ブルートフォース攻撃**から保護（アカウント乗っ取り防止）
    - `/auth/magic-link/send`: **メール爆撃（スパム）**から保護（メール送信コスト削減、サービス悪用防止）
    - `/admin/*`: **DDoS攻撃**とリソース消費から保護（サービス可用性維持）
    - `/token`, `/userinfo`: **APIアビューズ**から保護（過剰なトークン発行・情報取得防止）
  - **管理画面実装**: Phase 5でRate Limitの統計・ログを管理画面で可視化
    - ブロックされたIPアドレス一覧
    - エンドポイントごとのリクエスト数グラフ
    - 異常検知アラート

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
   - ✅ ER図作成 → [database-schema.md](../architecture/database-schema.md)
   - ✅ API仕様書作成 → [OpenAPI 3.1](../api/openapi.yaml) | [APIガイド](../api/README.md)
   - ✅ デザインシステム策定 → [design-system.md](../design/design-system.md)
   - ✅ ワイヤーフレーム作成 → [wireframes.md](../design/wireframes.md)

4. **実装開始**
   - Week 1からタイムラインに沿って進行

---

## 参考資料

### Enraiドキュメント
- **設計資料** (✅ 完成)
  - [database-schema.md](../architecture/database-schema.md) - データベーススキーマ・ER図
  - [openapi.yaml](../api/openapi.yaml) - OpenAPI 3.1仕様書
  - [API README](../api/README.md) - APIガイド・クイックスタート
  - [API_INVENTORY.md](./API_INVENTORY.md) - APIインベントリ
  - [design-system.md](../design/design-system.md) - デザインシステム
  - [wireframes.md](../design/wireframes.md) - UI ワイヤーフレーム（全13ページ）
- **プロジェクト情報**
  - [ROADMAP.md](../ROADMAP.md) - 全体ロードマップ
  - [VISION.md](../VISION.md) - プロジェクトビジョン

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
**Status**: Planning Complete - Ready for Implementation
**Next Review**: 2026-05-01 (Phase 5 Start)

---

## 📝 決定事項サマリー

### 技術スタック
- ✅ **Frontend**: Svelte + SvelteKit v5
- ✅ **CSS**: UnoCSS
- ✅ **Components**: Melt UI
- ✅ **Hosting**: Hybrid (Cloudflare Pages + Workers)
- ✅ **Captcha**: Cloudflare Turnstile
- ✅ **i18n**: Paraglide
- ✅ **Email**: Resend (default), adapter pattern for others

### アーキテクチャ
- ✅ **セッション管理**: サーバー側セッション + トークン交換（ITP完全対応）
- ✅ **ストレージ抽象化**: IStorageAdapter interface（マルチクラウド対応）
- ✅ **カスタムフィールド**: Hybrid（専用テーブル + JSON）
- ✅ **RBAC**: roles + user_roles テーブル
- ✅ **スコープマッピング**: scope_mappings テーブル

### API追加（2025-11-12）
- 📝 **ITP対応SSO API**（4個）
  - `POST /auth/session/token` - 短命トークン発行
  - `POST /auth/session/verify` - 短命トークン検証
  - `GET /session/status` - セッション有効性確認
  - `POST /session/refresh` - セッション延命
- 📝 **Logout API**（2個）
  - `GET /logout` - Front-channel Logout
  - `POST /logout/backchannel` - Back-channel Logout
- 📝 **管理者セッション管理 API**（2個）
  - `GET /admin/sessions` - セッション一覧
  - `POST /admin/sessions/:id/revoke` - セッション無効化
- 🔄 **トークン交換系 API**（検討中）
  - RFC 8693 Token Exchange（標準、最も柔軟）
  - 専用セッション交換API（シンプル、ITP対応SSO特化）
  - Hybrid アプローチ（両方サポート）
  - 決定: Phase 5実装時に要件整理

### データベーススキーマ
- ✅ Users (with custom_attributes_json, parent_user_id)
- ✅ user_custom_fields (searchable)
- ✅ Passkeys
- ✅ Sessions
- ✅ Roles & user_roles
- ✅ scope_mappings
- ✅ branding_settings
- ✅ identity_providers (future SAML/LDAP)

### 将来の拡張（Phase 7）
- 📝 WebSDK（高度なカスタマイズ）
- 📝 Visual Flow Builder（SimCity風UI）
- 📝 GDPR automation
- 📝 CSV/JSON import/export
- 📝 SCIM 2.0
