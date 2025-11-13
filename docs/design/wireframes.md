# Enrai UI Wireframes 📐

**最終更新**: 2025-11-13
**バージョン**: 1.0.0
**ステータス**: Phase 5設計

---

## 📋 目次

1. [概要](#概要)
2. [画面遷移図](#画面遷移図)
3. [エンドユーザー向けページ](#エンドユーザー向けページ)
4. [管理者向けページ](#管理者向けページ)
5. [共通コンポーネント](#共通コンポーネント)
6. [レスポンシブ対応](#レスポンシブ対応)
7. [アクセシビリティ](#アクセシビリティ)

---

## 概要

このドキュメントは、Enrai OIDC OPの全13ページのワイヤーフレームを定義します。

### ページ一覧

| # | ページ名 | パス | カテゴリ | 優先度 |
|---|---------|------|---------|--------|
| 1 | ログイン | `/login` | エンドユーザー | 🔴 必須 |
| 2 | アカウント登録 | `/register` | エンドユーザー | 🔴 必須 |
| 3 | Magic Link送信完了 | `/magic-link-sent` | エンドユーザー | 🔴 必須 |
| 4 | Magic Link検証 | `/verify-magic-link` | エンドユーザー | 🔴 必須 |
| 5 | OAuth同意画面 | `/consent` | エンドユーザー | 🔴 必須 |
| 6 | エラーページ | `/error` | エンドユーザー | 🟡 重要 |
| 7 | 管理者ダッシュボード | `/admin` | 管理者 | 🔴 必須 |
| 8 | ユーザー管理 | `/admin/users` | 管理者 | 🔴 必須 |
| 9 | ユーザー詳細/編集 | `/admin/users/:id` | 管理者 | 🔴 必須 |
| 10 | クライアント管理 | `/admin/clients` | 管理者 | 🔴 必須 |
| 11 | クライアント詳細/編集 | `/admin/clients/:id` | 管理者 | 🟡 重要 |
| 12 | 設定 | `/admin/settings` | 管理者 | 🟡 重要 |
| 13 | Audit Log | `/admin/audit-log` | 管理者 | 🟢 推奨 |

### 設計原則

1. **シンプル & クリーン** - 余計な要素を排除
2. **モバイルファースト** - 小画面から設計
3. **Auth0/Clerkを超えるUX** - より直感的、高速
4. **アクセシビリティ優先** - WCAG 2.1 AA準拠
5. **一貫性** - デザインシステムに準拠

---

## 画面遷移図

### エンドユーザーフロー

```mermaid
graph TD
    A[アプリ] -->|認証開始| B[/login ログイン]
    B -->|新規ユーザー| C[/register 登録]
    B -->|Passkey| D[Passkey認証]
    B -->|Magic Link| E[/magic-link-sent 送信完了]

    C -->|Passkey登録| F[Passkey作成]
    C -->|Magic Link| E

    E -->|メール内リンク| G[/verify-magic-link 検証]

    D -->|成功| H[/consent 同意画面]
    F -->|成功| H
    G -->|成功| H

    H -->|許可| I[アプリへリダイレクト]
    H -->|拒否| B

    B -->|エラー| J[/error エラー]
    C -->|エラー| J
    G -->|エラー| J

    style B fill:#3B82F6,color:#fff
    style H fill:#10B981,color:#fff
    style J fill:#EF4444,color:#fff
```

### 管理者フロー

```mermaid
graph TD
    A[/admin ダッシュボード] -->|ユーザー管理| B[/admin/users 一覧]
    A -->|クライアント管理| C[/admin/clients 一覧]
    A -->|設定| D[/admin/settings]
    A -->|ログ| E[/admin/audit-log]

    B -->|詳細/編集| F[/admin/users/:id]
    B -->|新規作成| G[ユーザー作成モーダル]

    C -->|詳細/編集| H[/admin/clients/:id]
    C -->|新規作成| I[クライアント作成モーダル]

    F -->|保存| B
    F -->|削除| B

    H -->|保存| C
    H -->|削除| C

    style A fill:#3B82F6,color:#fff
    style B fill:#10B981,color:#fff
    style C fill:#10B981,color:#fff
```

---

## エンドユーザー向けページ

### Page 1: ログイン画面 (`/login`)

**目的**: パスワードレス認証（Passkey + Magic Link）

**レイアウト**:

```
┌─────────────────────────────────────────┐
│                                         │
│              [Enrai Logo]              │
│                                         │
│         Sign in to your account         │
│     Continue to access your apps        │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │ Email address                     │ │
│  │ ┌─────────────────────────────┐   │ │
│  │ │ you@example.com             │   │ │
│  │ └─────────────────────────────┘   │ │
│  └───────────────────────────────────┘ │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │  🔑  Continue with Passkey        │ │
│  └───────────────────────────────────┘ │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │  ✉️  Send Magic Link              │ │
│  └───────────────────────────────────┘ │
│                                         │
│       Don't have an account?            │
│            [Create account]             │
│                                         │
│  ─────────────────────────────────────  │
│  Protected by Cloudflare Turnstile      │
│                                         │
└─────────────────────────────────────────┘
```

**コンポーネント構成**:

```html
<main class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
  <div class="w-full max-w-md">

    <!-- Logo -->
    <div class="text-center mb-8">
      <img src="/logo.svg" alt="Enrai" class="h-12 mx-auto" />
    </div>

    <!-- Card -->
    <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6 sm:p-8">

      <!-- Header -->
      <div class="text-center mb-6">
        <h1 class="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
          Sign in to your account
        </h1>
        <p class="text-sm text-gray-600 dark:text-gray-400">
          Continue to access your apps
        </p>
      </div>

      <!-- Form -->
      <form class="space-y-4">

        <!-- Email Input -->
        <div>
          <label for="email" class="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
            Email address
          </label>
          <input
            id="email"
            type="email"
            required
            class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500"
            placeholder="you@example.com"
          />
        </div>

        <!-- Primary Button: Passkey -->
        <button
          type="button"
          class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-500 text-white font-medium rounded-lg hover:bg-primary-600 transition"
        >
          <svg class="w-5 h-5"><!-- key icon --></svg>
          Continue with Passkey
        </button>

        <!-- Secondary Button: Magic Link -->
        <button
          type="button"
          class="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-100 text-gray-700 font-medium rounded-lg hover:bg-gray-200 transition"
        >
          <svg class="w-5 h-5"><!-- mail icon --></svg>
          Send Magic Link
        </button>

      </form>

      <!-- Footer Link -->
      <div class="mt-6 text-center text-sm">
        <span class="text-gray-600 dark:text-gray-400">Don't have an account?</span>
        <a href="/register" class="text-primary-600 hover:text-primary-700 font-medium ml-1">
          Create account
        </a>
      </div>

    </div>

    <!-- Turnstile -->
    <div class="mt-4 text-center text-xs text-gray-500">
      Protected by Cloudflare Turnstile
    </div>

  </div>
</main>
```

**インタラクション**:

1. **メールアドレス入力**
   - リアルタイムバリデーション（形式チェック）
   - エラー時は赤枠 + エラーメッセージ表示

2. **Continue with Passkey**
   - クリック → WebAuthn API呼び出し
   - ローディング状態表示
   - 成功 → `/consent` へ
   - 失敗 → エラーメッセージ表示

3. **Send Magic Link**
   - クリック → `/auth/magic-link/send` API呼び出し
   - 成功 → `/magic-link-sent` へ遷移
   - 失敗 → エラーメッセージ

**状態管理**:

- `loading`: boolean - API呼び出し中
- `error`: string | null - エラーメッセージ
- `email`: string - 入力されたメールアドレス
- `emailValid`: boolean - メールアドレスの妥当性

**アクセシビリティ**:

- フォームフィールドに適切な `<label>` と `id` の紐付け
- エラーメッセージは `aria-describedby` で関連付け
- キーボード操作可能（Tab, Enter）
- ローディング状態は `aria-busy="true"`

---

### Page 2: アカウント登録画面 (`/register`)

**目的**: 新規ユーザー登録

**レイアウト**:

```
┌─────────────────────────────────────────┐
│                                         │
│              [Enrai Logo]              │
│                                         │
│         Create your account             │
│     Join thousands of users             │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │ Email address                     │ │
│  │ ┌─────────────────────────────┐   │ │
│  │ │ you@example.com             │   │ │
│  │ └─────────────────────────────┘   │ │
│  └───────────────────────────────────┘ │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │ Full name (optional)              │ │
│  │ ┌─────────────────────────────┐   │ │
│  │ │ John Doe                    │   │ │
│  │ └─────────────────────────────┘   │ │
│  └───────────────────────────────────┘ │
│                                         │
│  ☑ I agree to the Terms of Service     │
│     and Privacy Policy                  │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │  🔑  Create with Passkey          │ │
│  └───────────────────────────────────┘ │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │  ✉️  Sign up with Magic Link      │ │
│  └───────────────────────────────────┘ │
│                                         │
│       Already have an account?          │
│               [Sign in]                 │
│                                         │
└─────────────────────────────────────────┘
```

**コンポーネント構成**:

```html
<main class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
  <div class="w-full max-w-md">

    <div class="text-center mb-8">
      <img src="/logo.svg" alt="Enrai" class="h-12 mx-auto" />
    </div>

    <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6 sm:p-8">

      <div class="text-center mb-6">
        <h1 class="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
          Create your account
        </h1>
        <p class="text-sm text-gray-600 dark:text-gray-400">
          Join thousands of users
        </p>
      </div>

      <form class="space-y-4">

        <!-- Email -->
        <div>
          <label for="email" class="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
            Email address
          </label>
          <input
            id="email"
            type="email"
            required
            class="w-full px-3 py-2 border border-gray-300 rounded-lg"
            placeholder="you@example.com"
          />
        </div>

        <!-- Name (Optional) -->
        <div>
          <label for="name" class="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
            Full name <span class="text-gray-400">(optional)</span>
          </label>
          <input
            id="name"
            type="text"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg"
            placeholder="John Doe"
          />
        </div>

        <!-- Terms Checkbox -->
        <div class="flex items-start gap-2">
          <input
            id="terms"
            type="checkbox"
            required
            class="mt-1 w-4 h-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
          />
          <label for="terms" class="text-sm text-gray-600 dark:text-gray-400">
            I agree to the
            <a href="/terms" class="text-primary-600 hover:underline">Terms of Service</a>
            and
            <a href="/privacy" class="text-primary-600 hover:underline">Privacy Policy</a>
          </label>
        </div>

        <!-- Buttons -->
        <button type="button" class="w-full btn-primary">
          <svg class="w-5 h-5"><!-- key icon --></svg>
          Create with Passkey
        </button>

        <button type="button" class="w-full btn-secondary">
          <svg class="w-5 h-5"><!-- mail icon --></svg>
          Sign up with Magic Link
        </button>

      </form>

      <div class="mt-6 text-center text-sm">
        <span class="text-gray-600 dark:text-gray-400">Already have an account?</span>
        <a href="/login" class="text-primary-600 hover:text-primary-700 font-medium ml-1">
          Sign in
        </a>
      </div>

    </div>

  </div>
</main>
```

**バリデーション**:

- Email: 形式チェック、重複チェック（API呼び出し）
- Name: 任意（空でも可）
- Terms: 必須チェック

---

### Page 3: Magic Link送信完了 (`/magic-link-sent`)

**目的**: Magic Link送信完了の通知

**レイアウト**:

```
┌─────────────────────────────────────────┐
│                                         │
│              [Enrai Logo]              │
│                                         │
│               [✉️ Icon]                 │
│                                         │
│           Check your email              │
│                                         │
│   We sent a magic link to:              │
│       user@example.com                  │
│                                         │
│   Click the link in the email to        │
│   sign in to your account.              │
│                                         │
│   The link expires in 15 minutes.       │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │      Didn't receive the email?    │ │
│  │       [Resend in 30s...]          │ │
│  └───────────────────────────────────┘ │
│                                         │
│          [← Back to login]              │
│                                         │
└─────────────────────────────────────────┘
```

**コンポーネント構成**:

```html
<main class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
  <div class="w-full max-w-md text-center">

    <div class="mb-8">
      <img src="/logo.svg" alt="Enrai" class="h-12 mx-auto" />
    </div>

    <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-8">

      <!-- Icon -->
      <div class="mb-6">
        <div class="w-16 h-16 bg-primary-100 dark:bg-primary-900/20 rounded-full flex items-center justify-center mx-auto">
          <svg class="w-8 h-8 text-primary-600"><!-- mail icon --></svg>
        </div>
      </div>

      <!-- Content -->
      <h1 class="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
        Check your email
      </h1>

      <div class="space-y-3 text-sm text-gray-600 dark:text-gray-400">
        <p>
          We sent a magic link to:<br/>
          <span class="font-medium text-gray-900 dark:text-white">{email}</span>
        </p>
        <p>
          Click the link in the email to sign in to your account.
        </p>
        <p class="text-xs text-gray-500">
          The link expires in 15 minutes.
        </p>
      </div>

      <!-- Resend -->
      <div class="mt-8 p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg">
        <p class="text-sm text-gray-600 dark:text-gray-400 mb-2">
          Didn't receive the email?
        </p>
        {#if canResend}
          <button class="text-primary-600 hover:text-primary-700 font-medium text-sm">
            Resend email
          </button>
        {:else}
          <span class="text-gray-400 text-sm">
            Resend in {countdown}s...
          </span>
        {/if}
      </div>

      <!-- Back Link -->
      <a href="/login" class="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 mt-6">
        <svg class="w-4 h-4"><!-- arrow-left icon --></svg>
        Back to login
      </a>

    </div>

  </div>
</main>
```

**状態管理**:

- `email`: string - 送信先メールアドレス
- `countdown`: number - 再送可能までの秒数（30秒）
- `canResend`: boolean - 再送可能か

**インタラクション**:

- カウントダウンタイマー（30秒）
- 再送ボタン（カウントダウン終了後に有効化）
- 再送は最大3回まで

---

### Page 4: Magic Link検証 (`/verify-magic-link`)

**目的**: Magic Linkトークンの検証

**レイアウト**:

```
┌─────────────────────────────────────────┐
│                                         │
│              [Enrai Logo]              │
│                                         │
│          [⏳ Spinner Icon]              │
│                                         │
│           Verifying...                  │
│                                         │
│     Please wait while we verify         │
│         your magic link.                │
│                                         │
└─────────────────────────────────────────┘

// エラー時:

┌─────────────────────────────────────────┐
│                                         │
│              [Enrai Logo]              │
│                                         │
│               [❌ Icon]                 │
│                                         │
│         Invalid or Expired Link         │
│                                         │
│   This magic link is invalid or has     │
│   expired. Magic links are valid for    │
│   15 minutes after being sent.          │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │     Request a new magic link      │ │
│  └───────────────────────────────────┘ │
│                                         │
│          [← Back to login]              │
│                                         │
└─────────────────────────────────────────┘
```

**コンポーネント構成**:

```html
<main class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
  <div class="w-full max-w-md text-center">

    <div class="mb-8">
      <img src="/logo.svg" alt="Enrai" class="h-12 mx-auto" />
    </div>

    {#if loading}
      <!-- Loading State -->
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-8">
        <div class="mb-6">
          <svg class="w-12 h-12 text-primary-500 animate-spin mx-auto">
            <!-- spinner icon -->
          </svg>
        </div>
        <h1 class="text-xl font-semibold text-gray-900 dark:text-white mb-2">
          Verifying...
        </h1>
        <p class="text-sm text-gray-600 dark:text-gray-400">
          Please wait while we verify your magic link.
        </p>
      </div>
    {:else if error}
      <!-- Error State -->
      <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-8">
        <div class="mb-6">
          <div class="w-16 h-16 bg-error-100 dark:bg-error-900/20 rounded-full flex items-center justify-center mx-auto">
            <svg class="w-8 h-8 text-error-600"><!-- x icon --></svg>
          </div>
        </div>
        <h1 class="text-xl font-semibold text-gray-900 dark:text-white mb-4">
          Invalid or Expired Link
        </h1>
        <p class="text-sm text-gray-600 dark:text-gray-400 mb-6">
          This magic link is invalid or has expired. Magic links are valid for 15 minutes after being sent.
        </p>
        <a href="/login" class="btn-primary w-full mb-4">
          Request a new magic link
        </a>
        <a href="/login" class="text-sm text-gray-600 hover:text-gray-900">
          ← Back to login
        </a>
      </div>
    {/if}

  </div>
</main>
```

**ロジック**:

1. ページロード時に自動的にトークン検証
2. 成功 → `/consent` へリダイレクト
3. 失敗 → エラー表示

---

### Page 5: OAuth同意画面 (`/consent`)

**目的**: ユーザーによる権限付与の同意

**レイアウト**:

```
┌─────────────────────────────────────────┐
│                                         │
│              [Enrai Logo]              │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │ [Client Logo]                     │ │
│  │                                   │ │
│  │  MyApp wants to access your      │ │
│  │  Enrai account                  │ │
│  │                                   │ │
│  │  This will allow MyApp to:       │ │
│  │  ✓ View your email address       │ │
│  │  ✓ View your profile information │ │
│  │  ✓ Read your basic info          │ │
│  │                                   │ │
│  │  ─────────────────────────────   │ │
│  │                                   │ │
│  │  Signed in as:                   │ │
│  │  user@example.com                │ │
│  │  [Not you? Switch account]       │ │
│  │                                   │ │
│  │  ┌─────────────────────────────┐ │ │
│  │  │        Allow Access         │ │ │
│  │  └─────────────────────────────┘ │ │
│  │                                   │ │
│  │  ┌─────────────────────────────┐ │ │
│  │  │          Cancel             │ │ │
│  │  └─────────────────────────────┘ │ │
│  │                                   │ │
│  │  By allowing, you agree to      │ │
│  │  MyApp's [Terms] & [Privacy]    │ │
│  └───────────────────────────────────┘ │
│                                         │
└─────────────────────────────────────────┘
```

**コンポーネント構成**:

```html
<main class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4 py-8">
  <div class="w-full max-w-md">

    <div class="text-center mb-8">
      <img src="/logo.svg" alt="Enrai" class="h-12 mx-auto" />
    </div>

    <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">

      <!-- Client Info -->
      <div class="text-center mb-6">
        {#if client.logo_uri}
          <img src={client.logo_uri} alt={client.client_name} class="h-16 mx-auto mb-4 rounded" />
        {/if}
        <h1 class="text-xl font-semibold text-gray-900 dark:text-white mb-2">
          {client.client_name} wants to access your Enrai account
        </h1>
      </div>

      <!-- Permissions -->
      <div class="mb-6">
        <p class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
          This will allow {client.client_name} to:
        </p>
        <ul class="space-y-2">
          {#each scopes as scope}
            <li class="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-400">
              <svg class="w-5 h-5 text-success-500 flex-shrink-0"><!-- check icon --></svg>
              <span>{scope.description}</span>
            </li>
          {/each}
        </ul>
      </div>

      <div class="border-t border-gray-200 dark:border-gray-700 pt-6 mb-6"></div>

      <!-- User Info -->
      <div class="mb-6">
        <p class="text-xs text-gray-500 mb-2">Signed in as:</p>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-8 h-8 bg-primary-100 dark:bg-primary-900/20 rounded-full flex items-center justify-center">
              <span class="text-sm font-medium text-primary-600">{user.name[0]}</span>
            </div>
            <span class="text-sm font-medium text-gray-900 dark:text-white">{user.email}</span>
          </div>
          <button class="text-xs text-primary-600 hover:text-primary-700">
            Not you?
          </button>
        </div>
      </div>

      <!-- Actions -->
      <div class="space-y-3">
        <button class="w-full btn-primary">
          Allow Access
        </button>
        <button class="w-full btn-secondary">
          Cancel
        </button>
      </div>

      <!-- Footer -->
      {#if client.tos_uri || client.policy_uri}
        <p class="text-xs text-center text-gray-500 mt-4">
          By allowing, you agree to {client.client_name}'s
          {#if client.tos_uri}
            <a href={client.tos_uri} target="_blank" class="text-primary-600 hover:underline">Terms</a>
          {/if}
          {#if client.tos_uri && client.policy_uri} & {/if}
          {#if client.policy_uri}
            <a href={client.policy_uri} target="_blank" class="text-primary-600 hover:underline">Privacy Policy</a>
          {/if}
        </p>
      {/if}

    </div>

  </div>
</main>
```

**データ**:

- `client`: クライアント情報（名前、ロゴ、ポリシーURL）
- `user`: 現在ログイン中のユーザー情報
- `scopes`: 要求されるスコープと説明

**インタラクション**:

- **Allow**: 同意してリダイレクト
- **Cancel**: 拒否してエラーでリダイレクト
- **Not you?**: ログアウトして再ログイン

---

### Page 6: エラーページ (`/error`)

**目的**: 一般的なエラーの表示

**レイアウト**:

```
┌─────────────────────────────────────────┐
│                                         │
│              [Enrai Logo]              │
│                                         │
│               [⚠️ Icon]                 │
│                                         │
│          Something went wrong           │
│                                         │
│   {error_description}                   │
│                                         │
│   Error code: {error}                   │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │        Back to login              │ │
│  └───────────────────────────────────┘ │
│                                         │
│   Need help? [Contact support]          │
│                                         │
└─────────────────────────────────────────┘
```

**コンポーネント構成**:

```html
<main class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
  <div class="w-full max-w-md text-center">

    <div class="mb-8">
      <img src="/logo.svg" alt="Enrai" class="h-12 mx-auto" />
    </div>

    <div class="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-8">

      <!-- Icon -->
      <div class="mb-6">
        <div class="w-16 h-16 bg-warning-100 dark:bg-warning-900/20 rounded-full flex items-center justify-center mx-auto">
          <svg class="w-8 h-8 text-warning-600"><!-- alert-triangle icon --></svg>
        </div>
      </div>

      <!-- Content -->
      <h1 class="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
        Something went wrong
      </h1>

      <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
        {error_description || 'An unexpected error occurred. Please try again.'}
      </p>

      <div class="inline-block px-3 py-1 bg-gray-100 dark:bg-gray-900/50 rounded text-xs text-gray-500 font-mono mb-6">
        Error: {error || 'unknown_error'}
      </div>

      <!-- Actions -->
      <a href="/login" class="btn-primary w-full mb-4">
        Back to login
      </a>

      <!-- Support Link -->
      <a href="mailto:support@example.com" class="text-sm text-primary-600 hover:text-primary-700">
        Need help? Contact support
      </a>

    </div>

  </div>
</main>
```

**エラーコード**:

- `invalid_request`
- `access_denied`
- `server_error`
- `temporarily_unavailable`
- `magic_link_expired`
- カスタムエラーコード

---

## 管理者向けページ

### Page 7: 管理者ダッシュボード (`/admin`)

**目的**: システム全体の概要と統計

**レイアウト**:

```
┌─────────────────────────────────────────────────────────────────┐
│ [≡] Enrai Admin                      [🔍] [🔔] [👤 Admin ▾]   │
├──────────┬──────────────────────────────────────────────────────┤
│          │  Dashboard                                           │
│ 📊 Dash  │                                                      │
│ 👥 Users │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐│
│ 🔑 Client│  │  Users   │ │ Active   │ │  Logins  │ │Clients  ││
│ ⚙️ Setting│  │  1,234   │ │ Sessions │ │  Today   │ │   45    ││
│ 📝 Logs  │  │  +12%    │ │   156    │ │   892    │ │  +3     ││
│          │  └──────────┘ └──────────┘ └──────────┘ └─────────┘│
│          │                                                      │
│          │  Recent Activity                                    │
│          │  ┌──────────────────────────────────────────────┐  │
│          │  │ 🟢 user@example.com logged in     2m ago    │  │
│          │  │ 🟡 New user registered             5m ago    │  │
│          │  │ 🔵 Client "MyApp" created          10m ago   │  │
│          │  │ 🔴 Failed login attempt            15m ago   │  │
│          │  └──────────────────────────────────────────────┘  │
│          │                                                      │
│          │  User Growth                                         │
│          │  [Chart: Line graph showing growth]                 │
│          │                                                      │
└──────────┴──────────────────────────────────────────────────────┘
```

**コンポーネント構成**:

```html
<div class="min-h-screen bg-gray-50 dark:bg-gray-900">

  <!-- Top Bar -->
  <header class="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 sticky top-0 z-10">
    <div class="flex items-center justify-between px-4 py-3">
      <div class="flex items-center gap-4">
        <button class="lg:hidden">
          <svg class="w-6 h-6"><!-- menu icon --></svg>
        </button>
        <h1 class="text-xl font-semibold text-gray-900 dark:text-white">
          Enrai Admin
        </h1>
      </div>
      <div class="flex items-center gap-3">
        <button class="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">
          <svg class="w-5 h-5"><!-- search icon --></svg>
        </button>
        <button class="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg relative">
          <svg class="w-5 h-5"><!-- bell icon --></svg>
          <span class="absolute top-1 right-1 w-2 h-2 bg-error-500 rounded-full"></span>
        </button>
        <button class="flex items-center gap-2 p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">
          <div class="w-8 h-8 bg-primary-100 dark:bg-primary-900/20 rounded-full flex items-center justify-center">
            <span class="text-sm font-medium text-primary-600">A</span>
          </div>
          <span class="text-sm font-medium hidden sm:block">Admin</span>
          <svg class="w-4 h-4"><!-- chevron-down icon --></svg>
        </button>
      </div>
    </div>
  </header>

  <div class="flex">

    <!-- Sidebar -->
    <aside class="w-64 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 hidden lg:block">
      <nav class="p-4 space-y-1">
        <a href="/admin" class="flex items-center gap-3 px-3 py-2 bg-primary-50 dark:bg-primary-900/20 text-primary-600 rounded-lg">
          <svg class="w-5 h-5"><!-- dashboard icon --></svg>
          <span class="font-medium">Dashboard</span>
        </a>
        <a href="/admin/users" class="flex items-center gap-3 px-3 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">
          <svg class="w-5 h-5"><!-- users icon --></svg>
          <span>Users</span>
        </a>
        <a href="/admin/clients" class="flex items-center gap-3 px-3 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">
          <svg class="w-5 h-5"><!-- key icon --></svg>
          <span>Clients</span>
        </a>
        <a href="/admin/settings" class="flex items-center gap-3 px-3 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">
          <svg class="w-5 h-5"><!-- settings icon --></svg>
          <span>Settings</span>
        </a>
        <a href="/admin/audit-log" class="flex items-center gap-3 px-3 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg">
          <svg class="w-5 h-5"><!-- file-text icon --></svg>
          <span>Audit Log</span>
        </a>
      </nav>
    </aside>

    <!-- Main Content -->
    <main class="flex-1 p-6">

      <h2 class="text-2xl font-semibold text-gray-900 dark:text-white mb-6">
        Dashboard
      </h2>

      <!-- Stats Cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">

        <div class="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
          <div class="flex items-center justify-between mb-2">
            <p class="text-sm text-gray-600 dark:text-gray-400">Total Users</p>
            <svg class="w-5 h-5 text-primary-500"><!-- users icon --></svg>
          </div>
          <p class="text-3xl font-bold text-gray-900 dark:text-white">1,234</p>
          <p class="text-xs text-success-600 mt-1">+12% from last month</p>
        </div>

        <div class="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
          <div class="flex items-center justify-between mb-2">
            <p class="text-sm text-gray-600 dark:text-gray-400">Active Sessions</p>
            <svg class="w-5 h-5 text-success-500"><!-- activity icon --></svg>
          </div>
          <p class="text-3xl font-bold text-gray-900 dark:text-white">156</p>
        </div>

        <div class="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
          <div class="flex items-center justify-between mb-2">
            <p class="text-sm text-gray-600 dark:text-gray-400">Logins Today</p>
            <svg class="w-5 h-5 text-info-500"><!-- log-in icon --></svg>
          </div>
          <p class="text-3xl font-bold text-gray-900 dark:text-white">892</p>
        </div>

        <div class="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
          <div class="flex items-center justify-between mb-2">
            <p class="text-sm text-gray-600 dark:text-gray-400">OAuth Clients</p>
            <svg class="w-5 h-5 text-warning-500"><!-- key icon --></svg>
          </div>
          <p class="text-3xl font-bold text-gray-900 dark:text-white">45</p>
          <p class="text-xs text-success-600 mt-1">+3 this week</p>
        </div>

      </div>

      <!-- Recent Activity -->
      <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 mb-8">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Recent Activity
        </h3>
        <div class="space-y-3">
          <div class="flex items-center gap-3 text-sm">
            <div class="w-2 h-2 bg-success-500 rounded-full"></div>
            <span class="text-gray-900 dark:text-white">user@example.com logged in</span>
            <span class="text-gray-500 ml-auto">2m ago</span>
          </div>
          <div class="flex items-center gap-3 text-sm">
            <div class="w-2 h-2 bg-warning-500 rounded-full"></div>
            <span class="text-gray-900 dark:text-white">New user registered</span>
            <span class="text-gray-500 ml-auto">5m ago</span>
          </div>
          <div class="flex items-center gap-3 text-sm">
            <div class="w-2 h-2 bg-info-500 rounded-full"></div>
            <span class="text-gray-900 dark:text-white">Client "MyApp" created</span>
            <span class="text-gray-500 ml-auto">10m ago</span>
          </div>
          <div class="flex items-center gap-3 text-sm">
            <div class="w-2 h-2 bg-error-500 rounded-full"></div>
            <span class="text-gray-900 dark:text-white">Failed login attempt</span>
            <span class="text-gray-500 ml-auto">15m ago</span>
          </div>
        </div>
      </div>

      <!-- Chart -->
      <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          User Growth
        </h3>
        <!-- Chart component (use Chart.js or similar) -->
        <div class="h-64 flex items-center justify-center text-gray-400">
          [Chart: Line graph]
        </div>
      </div>

    </main>

  </div>

</div>
```

**データ**:

- リアルタイムまたは定期更新（5分ごと）
- `/admin/stats` APIから取得

---

### Page 8: ユーザー管理 (`/admin/users`)

**目的**: ユーザーの一覧・検索・CRUD

**レイアウト**:

```
┌─────────────────────────────────────────────────────────────────┐
│ [≡] Enrai Admin                      [🔍] [🔔] [👤 Admin ▾]   │
├──────────┬──────────────────────────────────────────────────────┤
│          │  Users                                               │
│ 📊 Dash  │                                                      │
│ 👥 Users │  [🔍 Search users...]     [Filter ▾]  [+ New User]  │
│ 🔑 Client│                                                      │
│ ⚙️ Setting│  ┌────────────────────────────────────────────────┐│
│ 📝 Logs  │  │ Email          │ Name    │ Created  │ Status   ││
│          │  ├────────────────────────────────────────────────┤│
│          │  │ user@ex.com    │ John D  │ 2d ago   │ ✓ Active ││
│          │  │ jane@ex.com    │ Jane S  │ 5d ago   │ ✓ Active ││
│          │  │ bob@ex.com     │ Bob M   │ 10d ago  │ ⚠ Pend   ││
│          │  └────────────────────────────────────────────────┘│
│          │                                                      │
│          │  [← Previous]  Page 1 of 25  [Next →]               │
│          │                                                      │
└──────────┴──────────────────────────────────────────────────────┘
```

**コンポーネント構成**:

```html
<main class="flex-1 p-6">

  <!-- Header -->
  <div class="flex items-center justify-between mb-6">
    <h2 class="text-2xl font-semibold text-gray-900 dark:text-white">
      Users
    </h2>
    <button class="btn-primary flex items-center gap-2">
      <svg class="w-5 h-5"><!-- plus icon --></svg>
      New User
    </button>
  </div>

  <!-- Search & Filters -->
  <div class="flex gap-3 mb-6">
    <div class="flex-1 relative">
      <input
        type="search"
        placeholder="Search users..."
        class="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg"
      />
      <svg class="w-5 h-5 absolute left-3 top-2.5 text-gray-400"><!-- search icon --></svg>
    </div>
    <button class="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50">
      <svg class="w-5 h-5"><!-- filter icon --></svg>
    </button>
  </div>

  <!-- Table -->
  <div class="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
    <table class="w-full">
      <thead class="bg-gray-50 dark:bg-gray-900/50">
        <tr>
          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Email</th>
          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
          <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
          <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
        {#each users as user}
          <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
            <td class="px-6 py-4 text-sm font-medium text-gray-900 dark:text-white">
              {user.email}
            </td>
            <td class="px-6 py-4 text-sm text-gray-600 dark:text-gray-400">
              {user.name || '-'}
            </td>
            <td class="px-6 py-4 text-sm text-gray-600 dark:text-gray-400">
              {formatDate(user.created_at)}
            </td>
            <td class="px-6 py-4">
              {#if user.email_verified}
                <span class="badge-success">Active</span>
              {:else}
                <span class="badge-warning">Pending</span>
              {/if}
            </td>
            <td class="px-6 py-4 text-right">
              <button class="text-primary-600 hover:text-primary-700 text-sm font-medium">
                Edit
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <!-- Pagination -->
  <div class="flex items-center justify-between mt-6">
    <button class="btn-secondary" disabled={page === 1}>
      ← Previous
    </button>
    <span class="text-sm text-gray-600 dark:text-gray-400">
      Page {page} of {totalPages}
    </span>
    <button class="btn-secondary" disabled={page === totalPages}>
      Next →
    </button>
  </div>

</main>
```

**機能**:

- 検索（email, name）
- フィルター（verified/unverified, active/inactive）
- ソート（created_at, last_login_at, email）
- ページネーション（50件/ページ）

---

### Page 9-13: 残りの管理者ページ

残りのページ（ユーザー詳細、クライアント管理、設定、Audit Log）も同様のパターンで設計されます。詳細は省略しますが、共通要素：

- サイドバーナビゲーション
- トップバー（検索、通知、プロファイル）
- データテーブル（検索、フィルター、ソート、ページネーション）
- CRUD操作（作成、読み取り、更新、削除）
- モーダルダイアログ
- トースト通知

---

## 共通コンポーネント

### ナビゲーション

- トップバー（ロゴ、検索、通知、ユーザーメニュー）
- サイドバー（管理者ページのみ）
- モバイルメニュー（ハンバーガー）

### フォーム要素

- Input（text, email, password, etc.）
- Textarea
- Select / Dropdown
- Checkbox
- Radio
- Toggle Switch

### フィードバック

- Alert（success, warning, error, info）
- Toast通知
- Loading Spinner
- Skeleton Loader
- Progress Bar

### データ表示

- Table（ソート、ページネーション）
- Card
- Badge
- Avatar
- Empty State

### オーバーレイ

- Modal / Dialog
- Dropdown Menu
- Tooltip
- Popover

---

## レスポンシブ対応

### ブレークポイント

| デバイス | 幅 | レイアウト |
|---------|-----|-----------|
| モバイル | < 640px | 1列、スタック |
| タブレット | 640-1024px | 2列、一部サイドバー折りたたみ |
| デスクトップ | > 1024px | フル機能、サイドバー表示 |

### モバイル最適化

- タッチターゲット最小44x44px
- スワイプジェスチャー対応
- オフキャンバスメニュー
- 縦スクロール優先

---

## アクセシビリティ

### キーボード操作

- Tab: フォーカス移動
- Enter/Space: ボタン実行
- Esc: モーダル閉じる
- Arrow keys: ドロップダウンナビゲーション

### スクリーンリーダー

- セマンティックHTML
- ARIA属性（role, aria-label, aria-describedby）
- ライブリージョン（aria-live）
- フォーカス管理

### カラーコントラスト

- WCAG 2.1 AA準拠
- 4.5:1以上（通常テキスト）
- 3:1以上（大テキスト、UI）

---

## 参考資料

### 関連ドキュメント

- [design-system.md](./design-system.md) - デザインシステム
- [database-schema.md](../architecture/database-schema.md) - データベーススキーマ
- [openapi.yaml](../api/openapi.yaml) - API仕様書
- [PHASE5_PLANNING.md](../project-management/PHASE5_PLANNING.md) - Phase 5計画

### デザインインスピレーション

- [Auth0 Universal Login](https://auth0.com/docs/universal-login)
- [Clerk Components](https://clerk.com/docs/components/overview)
- [Supabase Auth UI](https://supabase.com/docs/guides/auth/auth-ui)
- [Tailwind UI](https://tailwindui.com/)

---

**変更履歴**:
- 2025-11-13: 初版作成（Phase 5設計）
