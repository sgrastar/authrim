# Enrai Design System 🎨

**Last Updated**: 2025-11-13
**Version**: 1.0.0
**Status**: Phase 5 Design

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Design Principles](#design-principles)
3. [Color System](#color-system)
4. [Typography](#typography)
5. [Spacing](#spacing)
6. [Grid System](#grid-system)
7. [Components](#components)
8. [Icons](#icons)
9. [Animation](#animation)
10. [Accessibility](#accessibility)
11. [Dark Mode](#dark-mode)
12. [Responsive Design](#responsive-design)

---

## Overview

Enrai Design System is a unified design language.

### Design Goals

1. **Simple & Intuitive** - Eliminate complexity, create UI that users never get lost in
2. **Fast & Lightweight** - Edge optimized, minimized bundle size
3. **Accessible** - WCAG 2.1 AA compliant, usable by everyone
4. **Modern & Beautiful** - Latest design trends of 2025
5. **Customizable** - Flexibly changeable via branding settings

### Tech Stack

| Category | Technology | Reason |
|---------|------|------|
| **CSS Framework** | UnoCSS | Lightweight, Tailwind compatible, fast |
| **Components** | Melt UI (Svelte) | Headless, accessible, lightweight |
| **Framework** | SvelteKit v5 | Fast, small bundle, SSR support |
| **i18n** | Paraglide | Type-safe, lightweight |
| **Captcha** | Cloudflare Turnstile | Privacy-focused, reCAPTCHA compatible |

### Design Token Management

All design tokens are defined in UnoCSS configuration and output as CSS variables:

```typescript
// uno.config.ts
export default defineConfig({
  theme: {
    colors: { /* Color palette */ },
    fontFamily: { /* Fonts */ },
    spacing: { /* Spacing */ },
  }
})
```

---

## Design Principles

### 1. Clarity over Cleverness
- Prioritize clarity, avoid tricky UI
- Information architecture understandable at a glance

### 2. Speed & Efficiency
- Page load < 1 second
- Interactions respond instantly (60fps)
- Eliminate unnecessary animations

### 3. Consistency & Predictability
- Same patterns look the same
- Don't betray user expectations

### 4. Progressive Enhancement
- Basic functionality works without JavaScript
- Rich experiences added gradually

### 5. Inclusive by Default
- Full keyboard navigation support
- Screen reader compatible
- Compliant with color contrast standards

---

## Color System

### Primary Color

**Blue** - Trustworthiness, security, professional

| Name | Light Mode | Dark Mode | Usage |
|------|-----------|-----------|------|
| `primary-50` | `#EFF6FF` | `#1E3A5F` | Background, hover |
| `primary-100` | `#DBEAFE` | `#2C5282` | Background accent |
| `primary-200` | `#BFDBFE` | `#2B6CB0` | Border |
| `primary-300` | `#93C5FD` | `#3182CE` | Disabled state |
| `primary-400` | `#60A5FA` | `#4299E1` | Hover |
| `primary-500` | `#3B82F6` | `#4299E1` | **Main (default)** |
| `primary-600` | `#2563EB` | `#60A5FA` | Active |
| `primary-700` | `#1D4ED8` | `#93C5FD` | Text |
| `primary-800` | `#1E40AF` | `#BFDBFE` | - |
| `primary-900` | `#1E3A8A` | `#DBEAFE` | - |

### Secondary Color

**Green** - Success, safety, authentication complete

| Name | Light Mode | Dark Mode | Usage |
|------|-----------|-----------|------|
| `secondary-50` | `#ECFDF5` | `#1C4532` | Background |
| `secondary-100` | `#D1FAE5` | `#22543D` | Background accent |
| `secondary-500` | `#10B981` | `#48BB78` | **Main** |
| `secondary-600` | `#059669` | `#68D391` | Hover |
| `secondary-700` | `#047857` | `#9AE6B4` | Active |

### Neutral Colors

**Gray** - Text, background, border

| Name | Light Mode | Dark Mode | Usage |
|------|-----------|-----------|------|
| `gray-50` | `#F9FAFB` | `#1A202C` | 背景 |
| `gray-100` | `#F3F4F6` | `#2D3748` | カード背景 |
| `gray-200` | `#E5E7EB` | `#4A5568` | ボーダー |
| `gray-300` | `#D1D5DB` | `#718096` | ボーダー（強調） |
| `gray-400` | `#9CA3AF` | `#A0AEC0` | プレースホルダー |
| `gray-500` | `#6B7280` | `#CBD5E0` | 無効テキスト |
| `gray-600` | `#4B5563` | `#E2E8F0` | セカンダリテキスト |
| `gray-700` | `#374151` | `#EDF2F7` | メインテキスト |
| `gray-800` | `#1F2937` | `#F7FAFC` | ヘッダーテキスト |
| `gray-900` | `#111827` | `#FFFFFF` | 最も強い強調 |

### Semantic Colors

**Colors representing state**

| State | Light Mode | Dark Mode | Usage |
|------|-----------|-----------|------|
| `success-500` | `#10B981` (Green) | `#48BB78` | 成功メッセージ、認証成功 |
| `warning-500` | `#F59E0B` (Amber) | `#ECC94B` | 警告、注意喚起 |
| `error-500` | `#EF4444` (Red) | `#FC8181` | エラー、失敗 |
| `info-500` | `#3B82F6` (Blue) | `#63B3ED` | 情報、ヒント |

### カラー使用ガイドライン

```css
/* Primary - CTA、リンク、フォーカス */
.btn-primary { @apply bg-primary-500 text-white hover:bg-primary-600; }

/* Secondary - サブアクション */
.btn-secondary { @apply bg-secondary-500 text-white hover:bg-secondary-600; }

/* Neutral - キャンセル、通常ボタン */
.btn-neutral { @apply bg-gray-200 text-gray-700 hover:bg-gray-300; }

/* Success - 認証成功、完了 */
.alert-success { @apply bg-success-50 border-success-500 text-success-700; }

/* Error - エラーメッセージ */
.alert-error { @apply bg-error-50 border-error-500 text-error-700; }
```

### カスタマイズ（ブランディング設定）

管理画面から変更可能（`branding_settings`テーブル）：

```sql
UPDATE branding_settings SET
  primary_color = '#FF5733',    -- カスタムプライマリ
  secondary_color = '#28A745',  -- カスタムセカンダリ
  font_family = 'Poppins'       -- カスタムフォント
WHERE id = 'default';
```

---

## Typography

### Font Family

**Sans-serif (default)** - Clean and readable

```css
font-family: 'Inter', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', sans-serif;
```

**Monospace (code)** - Code, token display

```css
font-family: 'Fira Code', 'Consolas', 'Monaco', 'Courier New', monospace;
```

### Font Scale

| Class | Size | Line Height | Usage |
|--------|--------|-------------|------|
| `text-xs` | 12px (0.75rem) | 16px (1rem) | 補足、メタ情報 |
| `text-sm` | 14px (0.875rem) | 20px (1.25rem) | 本文（小）、ラベル |
| `text-base` | 16px (1rem) | 24px (1.5rem) | **メイン本文** |
| `text-lg` | 18px (1.125rem) | 28px (1.75rem) | 強調本文 |
| `text-xl` | 20px (1.25rem) | 28px (1.75rem) | サブ見出し |
| `text-2xl` | 24px (1.5rem) | 32px (2rem) | 見出し H3 |
| `text-3xl` | 30px (1.875rem) | 36px (2.25rem) | 見出し H2 |
| `text-4xl` | 36px (2.25rem) | 40px (2.5rem) | 見出し H1 |
| `text-5xl` | 48px (3rem) | 48px (3rem) | ヒーロー見出し |

### フォントウェイト

| クラス | Weight | 用途 |
|--------|--------|------|
| `font-normal` | 400 | 通常本文 |
| `font-medium` | 500 | 強調、ボタン |
| `font-semibold` | 600 | 見出し、ナビゲーション |
| `font-bold` | 700 | 強い強調、アラート |

### タイポグラフィ使用例

```html
<!-- ヒーロー見出し -->
<h1 class="text-4xl font-bold text-gray-900 dark:text-white">
  Welcome to Enrai
</h1>

<!-- セクション見出し -->
<h2 class="text-2xl font-semibold text-gray-800 dark:text-gray-100">
  Sign in to your account
</h2>

<!-- 本文 -->
<p class="text-base text-gray-600 dark:text-gray-300">
  Enter your email address to continue
</p>

<!-- ラベル -->
<label class="text-sm font-medium text-gray-700 dark:text-gray-200">
  Email address
</label>

<!-- エラーメッセージ -->
<p class="text-sm text-error-600 dark:text-error-400">
  Invalid email address
</p>
```

---

## Spacing

### Spacing Scale

8px-based spacing system (multiples of 8)

| クラス | サイズ | px | 用途 |
|--------|--------|-----|------|
| `0` | 0 | 0px | なし |
| `0.5` | 0.125rem | 2px | 極小 |
| `1` | 0.25rem | 4px | 最小 |
| `2` | 0.5rem | 8px | 小 |
| `3` | 0.75rem | 12px | 中 |
| `4` | 1rem | 16px | **標準** |
| `5` | 1.25rem | 20px | やや大 |
| `6` | 1.5rem | 24px | 大 |
| `8` | 2rem | 32px | 特大 |
| `10` | 2.5rem | 40px | セクション間 |
| `12` | 3rem | 48px | 大セクション間 |
| `16` | 4rem | 64px | ページ間 |
| `20` | 5rem | 80px | ヒーローセクション |

### スペーシング使用ガイドライン

```html
<!-- カード内パディング -->
<div class="p-6"><!-- 24px padding --></div>

<!-- ボタン -->
<button class="px-4 py-2"><!-- 16px横、8px縦 --></button>

<!-- フォームフィールド間 -->
<div class="space-y-4"><!-- 16px縦方向マージン --></div>

<!-- セクション間 -->
<section class="py-12"><!-- 48px上下 --></section>

<!-- ページコンテナ -->
<div class="px-4 sm:px-6 lg:px-8"><!-- レスポンシブ横パディング --></div>
```

---

## Grid System

### Container Width

| Breakpoint | Max Width | Usage |
|-----------------|--------|------|
| `xs` (< 640px) | 100% | モバイル |
| `sm` (640px+) | 640px | 小タブレット |
| `md` (768px+) | 768px | タブレット |
| `lg` (1024px+) | 1024px | デスクトップ |
| `xl` (1280px+) | 1280px | 大デスクトップ |
| `2xl` (1536px+) | 1536px | 特大画面 |

### レイアウトパターン

#### 中央寄せコンテナ

```html
<div class="container mx-auto px-4 max-w-7xl">
  <!-- コンテンツ -->
</div>
```

#### 2カラムレイアウト（サイドバー + メイン）

```html
<div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
  <aside class="lg:col-span-3"><!-- サイドバー --></aside>
  <main class="lg:col-span-9"><!-- メインコンテンツ --></main>
</div>
```

#### カードグリッド

```html
<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
  <div class="card"><!-- カード1 --></div>
  <div class="card"><!-- カード2 --></div>
  <div class="card"><!-- カード3 --></div>
</div>
```

---

## Components

### Buttons

#### Primary Button

```html
<button class="
  px-4 py-2
  bg-primary-500 text-white
  font-medium text-sm
  rounded-lg
  hover:bg-primary-600
  focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2
  disabled:opacity-50 disabled:cursor-not-allowed
  transition-colors duration-150
">
  Continue with Passkey
</button>
```

#### Secondary Button

```html
<button class="
  px-4 py-2
  bg-gray-200 text-gray-700
  font-medium text-sm
  rounded-lg
  hover:bg-gray-300
  focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-2
">
  Cancel
</button>
```

#### Ghost Button

```html
<button class="
  px-4 py-2
  text-primary-600
  font-medium text-sm
  rounded-lg
  hover:bg-primary-50
  focus:outline-none focus:ring-2 focus:ring-primary-500
">
  Back to login
</button>
```

### Input Fields

```html
<!-- Text Input -->
<div class="space-y-1">
  <label for="email" class="block text-sm font-medium text-gray-700 dark:text-gray-200">
    Email address
  </label>
  <input
    id="email"
    type="email"
    class="
      w-full px-3 py-2
      border border-gray-300 rounded-lg
      text-gray-900
      placeholder-gray-400
      focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent
      disabled:bg-gray-100 disabled:cursor-not-allowed
    "
    placeholder="you@example.com"
  />
</div>

<!-- Error State -->
<div class="space-y-1">
  <label class="block text-sm font-medium text-gray-700">Email address</label>
  <input
    type="email"
    class="
      w-full px-3 py-2
      border-2 border-error-500 rounded-lg
      text-gray-900
      focus:outline-none focus:ring-2 focus:ring-error-500
    "
    aria-invalid="true"
    aria-describedby="email-error"
  />
  <p id="email-error" class="text-sm text-error-600">
    Please enter a valid email address
  </p>
</div>
```

### Card

```html
<div class="
  bg-white dark:bg-gray-800
  border border-gray-200 dark:border-gray-700
  rounded-lg
  shadow-sm
  p-6
">
  <h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-2">
    Card Title
  </h3>
  <p class="text-gray-600 dark:text-gray-300">
    Card content goes here
  </p>
</div>
```

### Alert

```html
<!-- Success Alert -->
<div class="
  flex items-start gap-3
  p-4
  bg-success-50 dark:bg-success-900/20
  border border-success-200 dark:border-success-800
  rounded-lg
" role="alert">
  <svg class="w-5 h-5 text-success-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
    <!-- success icon -->
  </svg>
  <div>
    <p class="text-sm font-medium text-success-800 dark:text-success-200">
      Successfully authenticated!
    </p>
  </div>
</div>

<!-- Error Alert -->
<div class="
  flex items-start gap-3
  p-4
  bg-error-50 dark:bg-error-900/20
  border border-error-200 dark:border-error-800
  rounded-lg
" role="alert">
  <svg class="w-5 h-5 text-error-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
    <!-- error icon -->
  </svg>
  <div>
    <p class="text-sm font-medium text-error-800 dark:text-error-200">
      Invalid email or password
    </p>
  </div>
</div>
```

### Modal

```html
<!-- Backdrop -->
<div class="fixed inset-0 bg-gray-900/50 backdrop-blur-sm z-40"></div>

<!-- Modal -->
<div class="
  fixed inset-0 z-50
  flex items-center justify-center
  p-4
">
  <div class="
    bg-white dark:bg-gray-800
    rounded-lg
    shadow-xl
    max-w-md w-full
    p-6
  " role="dialog" aria-modal="true">
    <h2 class="text-xl font-semibold text-gray-900 dark:text-white mb-4">
      Confirm Action
    </h2>
    <p class="text-gray-600 dark:text-gray-300 mb-6">
      Are you sure you want to delete this user?
    </p>
    <div class="flex gap-3 justify-end">
      <button class="btn-secondary">Cancel</button>
      <button class="btn-primary bg-error-500 hover:bg-error-600">Delete</button>
    </div>
  </div>
</div>
```

### Badge

```html
<!-- Status Badge -->
<span class="
  inline-flex items-center
  px-2.5 py-0.5
  rounded-full
  text-xs font-medium
  bg-success-100 text-success-800
  dark:bg-success-800/20 dark:text-success-300
">
  Active
</span>

<span class="
  inline-flex items-center
  px-2.5 py-0.5
  rounded-full
  text-xs font-medium
  bg-gray-100 text-gray-800
  dark:bg-gray-700 dark:text-gray-300
">
  Inactive
</span>
```

### Loading Spinner

```html
<svg class="animate-spin h-5 w-5 text-primary-500" fill="none" viewBox="0 0 24 24">
  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
</svg>
```

### Melt UI コンポーネント統合

```svelte
<script>
  import { createDialog } from '@melt-ui/svelte'

  const {
    elements: { trigger, overlay, content, title, description, close },
    states: { open }
  } = createDialog()
</script>

<button use:melt={$trigger} class="btn-primary">
  Open Dialog
</button>

{#if $open}
  <div use:melt={$overlay} class="fixed inset-0 bg-gray-900/50 z-40" />
  <div use:melt={$content} class="modal-content">
    <h2 use:melt={$title} class="modal-title">Dialog Title</h2>
    <p use:melt={$description} class="modal-description">Dialog content</p>
    <button use:melt={$close} class="btn-secondary">Close</button>
  </div>
{/if}
```

---

## Icons

### Icon Library

**Lucide Icons** - Lightweight, open source, SVG

```bash
pnpm install lucide-svelte
```

### よく使うアイコン

| アイコン | 用途 |
|---------|------|
| `Check` | 成功、完了、選択 |
| `X` | 閉じる、エラー、削除 |
| `AlertCircle` | 警告、注意 |
| `Info` | 情報、ヘルプ |
| `Lock` | セキュリティ、認証 |
| `Mail` | メール、Magic Link |
| `Key` | Passkey、認証情報 |
| `User` | ユーザープロファイル |
| `Settings` | 設定 |
| `LogOut` | ログアウト |

### アイコン使用例

```svelte
<script>
  import { Check, AlertCircle, Mail } from 'lucide-svelte'
</script>

<!-- Success icon -->
<Check class="w-5 h-5 text-success-500" />

<!-- Alert icon -->
<AlertCircle class="w-5 h-5 text-warning-500" />

<!-- Mail icon -->
<Mail class="w-5 h-5 text-gray-400" />
```

---

## Animation

### Transitions

```css
/* 標準トランジション */
.transition-base {
  transition-property: background-color, border-color, color, fill, stroke;
  transition-duration: 150ms;
  transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
}

/* ホバーエフェクト */
.btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  transition: all 150ms ease-out;
}

/* フェードイン */
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.fade-in {
  animation: fadeIn 200ms ease-out;
}
```

### アニメーション原則

1. **控えめに** - 不必要なアニメーションは避ける
2. **高速** - 150-300msが理想
3. **意味がある** - ユーザーの理解を助けるアニメーション
4. **アクセシビリティ** - `prefers-reduced-motion` 対応

```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## Accessibility

### WCAG 2.1 AA Compliance Checklist

#### ✅ Color Contrast

| 要素 | 最低比率 | 推奨比率 |
|------|---------|---------|
| 通常テキスト (16px+) | 4.5:1 | 7:1 |
| 大テキスト (24px+) | 3:1 | 4.5:1 |
| UIコンポーネント | 3:1 | - |

**検証済みの組み合わせ**:
- `text-gray-900` on `bg-white` ✅ 21:1
- `text-gray-700` on `bg-white` ✅ 10.4:1
- `text-primary-600` on `bg-white` ✅ 7.2:1
- `text-white` on `bg-primary-500` ✅ 4.9:1

#### ✅ キーボード操作

```html
<!-- すべてのインタラクティブ要素はフォーカス可能 -->
<button tabindex="0" class="focus:ring-2 focus:ring-primary-500">
  Click me
</button>

<!-- スキップリンク -->
<a href="#main-content" class="sr-only focus:not-sr-only">
  Skip to main content
</a>

<!-- フォーカストラップ（モーダル内） -->
<div role="dialog" aria-modal="true">
  <!-- 最初のフォーカス可能要素 -->
  <button>First</button>
  <!-- コンテンツ -->
  <button>Last</button>
</div>
```

#### ✅ ARIA属性

```html
<!-- ボタン状態 -->
<button aria-pressed="true">Toggle</button>

<!-- 展開可能セクション -->
<button aria-expanded="false" aria-controls="section-1">
  Expand
</button>
<div id="section-1" hidden>Content</div>

<!-- フォームバリデーション -->
<input
  type="email"
  aria-invalid="true"
  aria-describedby="email-error"
/>
<p id="email-error" role="alert">Invalid email</p>

<!-- ローディング状態 -->
<div role="status" aria-live="polite" aria-label="Loading">
  <svg class="spinner" aria-hidden="true">...</svg>
  Loading...
</div>
```

#### ✅ セマンティックHTML

```html
<!-- 正しい見出し階層 -->
<h1>Page Title</h1>
  <h2>Section</h2>
    <h3>Subsection</h3>

<!-- ランドマーク -->
<header role="banner">
  <nav role="navigation" aria-label="Main">...</nav>
</header>
<main role="main" id="main-content">...</main>
<footer role="contentinfo">...</footer>

<!-- リスト -->
<ul role="list">
  <li>Item 1</li>
  <li>Item 2</li>
</ul>
```

#### ✅ スクリーンリーダー対応

```html
<!-- 視覚的に隠す（SR用） -->
<span class="sr-only">Email address</span>

<!-- アイコンのラベル -->
<button aria-label="Close dialog">
  <X aria-hidden="true" />
</button>

<!-- ライブリージョン -->
<div role="alert" aria-live="assertive">
  Error: Invalid credentials
</div>
```

---

## Dark Mode

### Implementation Method

UnoCSS + CSS変数で実装：

```typescript
// uno.config.ts
export default defineConfig({
  darkMode: 'class', // .dark クラスでトグル
  theme: {
    colors: {
      // Light & Dark両対応
    }
  }
})
```

### ダークモード切り替え

```svelte
<script>
  import { writable } from 'svelte/store'

  const darkMode = writable(false)

  function toggleDarkMode() {
    $darkMode = !$darkMode
    if ($darkMode) {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
    localStorage.setItem('theme', $darkMode ? 'dark' : 'light')
  }
</script>

<button on:click={toggleDarkMode} aria-label="Toggle dark mode">
  {#if $darkMode}
    <Sun class="w-5 h-5" />
  {:else}
    <Moon class="w-5 h-5" />
  {/if}
</button>
```

### ダークモード対応クラス

```html
<!-- 背景色 -->
<div class="bg-white dark:bg-gray-900">

<!-- テキスト色 -->
<p class="text-gray-900 dark:text-white">

<!-- ボーダー -->
<div class="border-gray-200 dark:border-gray-700">

<!-- カード -->
<div class="bg-white dark:bg-gray-800 shadow-sm dark:shadow-gray-900/50">
```

---

## Responsive Design

### Breakpoints

| Prefix | Min Width | Device |
|--------|----------|---------|
| (なし) | 0px | モバイル（デフォルト） |
| `sm:` | 640px | 大型モバイル、小タブレット |
| `md:` | 768px | タブレット |
| `lg:` | 1024px | デスクトップ |
| `xl:` | 1280px | 大型デスクトップ |
| `2xl:` | 1536px | 特大画面 |

### モバイルファースト

```html
<!-- モバイル: 1列、デスクトップ: 3列 -->
<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">

<!-- モバイル: text-base、デスクトップ: text-lg -->
<h1 class="text-base md:text-lg lg:text-xl">

<!-- モバイル: p-4、デスクトップ: p-8 -->
<div class="p-4 md:p-6 lg:p-8">
```

### レスポンシブパディング

```html
<!-- コンテナ -->
<div class="px-4 sm:px-6 lg:px-8">
  <!-- 4px → 24px → 32px -->
</div>

<!-- セクション -->
<section class="py-8 md:py-12 lg:py-16">
  <!-- 32px → 48px → 64px -->
</section>
```

---

## Branding Customization

The following can be customized from the admin panel:

### Customizable Items

1. **Colors**
   - Primary color
   - Secondary color

2. **Typography**
   - Font family (Google Fonts support)

3. **Logo & Images**
   - Logo URL
   - Background image URL

4. **Custom CSS**
   - Full CSS override possible

5. **Custom HTML**
   - Add header & footer

### Customization Examples

```css
/* カスタムCSS例（branding_settings.custom_css） */
:root {
  --color-primary: #FF5733;
  --font-family: 'Poppins', sans-serif;
}

.btn-primary {
  background: linear-gradient(135deg, #FF5733 0%, #FF8C42 100%);
  border-radius: 12px;
}

.login-page {
  background-image: url('https://example.com/bg.jpg');
  background-size: cover;
}
```

---

## References

### Design Systems

- [Tailwind CSS](https://tailwindcss.com/)
- [UnoCSS](https://unocss.dev/)
- [Melt UI](https://melt-ui.com/)
- [shadcn/ui](https://ui.shadcn.com/)
- [Radix Colors](https://www.radix-ui.com/colors)

### Accessibility

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- [A11y Project](https://www.a11yproject.com/)

### Enrai Documentation

- [database-schema.md](../architecture/database-schema.md) - Database schema
- [openapi.yaml](../api/openapi.yaml) - API specification
- [wireframes.md](./wireframes.md) - UI wireframes
- [PHASE5_PLANNING.md](../project-management/PHASE5_PLANNING.md) - Phase 5 planning

---

**Change History**:
- 2025-11-13: Initial version (Phase 5 design)
