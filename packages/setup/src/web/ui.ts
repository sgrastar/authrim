/**
 * HTML Template for Authrim Setup Web UI
 *
 * A simple, self-contained UI for the setup wizard.
 * Follows the setup flow defined in the design document.
 */

import type { Locale, LocaleInfo } from '../i18n/types.js';

export function getHtmlTemplate(
  sessionToken?: string,
  manageOnly?: boolean,
  locale: Locale = 'en',
  translations: Record<string, string> = {},
  availableLocales: LocaleInfo[] = []
): string {
  // Escape token for safe embedding in JavaScript
  const safeToken = sessionToken ? sessionToken.replace(/['"\\]/g, '') : '';
  const manageOnlyFlag = manageOnly ? 'true' : 'false';

  // Safely stringify translations for embedding in JavaScript
  const translationsJson = JSON.stringify(translations);
  const availableLocalesJson = JSON.stringify(availableLocales);

  // Generate locale options HTML server-side
  const localeOptionsHtml = availableLocales
    .map(
      (l) =>
        `<option value="${l.code}"${l.code === locale ? ' selected' : ''}>${l.nativeName}</option>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authrim Setup</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400&family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&display=swap" rel="stylesheet">
  <style>
    :root {
      /* Typography */
      --font-serif: 'Cormorant Garamond', Georgia, 'Times New Roman', serif;
      --font-sans: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-mono: 'SF Mono', Monaco, 'Cascadia Code', 'Consolas', monospace;

      /* Light theme colors */
      --primary: #2563eb;
      --primary-dark: #1d4ed8;
      --primary-light: #3b82f6;
      --accent: #c2410c;
      --success: #059669;
      --error: #dc2626;
      --warning: #d97706;
      --bg: #f8f5e3;
      --bg-secondary: #f3eed6;
      --card-bg: #fffefa;
      --card-bg-hover: #fdfcf4;
      --text: #1c1917;
      --text-muted: #57534e;
      --text-subtle: #78716c;
      --border: #d6d3d1;
      --border-light: #e7e5e4;

      /* Glassmorphism */
      --glass-bg: rgba(248, 245, 227, 0.25);
      --glass-border: rgba(214, 211, 209, 0.5);

      /* Splash */
      --splash-bg: #1c1917;
      --splash-text: #f8f5e3;

      /* Shadows & Effects */
      --shadow-sm: 0 1px 2px rgba(28, 25, 23, 0.04);
      --shadow-md: 0 4px 12px rgba(28, 25, 23, 0.06);
      --shadow-lg: 0 12px 32px rgba(28, 25, 23, 0.08);
      --shadow-card: 0 1px 3px rgba(28, 25, 23, 0.04), 0 4px 12px rgba(28, 25, 23, 0.02);

      /* Transitions */
      --transition-fast: 150ms cubic-bezier(0.4, 0, 0.2, 1);
      --transition-base: 250ms cubic-bezier(0.4, 0, 0.2, 1);
      --transition-slow: 400ms cubic-bezier(0.4, 0, 0.2, 1);
    }

    /* Dark theme */
    [data-theme="dark"] {
      --primary: #60a5fa;
      --primary-dark: #3b82f6;
      --primary-light: #93c5fd;
      --accent: #fb923c;
      --success: #34d399;
      --error: #f87171;
      --warning: #fbbf24;
      --bg: #0c0a09;
      --bg-secondary: #1c1917;
      --card-bg: #1c1917;
      --card-bg-hover: #292524;
      --text: #fafaf9;
      --text-muted: #a8a29e;
      --text-subtle: #78716c;
      --border: #44403c;
      --border-light: #292524;
      --glass-bg: rgba(28, 25, 23, 0.35);
      --glass-border: rgba(68, 64, 60, 0.5);
      --splash-bg: #0c0a09;
      --splash-text: #f8f5e3;
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.2);
      --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.3);
      --shadow-lg: 0 12px 32px rgba(0, 0, 0, 0.4);
      --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.2), 0 4px 12px rgba(0, 0, 0, 0.15);
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--font-sans);
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      min-height: 100vh;
      transition: background-color var(--transition-slow), color var(--transition-slow);
    }

    /* Subtle grain texture */
    body::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      opacity: 0.015;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
      z-index: 9998;
    }

    [data-theme="dark"] body::before {
      opacity: 0.03;
    }

    /* ========================================
       SPLASH SCREEN
       ======================================== */
    .splash {
      position: fixed;
      inset: 0;
      z-index: 10000;
      background: var(--splash-bg);
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 1;
      visibility: visible;
      transition: opacity 600ms ease, visibility 600ms ease;
    }

    .splash.fade-out {
      opacity: 0;
      visibility: hidden;
    }

    .splash-content {
      text-align: center;
      opacity: 0;
      transform: translateY(16px);
      animation: splash-reveal 800ms ease forwards;
      animation-delay: 200ms;
    }

    .splash-title {
      font-family: var(--font-serif);
      font-size: clamp(3.5rem, 10vw, 5.5rem);
      font-weight: 600;
      color: var(--splash-text);
      letter-spacing: -0.03em;
      line-height: 1;
      margin-bottom: 1rem;
    }

    .splash-tagline {
      font-family: var(--font-sans);
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text-subtle);
      letter-spacing: 0.2em;
      text-transform: uppercase;
      margin-bottom: 3rem;
    }

    .splash-loader {
      width: 32px;
      height: 32px;
      margin: 0 auto;
      border: 2px solid var(--border);
      border-top-color: var(--splash-text);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes splash-reveal {
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    /* ========================================
       BACKGROUND TYPOGRAPHY
       ======================================== */
    .bg-typography {
      position: fixed;
      top: -16%;
      left: -5%;
      font-family: var(--font-serif);
      font-size: clamp(26rem, 25vw, 28rem);
      font-weight: 700;
      color: rgba(209, 201, 173, 0.18);
      letter-spacing: -0.04em;
      white-space: nowrap;
      pointer-events: none;
      z-index: 0;
      user-select: none;
    }

    [data-theme="dark"] .bg-typography {
      color: rgba(255, 255, 255, 0.025);
    }

    /* ========================================
       THEME TOGGLE
       ======================================== */
    /* Top Controls Container - holds language selector and theme toggle */
    .top-controls {
      position: fixed;
      top: 1.25rem;
      right: 1.5rem;
      z-index: 100;
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    /* Language Selector - styled to match theme toggle */
    .lang-selector select {
      height: 44px;
      padding: 0 2.25rem 0 1rem;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition-fast);
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 0.75rem center;
      box-shadow: var(--shadow-sm);
    }

    .lang-selector select:hover {
      background-color: var(--card-bg-hover);
      border-color: var(--primary);
      transform: scale(1.02);
    }

    .lang-selector select:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
    }

    .lang-selector select:active {
      transform: scale(0.98);
    }

    .theme-toggle {
      width: 44px;
      height: 44px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 1.25rem;
      transition: all var(--transition-fast);
      box-shadow: var(--shadow-sm);
    }

    .theme-toggle:hover {
      background: var(--card-bg-hover);
      border-color: var(--primary);
      transform: scale(1.05);
    }

    .theme-toggle:active {
      transform: scale(0.95);
    }

    /* ========================================
       LAYOUT
       ======================================== */
    .container {
      position: relative;
      z-index: 1;
      max-width: 820px;
      margin: 0 auto;
      padding: 2.5rem 2rem;
    }

    header {
      text-align: center;
      margin-bottom: 2rem;
      padding-top: 0.5rem;
    }

    h1 {
      font-family: var(--font-serif);
      font-size: clamp(2.25rem, 6vw, 3rem);
      font-weight: 600;
      color: var(--text);
      letter-spacing: -0.03em;
      line-height: 1;
      margin-bottom: 0.5rem;
    }

    .header-wizard {
      font-family: var(--font-serif);
      font-size: 1.15rem;
      font-weight: 400;
      font-style: italic;
      color: var(--primary);
      margin-bottom: 0.375rem;
    }

    .subtitle {
      font-family: var(--font-sans);
      font-size: 0.85rem;
      color: var(--text-muted);
      letter-spacing: 0.03em;
    }

    /* ========================================
       CARDS
       ======================================== */
    .card {
      position: relative;
      z-index: 1;
      background: var(--glass-bg);
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
      border-radius: 16px;
      border: 1px solid var(--glass-border);
      padding: 2rem;
      margin-bottom: 1.75rem;
      box-shadow: var(--shadow-card);
      transition: background-color var(--transition-base), border-color var(--transition-fast), box-shadow var(--transition-fast);
    }

    .card:hover {
      border-color: var(--border);
    }

    .card-title {
      font-family: var(--font-sans);
      font-size: 1.35rem;
      font-weight: 600;
      margin-bottom: 1.25rem;
      display: flex;
      align-items: center;
      gap: 0.625rem;
      color: var(--text);
    }

    /* ========================================
       STATUS BADGES
       ======================================== */
    .status-badge {
      font-family: var(--font-sans);
      font-size: 0.7rem;
      font-weight: 600;
      padding: 0.3rem 0.625rem;
      border-radius: 6px;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }

    .status-pending {
      background: var(--bg-secondary);
      color: var(--text-muted);
    }
    .status-running {
      background: rgba(37, 99, 235, 0.1);
      color: var(--primary);
    }
    .status-success {
      background: rgba(5, 150, 105, 0.1);
      color: var(--success);
    }
    .status-error {
      background: rgba(220, 38, 38, 0.1);
      color: var(--error);
    }
    .status-warning {
      background: rgba(217, 119, 6, 0.1);
      color: var(--warning);
    }

    [data-theme="dark"] .status-running { background: rgba(96, 165, 250, 0.15); }
    [data-theme="dark"] .status-success { background: rgba(52, 211, 153, 0.15); }
    [data-theme="dark"] .status-error { background: rgba(248, 113, 113, 0.15); }
    [data-theme="dark"] .status-warning { background: rgba(251, 191, 36, 0.15); }

    /* ========================================
       MODE SELECTION CARDS
       ======================================== */
    .mode-cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1.25rem;
      margin-bottom: 1.25rem;
    }

    .mode-card {
      background: var(--card-bg);
      border: 2px solid var(--border-light);
      border-radius: 14px;
      padding: 1.75rem;
      cursor: pointer;
      transition: all var(--transition-base);
      position: relative;
    }

    .mode-card:hover {
      border-color: var(--primary);
      background: var(--card-bg-hover);
      transform: translateY(-2px);
      box-shadow: var(--shadow-md);
    }

    .mode-card.selected {
      border-color: var(--primary);
      background: rgba(37, 99, 235, 0.04);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
    }

    [data-theme="dark"] .mode-card.selected {
      background: rgba(96, 165, 250, 0.08);
      box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.15);
    }

    .mode-card .mode-icon {
      font-size: 2.25rem;
      margin-bottom: 0.75rem;
      display: block;
    }

    .mode-card h3 {
      font-family: var(--font-sans);
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: var(--text);
    }

    .mode-card p {
      font-size: 0.9rem;
      color: var(--text-muted);
      margin-bottom: 0.875rem;
      line-height: 1.5;
    }

    .mode-card ul {
      font-size: 0.8rem;
      color: var(--text-subtle);
      margin-left: 1rem;
      line-height: 1.6;
    }

    .mode-card ul li {
      margin-bottom: 0.3rem;
    }

    .mode-badge {
      position: absolute;
      top: -10px;
      right: 12px;
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);
      color: white;
      font-family: var(--font-sans);
      font-size: 0.65rem;
      font-weight: 600;
      padding: 0.35rem 0.625rem;
      border-radius: 6px;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      box-shadow: 0 2px 8px rgba(37, 99, 235, 0.3);
    }

    /* ========================================
       FORMS
       ======================================== */
    .form-group {
      margin-bottom: 1.25rem;
    }

    label {
      display: block;
      font-family: var(--font-sans);
      font-weight: 500;
      font-size: 0.9rem;
      margin-bottom: 0.5rem;
      color: var(--text);
    }

    input[type="text"],
    input[type="password"],
    input[type="email"],
    input[type="file"],
    select {
      width: 100%;
      padding: 0.875rem 1rem;
      border: 1px solid var(--border);
      border-radius: 10px;
      font-family: var(--font-sans);
      font-size: 0.95rem;
      background: var(--card-bg);
      color: var(--text);
      transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
    }

    input::placeholder,
    select::placeholder {
      color: var(--text-subtle);
    }

    input:focus,
    select:focus {
      outline: none;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
    }

    [data-theme="dark"] input:focus,
    [data-theme="dark"] select:focus {
      box-shadow: 0 0 0 3px rgba(96, 165, 250, 0.15);
    }

    /* Fix browser autofill/autocomplete styling */
    input:-webkit-autofill,
    input:-webkit-autofill:hover,
    input:-webkit-autofill:focus,
    input:-webkit-autofill:active {
      -webkit-box-shadow: 0 0 0 30px var(--card-bg) inset !important;
      -webkit-text-fill-color: var(--text) !important;
      caret-color: var(--text) !important;
    }

    small {
      display: block;
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.375rem;
      line-height: 1.4;
    }

    .checkbox-group {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
    }

    .checkbox-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      cursor: pointer;
    }

    .checkbox-item input[type="checkbox"] {
      width: 18px;
      height: 18px;
      accent-color: var(--primary);
      cursor: pointer;
      /* Custom checkbox styling */
      appearance: none;
      -webkit-appearance: none;
      background: var(--card-bg);
      border: 2px solid var(--border);
      border-radius: 4px;
      transition: all var(--transition-fast);
    }

    .checkbox-item input[type="checkbox"]:checked {
      background: var(--primary);
      border-color: var(--primary);
    }

    .checkbox-item input[type="checkbox"]:checked::after {
      content: '✓';
      display: block;
      color: white;
      font-size: 12px;
      font-weight: bold;
      text-align: center;
      line-height: 14px;
    }

    .checkbox-item input[type="checkbox"]:hover:not(:disabled) {
      border-color: var(--primary);
    }

    .checkbox-item input[type="checkbox"]:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    [data-theme="dark"] .checkbox-item input[type="checkbox"] {
      background: var(--bg-secondary);
      border-color: var(--border);
    }

    [data-theme="dark"] .checkbox-item input[type="checkbox"]:checked {
      background: var(--primary);
      border-color: var(--primary);
    }

    /* ========================================
       COMPONENT CARDS
       ======================================== */
    .component-card {
      background: var(--glass-bg);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      border: 1px solid var(--glass-border);
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 0.75rem;
      transition: background-color var(--transition-base), border-color var(--transition-base);
    }

    .component-card p {
      color: var(--text-muted);
    }

    /* ========================================
       HINT / TIP BOXES
       ======================================== */
    .hint-box {
      padding: 0.625rem 0.875rem;
      border-radius: 8px;
      font-size: 0.875rem;
      line-height: 1.5;
      background: #fef3c7;
      color: #92400e;
      border: 1px solid #fcd34d;
    }

    [data-theme="dark"] .hint-box {
      background: rgba(251, 191, 36, 0.12);
      color: #fcd34d;
      border-color: rgba(251, 191, 36, 0.25);
    }

    .section-hint.hint-box {
      background: rgba(251, 191, 36, 0.15);
      color: #92400e;
    }

    [data-theme="dark"] .section-hint.hint-box {
      background: rgba(251, 191, 36, 0.1);
      color: #fcd34d;
    }

    /* ========================================
       INFRASTRUCTURE INFO SECTION
       ======================================== */
    .infra-section {
      background: var(--bg-secondary);
      border: 1px solid var(--border-light);
      border-radius: 12px;
      padding: 1.25rem;
      margin-bottom: 1.25rem;
    }

    .infra-section h4 {
      margin: 0 0 0.875rem 0;
      font-family: var(--font-sans);
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .infra-item {
      display: flex;
      justify-content: space-between;
      padding: 0.375rem 0;
      font-size: 0.875rem;
    }

    .infra-label {
      color: var(--text-muted);
    }

    .infra-value {
      font-family: var(--font-mono);
      font-size: 0.8rem;
      color: var(--primary);
    }

    /* ========================================
       DOMAIN CONFIGURATION SECTION
       ======================================== */
    .domain-section {
      background: var(--bg-secondary);
      border: 1px solid var(--border-light);
      border-radius: 12px;
      padding: 1.25rem;
      margin-bottom: 1.25rem;
    }

    .domain-section h4 {
      margin: 0 0 0.625rem 0;
      font-family: var(--font-sans);
      font-size: 1rem;
      font-weight: 600;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .domain-section .section-hint {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-bottom: 1rem;
      padding: 0.625rem 0.75rem;
      background: rgba(37, 99, 235, 0.06);
      border-radius: 8px;
      line-height: 1.5;
    }

    [data-theme="dark"] .domain-section .section-hint {
      background: rgba(96, 165, 250, 0.1);
    }

    .domain-row {
      display: grid;
      grid-template-columns: 90px 1fr;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }

    .domain-row:last-of-type {
      margin-bottom: 0;
    }

    .domain-label {
      font-size: 0.85rem;
      color: var(--text-muted);
      font-weight: 500;
    }

    .domain-input-wrapper {
      position: relative;
    }

    .domain-input-wrapper input {
      padding-right: 180px;
    }

    .domain-default {
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      font-family: var(--font-mono);
      font-size: 0.65rem;
      color: var(--text-subtle);
      background: var(--bg);
      padding: 3px 8px;
      border-radius: 5px;
      max-width: 160px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .issuer-preview {
      margin-top: 0.875rem;
      padding: 0.625rem 0.75rem;
      background: rgba(5, 150, 105, 0.08);
      border-radius: 8px;
      font-size: 0.875rem;
    }

    [data-theme="dark"] .issuer-preview {
      background: rgba(52, 211, 153, 0.1);
    }

    .issuer-preview .label {
      color: var(--text-muted);
      font-size: 0.75rem;
    }

    .issuer-preview .value {
      color: var(--success);
      font-family: var(--font-mono);
      font-size: 0.8rem;
      word-break: break-all;
    }

    /* ========================================
       BUTTONS
       ======================================== */
    button, a.btn-primary, a.btn-secondary {
      padding: 0.875rem 1.75rem;
      border-radius: 10px;
      font-family: var(--font-sans);
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: all var(--transition-fast);
      border: none;
      text-decoration: none;
      display: inline-block;
      text-align: center;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);
      color: white;
      box-shadow: 0 2px 8px rgba(37, 99, 235, 0.25);
    }

    .btn-primary:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.35);
    }

    .btn-primary:active:not(:disabled) {
      transform: translateY(0);
    }

    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      box-shadow: none;
    }

    [data-theme="dark"] .btn-primary {
      box-shadow: 0 2px 8px rgba(96, 165, 250, 0.3);
    }

    [data-theme="dark"] .btn-primary:hover:not(:disabled) {
      box-shadow: 0 4px 12px rgba(96, 165, 250, 0.4);
    }

    .btn-secondary {
      background: var(--glass-bg);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      color: var(--text);
      border: 1px solid var(--glass-border);
    }

    .btn-secondary:hover {
      background: var(--card-bg);
      border-color: var(--border);
    }

    .button-group {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      margin-top: 2rem;
    }

    .button-group .btn-secondary:first-child:last-child {
      /* Single back button - keep left aligned */
      margin-right: auto;
    }

    .button-group .btn-primary {
      margin-left: auto;
    }

    .button-group .btn-secondary + .btn-primary {
      margin-left: 0;
    }

    /* ========================================
       PROGRESS LOG
       ======================================== */
    .progress-log {
      background: #0f172a;
      border-radius: 12px;
      padding: 1.25rem;
      max-height: 320px;
      overflow-y: auto;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      border: 1px solid #1e293b;
    }

    .progress-log pre {
      color: #e2e8f0;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.6;
    }

    /* Progress UI Components */
    .progress-container {
      margin: 1.25rem 0;
    }

    .progress-status {
      display: flex;
      align-items: center;
      gap: 0.875rem;
      margin-bottom: 1rem;
    }

    .progress-status .spinner {
      width: 22px;
      height: 22px;
      border: 2px solid var(--border);
      border-top-color: var(--primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .progress-bar-wrapper {
      background: var(--bg-secondary);
      border-radius: 6px;
      height: 10px;
      overflow: hidden;
      margin-bottom: 0.625rem;
    }

    .progress-bar {
      height: 100%;
      background: linear-gradient(90deg, var(--primary) 0%, var(--primary-light) 100%);
      border-radius: 6px;
      transition: width 0.4s ease;
    }

    .progress-text {
      font-family: var(--font-sans);
      font-size: 0.85rem;
      color: var(--text-muted);
    }

    .log-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.625rem 1rem;
      background: var(--bg-secondary);
      border: 1px solid var(--border-light);
      border-radius: 8px;
      cursor: pointer;
      font-family: var(--font-sans);
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-top: 1rem;
      transition: all var(--transition-fast);
    }

    .log-toggle:hover {
      background: var(--border-light);
      color: var(--text);
    }

    .log-toggle .arrow {
      transition: transform var(--transition-fast);
    }

    .log-toggle.open .arrow {
      transform: rotate(90deg);
    }

    /* ========================================
       STEP INDICATOR - Refined Minimal Design
       ======================================== */
    .step-indicator {
      position: relative;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 0;
      margin-bottom: 2.5rem;
      padding: 0.75rem 0;
    }

    /* The connecting line */
    .step-indicator::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: calc(100% - 80px);
      max-width: 500px;
      height: 1px;
      background: var(--border);
    }

    .step {
      position: relative;
      z-index: 1;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--font-sans);
      font-weight: 500;
      font-size: 0.7rem;
      background: var(--bg);
      transition: all var(--transition-base);
    }

    .step-active {
      width: 32px;
      height: 32px;
      background: var(--text);
      color: var(--bg);
      font-weight: 600;
      font-size: 0.75rem;
      box-shadow: 0 0 0 4px var(--bg), 0 0 0 5px var(--text);
    }

    [data-theme="dark"] .step-active {
      background: var(--splash-text);
      color: var(--bg);
      box-shadow: 0 0 0 4px var(--bg), 0 0 0 5px var(--splash-text);
    }

    .step-complete {
      background: var(--text);
      color: var(--bg);
      font-size: 0;
    }

    .step-complete::after {
      content: '✓';
      font-size: 0.7rem;
    }

    [data-theme="dark"] .step-complete {
      background: var(--splash-text);
      color: var(--bg);
    }

    .step-pending {
      background: var(--bg);
      color: var(--text-subtle);
      border: 1px solid var(--border);
    }

    .step-connector {
      width: 40px;
      height: 1px;
      background: transparent;
      align-self: center;
    }

    /* ========================================
       ALERTS
       ======================================== */
    .alert {
      padding: 1rem 1.25rem;
      border-radius: 10px;
      margin-bottom: 1.25rem;
      font-size: 0.9rem;
      line-height: 1.5;
    }

    .alert-success {
      background: rgba(5, 150, 105, 0.08);
      color: var(--success);
      border: 1px solid rgba(5, 150, 105, 0.2);
    }
    .alert-error {
      background: rgba(220, 38, 38, 0.08);
      color: var(--error);
      border: 1px solid rgba(220, 38, 38, 0.2);
    }
    .alert-warning {
      background: rgba(217, 119, 6, 0.08);
      color: var(--warning);
      border: 1px solid rgba(217, 119, 6, 0.2);
    }
    .alert-info {
      background: rgba(37, 99, 235, 0.06);
      color: var(--primary);
      border: 1px solid rgba(37, 99, 235, 0.15);
    }

    [data-theme="dark"] .alert-success {
      background: rgba(52, 211, 153, 0.1);
      border-color: rgba(52, 211, 153, 0.25);
    }
    [data-theme="dark"] .alert-error {
      background: rgba(248, 113, 113, 0.1);
      border-color: rgba(248, 113, 113, 0.25);
    }
    [data-theme="dark"] .alert-warning {
      background: rgba(251, 191, 36, 0.1);
      border-color: rgba(251, 191, 36, 0.25);
    }
    [data-theme="dark"] .alert-info {
      background: rgba(96, 165, 250, 0.1);
      border-color: rgba(96, 165, 250, 0.2);
    }

    /* ========================================
       URL DISPLAY
       ======================================== */
    .url-display {
      background: var(--bg-secondary);
      padding: 1.25rem;
      border-radius: 12px;
      margin-top: 1.25rem;
      border: 1px solid var(--border-light);
    }

    .url-item {
      display: flex;
      gap: 0.75rem;
      margin-bottom: 0.625rem;
      align-items: baseline;
    }

    .url-label {
      font-family: var(--font-sans);
      font-weight: 600;
      font-size: 0.85rem;
      min-width: 110px;
      color: var(--text-muted);
    }

    .url-value {
      font-family: var(--font-mono);
      font-size: 0.8rem;
      color: var(--primary);
      word-break: break-all;
      overflow-wrap: break-word;
    }

    /* ========================================
       FILE INPUT
       ======================================== */
    .file-input-wrapper {
      position: relative;
      overflow: hidden;
      display: inline-block;
    }

    .file-input-wrapper input[type=file] {
      position: absolute;
      left: 0;
      top: 0;
      opacity: 0;
      cursor: pointer;
      width: 100%;
      height: 100%;
    }

    .file-input-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.875rem 1.5rem;
      background: var(--bg-secondary);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 10px;
      cursor: pointer;
      font-family: var(--font-sans);
      font-weight: 500;
      transition: all var(--transition-fast);
    }

    .file-input-btn:hover {
      background: var(--border-light);
      border-color: var(--primary);
    }

    .config-preview {
      background: var(--bg-secondary);
      border: 1px solid var(--border-light);
      border-radius: 10px;
      padding: 1rem;
      margin-top: 1rem;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      max-height: 200px;
      overflow-y: auto;
      line-height: 1.5;
    }

    .hidden { display: none; }

    /* ========================================
       MODAL
       ======================================== */
    .modal {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .modal.hidden { display: none; }

    .modal-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
    }

    .modal-content {
      position: relative;
      background: var(--card-bg);
      border-radius: 16px;
      padding: 2rem;
      max-width: 460px;
      width: 90%;
      box-shadow: var(--shadow-lg);
      border: 1px solid var(--border-light);
    }

    .modal-content h3 {
      font-family: var(--font-sans);
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 1rem;
    }

    /* ========================================
       RESOURCE PREVIEW
       ======================================== */
    .resource-preview {
      background: var(--bg-secondary);
      border: 1px solid var(--border-light);
      border-radius: 12px;
      padding: 1.25rem;
      margin-bottom: 1.25rem;
    }

    .resource-list {
      display: grid;
      gap: 1.25rem;
    }

    .resource-category {
      font-size: 0.875rem;
    }

    .resource-category strong {
      display: block;
      font-family: var(--font-sans);
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: var(--text);
    }

    .resource-category ul {
      margin: 0;
      padding-left: 1.5rem;
      color: var(--text-muted);
    }

    .resource-category li {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      margin-bottom: 0.3rem;
    }

    /* Progress spinner */
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid var(--border);
      border-top-color: var(--primary);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-right: 0.5rem;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .progress-item {
      display: flex;
      align-items: center;
      margin-bottom: 0.5rem;
      color: #e2e8f0;
      font-family: var(--font-mono);
      font-size: 0.8rem;
    }

    .progress-item.complete {
      color: var(--success);
    }

    .progress-item.error {
      color: var(--error);
    }

    /* ========================================
       ENVIRONMENT CARDS
       ======================================== */
    .env-cards {
      display: grid;
      gap: 1rem;
      margin-bottom: 1.25rem;
    }

    .env-card {
      background: var(--card-bg);
      border: 1px solid var(--border-light);
      border-radius: 12px;
      padding: 1.25rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .env-card:hover {
      border-color: var(--primary);
      background: var(--card-bg-hover);
      box-shadow: var(--shadow-md);
      transform: translateY(-1px);
    }

    .env-card-info {
      flex: 1;
    }

    .env-card-name {
      font-family: var(--font-sans);
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: var(--text);
    }

    .env-card-stats {
      display: flex;
      gap: 1.25rem;
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    .env-card-stat {
      display: flex;
      align-items: center;
      gap: 0.375rem;
    }

    .env-card-actions {
      display: flex;
      gap: 0.625rem;
    }

    .btn-danger {
      background: var(--error);
      color: white;
      padding: 0.625rem 1rem;
      font-size: 0.85rem;
      border-radius: 8px;
    }

    .btn-danger:hover {
      background: #b91c1c;
      transform: translateY(-1px);
    }

    .btn-warning {
      background: var(--warning);
      color: white;
      padding: 0.75rem 1.25rem;
      font-size: 0.9rem;
      border-radius: 10px;
      box-shadow: 0 2px 8px rgba(217, 119, 6, 0.25);
    }

    .btn-warning:hover {
      background: #b45309;
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(217, 119, 6, 0.35);
    }

    [data-theme="dark"] .btn-warning {
      box-shadow: 0 2px 8px rgba(251, 191, 36, 0.3);
    }

    [data-theme="dark"] .btn-warning:hover {
      box-shadow: 0 4px 12px rgba(251, 191, 36, 0.4);
    }

    .btn-info {
      background: var(--primary);
      color: white;
      padding: 0.625rem 1rem;
      font-size: 0.85rem;
      border-radius: 8px;
    }

    .btn-info:hover {
      background: var(--primary-dark);
      transform: translateY(-1px);
    }

    /* ========================================
       RESOURCE LIST (Details view)
       ======================================== */
    .resource-section {
      margin-bottom: 1.75rem;
    }

    .resource-section-title {
      font-family: var(--font-sans);
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 0.875rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: var(--text);
    }

    .resource-section-title .count {
      font-size: 0.8rem;
      color: var(--text-muted);
      font-weight: 500;
    }

    .resource-list {
      background: var(--bg-secondary);
      border-radius: 10px;
      padding: 0.875rem;
      border: 1px solid var(--border-light);
    }

    .resource-item {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      padding: 0.5rem 0.75rem;
      margin-bottom: 0.375rem;
      background: var(--card-bg);
      border-radius: 6px;
      border: 1px solid var(--border-light);
    }

    .resource-item:last-child {
      margin-bottom: 0;
    }

    .resource-item-name {
      font-weight: 600;
    }

    .resource-item-details {
      font-size: 0.7rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
      font-family: var(--font-sans);
    }

    .resource-item-details span {
      margin-right: 1rem;
    }

    .resource-item-loading {
      color: var(--text-muted);
      font-style: italic;
    }

    .resource-item-error {
      color: var(--error);
    }

    .resource-item-not-deployed {
      color: var(--warning);
      font-style: italic;
    }

    .resource-empty {
      color: var(--text-muted);
      font-style: italic;
      font-size: 0.875rem;
    }

    /* ========================================
       DELETE OPTIONS
       ======================================== */
    .delete-options {
      display: grid;
      gap: 0.875rem;
    }

    .delete-option {
      display: flex;
      align-items: center;
      gap: 0.875rem;
      padding: 1rem;
      border: 1px solid var(--border-light);
      border-radius: 10px;
      cursor: pointer;
      background: var(--card-bg);
      transition: all var(--transition-fast);
    }

    .delete-option:hover {
      background: var(--bg-secondary);
      border-color: var(--border);
    }

    .delete-option input[type="checkbox"] {
      width: 18px;
      height: 18px;
      accent-color: var(--error);
    }

    .delete-option span {
      display: flex;
      flex-direction: column;
    }

    .delete-option small {
      color: var(--text-muted);
      font-size: 0.8rem;
    }

    /* ========================================
       DATABASE CONFIGURATION
       ======================================== */
    .database-config-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
      margin-bottom: 1.75rem;
    }

    .database-config-stack {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      margin-bottom: 1.75rem;
    }

    .database-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border-light);
      border-radius: 12px;
      padding: 1.5rem;
    }

    .database-card h3 {
      margin: 0 0 1.125rem 0;
      font-family: var(--font-sans);
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--text);
    }

    .db-description {
      font-size: 0.875rem;
      color: var(--text-muted);
      margin-bottom: 1.25rem;
      line-height: 1.6;
    }

    .db-description p {
      margin: 0 0 0.5rem 0;
    }

    .db-description ul {
      margin: 0.5rem 0;
      padding-left: 1.25rem;
    }

    .db-description li {
      margin-bottom: 0.3rem;
    }

    .db-hint {
      font-style: italic;
      margin-top: 0.875rem;
      padding: 0.625rem 0.75rem;
      background: rgba(37, 99, 235, 0.06);
      border-radius: 8px;
      font-size: 0.85rem;
    }

    [data-theme="dark"] .db-hint {
      background: rgba(96, 165, 250, 0.1);
    }

    .region-selection h4 {
      margin: 0 0 0.875rem 0;
      font-family: var(--font-sans);
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--text);
    }

    .radio-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .radio-item {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      cursor: pointer;
      padding: 0.375rem 0;
      font-size: 0.9rem;
    }

    .radio-item input[type="radio"] {
      margin: 0;
      width: 18px;
      height: 18px;
      /* Custom radio styling */
      appearance: none;
      -webkit-appearance: none;
      background: var(--card-bg);
      border: 2px solid var(--border);
      border-radius: 50%;
      cursor: pointer;
      transition: all var(--transition-fast);
      position: relative;
    }

    .radio-item input[type="radio"]:checked {
      border-color: var(--primary);
      background: var(--card-bg);
    }

    .radio-item input[type="radio"]:checked::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 10px;
      height: 10px;
      background: var(--primary);
      border-radius: 50%;
    }

    .radio-item input[type="radio"]:hover:not(:disabled) {
      border-color: var(--primary);
    }

    [data-theme="dark"] .radio-item input[type="radio"] {
      background: var(--bg-secondary);
      border-color: var(--border);
    }

    [data-theme="dark"] .radio-item input[type="radio"]:checked {
      border-color: var(--primary);
      background: var(--bg-secondary);
    }

    .radio-separator {
      font-family: var(--font-sans);
      font-size: 0.7rem;
      color: var(--text-subtle);
      margin: 0.75rem 0 0.375rem 0;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    @media (max-width: 768px) {
      .database-config-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
  <script>
    // i18n Translation System
    let _translations = ${translationsJson};
    const _availableLocales = ${availableLocalesJson};
    let _currentLocale = '${locale}';

    /**
     * Translate a key with optional parameter substitution
     * @param {string} key - Translation key
     * @param {Object} params - Parameters for substitution {{param}}
     * @returns {string} Translated string or key if not found
     */
    function t(key, params = {}) {
      let text = _translations[key] || key;
      if (params) {
        Object.entries(params).forEach(([param, value]) => {
          text = text.replace(new RegExp('\\\\{\\\\{' + param + '\\\\}\\\\}', 'g'), String(value));
        });
      }
      return text;
    }

    /**
     * Update all elements with data-i18n attribute
     */
    function updateAllTranslations() {
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const params = el.getAttribute('data-i18n-params');
        if (key) {
          const parsedParams = params ? JSON.parse(params) : {};
          el.textContent = t(key, parsedParams);
        }
      });
      // Update placeholders
      document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (key) {
          el.setAttribute('placeholder', t(key));
        }
      });
      // Update html lang attribute
      document.documentElement.lang = _currentLocale;
    }

    /**
     * Change the current language without page reload
     * @param {string} locale - Locale code (e.g., 'en', 'ja')
     */
    async function changeLanguage(locale) {
      if (locale === _currentLocale) return;

      try {
        const response = await fetch('/api/translations/' + locale);
        if (!response.ok) throw new Error('Failed to fetch translations');

        const data = await response.json();
        _translations = data.translations;
        _currentLocale = locale;

        // Save preference
        localStorage.setItem('authrim_setup_lang', locale);

        // Update URL without reload (for sharing/bookmarking)
        const url = new URL(window.location.href);
        url.searchParams.set('lang', locale);
        window.history.replaceState({}, '', url.toString());

        // Update all translatable elements
        updateAllTranslations();

        // Update the language selector dropdown to reflect the new language
        const langSelect = document.getElementById('lang-select');
        if (langSelect) {
          langSelect.value = locale;
        }
      } catch (error) {
        console.error('Failed to change language:', error);
        // Fallback: reload the page
        localStorage.setItem('authrim_setup_lang', locale);
        const url = new URL(window.location.href);
        url.searchParams.set('lang', locale);
        window.location.href = url.toString();
      }
    }

    // Initialize translations on page load
    (function() {
      const savedLang = localStorage.getItem('authrim_setup_lang');
      const url = new URL(window.location.href);
      const urlLang = url.searchParams.get('lang');

      // If URL has lang parameter, use it and save to localStorage (CLI passed language)
      if (urlLang && _availableLocales.some(l => l.code === urlLang)) {
        localStorage.setItem('authrim_setup_lang', urlLang);
        // Apply translations for the current locale immediately
        updateAllTranslations();
      } else if (savedLang && savedLang !== _currentLocale) {
        // If there's a saved language preference and no query param, switch to it
        url.searchParams.set('lang', savedLang);
        window.history.replaceState({}, '', url.toString());
        changeLanguage(savedLang);
      } else {
        // Apply translations for the current locale immediately
        updateAllTranslations();
      }

      // Ensure the language selector displays the current language
      // This is needed in case the HTML selected attribute isn't being honored
      const langSelect = document.getElementById('lang-select');
      if (langSelect) {
        langSelect.value = _currentLocale;
      }
    })();
  </script>
</head>
<body>
  <!-- Background Typography -->
  <div class="bg-typography" aria-hidden="true">Authrim</div>

  <!-- Splash Screen -->
  <div id="splash" class="splash">
    <div class="splash-content">
      <h1 class="splash-title">Authrim</h1>
      <p class="splash-tagline">Identity & Access Platform</p>
      <div class="splash-loader"></div>
    </div>
  </div>

  <!-- Top Controls: Language Selector + Theme Toggle -->
  <div class="top-controls">
    <div class="lang-selector">
      <select id="lang-select" onchange="changeLanguage(this.value)" aria-label="Select language">
        ${localeOptionsHtml}
      </select>
    </div>
    <button id="theme-toggle" class="theme-toggle" aria-label="Toggle theme">🌙</button>
  </div>

  <div class="container">
    <header>
      <h1>Authrim</h1>
      <p class="header-wizard">Setup Wizard</p>
      <p class="subtitle">OIDC Provider on Cloudflare Workers</p>
    </header>

    <div class="step-indicator" id="step-indicator">
      <div class="step step-active" id="step-1">1</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-2">2</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-3">3</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-4">4</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-5">5</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-6">6</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-7">7</div>
      <div class="step-connector"></div>
      <div class="step step-pending" id="step-8">8</div>
    </div>

    <!-- Step 1: Prerequisites -->
    <div id="section-prerequisites" class="card">
      <h2 class="card-title">
        <span data-i18n="web.prereq.title">Prerequisites</span>
        <span class="status-badge status-running" id="prereq-status" data-i18n="web.prereq.checking">Checking...</span>
      </h2>
      <div id="prereq-content">
        <p data-i18n="web.prereq.checkingRequirements">Checking system requirements...</p>
      </div>
    </div>

    <!-- Step 1.5: Top Menu (New Setup / Load Config / Manage) -->
    <div id="section-top-menu" class="card hidden">
      <h2 class="card-title" data-i18n="web.menu.title">Get Started</h2>
      <p style="margin-bottom: 1.5rem; color: var(--text-muted);" data-i18n="web.menu.subtitle">Choose an option to continue:</p>

      <div class="mode-cards" style="grid-template-columns: repeat(3, 1fr);">
        <div class="mode-card" id="menu-new-setup">
          <div class="mode-icon">🆕</div>
          <h3 data-i18n="web.menu.newSetup">New Setup</h3>
          <p data-i18n="web.menu.newSetupDesc">Create a new Authrim deployment from scratch</p>
        </div>

        <div class="mode-card" id="menu-load-config">
          <div class="mode-icon">📂</div>
          <h3 data-i18n="web.menu.loadConfig">Load Config</h3>
          <p data-i18n="web.menu.loadConfigDesc">Resume or redeploy using existing config</p>
        </div>

        <div class="mode-card" id="menu-manage-env">
          <div class="mode-icon">⚙️</div>
          <h3 data-i18n="web.menu.manageEnv">Manage Environments</h3>
          <p data-i18n="web.menu.manageEnvDesc">View, inspect, or delete existing environments</p>
        </div>
      </div>
    </div>

    <!-- Step 1.6: Setup Mode Selection (Quick / Custom) -->
    <div id="section-mode" class="card hidden">
      <h2 class="card-title" data-i18n="web.mode.title">Setup Mode</h2>
      <p style="margin-bottom: 1.5rem; color: var(--text-muted);" data-i18n="web.mode.subtitle">Choose how you want to set up Authrim:</p>

      <div class="mode-cards">
        <div class="mode-card" id="mode-quick">
          <div class="mode-icon">⚡</div>
          <h3 data-i18n="web.mode.quick">Quick Setup</h3>
          <p data-i18n="web.mode.quickDesc">Get started in ~5 minutes</p>
          <ul>
            <li data-i18n="web.mode.quickEnv">Environment selection</li>
            <li data-i18n="web.mode.quickDomain">Optional custom domain</li>
            <li data-i18n="web.mode.quickDefault">Default components</li>
          </ul>
          <span class="mode-badge" data-i18n="web.mode.recommended">Recommended</span>
        </div>

        <div class="mode-card" id="mode-custom">
          <div class="mode-icon">🔧</div>
          <h3 data-i18n="web.mode.custom">Custom Setup</h3>
          <p data-i18n="web.mode.customDesc">Full control over configuration</p>
          <ul>
            <li data-i18n="web.mode.customComp">Component selection</li>
            <li data-i18n="web.mode.customUrl">URL configuration</li>
            <li data-i18n="web.mode.customAdvanced">Advanced settings</li>
          </ul>
        </div>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-top" data-i18n="web.btn.back">Back</button>
      </div>
    </div>

    <!-- Step 1.7: Load Config -->
    <div id="section-load-config" class="card hidden">
      <h2 class="card-title" data-i18n="web.loadConfig.title">Load Configuration</h2>
      <p style="margin-bottom: 1rem; color: var(--text-muted);" data-i18n="web.loadConfig.subtitle">Select your authrim-config.json file:</p>

      <div class="form-group">
        <div class="file-input-wrapper">
          <span class="file-input-btn" data-i18n="web.loadConfig.chooseFile">📁 Choose File</span>
          <input type="file" id="config-file" accept=".json">
        </div>
        <span id="config-file-name" style="margin-left: 1rem; color: var(--text-muted);"></span>
      </div>

      <div id="config-preview-section" class="hidden">
        <h3 style="font-size: 1rem; margin-bottom: 0.5rem;" data-i18n="web.loadConfig.preview">Configuration Preview</h3>
        <div class="config-preview" id="config-preview-content"></div>
      </div>

      <div id="config-validation-error" class="hidden" style="margin-top: 1rem; padding: 1rem; background: #fee2e2; border: 1px solid #fca5a5; border-radius: 8px;">
        <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
          <span style="font-size: 1.25rem;">⚠️</span>
          <strong style="color: #b91c1c;" data-i18n="web.loadConfig.validationFailed">Configuration Validation Failed</strong>
        </div>
        <ul id="config-validation-errors" style="margin: 0; padding-left: 1.5rem; color: #991b1b; font-size: 0.875rem;"></ul>
      </div>

      <div id="config-validation-success" class="hidden" style="margin-top: 1rem; padding: 0.75rem 1rem; background: #d1fae5; border: 1px solid #6ee7b7; border-radius: 8px;">
        <span style="color: #065f46;" data-i18n="web.loadConfig.valid">✓ Configuration is valid</span>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-top-2" data-i18n="web.btn.back">Back</button>
        <button class="btn-primary" id="btn-load-config" disabled data-i18n="web.loadConfig.loadContinue">Load & Continue</button>
      </div>
    </div>

    <!-- Step 2: Configuration -->
    <div id="section-config" class="card hidden">
      <h2 class="card-title" data-i18n="web.config.title">Configuration</h2>

      <!-- 1. Components (shown in custom mode) -->
      <div id="advanced-options" class="hidden">
        <h3 style="margin: 0 0 1rem; font-size: 1rem;">📦 <span data-i18n="web.config.components">Components</span></h3>

        <!-- API Component (required) -->
        <div class="component-card">
          <label class="checkbox-item" style="font-weight: 600; margin-bottom: 0.25rem;">
            <input type="checkbox" id="comp-api" checked disabled>
            🔐 <span data-i18n="web.config.apiRequired">API (required)</span>
          </label>
          <p style="margin: 0.25rem 0 0.5rem 1.5rem; font-size: 0.85rem;" data-i18n="web.config.apiDesc">
            OIDC Provider endpoints: authorize, token, userinfo, discovery, management APIs.
          </p>
          <div style="margin-left: 1.5rem; display: flex; flex-wrap: wrap; gap: 0.75rem;">
            <label class="checkbox-item" style="font-size: 0.9rem;">
              <input type="checkbox" id="comp-saml">
              <span data-i18n="web.config.saml">SAML IdP</span>
            </label>
            <label class="checkbox-item" style="font-size: 0.9rem;">
              <input type="checkbox" id="comp-async">
              Device Flow / CIBA
            </label>
            <label class="checkbox-item" style="font-size: 0.9rem;">
              <input type="checkbox" id="comp-vc">
              Verifiable Credentials
            </label>
          </div>
        </div>

        <!-- Login UI Component -->
        <div class="component-card">
          <label class="checkbox-item" style="font-weight: 600; margin-bottom: 0.25rem;">
            <input type="checkbox" id="comp-login-ui" checked>
            🖥️ <span data-i18n="web.comp.loginUi">Login UI</span>
          </label>
          <p style="margin: 0.25rem 0 0 1.5rem; font-size: 0.85rem;" data-i18n="web.comp.loginUiDesc">
            User-facing login, registration, consent, and account management pages.
          </p>
        </div>

        <!-- Admin UI Component -->
        <div class="component-card">
          <label class="checkbox-item" style="font-weight: 600; margin-bottom: 0.25rem;">
            <input type="checkbox" id="comp-admin-ui" checked>
            ⚙️ <span data-i18n="web.comp.adminUi">Admin UI</span>
          </label>
          <p style="margin: 0.25rem 0 0 1.5rem; font-size: 0.85rem;" data-i18n="web.comp.adminUiDesc">
            Admin dashboard for managing tenants, clients, users, and system settings.
          </p>
        </div>

        <hr style="margin: 1.5rem 0; border: none; border-top: 1px solid var(--border);">
      </div>

      <!-- 2. Environment Name -->
      <div class="form-group">
        <label for="env"><span data-i18n="web.form.envName">Environment Name</span> <span style="color: var(--error);">*</span></label>
        <input type="text" id="env" placeholder="e.g., prod, staging, dev" data-i18n-placeholder="web.form.envNamePlaceholder" required>
        <small style="color: var(--text-muted)" data-i18n="web.form.envNameHint">Lowercase letters, numbers, and hyphens only</small>
      </div>

      <!-- 3. Domain Configuration -->
      <!-- 3.1 API / Issuer Domain -->
      <div class="domain-section">
        <h4>🌐 <span data-i18n="web.section.apiDomain">API / Issuer Domain</span></h4>

        <div class="form-group" style="margin-bottom: 0.75rem;">
          <label for="base-domain" data-i18n="web.form.baseDomain">Base Domain (API Domain)</label>
          <input type="text" id="base-domain" placeholder="oidc.example.com" data-i18n-placeholder="web.form.baseDomainPlaceholder">
          <small style="color: var(--text-muted)" data-i18n="web.form.baseDomainHint">Custom domain for Authrim. Leave empty to use workers.dev</small>
          <label class="checkbox-item" id="naked-domain-label" style="display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem;">
            <input type="checkbox" id="naked-domain">
            <span data-i18n="web.form.nakedDomain">Exclude tenant name from URL</span>
          </label>
          <small id="naked-domain-hint" style="color: var(--text-muted); margin-left: 1.5rem;" data-i18n="web.form.nakedDomainHint">
            Use https://example.com instead of https://{tenant}.example.com
          </small>
          <small id="workers-dev-note" style="color: #d97706; margin-left: 1.5rem; display: none;" data-i18n="web.form.nakedDomainWarning">
            ⚠️ Tenant subdomains require a custom domain. Workers.dev does not support wildcard subdomains.
          </small>
        </div>

        <!-- Default Tenant (hidden when naked domain is checked or using workers.dev) -->
        <div id="tenant-fields">
          <div class="form-group" style="margin-bottom: 0.5rem;">
            <label for="tenant-name" data-i18n="web.form.tenantId">Default Tenant ID</label>
            <input type="text" id="tenant-name" placeholder="default" value="default" data-i18n-placeholder="web.form.tenantIdPlaceholder">
            <small style="color: var(--text-muted)" data-i18n="web.form.tenantIdHint">First tenant identifier (lowercase, no spaces)</small>
            <small id="tenant-workers-note" style="color: #6b7280; display: none;" data-i18n="web.form.tenantIdWorkerNote">
              (Tenant ID is used internally. URL subdomain requires custom domain.)
            </small>
          </div>
        </div>

        <div class="form-group" style="margin-bottom: 0;">
          <label for="tenant-display" data-i18n="web.form.tenantDisplay">Tenant Display Name</label>
          <input type="text" id="tenant-display" placeholder="My Company" value="Default Tenant" data-i18n-placeholder="web.form.tenantDisplayPlaceholder">
          <small style="color: var(--text-muted)" data-i18n="web.form.tenantDisplayHint">Name shown on login page and consent screen</small>
        </div>
      </div>

      <!-- 3.2 UI Domains -->
      <div class="domain-section" id="ui-domains-section">
        <h4>🖥️ <span data-i18n="web.section.uiDomains">UI Domains (Optional)</span></h4>
        <div class="section-hint" data-i18n="web.section.uiDomainsHint">
          Custom domains for Login/Admin UIs. Each can be set independently.
          Leave empty to use Cloudflare Pages default.
        </div>

        <div class="domain-row" id="login-domain-row">
          <span class="domain-label" data-i18n="web.domain.loginUi">Login UI</span>
          <div class="domain-input-wrapper">
            <input type="text" id="login-domain" placeholder="login.example.com" data-i18n-placeholder="web.form.loginDomainPlaceholder">
            <span class="domain-default" id="login-default">{env}-ar-ui.pages.dev</span>
          </div>
        </div>

        <div class="domain-row" id="admin-domain-row">
          <span class="domain-label" data-i18n="web.domain.adminUi">Admin UI</span>
          <div class="domain-input-wrapper">
            <input type="text" id="admin-domain" placeholder="admin.example.com" data-i18n-placeholder="web.form.adminDomainPlaceholder">
            <span class="domain-default" id="admin-default">{env}-ar-ui.pages.dev/admin</span>
          </div>
        </div>

        <div class="section-hint hint-box" style="margin-top: 0.75rem;" data-i18n="web.section.corsHint">
          💡 CORS: Cross-origin requests from Login/Admin UI to API are automatically allowed.
        </div>
      </div>

      <!-- 4. Preview Section (at the bottom) -->
      <div class="infra-section" id="config-preview">
        <h4>📋 <span data-i18n="web.section.configPreview">Configuration Preview</span></h4>
        <div class="infra-item">
          <span class="infra-label" data-i18n="web.preview.components">Components:</span>
          <span class="infra-value" id="preview-components">API, Login UI, Admin UI</span>
        </div>
        <div class="infra-item">
          <span class="infra-label" data-i18n="web.preview.workers">Workers:</span>
          <span class="infra-value" id="preview-workers">{env}-ar-router, {env}-ar-auth, ...</span>
        </div>
        <div class="infra-item">
          <span class="infra-label" data-i18n="web.preview.issuerUrl">Issuer URL:</span>
          <span class="infra-value" id="preview-issuer">https://{tenant}.{base-domain}</span>
        </div>
        <div class="infra-item">
          <span class="infra-label" data-i18n="web.preview.loginUi">Login UI:</span>
          <span class="infra-value" id="preview-login">{env}-ar-ui.pages.dev</span>
        </div>
        <div class="infra-item">
          <span class="infra-label" data-i18n="web.preview.adminUi">Admin UI:</span>
          <span class="infra-value" id="preview-admin">{env}-ar-ui.pages.dev/admin</span>
        </div>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-mode" data-i18n="web.btn.back">Back</button>
        <button class="btn-primary" id="btn-configure" data-i18n="web.btn.continue">Continue</button>
      </div>
    </div>

    <!-- Step 3: Database Configuration -->
    <div id="section-database" class="card hidden">
      <h2 class="card-title" data-i18n="web.db.title">🗄️ Database Configuration</h2>

      <p style="margin-bottom: 1rem; color: var(--text-muted);" data-i18n="web.db.introDesc">
        Authrim uses two separate D1 databases to isolate personal data from application data.
      </p>

      <p style="margin-bottom: 1.5rem; font-size: 0.85rem; color: var(--text-muted);" data-i18n="web.db.regionNote">
        Note: Database region cannot be changed after creation.
      </p>

      <div class="database-config-stack">
        <!-- Core Database (Non-PII) -->
        <div class="database-card">
          <h3>🗄️ <span data-i18n="web.db.coreTitle">Core Database</span> <span style="font-size: 0.8rem; font-weight: normal; color: var(--text-muted);">(<span data-i18n="web.db.coreNonPii">Non-PII</span>)</span></h3>
          <div class="db-description">
            <p data-i18n="web.db.coreDataDesc">Stores non-personal application data including:</p>
            <ul>
              <li data-i18n="web.db.coreData1">OAuth clients and their configurations</li>
              <li data-i18n="web.db.coreData2">Authorization codes and access tokens</li>
              <li data-i18n="web.db.coreData3">User sessions and login state</li>
              <li data-i18n="web.db.coreData4">Tenant settings and configurations</li>
              <li data-i18n="web.db.coreData5">Audit logs and security events</li>
            </ul>
            <p class="db-hint" data-i18n="web.db.coreHint">This database handles all authentication flows and should be placed close to your primary user base.</p>
          </div>

          <div class="region-selection">
            <h4 data-i18n="web.db.region">Region</h4>
            <div class="radio-group">
              <label class="radio-item">
                <input type="radio" name="db-core-location" value="auto" checked>
                <span data-i18n="web.db.autoNearest">Automatic (nearest to you)</span>
              </label>
              <div class="radio-separator" data-i18n="web.db.locationHints">Location Hints</div>
              <label class="radio-item">
                <input type="radio" name="db-core-location" value="wnam">
                <span data-i18n="web.db.northAmericaWest">North America (West)</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-core-location" value="enam">
                <span data-i18n="web.db.northAmericaEast">North America (East)</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-core-location" value="weur">
                <span data-i18n="web.db.europeWest">Europe (West)</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-core-location" value="eeur">
                <span data-i18n="web.db.europeEast">Europe (East)</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-core-location" value="apac">
                <span data-i18n="web.db.asiaPacific">Asia Pacific</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-core-location" value="oc">
                <span data-i18n="web.db.oceania">Oceania</span>
              </label>
              <div class="radio-separator" data-i18n="web.db.jurisdiction">Jurisdiction (Compliance)</div>
              <label class="radio-item">
                <input type="radio" name="db-core-location" value="eu">
                <span data-i18n="web.db.euJurisdiction">EU Jurisdiction (GDPR compliance)</span>
              </label>
            </div>
          </div>
        </div>

        <!-- PII Database -->
        <div class="database-card">
          <h3>🔒 <span data-i18n="web.db.piiTitle">PII Database</span> <span style="font-size: 0.8rem; font-weight: normal; color: var(--text-muted);">(<span data-i18n="web.db.piiLabel">Personal Identifiable Information</span>)</span></h3>
          <div class="db-description">
            <p data-i18n="web.db.piiDataDesc">Stores personal user data including:</p>
            <ul>
              <li data-i18n="web.db.piiData1">User profiles (name, email, phone)</li>
              <li data-i18n="web.db.piiData2">Passkey/WebAuthn credentials</li>
              <li data-i18n="web.db.piiData3">User preferences and settings</li>
              <li data-i18n="web.db.piiData4">Any custom user attributes</li>
            </ul>
            <p class="db-hint" data-i18n="web.db.piiHint">This database contains personal data. Consider placing it in a region that complies with your data protection requirements.</p>
          </div>

          <div class="region-selection">
            <h4 data-i18n="web.db.region">Region</h4>
            <div class="radio-group">
              <label class="radio-item">
                <input type="radio" name="db-pii-location" value="auto" checked>
                <span data-i18n="web.db.autoNearest">Automatic (nearest to you)</span>
              </label>
              <div class="radio-separator" data-i18n="web.db.locationHints">Location Hints</div>
              <label class="radio-item">
                <input type="radio" name="db-pii-location" value="wnam">
                <span data-i18n="web.db.northAmericaWest">North America (West)</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-pii-location" value="enam">
                <span data-i18n="web.db.northAmericaEast">North America (East)</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-pii-location" value="weur">
                <span data-i18n="web.db.europeWest">Europe (West)</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-pii-location" value="eeur">
                <span data-i18n="web.db.europeEast">Europe (East)</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-pii-location" value="apac">
                <span data-i18n="web.db.asiaPacific">Asia Pacific</span>
              </label>
              <label class="radio-item">
                <input type="radio" name="db-pii-location" value="oc">
                <span data-i18n="web.db.oceania">Oceania</span>
              </label>
              <div class="radio-separator" data-i18n="web.db.jurisdiction">Jurisdiction (Compliance)</div>
              <label class="radio-item">
                <input type="radio" name="db-pii-location" value="eu">
                <span data-i18n="web.db.euJurisdiction">EU Jurisdiction (GDPR compliance)</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-database" data-i18n="web.btn.back">Back</button>
        <button class="btn-primary" id="btn-continue-database" data-i18n="web.btn.continue">Continue</button>
      </div>
    </div>

    <!-- Step 4: Email Provider Configuration -->
    <div id="section-email" class="card hidden">
      <h2 class="card-title" data-i18n="web.email.title">📧 Email Provider</h2>

      <p style="margin-bottom: 1rem; color: var(--text-muted);" data-i18n="web.email.introDesc">
        Used for sending Mail OTP and email address verification.
        You can configure this later if you prefer.
      </p>

      <div class="radio-group" style="margin-bottom: 1.5rem;">
        <label class="radio-item" style="padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px;">
          <input type="radio" name="email-setup-choice" value="later" checked>
          <span style="display: flex; flex-direction: column; gap: 0.25rem;">
            <strong data-i18n="web.email.configureLater">Configure later</strong>
            <small style="color: var(--text-muted);" data-i18n="web.email.configureLaterHint">Skip for now and configure later.</small>
          </span>
        </label>
        <label class="radio-item" style="padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px; margin-top: 0.5rem;">
          <input type="radio" name="email-setup-choice" value="configure">
          <span style="display: flex; flex-direction: column; gap: 0.25rem;">
            <strong data-i18n="web.email.configureResend">Configure Resend</strong>
            <small style="color: var(--text-muted);" data-i18n="web.email.configureResendHint">Set up email sending with Resend (recommended for production).</small>
          </span>
        </label>
      </div>

      <!-- Resend Configuration Form (hidden by default) -->
      <div id="resend-config-form" class="hidden" style="background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem;">
        <h3 style="margin: 0 0 1rem 0; font-size: 1rem;">🔑 <span data-i18n="web.email.resendSetup">Resend Configuration</span></h3>

        <div class="alert alert-info" style="margin-bottom: 1rem;">
          <strong>📋 <span data-i18n="web.email.beforeBegin">Before you begin:</span></strong>
          <ol style="margin: 0.5rem 0 0 1rem; padding: 0;">
            <li><span data-i18n="web.email.step1">Create a Resend account at</span> <a href="https://resend.com" target="_blank" style="color: var(--primary);">resend.com</a></li>
            <li><span data-i18n="web.email.step2">Add and verify your domain at</span> <a href="https://resend.com/domains" target="_blank" style="color: var(--primary);">Domains Dashboard</a></li>
            <li><span data-i18n="web.email.step3">Create an API key at</span> <a href="https://resend.com/api-keys" target="_blank" style="color: var(--primary);">API Keys</a></li>
          </ol>
        </div>

        <div class="form-group">
          <label for="resend-api-key" data-i18n="web.email.resendApiKey">Resend API Key</label>
          <input type="password" id="resend-api-key" placeholder="re_xxxxxxxxxx" autocomplete="off">
          <small style="color: var(--text-muted);" data-i18n="web.email.resendApiKeyHint">Your API key starts with "re_"</small>
        </div>

        <div class="form-group">
          <label for="email-from-address" data-i18n="web.email.fromEmailAddress">From Email Address</label>
          <input type="email" id="email-from-address" placeholder="noreply@yourdomain.com" autocomplete="off">
          <small style="color: var(--text-muted);" data-i18n="web.email.fromEmailHint">Must be from a verified domain in your Resend account</small>
        </div>

        <div class="form-group">
          <label for="email-from-name" data-i18n="web.email.fromDisplayName">From Display Name (optional)</label>
          <input type="text" id="email-from-name" placeholder="Authrim" autocomplete="off">
          <small style="color: var(--text-muted);" data-i18n="web.email.fromDisplayHint">Displayed as the sender name in email clients</small>
        </div>

        <div class="alert alert-warning" style="margin-top: 1rem;">
          <strong>⚠️ <span data-i18n="web.email.domainVerificationTitle">Domain Verification Required</span></strong>
          <p style="margin: 0.25rem 0 0 0; font-size: 0.875rem;" data-i18n="web.email.domainVerificationDesc">
            Before your domain is verified, emails can only be sent from onboarding@resend.dev (for testing).
          </p>
          <p style="margin: 0.25rem 0 0 0; font-size: 0.875rem;">
            <a href="https://resend.com/docs/dashboard/domains/introduction" target="_blank" style="color: var(--primary);" data-i18n="web.email.learnMore">Learn more about domain verification →</a>
          </p>
        </div>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-email" data-i18n="web.btn.back">Back</button>
        <button class="btn-primary" id="btn-continue-email" data-i18n="web.btn.continue">Continue</button>
      </div>
    </div>

    <!-- Step 5: Provisioning -->
    <div id="section-provision" class="card hidden">
      <h2 class="card-title">
        <span data-i18n="web.provision.title">Resource Provisioning</span>
        <span class="status-badge status-pending" id="provision-status" data-i18n="web.provision.ready">Ready</span>
      </h2>

      <p style="margin-bottom: 1rem;" data-i18n="web.provision.desc">The following resources will be created:</p>

      <!-- Resource names preview -->
      <div id="resource-preview" class="resource-preview">
        <h4 style="font-size: 0.9rem; margin-bottom: 0.75rem; color: var(--text-muted);">📋 <span data-i18n="web.provision.resourcePreview">Resource Names:</span></h4>
        <div class="resource-list">
          <div class="resource-category">
            <strong data-i18n="web.provision.d1Databases">D1 Databases:</strong>
            <ul id="preview-d1"></ul>
          </div>
          <div class="resource-category">
            <strong data-i18n="web.provision.kvNamespaces">KV Namespaces:</strong>
            <ul id="preview-kv"></ul>
          </div>
          <div class="resource-category">
            <strong data-i18n="web.provision.cryptoKeys">Cryptographic Keys:</strong>
            <ul id="preview-keys"></ul>
          </div>
        </div>
      </div>

      <!-- Progress UI (shown during provisioning) -->
      <div id="provision-progress-ui" class="progress-container hidden">
        <div class="progress-status">
          <div class="spinner" id="provision-spinner"></div>
          <span id="provision-current-task" data-i18n="web.provision.initializing">Initializing...</span>
        </div>
        <div class="progress-bar-wrapper">
          <div class="progress-bar" id="provision-progress-bar" style="width: 0%"></div>
        </div>
        <div class="progress-text" id="provision-progress-text">0 / 0 resources</div>

        <div class="log-toggle" id="provision-log-toggle">
          <span class="arrow">▶</span>
          <span data-i18n="web.provision.showLog">Show detailed log</span>
        </div>
      </div>

      <div class="progress-log hidden" id="provision-log">
        <pre id="provision-output"></pre>
      </div>

      <!-- Keys saved location (shown after completion) -->
      <div id="keys-saved-info" class="alert alert-info hidden" style="margin-top: 1rem;">
        <strong>🔑 <span data-i18n="web.provision.keysSavedTo">Keys saved to:</span></strong>
        <code style="display: block; margin-top: 0.5rem; padding: 0.5rem; background: #f1f5f9; border-radius: 4px;" id="keys-path"></code>
        <p style="margin-top: 0.5rem; font-size: 0.85rem; color: var(--text-muted);" data-i18n="web.provision.keepSafe">
          ⚠️ Keep this directory safe and add it to .gitignore
        </p>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-config" data-i18n="web.btn.back">Back</button>
        <button class="btn-primary" id="btn-provision" data-i18n="web.provision.createResources">Create Resources</button>
        <button class="btn-secondary hidden" id="btn-save-config-provision" title="Save configuration to file" data-i18n="web.provision.saveConfig">💾 Save Config</button>
        <button class="btn-primary hidden" id="btn-goto-deploy" data-i18n="web.provision.continueDeploy">Continue to Deploy →</button>
      </div>
    </div>

    <!-- Step 4: Deployment -->
    <div id="section-deploy" class="card hidden">
      <h2 class="card-title">
        <span data-i18n="web.deploy.title">Deployment</span>
        <span class="status-badge status-pending" id="deploy-status" data-i18n="web.provision.ready">Ready</span>
      </h2>

      <p id="deploy-ready-text" style="margin-bottom: 1rem;" data-i18n="web.deploy.readyText">Ready to deploy Authrim workers to Cloudflare.</p>

      <!-- Progress UI (shown during deployment) -->
      <div id="deploy-progress-ui" class="progress-container hidden">
        <div class="progress-status">
          <div class="spinner" id="deploy-spinner"></div>
          <span id="deploy-current-task" data-i18n="web.provision.initializing">Initializing...</span>
        </div>
        <div class="progress-bar-wrapper">
          <div class="progress-bar" id="deploy-progress-bar" style="width: 0%"></div>
        </div>
        <div class="progress-text" id="deploy-progress-text">0 / 0 components</div>

        <div class="log-toggle" id="deploy-log-toggle">
          <span class="arrow">▶</span>
          <span data-i18n="web.provision.showLog">Show detailed log</span>
        </div>
      </div>

      <div class="progress-log hidden" id="deploy-log">
        <pre id="deploy-output"></pre>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-provision" data-i18n="web.btn.back">Back</button>
        <button class="btn-primary" id="btn-deploy" data-i18n="web.deploy.startDeploy">Start Deploy</button>
      </div>
    </div>

    <!-- Complete -->
    <div id="section-complete" class="card hidden">
      <h2 class="card-title" style="color: var(--success);" data-i18n="web.complete.title">
        ✅ Setup Complete!
      </h2>

      <p data-i18n="web.complete.desc">Authrim has been successfully deployed.</p>

      <div class="url-display" id="urls">
        <!-- URLs will be inserted here -->
      </div>

      <div class="alert alert-info" style="margin-top: 1rem;">
        <strong data-i18n="web.complete.nextSteps">Next Steps:</strong>
        <ol style="margin-left: 1.5rem; margin-top: 0.5rem;">
          <li data-i18n="web.complete.step1">Visit the <strong>Admin Setup</strong> URL above to register your first admin with Passkey</li>
          <li data-i18n="web.complete.step2">Log in to the Admin UI to create OAuth clients</li>
          <li data-i18n="web.complete.step3">Configure your application to use the OIDC endpoints</li>
        </ol>
      </div>

      <div class="button-group" style="margin-top: 1.5rem; justify-content: center;">
        <button class="btn-secondary" id="btn-save-config-complete" title="Save configuration to file" data-i18n="web.complete.saveConfig">💾 Save Configuration</button>
        <button class="btn-secondary" id="btn-back-to-main" title="Return to main screen" data-i18n="web.complete.backToMain">🏠 Back to Main</button>
      </div>

      <p style="text-align: center; margin-top: 1.5rem; color: var(--text-muted); font-size: 0.9rem;">
        ✅ <span data-i18n="web.complete.canClose">Setup is complete. You can safely close this window.</span>
      </p>
    </div>

    <!-- Environment Management: List -->
    <div id="section-env-list" class="card hidden">
      <h2 class="card-title">
        <span data-i18n="web.env.title">Manage Environments</span>
        <span class="status-badge status-pending" id="env-list-status" data-i18n="web.env.loading">Loading...</span>
      </h2>

      <p style="margin-bottom: 1rem; color: var(--text-muted);" data-i18n="web.env.detectedDesc">
        Detected Authrim environments in your Cloudflare account:
      </p>

      <div id="env-list-loading" class="progress-log">
        <pre id="env-scan-output"></pre>
      </div>

      <div id="env-list-content" class="hidden">
        <div id="env-cards" class="env-cards">
          <!-- Environment cards will be inserted here -->
        </div>

        <div id="no-envs-message" class="alert alert-info hidden" data-i18n="web.env.noEnvsDetected">
          No Authrim environments detected in this Cloudflare account.
        </div>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-env-list" data-i18n="web.btn.back">Back</button>
        <button class="btn-secondary" id="btn-refresh-env-list">🔄 <span data-i18n="web.env.refresh">Refresh</span></button>
      </div>
    </div>

    <!-- Environment Management: Details -->
    <div id="section-env-detail" class="card hidden">
      <h2 class="card-title">
        📋 <span data-i18n="web.envDetail.title">Environment Details</span>
        <code id="detail-env-name" style="background: var(--bg); padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 1rem;"></code>
      </h2>

      <!-- Admin Setup Section -->
      <div id="admin-setup-section" class="hidden hint-box" style="margin-bottom: 1.5rem; padding: 1rem;">
        <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem;">
          <span style="font-size: 1.5rem;">⚠️</span>
          <div>
            <div style="font-weight: 600;" data-i18n="web.envDetail.adminNotConfigured">Admin Account Not Configured</div>
            <div style="font-size: 0.875rem; opacity: 0.85;" data-i18n="web.envDetail.adminNotConfiguredDesc">Initial administrator has not been set up for this environment.</div>
          </div>
        </div>
        <button class="btn-primary" id="btn-start-admin-setup" style="margin-top: 0.5rem;" data-i18n="web.envDetail.startPasskey">
          🔐 Start Admin Account Setup with Passkey
        </button>
        <div id="admin-setup-result" class="hidden" style="margin-top: 1rem; padding: 0.75rem; background: var(--card-bg); border-radius: 6px;">
          <div style="font-weight: 500; margin-bottom: 0.5rem;" data-i18n="web.envDetail.setupUrlGenerated">Setup URL Generated:</div>
          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <input type="text" id="admin-setup-url" readonly style="flex: 1; padding: 0.5rem; border: 1px solid var(--border); border-radius: 4px; font-family: monospace; font-size: 0.875rem; background: var(--bg); color: var(--text);">
            <button class="btn-secondary" id="btn-copy-setup-url" style="white-space: nowrap;">📋 <span data-i18n="web.envDetail.copyBtn">Copy</span></button>
          </div>
          <div style="text-align: center; margin-top: 1rem;">
            <a id="btn-open-setup-url" href="#" target="_blank" class="btn-primary">🔑 <span data-i18n="web.envDetail.openSetup">Open Setup</span></a>
          </div>
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.75rem; text-align: center;" data-i18n="web.envDetail.urlValidFor">
            This URL is valid for 1 hour. Open it in a browser to register the first admin account.
          </div>
        </div>
      </div>

      <div id="detail-resources">
        <!-- Workers -->
        <div class="resource-section">
          <div class="resource-section-title">
            🔧 <span data-i18n="web.envDetail.workers">Workers</span> <span class="count" id="detail-workers-count">(0)</span>
          </div>
          <div class="resource-list" id="detail-workers-list"></div>
        </div>

        <!-- Worker Update Section -->
        <div class="resource-section" id="worker-update-section" style="margin-top: 1.5rem; border-top: 1px solid var(--border); padding-top: 1.5rem;">
          <div class="resource-section-title">
            🔄 <span data-i18n="web.envDetail.workerUpdate">Update Workers</span>
          </div>

          <!-- Version comparison table -->
          <div id="worker-version-table" style="margin-top: 1rem; overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
              <thead>
                <tr style="border-bottom: 2px solid var(--border);">
                  <th style="text-align: left; padding: 0.5rem;" data-i18n="web.envDetail.workerName">Worker</th>
                  <th style="text-align: left; padding: 0.5rem;" data-i18n="web.envDetail.deployedVersion">Deployed</th>
                  <th style="text-align: left; padding: 0.5rem;" data-i18n="web.envDetail.localVersion">Local</th>
                  <th style="text-align: center; padding: 0.5rem;" data-i18n="web.envDetail.updateStatus">Status</th>
                </tr>
              </thead>
              <tbody id="worker-version-tbody">
                <tr><td colspan="4" style="text-align: center; padding: 1rem; color: var(--text-muted);" data-i18n="web.status.loading">Loading...</td></tr>
              </tbody>
            </table>
          </div>

          <!-- Update options -->
          <div style="margin-top: 1rem; display: flex; gap: 1rem; align-items: center; flex-wrap: wrap;">
            <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
              <input type="checkbox" id="update-only-changed" checked style="width: 1rem; height: 1rem;">
              <span data-i18n="web.envDetail.updateOnlyChanged">Update only changed versions</span>
            </label>
            <span id="update-summary" style="color: var(--text-muted); font-size: 0.875rem;"></span>
          </div>

          <!-- Action buttons -->
          <div style="margin-top: 1rem; display: flex; gap: 0.75rem; flex-wrap: wrap;">
            <button class="btn-primary" id="btn-update-workers" disabled>
              🚀 <span data-i18n="web.envDetail.updateAllWorkers">Update Workers</span>
            </button>
            <button class="btn-secondary" id="btn-refresh-versions">
              🔄 <span data-i18n="web.envDetail.refreshVersions">Refresh</span>
            </button>
          </div>

          <!-- Progress log -->
          <div id="worker-update-progress" class="hidden" style="margin-top: 1rem;">
            <div style="font-weight: 500; margin-bottom: 0.5rem;" data-i18n="web.envDetail.updateProgress">Update Progress:</div>
            <div id="worker-update-log" class="progress-log" style="max-height: 250px; overflow-y: auto; background: var(--bg); padding: 0.75rem; border-radius: 6px; font-family: var(--font-mono); font-size: 0.8rem; line-height: 1.5;"></div>
          </div>
        </div>

        <!-- D1 Databases -->
        <div class="resource-section">
          <div class="resource-section-title">
            📊 <span data-i18n="web.envDetail.d1Databases">D1 Databases</span> <span class="count" id="detail-d1-count">(0)</span>
          </div>
          <div class="resource-list" id="detail-d1-list"></div>
        </div>

        <!-- KV Namespaces -->
        <div class="resource-section">
          <div class="resource-section-title">
            🗄️ <span data-i18n="web.envDetail.kvNamespaces">KV Namespaces</span> <span class="count" id="detail-kv-count">(0)</span>
          </div>
          <div class="resource-list" id="detail-kv-list"></div>
        </div>

        <!-- Queues -->
        <div class="resource-section" id="detail-queues-section">
          <div class="resource-section-title">
            📨 <span data-i18n="web.envDetail.queues">Queues</span> <span class="count" id="detail-queues-count">(0)</span>
          </div>
          <div class="resource-list" id="detail-queues-list"></div>
        </div>

        <!-- R2 Buckets -->
        <div class="resource-section" id="detail-r2-section">
          <div class="resource-section-title">
            📁 <span data-i18n="web.envDetail.r2Buckets">R2 Buckets</span> <span class="count" id="detail-r2-count">(0)</span>
          </div>
          <div class="resource-list" id="detail-r2-list"></div>
        </div>

        <!-- Pages Projects -->
        <div class="resource-section" id="detail-pages-section">
          <div class="resource-section-title">
            📄 <span data-i18n="web.envDetail.pagesProjects">Pages Projects</span> <span class="count" id="detail-pages-count">(0)</span>
          </div>
          <div class="resource-list" id="detail-pages-list"></div>
        </div>
      </div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-env-detail" data-i18n="web.env.backToList">← Back to List</button>
        <button class="btn-danger" id="btn-delete-from-detail">🗑️ <span data-i18n="web.env.deleteEnv">Delete Environment...</span></button>
      </div>
    </div>

    <!-- Environment Management: Delete Confirmation -->
    <div id="section-env-delete" class="card hidden">
      <h2 class="card-title" style="color: var(--error);">
        ⚠️ <span data-i18n="web.delete.title">Delete Environment</span>
      </h2>

      <div class="alert alert-warning">
        <strong>Warning:</strong> <span data-i18n="web.delete.warning">This action is irreversible. All selected resources will be permanently deleted.</span>
      </div>

      <div style="margin: 1.5rem 0;">
        <h3 style="font-size: 1.1rem; margin-bottom: 1rem;">
          <span data-i18n="web.delete.environment">Environment:</span> <code id="delete-env-name" style="background: var(--bg); padding: 0.25rem 0.5rem; border-radius: 4px;"></code>
        </h3>

        <div id="delete-options-section">
        <p style="margin-bottom: 1rem; color: var(--text-muted);" data-i18n="web.delete.selectResources">Select resources to delete:</p>

        <div class="delete-options">
          <label class="checkbox-item delete-option">
            <input type="checkbox" id="delete-workers" checked>
            <span>
              <strong data-i18n="web.delete.workers">Workers</strong>
              <small id="delete-workers-count">(0 workers)</small>
            </span>
          </label>

          <label class="checkbox-item delete-option">
            <input type="checkbox" id="delete-d1" checked>
            <span>
              <strong data-i18n="web.delete.d1Databases">D1 Databases</strong>
              <small id="delete-d1-count">(0 databases)</small>
            </span>
          </label>

          <label class="checkbox-item delete-option">
            <input type="checkbox" id="delete-kv" checked>
            <span>
              <strong data-i18n="web.delete.kvNamespaces">KV Namespaces</strong>
              <small id="delete-kv-count">(0 namespaces)</small>
            </span>
          </label>

          <label class="checkbox-item delete-option">
            <input type="checkbox" id="delete-queues" checked>
            <span>
              <strong data-i18n="web.delete.queues">Queues</strong>
              <small id="delete-queues-count">(0 queues)</small>
            </span>
          </label>

          <label class="checkbox-item delete-option">
            <input type="checkbox" id="delete-r2" checked>
            <span>
              <strong data-i18n="web.delete.r2Buckets">R2 Buckets</strong>
              <small id="delete-r2-count">(0 buckets)</small>
            </span>
          </label>

          <label class="checkbox-item delete-option">
            <input type="checkbox" id="delete-pages" checked>
            <span>
              <strong data-i18n="web.delete.pagesProjects">Pages Projects</strong>
              <small id="delete-pages-count">(0 projects)</small>
            </span>
          </label>
        </div>
        </div>
      </div>

      <!-- Progress UI (shown during deletion) -->
      <div id="delete-progress-ui" class="progress-container hidden">
        <div class="progress-status">
          <div class="spinner" id="delete-spinner"></div>
          <span id="delete-current-task" data-i18n="web.provision.initializing">Initializing...</span>
        </div>
        <div class="progress-bar-wrapper">
          <div class="progress-bar" id="delete-progress-bar" style="width: 0%"></div>
        </div>
        <div class="progress-text" id="delete-progress-text">0 / 0 resources</div>

        <div class="log-toggle" id="delete-log-toggle">
          <span class="arrow">▶</span>
          <span data-i18n="web.provision.showLog">Show detailed log</span>
        </div>
      </div>

      <div class="progress-log hidden" id="delete-log">
        <pre id="delete-output"></pre>
      </div>

      <div id="delete-result" class="hidden"></div>

      <div class="button-group">
        <button class="btn-secondary" id="btn-back-env-delete" data-i18n="web.delete.cancelBtn">Cancel</button>
        <button class="btn-primary" id="btn-confirm-delete" style="background: var(--error);">🗑️ <span data-i18n="web.delete.confirmBtn">Delete Selected</span></button>
      </div>
    </div>
  </div>

  <!-- Save Config Modal -->
  <div id="save-config-modal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-content">
      <h3 style="margin: 0 0 1rem 0;">💾 <span data-i18n="web.modal.saveTitle">Save Configuration?</span></h3>
      <p style="color: var(--text-muted); margin-bottom: 1.5rem;" data-i18n="web.modal.saveQuestion">
        Would you like to save your configuration to a file before proceeding?
      </p>
      <p style="color: var(--text-muted); margin-bottom: 1.5rem; font-size: 0.9rem;" data-i18n="web.modal.saveReason">
        This allows you to resume setup later or use the same settings for another deployment.
      </p>
      <div class="button-group" style="justify-content: flex-end;">
        <button class="btn-secondary" id="modal-skip-save" data-i18n="web.modal.skipBtn">Skip</button>
        <button class="btn-primary" id="modal-save-config" data-i18n="web.modal.saveBtn">Save Configuration</button>
      </div>
    </div>
  </div>

  <script>
    // ========================================
    // THEME MANAGEMENT
    // ========================================
    function initTheme() {
      const savedTheme = localStorage.getItem('authrim-theme');
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      const theme = savedTheme || (prefersDark ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', theme);
      updateThemeToggle(theme);
    }

    function toggleTheme() {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const newTheme = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('authrim-theme', newTheme);
      updateThemeToggle(newTheme);
    }

    function updateThemeToggle(theme) {
      const toggle = document.getElementById('theme-toggle');
      if (toggle) {
        toggle.textContent = theme === 'dark' ? '☀️' : '🌙';
        toggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      }
    }

    // Listen for system preference changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('authrim-theme')) {
        const theme = e.matches ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', theme);
        updateThemeToggle(theme);
      }
    });

    // Initialize theme immediately
    initTheme();

    // Theme toggle event
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

    // ========================================
    // SPLASH SCREEN
    // ========================================
    function hideSplash() {
      const splash = document.getElementById('splash');
      if (splash) {
        splash.classList.add('fade-out');
        setTimeout(() => {
          splash.style.display = 'none';
        }, 600);
      }
    }

    // Hide splash after 2500ms
    setTimeout(hideSplash, 2500);

    // ========================================
    // MAIN APPLICATION
    // ========================================
    // Session token for API authentication (embedded by server)
    const SESSION_TOKEN = '${safeToken}';
    const MANAGE_ONLY = ${manageOnlyFlag};

    // State
    let currentStep = 1;
    let setupMode = 'quick'; // 'quick' or 'custom'
    let config = {};
    let loadedConfig = null;
    let provisioningCompleted = false;
    let provisionPollInterval = null;

    // Elements
    const steps = {
      1: document.getElementById('step-1'),
      2: document.getElementById('step-2'),
      3: document.getElementById('step-3'),
      4: document.getElementById('step-4'),
      5: document.getElementById('step-5'),
      6: document.getElementById('step-6'),
      7: document.getElementById('step-7'),
      8: document.getElementById('step-8'),
    };

    const sections = {
      prerequisites: document.getElementById('section-prerequisites'),
      topMenu: document.getElementById('section-top-menu'),
      mode: document.getElementById('section-mode'),
      loadConfig: document.getElementById('section-load-config'),
      config: document.getElementById('section-config'),
      database: document.getElementById('section-database'),
      email: document.getElementById('section-email'),
      provision: document.getElementById('section-provision'),
      deploy: document.getElementById('section-deploy'),
      complete: document.getElementById('section-complete'),
      envList: document.getElementById('section-env-list'),
      envDetail: document.getElementById('section-env-detail'),
      envDelete: document.getElementById('section-env-delete'),
    };

    // Environment management state
    let detectedEnvironments = [];
    let selectedEnvForDetail = null;
    let selectedEnvForDelete = null;
    let workingDirectory = '';
    let workersSubdomain = ''; // e.g., 'sgrastar' for {worker}.sgrastar.workers.dev

    // API helpers (with session token authentication)
    async function api(endpoint, options = {}) {
      const { headers: customHeaders, body, ...restOptions } = options;
      const response = await fetch('/api' + endpoint, {
        ...restOptions,
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': SESSION_TOKEN,
          ...(customHeaders || {}),
        },
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      });
      return response.json();
    }

    // Step navigation
    function setStep(step) {
      currentStep = step;
      for (let i = 1; i <= 7; i++) {
        const el = steps[i];
        el.className = 'step ' + (i < step ? 'step-complete' : i === step ? 'step-active' : 'step-pending');
      }
    }

    function showSection(name) {
      Object.values(sections).forEach(s => s.classList.add('hidden'));
      sections[name].classList.remove('hidden');
      window.scrollTo(0, 0);
    }

    // Auto-scroll helper for progress logs
    function scrollToBottom(element) {
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    }

    // Log toggle functionality
    function setupLogToggle(toggleId, logId) {
      const toggle = document.getElementById(toggleId);
      const log = document.getElementById(logId);
      if (toggle && log) {
        toggle.addEventListener('click', () => {
          const isHidden = log.classList.contains('hidden');
          if (isHidden) {
            log.classList.remove('hidden');
            toggle.classList.add('open');
            toggle.querySelector('span:last-child').textContent = t('web.provision.hideLog');
          } else {
            log.classList.add('hidden');
            toggle.classList.remove('open');
            toggle.querySelector('span:last-child').textContent = t('web.provision.showLog');
          }
        });
      }
    }

    // Setup all log toggles
    setupLogToggle('deploy-log-toggle', 'deploy-log');
    setupLogToggle('provision-log-toggle', 'provision-log');
    setupLogToggle('delete-log-toggle', 'delete-log');

    // Progress UI update helper
    function updateProgressUI(prefix, current, total, currentTask) {
      const progressBar = document.getElementById(prefix + '-progress-bar');
      const progressText = document.getElementById(prefix + '-progress-text');
      const currentTaskEl = document.getElementById(prefix + '-current-task');
      const spinner = document.getElementById(prefix + '-spinner');

      if (progressBar && total > 0) {
        const percent = Math.min(Math.round((current / total) * 100), 100);
        progressBar.style.width = percent + '%';
      }
      if (progressText) {
        // For deploy, show percentage; for others, show count
        if (prefix === 'deploy') {
          const percent = Math.min(Math.round((current / total) * 100), 100);
          progressText.textContent = percent + '% complete';
        } else {
          progressText.textContent = current + ' / ' + total + ' resources';
        }
      }
      if (currentTaskEl && currentTask) {
        currentTaskEl.textContent = currentTask;
      }
      // Hide spinner when complete
      if (spinner) {
        spinner.style.display = (current >= total && total > 0) ? 'none' : 'block';
      }
    }

    // Parse progress message to extract current task
    function parseProgressMessage(message) {
      // Match patterns like "Deploying xxx...", "Creating xxx...", "Deleting xxx..."
      if (message.includes('Deploying ')) {
        const parts = message.split('Deploying ')[1];
        if (parts) {
          const name = parts.split('.')[0].split(' ')[0];
          if (name) return 'Deploying ' + name + '...';
        }
      }

      if (message.includes('Creating ')) {
        const parts = message.split('Creating ')[1];
        if (parts) {
          const name = parts.split(' ')[0].split('.')[0];
          if (name) return 'Creating ' + name + '...';
        }
      }

      if (message.includes('Deleting')) {
        const parts = message.split('Deleting')[1];
        if (parts) {
          const name = parts.trim().split(' ')[0].replace(':', '');
          if (name) return 'Deleting ' + name + '...';
        }
      }

      if (message.includes('✓')) {
        const parts = message.split('✓')[1];
        if (parts) {
          const text = parts.trim().substring(0, 40);
          return '✓ ' + text;
        }
      }

      if (message.includes('Level ')) {
        const parts = message.split('Level ')[1];
        if (parts) {
          const num = parts.trim().split(' ')[0];
          if (num) return 'Deployment Level ' + num;
        }
      }

      if (message.includes('Generating')) {
        const parts = message.split('Generating')[1];
        if (parts) {
          const text = parts.trim().substring(0, 30);
          return 'Generating ' + text + '...';
        }
      }

      if (message.includes('Uploading')) return 'Uploading secrets...';
      if (message.toLowerCase().includes('building')) return 'Building packages...';

      return null;
    }

    // Safe DOM element creation helpers
    function createAlert(type, content) {
      const div = document.createElement('div');
      div.className = 'alert alert-' + type;
      if (typeof content === 'string') {
        div.textContent = content;
      } else {
        div.appendChild(content);
      }
      return div;
    }

    function createUrlItem(label, url) {
      const div = document.createElement('div');
      div.className = 'url-item';

      const labelSpan = document.createElement('span');
      labelSpan.className = 'url-label';
      labelSpan.textContent = label;

      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.className = 'url-value';
      link.textContent = url;

      div.appendChild(labelSpan);
      div.appendChild(link);
      return div;
    }

    // Check prerequisites
    async function checkPrerequisites() {
      const prereqStatus = document.getElementById('prereq-status');
      const prereqContent = document.getElementById('prereq-content');

      try {
        const result = await api('/prerequisites');

        // Clear existing content
        prereqContent.textContent = '';

        if (!result.wranglerInstalled) {
          prereqStatus.textContent = t('web.error');
          prereqStatus.className = 'status-badge status-error';

          const alertDiv = document.createElement('div');
          alertDiv.className = 'alert alert-error';

          const title = document.createElement('strong');
          title.textContent = t('web.error.wranglerNotInstalled');
          alertDiv.appendChild(title);

          const para = document.createElement('p');
          para.textContent = t('web.error.pleaseInstall');
          alertDiv.appendChild(para);

          const code = document.createElement('code');
          code.style.display = 'block';
          code.style.marginTop = '0.5rem';
          code.style.padding = '0.5rem';
          code.style.background = '#f1f5f9';
          code.style.borderRadius = '4px';
          code.textContent = 'npm install -g wrangler';
          alertDiv.appendChild(code);

          prereqContent.appendChild(alertDiv);
          return false;
        }

        if (!result.auth.isLoggedIn) {
          prereqStatus.textContent = t('web.error.notLoggedIn');
          prereqStatus.className = 'status-badge status-warning';

          const alertDiv = document.createElement('div');
          alertDiv.className = 'alert alert-warning';

          const title = document.createElement('strong');
          title.textContent = t('web.error.notLoggedIn');
          alertDiv.appendChild(title);

          const para1 = document.createElement('p');
          para1.textContent = t('web.error.runCommand');
          alertDiv.appendChild(para1);

          const code = document.createElement('code');
          code.style.display = 'block';
          code.style.marginTop = '0.5rem';
          code.style.padding = '0.5rem';
          code.style.background = '#f1f5f9';
          code.style.borderRadius = '4px';
          code.textContent = 'wrangler login';
          alertDiv.appendChild(code);

          const para2 = document.createElement('p');
          para2.style.marginTop = '0.5rem';
          para2.textContent = t('web.error.thenRefresh');
          alertDiv.appendChild(para2);

          prereqContent.appendChild(alertDiv);
          return false;
        }

        prereqStatus.textContent = t('web.prereq.ready');
        prereqStatus.className = 'status-badge status-success';

        // Store working directory and workers subdomain for later use
        workingDirectory = result.cwd || '';
        workersSubdomain = result.workersSubdomain || '';

        const alertDiv = document.createElement('div');
        alertDiv.className = 'alert alert-success';

        const p1 = document.createElement('p');
        p1.textContent = '✓ ' + t('web.prereq.wranglerInstalled');
        p1.setAttribute('data-i18n', 'web.prereq.wranglerInstalled');
        alertDiv.appendChild(p1);

        const p2 = document.createElement('p');
        p2.textContent = '✓ ' + t('web.prereq.loggedInAs', { email: result.auth.email || 'Unknown' });
        alertDiv.appendChild(p2);

        prereqContent.appendChild(alertDiv);

        const buttonGroup = document.createElement('div');
        buttonGroup.className = 'button-group';

        const btn = document.createElement('button');
        btn.className = 'btn-primary';
        btn.textContent = t('common.continue');
        btn.setAttribute('data-i18n', 'common.continue');
        btn.addEventListener('click', showTopMenu);
        buttonGroup.appendChild(btn);

        prereqContent.appendChild(buttonGroup);

        return true;
      } catch (error) {
        prereqStatus.textContent = t('web.error');
        prereqStatus.className = 'status-badge status-error';
        prereqContent.textContent = '';
        prereqContent.appendChild(createAlert('error', t('web.error.checkingPrereq') + ' ' + error.message));
        return false;
      }
    }

    // Show top menu
    function showTopMenu() {
      showSection('topMenu');
    }

    // Top menu handlers
    document.getElementById('menu-new-setup').addEventListener('click', () => {
      showSection('mode');
    });

    document.getElementById('menu-load-config').addEventListener('click', () => {
      showSection('loadConfig');
    });

    // Setup mode handlers
    document.getElementById('mode-quick').addEventListener('click', () => {
      setupMode = 'quick';
      document.getElementById('mode-quick').classList.add('selected');
      document.getElementById('mode-custom').classList.remove('selected');
      document.getElementById('advanced-options').classList.add('hidden');
      setStep(2);
      showSection('config');
      updatePreview();
    });

    document.getElementById('mode-custom').addEventListener('click', () => {
      setupMode = 'custom';
      document.getElementById('mode-custom').classList.add('selected');
      document.getElementById('mode-quick').classList.remove('selected');
      document.getElementById('advanced-options').classList.remove('hidden');
      setStep(2);
      showSection('config');
      updatePreview();
    });

    document.getElementById('btn-back-top').addEventListener('click', () => {
      showSection('topMenu');
    });

    document.getElementById('btn-back-top-2').addEventListener('click', () => {
      showSection('topMenu');
    });

    // Load config handlers
    document.getElementById('config-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      document.getElementById('config-file-name').textContent = file.name;

      // Reset validation display
      document.getElementById('config-validation-error').classList.add('hidden');
      document.getElementById('config-validation-success').classList.add('hidden');
      document.getElementById('config-preview-section').classList.add('hidden');
      document.getElementById('btn-load-config').disabled = true;

      const reader = new FileReader();
      reader.onload = async (event) => {
        let rawConfig;
        try {
          rawConfig = JSON.parse(event.target.result);
        } catch (err) {
          document.getElementById('config-validation-error').classList.remove('hidden');
          const errorList = document.getElementById('config-validation-errors');
          while (errorList.firstChild) errorList.removeChild(errorList.firstChild);
          const li = document.createElement('li');
          li.textContent = t('web.error.invalidJson') + ' ' + err.message;
          errorList.appendChild(li);
          loadedConfig = null;
          return;
        }

        // Show preview
        document.getElementById('config-preview-content').textContent = JSON.stringify(rawConfig, null, 2);
        document.getElementById('config-preview-section').classList.remove('hidden');

        // Validate via API
        try {
          const response = await api('/config/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rawConfig),
          });

          if (response.valid) {
            loadedConfig = response.config;
            document.getElementById('config-validation-success').classList.remove('hidden');
            document.getElementById('btn-load-config').disabled = false;
          } else {
            document.getElementById('config-validation-error').classList.remove('hidden');
            const errorList = document.getElementById('config-validation-errors');
            while (errorList.firstChild) errorList.removeChild(errorList.firstChild);

            if (response.errors) {
              for (const err of response.errors) {
                const li = document.createElement('li');
                li.textContent = (err.path ? err.path + ': ' : '') + err.message;
                errorList.appendChild(li);
              }
            } else if (response.error) {
              const li = document.createElement('li');
              li.textContent = response.error;
              errorList.appendChild(li);
            }
            loadedConfig = null;
          }
        } catch (err) {
          document.getElementById('config-validation-error').classList.remove('hidden');
          const errorList = document.getElementById('config-validation-errors');
          while (errorList.firstChild) errorList.removeChild(errorList.firstChild);
          const li = document.createElement('li');
          li.textContent = t('web.error.validationFailed') + ' ' + err.message;
          errorList.appendChild(li);
          loadedConfig = null;
        }
      };
      reader.readAsText(file);
    });

    document.getElementById('btn-load-config').addEventListener('click', async () => {
      if (!loadedConfig) return;

      // Support both new format (v1.0.0) and old format (v0.1.x)
      const isNewFormat = loadedConfig.version === '1.0.0' || loadedConfig.environment?.prefix;

      // Extract values (with fallback for old format)
      const env = isNewFormat
        ? loadedConfig.environment?.prefix
        : loadedConfig.env || 'prod';

      const apiDomain = isNewFormat
        ? loadedConfig.urls?.api?.custom
        : loadedConfig.apiDomain;

      const loginUiDomain = isNewFormat
        ? loadedConfig.urls?.loginUi?.custom
        : loadedConfig.loginUiDomain;

      const adminUiDomain = isNewFormat
        ? loadedConfig.urls?.adminUi?.custom
        : loadedConfig.adminUiDomain;

      const tenant = loadedConfig.tenant || {
        name: 'default',
        displayName: 'Default Tenant',
        multiTenant: false,
      };

      const components = loadedConfig.components || {
        api: true,
        loginUi: true,
        adminUi: true,
        saml: false,
        async: false,
        vc: false,
        bridge: true,
        policy: true,
      };

      // Build internal config
      config = {
        env,
        apiDomain: apiDomain || null,
        loginUiDomain: loginUiDomain || null,
        adminUiDomain: adminUiDomain || null,
        tenant,
        components,
      };

      // Set form values
      document.getElementById('env').value = config.env;
      document.getElementById('base-domain').value = config.tenant?.baseDomain || config.apiDomain || '';
      document.getElementById('login-domain').value = config.loginUiDomain || '';
      document.getElementById('admin-domain').value = config.adminUiDomain || '';
      document.getElementById('tenant-name').value = config.tenant?.name || 'default';
      document.getElementById('tenant-display').value = config.tenant?.displayName || 'Default Tenant';
      document.getElementById('naked-domain').checked = config.tenant?.nakedDomain || false;

      // Set component checkboxes
      if (document.getElementById('comp-login-ui')) {
        document.getElementById('comp-login-ui').checked = components.loginUi !== false;
      }
      if (document.getElementById('comp-admin-ui')) {
        document.getElementById('comp-admin-ui').checked = components.adminUi !== false;
      }
      if (document.getElementById('comp-saml')) {
        document.getElementById('comp-saml').checked = components.saml === true;
      }
      if (document.getElementById('comp-async')) {
        document.getElementById('comp-async').checked = components.async === true;
      }
      if (document.getElementById('comp-vc')) {
        document.getElementById('comp-vc').checked = components.vc === true;
      }

      // Trigger env input to update preview/default labels
      document.getElementById('env').dispatchEvent(new Event('input'));

      // Show configuration screen for review/editing
      // User can modify settings before proceeding to provision
      setupMode = 'custom'; // Enable all options for editing
      document.getElementById('advanced-options').classList.remove('hidden');
      setStep(2);
      showSection('config');
      updatePreview();
    });

    // Configuration handlers
    // Update preview section when any input changes
    function updatePreview() {
      const env = document.getElementById('env').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || '{env}';
      const baseDomain = document.getElementById('base-domain').value.trim();
      const nakedDomain = document.getElementById('naked-domain').checked;
      const tenantName = document.getElementById('tenant-name').value.trim() || 'default';
      const loginDomain = document.getElementById('login-domain').value.trim();
      const adminDomain = document.getElementById('admin-domain').value.trim();

      // Components - build list based on mode and selections
      const components = ['API'];
      if (setupMode === 'quick') {
        components.push('Login UI', 'Admin UI');
      } else {
        if (document.getElementById('comp-login-ui').checked) components.push('Login UI');
        if (document.getElementById('comp-admin-ui').checked) components.push('Admin UI');
        if (document.getElementById('comp-saml').checked) components.push('SAML IdP');
        if (document.getElementById('comp-async').checked) components.push('Device Flow/CIBA');
        if (document.getElementById('comp-vc').checked) components.push('Verifiable Credentials');
      }
      document.getElementById('preview-components').textContent = components.join(', ');

      // Workers
      document.getElementById('preview-workers').textContent = env + '-ar-router, ' + env + '-ar-auth, ...';

      // Generate domains with account subdomain
      const workersDomain = workersSubdomain
        ? env + '-ar-router.' + workersSubdomain + '.workers.dev'
        : env + '-ar-router.workers.dev';
      // Note: Pages uses {project}.pages.dev format (no account subdomain, unlike Workers)
      const pagesDomain = env + '-ar-ui.pages.dev';

      // Issuer URL
      // Note: Tenant subdomain is only supported with custom domains, NOT workers.dev
      // Workers.dev doesn't support wildcard subdomains, so tenant prefix cannot be used

      if (baseDomain) {
        // Custom domain - tenant prefix can be used
        if (nakedDomain) {
          document.getElementById('preview-issuer').textContent = 'https://' + baseDomain;
        } else {
          document.getElementById('preview-issuer').textContent = 'https://' + tenantName + '.' + baseDomain;
        }
      } else {
        // Workers.dev - no tenant prefix (wildcard subdomains not supported)
        document.getElementById('preview-issuer').textContent = 'https://' + workersDomain;
      }

      // Login UI - check if component is enabled (in custom mode)
      const loginUiEnabled = document.getElementById('comp-login-ui').checked;
      const previewLogin = document.getElementById('preview-login');
      if (!loginUiEnabled) {
        previewLogin.textContent = '(Not deployed)';
        previewLogin.style.color = 'var(--text-muted)';
      } else if (loginDomain) {
        previewLogin.textContent = 'https://' + loginDomain;
        previewLogin.style.color = '';
      } else {
        previewLogin.textContent = 'https://' + pagesDomain;
        previewLogin.style.color = '';
      }
      document.getElementById('login-default').textContent = pagesDomain;

      // Admin UI - check if component is enabled (in custom mode)
      const adminUiEnabled = document.getElementById('comp-admin-ui').checked;
      const previewAdmin = document.getElementById('preview-admin');
      if (!adminUiEnabled) {
        previewAdmin.textContent = '(Not deployed)';
        previewAdmin.style.color = 'var(--text-muted)';
      } else if (adminDomain) {
        previewAdmin.textContent = 'https://' + adminDomain;
        previewAdmin.style.color = '';
      } else {
        previewAdmin.textContent = 'https://' + pagesDomain + '/admin';
        previewAdmin.style.color = '';
      }
      document.getElementById('admin-default').textContent = pagesDomain + '/admin';
    }

    // Attach event listeners to all inputs
    ['env', 'base-domain', 'naked-domain', 'tenant-name', 'login-domain', 'admin-domain', 'comp-login-ui', 'comp-admin-ui', 'comp-saml', 'comp-async', 'comp-vc'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', updatePreview);
        el.addEventListener('change', updatePreview);
      }
    });

    // Update UI based on base domain presence
    function updateBaseDomainUI() {
      const baseDomain = document.getElementById('base-domain').value.trim();
      const nakedDomainCheckbox = document.getElementById('naked-domain');
      const nakedDomainLabel = document.getElementById('naked-domain-label');
      const nakedDomainHint = document.getElementById('naked-domain-hint');
      const workersDevNote = document.getElementById('workers-dev-note');
      const tenantWorkersNote = document.getElementById('tenant-workers-note');
      const tenantFields = document.getElementById('tenant-fields');

      if (baseDomain) {
        // Custom domain - enable tenant subdomain options
        nakedDomainCheckbox.disabled = false;
        nakedDomainLabel.style.opacity = '1';
        nakedDomainHint.style.display = 'block';
        workersDevNote.style.display = 'none';
        tenantWorkersNote.style.display = 'none';
        // Show tenant fields if naked domain is not checked
        if (!nakedDomainCheckbox.checked) {
          tenantFields.style.display = 'block';
        }
      } else {
        // Workers.dev - tenant subdomains not supported
        nakedDomainCheckbox.disabled = true;
        nakedDomainCheckbox.checked = false;
        nakedDomainLabel.style.opacity = '0.5';
        nakedDomainHint.style.display = 'none';
        workersDevNote.style.display = 'block';
        tenantWorkersNote.style.display = 'block';
        tenantFields.style.display = 'block'; // Show tenant fields (for internal use)
      }
    }

    // Base domain change - update UI for tenant subdomain options
    document.getElementById('base-domain').addEventListener('input', () => {
      updateBaseDomainUI();
      updatePreview();
    });

    // Initial UI state
    updateBaseDomainUI();

    // Naked domain toggle - show/hide tenant name field and update placeholder
    document.getElementById('naked-domain').addEventListener('change', (e) => {
      const tenantFields = document.getElementById('tenant-fields');
      const baseDomainInput = document.getElementById('base-domain');
      if (e.target.checked) {
        tenantFields.style.display = 'none';
        baseDomainInput.placeholder = 'example.com';
      } else {
        tenantFields.style.display = 'block';
        baseDomainInput.placeholder = 'oidc.example.com';
      }
      updatePreview();
    });

    // Login UI component toggle - grey out domain settings when unchecked
    document.getElementById('comp-login-ui').addEventListener('change', (e) => {
      const loginDomainRow = document.getElementById('login-domain-row');
      const loginDomainInput = document.getElementById('login-domain');
      if (e.target.checked) {
        loginDomainRow.style.opacity = '1';
        loginDomainInput.disabled = false;
      } else {
        loginDomainRow.style.opacity = '0.4';
        loginDomainInput.disabled = true;
        loginDomainInput.value = '';
      }
      updatePreview();
    });

    // Admin UI component toggle - grey out domain settings when unchecked
    document.getElementById('comp-admin-ui').addEventListener('change', (e) => {
      const adminDomainRow = document.getElementById('admin-domain-row');
      const adminDomainInput = document.getElementById('admin-domain');
      if (e.target.checked) {
        adminDomainRow.style.opacity = '1';
        adminDomainInput.disabled = false;
      } else {
        adminDomainRow.style.opacity = '0.4';
        adminDomainInput.disabled = true;
        adminDomainInput.value = '';
      }
      updatePreview();
    });

    document.getElementById('btn-back-mode').addEventListener('click', () => {
      setStep(1);
      showSection('mode');
    });

    document.getElementById('btn-configure').addEventListener('click', async () => {
      // Get and validate environment name
      let env = document.getElementById('env').value.toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (!env) {
        alert('Please enter a valid environment name');
        return;
      }

      // Check if environment already exists
      const configureBtn = document.getElementById('btn-configure');
      const originalText = configureBtn.textContent;
      configureBtn.textContent = t('web.status.checking');
      configureBtn.disabled = true;

      try {
        const envResult = await api('/environments');
        if (envResult.success && envResult.environments) {
          const existingEnv = envResult.environments.find(e => e.name === env);
          if (existingEnv) {
            alert('Environment "' + env + '" already exists.\\n\\nWorkers: ' + existingEnv.workers.length + ', D1: ' + existingEnv.d1.length + ', KV: ' + existingEnv.kv.length + '\\n\\nPlease choose a different name or use "Manage Environments" to delete it first.');
            return;
          }
        }
      } catch (e) {
        // Continue if check fails - will catch errors later
        console.warn('Environment check failed:', e);
      } finally {
        configureBtn.textContent = originalText;
        configureBtn.disabled = false;
      }

      const baseDomain = document.getElementById('base-domain').value.trim();
      const nakedDomain = document.getElementById('naked-domain').checked;
      const tenantName = document.getElementById('tenant-name').value.trim() || 'default';
      const tenantDisplayName = document.getElementById('tenant-display').value.trim() || 'Default Tenant';
      const loginDomain = document.getElementById('login-domain').value.trim();
      const adminDomain = document.getElementById('admin-domain').value.trim();

      // API domain = base domain or null (workers.dev fallback)
      const apiDomain = baseDomain || null;

      config = {
        env,
        apiDomain,
        loginUiDomain: loginDomain || null,
        adminUiDomain: adminDomain || null,
        tenant: {
          name: nakedDomain ? null : tenantName,  // null for naked domain
          displayName: tenantDisplayName,
          multiTenant: baseDomain ? true : false,  // Only multi-tenant with custom domain
          baseDomain: baseDomain || undefined,
          nakedDomain: baseDomain ? nakedDomain : false,
        },
        components: {
          api: true,
          loginUi: setupMode === 'quick' || document.getElementById('comp-login-ui').checked,
          adminUi: setupMode === 'quick' || document.getElementById('comp-admin-ui').checked,
          saml: setupMode === 'custom' && document.getElementById('comp-saml').checked,
          async: setupMode === 'custom' && document.getElementById('comp-async').checked,
          vc: setupMode === 'custom' && document.getElementById('comp-vc').checked,
          bridge: true, // Standard component
          policy: true, // Standard component
        },
      };

      // Create default config with component settings
      await api('/config/default', {
        method: 'POST',
        body: {
          env,
          apiDomain,
          loginUiDomain: loginDomain,
          adminUiDomain: adminDomain,
          tenant: config.tenant,
          components: config.components,
        },
      });

      // Update resource preview with the selected env
      updateResourcePreview(env);
      updateProvisionButtons();

      // Go to database configuration step
      setStep(4);
      showSection('database');
    });

    document.getElementById('btn-back-config').addEventListener('click', () => {
      // Go back to email configuration (previous step in the flow)
      setStep(5);
      showSection('email');
    });

    // Database configuration handlers
    document.getElementById('btn-back-database').addEventListener('click', () => {
      setStep(3);
      showSection('config');
    });

    document.getElementById('btn-continue-database').addEventListener('click', () => {
      // Get selected values
      const coreLocation = document.querySelector('input[name="db-core-location"]:checked').value;
      const piiLocation = document.querySelector('input[name="db-pii-location"]:checked').value;

      // Parse location vs jurisdiction
      function parseDbLocation(value) {
        if (value === 'eu') {
          return { location: 'auto', jurisdiction: 'eu' };
        }
        return { location: value, jurisdiction: 'none' };
      }

      // Add database config to config object
      config.database = {
        core: parseDbLocation(coreLocation),
        pii: parseDbLocation(piiLocation),
      };

      // Proceed to email configuration
      setStep(5);
      showSection('email');
    });

    // Email configuration handlers
    // Toggle resend config form visibility
    document.querySelectorAll('input[name="email-setup-choice"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const resendForm = document.getElementById('resend-config-form');
        const choice = document.querySelector('input[name="email-setup-choice"]:checked').value;
        if (choice === 'configure') {
          resendForm.classList.remove('hidden');
        } else {
          resendForm.classList.add('hidden');
        }
      });
    });

    document.getElementById('btn-back-email').addEventListener('click', () => {
      setStep(4);
      showSection('database');
    });

    document.getElementById('btn-continue-email').addEventListener('click', async () => {
      const choice = document.querySelector('input[name="email-setup-choice"]:checked').value;
      const btn = document.getElementById('btn-continue-email');

      if (choice === 'configure') {
        // Validate and store email configuration
        const apiKey = document.getElementById('resend-api-key').value.trim();
        const fromAddress = document.getElementById('email-from-address').value.trim();
        const fromName = document.getElementById('email-from-name').value.trim();

        // Validate API key format
        if (!apiKey) {
          alert('Please enter your Resend API key');
          return;
        }
        if (!apiKey.startsWith('re_')) {
          if (!confirm('API key does not start with "re_". This may not be a valid Resend API key. Continue anyway?')) {
            return;
          }
        }

        // Validate email address
        if (!fromAddress) {
          alert('Please enter a From email address');
          return;
        }
        if (!fromAddress.includes('@')) {
          alert('Please enter a valid email address');
          return;
        }

        // Save email configuration to server
        btn.disabled = true;
        btn.textContent = t('web.status.saving');

        try {
          const result = await api('/email/configure', {
            method: 'POST',
            body: {
              env: config.env,
              provider: 'resend',
              apiKey: apiKey,
              fromAddress: fromAddress,
              fromName: fromName || undefined,
            },
          });

          if (!result.success) {
            throw new Error(result.error || 'Failed to save email configuration');
          }

          // Store email configuration (without apiKey for config file)
          config.email = {
            provider: 'resend',
            fromAddress: fromAddress,
            fromName: fromName || undefined,
            configured: true,
          };
        } catch (error) {
          alert('Failed to save email configuration: ' + error.message);
          btn.disabled = false;
          btn.textContent = t('web.btn.continue');
          return;
        }

        btn.disabled = false;
        btn.textContent = t('web.btn.continue');
      } else {
        // Configure later - no email provider
        config.email = {
          provider: 'none',
        };
      }

      // Show save config modal before proceeding
      const modal = document.getElementById('save-config-modal');
      modal.classList.remove('hidden');
    });

    // Modal handlers
    document.getElementById('modal-skip-save').addEventListener('click', () => {
      document.getElementById('save-config-modal').classList.add('hidden');
      proceedToProvision();
    });

    document.getElementById('modal-save-config').addEventListener('click', async () => {
      const modal = document.getElementById('save-config-modal');
      const btn = document.getElementById('modal-save-config');
      btn.disabled = true;
      btn.textContent = t('web.status.saving');

      try {
        await saveConfigToFile();
        modal.classList.add('hidden');
        btn.disabled = false;
        btn.textContent = t('web.btn.saveConfiguration');
        proceedToProvision();
      } catch (error) {
        alert('Failed to save configuration: ' + error.message);
        btn.disabled = false;
        btn.textContent = t('web.btn.saveConfiguration');
      }
    });

    // Close modal on backdrop click
    document.querySelector('.modal-backdrop').addEventListener('click', () => {
      document.getElementById('save-config-modal').classList.add('hidden');
      proceedToProvision();
    });

    function proceedToProvision() {
      updateResourcePreview(config.env);
      setStep(6);
      showSection('provision');
    }

    // Provision
    document.getElementById('btn-provision').addEventListener('click', async () => {
      const btn = document.getElementById('btn-provision');
      const btnGotoDeploy = document.getElementById('btn-goto-deploy');
      const status = document.getElementById('provision-status');
      const log = document.getElementById('provision-log');
      const output = document.getElementById('provision-output');
      const resourcePreview = document.getElementById('resource-preview');
      const keysSavedInfo = document.getElementById('keys-saved-info');
      const keysPath = document.getElementById('keys-path');
      const progressUI = document.getElementById('provision-progress-ui');

      // Confirmation dialog for re-provisioning
      if (provisioningCompleted) {
        const confirmed = confirm(
          '⚠️ Re-provision will DELETE all existing resources and create new ones.\\n\\n' +
          'This action will:\\n' +
          '• Delete existing D1 databases (all data will be lost)\\n' +
          '• Delete existing KV namespaces\\n' +
          '• Generate new encryption keys\\n\\n' +
          'Are you sure you want to continue?'
        );
        if (!confirmed) {
          return;
        }
      }

      btn.disabled = true;
      btn.classList.add('hidden');
      btnGotoDeploy.classList.add('hidden');
      status.textContent = t('web.status.running');
      status.className = 'status-badge status-running';
      progressUI.classList.remove('hidden');
      log.classList.add('hidden'); // Log is hidden by default, toggled via button
      resourcePreview.classList.add('hidden');
      keysSavedInfo.classList.add('hidden');
      output.textContent = '';

      let provisionCompleted = 0;
      const totalResources = 8; // D1 Core, D1 PII, KV Settings, KV Cache, KV Tokens, R2 (optional), Queues (optional), Keys
      updateProgressUI('provision', 0, totalResources, t('web.status.initializing'));

      // Start polling for progress
      let lastProgressLength = 0;
      provisionPollInterval = setInterval(async () => {
        try {
          const statusResult = await api('/deploy/status');
          if (statusResult.progress && statusResult.progress.length > lastProgressLength) {
            // Append new progress messages
            const newMessages = statusResult.progress.slice(lastProgressLength);
            newMessages.forEach(msg => {
              output.textContent += msg + '\\n';
              // Update progress UI based on message content
              const taskInfo = parseProgressMessage(msg);
              if (taskInfo) {
                updateProgressUI('provision', provisionCompleted, totalResources, taskInfo);
              }
              // Count completed items (lines with checkmark)
              if (msg.includes('✓') || msg.includes('✅')) {
                provisionCompleted++;
                updateProgressUI('provision', provisionCompleted, totalResources, taskInfo || ('Completed ' + provisionCompleted + ' items'));
              }
            });
            lastProgressLength = statusResult.progress.length;
            scrollToBottom(log);
          }
        } catch (e) {
          // Ignore polling errors
        }
      }, 500);

      try {
        // Check if keys already exist for this environment
        const keysCheck = await api('/keys/check/' + config.env);
        if (keysCheck.exists) {
          output.textContent += '⚠️ Warning: Keys already exist for environment "' + config.env + '"\\n';
          output.textContent += '   Existing keys will be overwritten.\\n';
          output.textContent += '\\n';
          scrollToBottom(log);
        }

        // Generate keys
        output.textContent += '🔐 Generating cryptographic keys...\\n';
        scrollToBottom(log);
        const keyResult = await api('/keys/generate', {
          method: 'POST',
          body: { keyId: config.env + '-key-' + Date.now(), env: config.env },
        });
        output.textContent += '  ✓ RSA key pair generated\\n';
        output.textContent += '  ✓ Encryption keys generated\\n';
        output.textContent += '  ✓ Admin secrets generated\\n';
        output.textContent += '\\n';
        scrollToBottom(log);

        // Show keys saved location (new structure: .authrim/{env}/keys/)
        keysPath.textContent = workingDirectory ? workingDirectory + '/.authrim/' + config.env + '/keys/' : './.authrim/' + config.env + '/keys/';

        // Provision resources
        output.textContent += '☁️ Provisioning Cloudflare resources...\\n';
        scrollToBottom(log);

        const result = await api('/provision', {
          method: 'POST',
          body: { env: config.env, databaseConfig: config.database },
        });

        // Stop polling
        if (provisionPollInterval) {
          clearInterval(provisionPollInterval);
          provisionPollInterval = null;
        }

        if (result.success) {
          // Final progress update
          updateProgressUI('provision', totalResources, totalResources, '✅ Provisioning complete!');
          output.textContent += '\\n✅ Provisioning complete!\\n';
          scrollToBottom(log);
          status.textContent = t('web.status.complete');
          status.className = 'status-badge status-success';

          // Mark provisioning as completed
          provisioningCompleted = true;

          // Show keys saved info
          keysSavedInfo.classList.remove('hidden');

          // Update buttons - change to warning style for re-provision
          btn.textContent = t('web.btn.reprovision');
          btn.classList.remove('hidden', 'btn-primary');
          btn.classList.add('btn-warning');
          btn.disabled = false;
          btnGotoDeploy.classList.remove('hidden');
        } else {
          throw new Error(result.error);
        }
      } catch (error) {
        // Stop polling
        if (provisionPollInterval) {
          clearInterval(provisionPollInterval);
          provisionPollInterval = null;
        }

        output.textContent += '\\n❌ Error: ' + error.message + '\\n';
        scrollToBottom(log);
        status.textContent = t('web.status.error');
        status.className = 'status-badge status-error';
        btn.classList.remove('hidden');
        btn.disabled = false;
        resourcePreview.classList.remove('hidden');
      }
    });

    // Continue to Deploy button
    document.getElementById('btn-goto-deploy').addEventListener('click', () => {
      setStep(7);
      showSection('deploy');
    });

    document.getElementById('btn-back-provision').addEventListener('click', () => {
      setStep(6);
      // Update buttons based on provisioning status
      updateProvisionButtons();
      // Show resource preview if not completed
      if (!provisioningCompleted) {
        document.getElementById('resource-preview').classList.remove('hidden');
      }
      showSection('provision');
    });

    // Deploy
    document.getElementById('btn-deploy').addEventListener('click', async () => {
      const btn = document.getElementById('btn-deploy');
      const status = document.getElementById('deploy-status');
      const log = document.getElementById('deploy-log');
      const output = document.getElementById('deploy-output');
      const progressUI = document.getElementById('deploy-progress-ui');
      const readyText = document.getElementById('deploy-ready-text');

      btn.disabled = true;
      btn.classList.add('hidden');
      status.textContent = t('web.status.deploying');
      status.className = 'status-badge status-running';
      readyText.classList.add('hidden');
      progressUI.classList.remove('hidden');
      log.classList.add('hidden'); // Log is hidden by default, toggled via button
      output.textContent = t('web.status.startingDeploy') + '\\n\\n';

      let completedCount = 0;
      // Use indeterminate progress - actual step count varies based on components
      // We'll update the total dynamically based on actual progress
      let totalComponents = 0; // Will be calculated from actual progress
      updateProgressUI('deploy', 0, 100, t('web.status.initializing'));

      try {
        // Generate wrangler configs first
        output.textContent += 'Generating wrangler.toml files...\\n';
        scrollToBottom(log);
        await api('/wrangler/generate', {
          method: 'POST',
          body: { env: config.env },
        });
        output.textContent += '✓ Config files generated\\n\\n';
        scrollToBottom(log);

        // Start deployment
        output.textContent += 'Deploying workers...\\n';
        scrollToBottom(log);

        // Poll for status updates
        let lastProgressLength = 0;
        const pollInterval = setInterval(async () => {
          const statusResult = await api('/deploy/status');
          if (statusResult.progress && statusResult.progress.length > lastProgressLength) {
            const newMessages = statusResult.progress.slice(lastProgressLength);
            newMessages.forEach(msg => {
              output.textContent += msg + '\\n';
              // Update progress UI based on message content
              const taskInfo = parseProgressMessage(msg);
              // Count completed items (lines with checkmark)
              if (msg.includes('✓') || msg.includes('✅')) {
                completedCount++;
              }
              // Update total when we see completion markers (e.g., "5/5")
              const progressMatch = msg.match(/(\\d+)\\/(\\d+)/);
              if (progressMatch) {
                const [, , total] = progressMatch;
                totalComponents = Math.max(totalComponents, parseInt(total, 10) + completedCount);
              }
              // Display progress as percentage or show current task
              const displayTotal = totalComponents > 0 ? totalComponents : completedCount + 10;
              const percent = Math.min(Math.round((completedCount / displayTotal) * 100), 99);
              updateProgressUI('deploy', percent, 100, taskInfo || ('Processing... ' + completedCount + ' steps completed'));
            });
            lastProgressLength = statusResult.progress.length;
            scrollToBottom(log);
          }
        }, 1000);

        const result = await api('/deploy', {
          method: 'POST',
          body: {
            env: config.env,
            dryRun: false,
          },
        });

        clearInterval(pollInterval);

        if (result.success) {
          // Final progress update
          updateProgressUI('deploy', 100, 100, '✓ Deployment complete!');
          output.textContent += '\\n✓ Deployment complete!\\n';
          scrollToBottom(log);

          // Complete admin setup to get setup URL
          output.textContent += '\\nSetting up initial admin...\\n';
          scrollToBottom(log);
          const workersDomain = workersSubdomain
            ? config.env + '-ar-router.' + workersSubdomain + '.workers.dev'
            : config.env + '-ar-router.workers.dev';
          // Build API URL
          // Note: Tenant subdomain only works with custom domains, NOT workers.dev
          let apiUrl;
          if (config.apiDomain) {
            // Custom domain - add tenant prefix if not naked domain
            if (config.tenant && config.tenant.name && !config.tenant.nakedDomain) {
              apiUrl = 'https://' + config.tenant.name + '.' + config.apiDomain;
            } else {
              apiUrl = 'https://' + config.apiDomain;
            }
          } else {
            // Workers.dev - no tenant prefix (wildcard subdomains not supported)
            apiUrl = 'https://' + workersDomain;
          }
          // Login UI URL for setup page (setup page is in Login UI, not API)
          const pagesDomain = config.env + '-ar-ui.pages.dev';
          const loginUiUrl = config.loginUiDomain ? 'https://' + config.loginUiDomain : 'https://' + pagesDomain;

          output.textContent += '  API URL: ' + apiUrl + '\\n';
          output.textContent += '  Login UI URL: ' + loginUiUrl + '\\n';
          output.textContent += '  Keys Dir: .authrim/' + config.env + '/keys/\\n';
          scrollToBottom(log);

          let adminSetupResult;
          try {
            adminSetupResult = await api('/admin/setup', {
              method: 'POST',
              body: {
                env: config.env,
                baseUrl: apiUrl,  // Setup page is served by ar-auth worker (API)
                // keysDir is auto-detected by API using paths.ts
              },
            });
            output.textContent += '  API Response: ' + JSON.stringify(adminSetupResult) + '\\n';
            scrollToBottom(log);
          } catch (adminError) {
            output.textContent += '  ✗ Admin setup API error: ' + adminError.message + '\\n';
            scrollToBottom(log);
            adminSetupResult = { success: false, error: adminError.message };
          }

          if (adminSetupResult.success && adminSetupResult.setupUrl) {
            output.textContent += '✓ Admin setup ready!\\n';
            output.textContent += '  Setup URL: ' + adminSetupResult.setupUrl + '\\n';
          } else if (adminSetupResult.alreadyCompleted) {
            output.textContent += 'ℹ Admin setup already completed\\n';
          } else if (adminSetupResult.error) {
            output.textContent += '⚠ Admin setup warning: ' + adminSetupResult.error + '\\n';
          } else {
            output.textContent += '⚠ Admin setup: No setup URL returned\\n';
          }
          scrollToBottom(log);

          status.textContent = t('web.status.complete');
          status.className = 'status-badge status-success';

          // Show completion with setup URL and debug info
          showComplete({
            ...result,
            setupUrl: adminSetupResult.setupUrl,
            adminSetupDebug: adminSetupResult,
          });
        } else {
          throw new Error(result.error || 'Deployment failed');
        }
      } catch (error) {
        output.textContent += '\\n✗ Error: ' + error.message + '\\n';
        scrollToBottom(log);
        status.textContent = t('web.status.error');
        status.className = 'status-badge status-error';
        btn.disabled = false;
      }
    });

    // Show completion
    function showComplete(result) {
      const urlsEl = document.getElementById('urls');
      const env = config.env;

      // Generate correct URLs with account subdomain
      const workersDomain = workersSubdomain
        ? env + '-ar-router.' + workersSubdomain + '.workers.dev'
        : env + '-ar-router.workers.dev';
      // Note: Pages uses {project}.pages.dev format (no account subdomain, unlike Workers)
      const pagesDomain = env + '-ar-ui.pages.dev';

      // Build API URL
      // Note: Tenant subdomain only works with custom domains, NOT workers.dev
      let apiUrl;
      if (config.apiDomain) {
        // Custom domain - add tenant prefix if not naked domain
        if (config.tenant && config.tenant.name && !config.tenant.nakedDomain) {
          apiUrl = 'https://' + config.tenant.name + '.' + config.apiDomain;
        } else {
          apiUrl = 'https://' + config.apiDomain;
        }
      } else {
        // Workers.dev - no tenant prefix (wildcard subdomains not supported)
        apiUrl = 'https://' + workersDomain;
      }
      const loginUrl = config.loginUiDomain ? 'https://' + config.loginUiDomain : 'https://' + pagesDomain;
      const adminUrl = config.adminUiDomain ? 'https://' + config.adminUiDomain : 'https://' + pagesDomain + '/admin';

      // Clear and rebuild URLs section safely
      urlsEl.textContent = '';

      // API URL with OIDC Discovery link
      urlsEl.appendChild(createUrlItem('API (Issuer):', apiUrl));
      const discoveryUrl = apiUrl + '/.well-known/openid-configuration';
      urlsEl.appendChild(createUrlItem('Discovery:', discoveryUrl));

      urlsEl.appendChild(createUrlItem('Login UI:', loginUrl));
      urlsEl.appendChild(createUrlItem('Admin UI:', adminUrl));

      // Create Admin Setup section (separate, prominent box)
      const adminSetupSection = document.createElement('div');
      adminSetupSection.style.cssText = 'margin-top: 1.5rem; padding: 1.25rem; background: linear-gradient(135deg, rgba(37, 99, 235, 0.1) 0%, rgba(59, 130, 246, 0.05) 100%); border: 2px solid var(--primary); border-radius: 12px;';

      if (result && result.setupUrl) {
        adminSetupSection.innerHTML = \`
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;">
            <span style="font-size: 1.5rem;">🔐</span>
            <h4 style="margin: 0; font-size: 1.1rem; font-weight: 600; color: var(--primary);">Admin Account Setup</h4>
            <span style="background: var(--warning); color: white; font-size: 0.7rem; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 600;">IMPORTANT</span>
          </div>
          <p style="margin: 0 0 0.75rem; font-size: 0.9rem; color: var(--text-muted);">
            Register your first administrator account with Passkey authentication:
          </p>
          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <input type="text" value="\${result.setupUrl}" readonly style="flex: 1; min-width: 200px; padding: 0.625rem 0.75rem; border: 1px solid var(--border); border-radius: 8px; font-family: var(--font-mono); font-size: 0.8rem; background: var(--card-bg); color: var(--text);">
            <button class="btn-secondary" onclick="navigator.clipboard.writeText('\${result.setupUrl}'); this.textContent='✓ Copied'; setTimeout(() => this.textContent='📋 Copy', 2000);" style="white-space: nowrap;">📋 Copy</button>
          </div>
          <div style="text-align: center; margin-top: 1rem;">
            <a href="\${result.setupUrl}" target="_blank" class="btn-primary">🔑 Open Setup</a>
          </div>
          <div class="hint-box" style="margin-top: 0.75rem;">
            ⚠️ This URL can only be used <strong>once</strong> and expires in <strong>1 hour</strong>.
          </div>
        \`;
      } else {
        // Show message when setup URL is missing
        let debugInfo = '';
        if (result && result.adminSetupDebug) {
          const debug = result.adminSetupDebug;
          if (debug.alreadyCompleted) {
            debugInfo = '<p style="margin: 0.5rem 0 0; font-size: 0.85rem; color: var(--text-muted);">Admin setup has already been completed for this environment.</p>';
          } else if (debug.error) {
            debugInfo = '<p style="margin: 0.5rem 0 0; font-size: 0.85rem; color: var(--error);">Error: ' + debug.error + '</p>';
          }
        }
        adminSetupSection.innerHTML = \`
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
            <span style="font-size: 1.5rem;">🔐</span>
            <h4 style="margin: 0; font-size: 1.1rem; font-weight: 600; color: var(--text-muted);">Admin Account Setup</h4>
          </div>
          <p style="margin: 0; font-size: 0.9rem; color: var(--text-muted);">
            Setup URL not available. You can configure admin access from the Admin UI later.
          </p>
          \${debugInfo}
        \`;
      }
      urlsEl.parentNode.insertBefore(adminSetupSection, urlsEl.nextSibling);

      setStep(8);
      showSection('complete');
    }

    // Resource naming functions
    function getResourceNames(env) {
      // Keys are stored in environment-specific subdirectory: .authrim/{env}/keys/
      const keysDir = workingDirectory ? workingDirectory + '/.authrim/' + env + '/keys' : '.authrim/' + env + '/keys';
      return {
        d1: [
          env + '-authrim-core-db',
          env + '-authrim-pii-db'
        ],
        kv: [
          env + '-CLIENTS_CACHE',
          env + '-INITIAL_ACCESS_TOKENS',
          env + '-SETTINGS',
          env + '-REBAC_CACHE',
          env + '-USER_CACHE',
          env + '-AUTHRIM_CONFIG',
          env + '-STATE_STORE',
          env + '-CONSENT_CACHE'
        ],
        keys: [
          keysDir + '/private.pem (RSA Private Key)',
          keysDir + '/public.jwk.json (JWK Public Key)',
          keysDir + '/rp_token_encryption_key.txt',
          keysDir + '/admin_api_secret.txt',
          keysDir + '/key_manager_secret.txt',
          keysDir + '/setup_token.txt'
        ]
      };
    }

    // Get human-readable label for database region
    function getRegionLabel(location, jurisdiction) {
      if (jurisdiction === 'eu') {
        return 'EU Jurisdiction';
      }
      const labels = {
        'auto': 'Automatic',
        'wnam': 'North America (West)',
        'enam': 'North America (East)',
        'weur': 'Europe (West)',
        'eeur': 'Europe (East)',
        'apac': 'Asia Pacific',
        'oc': 'Oceania',
      };
      return labels[location] || 'Automatic';
    }

    function updateResourcePreview(env) {
      const resources = getResourceNames(env);

      const d1List = document.getElementById('preview-d1');
      const kvList = document.getElementById('preview-kv');
      const keysList = document.getElementById('preview-keys');

      d1List.innerHTML = '';
      kvList.innerHTML = '';
      keysList.innerHTML = '';

      // Get region info from config
      const coreRegion = config.database?.core || { location: 'auto', jurisdiction: 'none' };
      const piiRegion = config.database?.pii || { location: 'auto', jurisdiction: 'none' };

      // D1 databases with region info
      const coreDbName = env + '-authrim-core-db';
      const piiDbName = env + '-authrim-pii-db';

      const coreLi = document.createElement('li');
      coreLi.innerHTML = coreDbName + ' <span style="color: var(--text-muted); font-size: 0.85em;">(' + getRegionLabel(coreRegion.location, coreRegion.jurisdiction) + ')</span>';
      d1List.appendChild(coreLi);

      const piiLi = document.createElement('li');
      piiLi.innerHTML = piiDbName + ' <span style="color: var(--text-muted); font-size: 0.85em;">(' + getRegionLabel(piiRegion.location, piiRegion.jurisdiction) + ')</span>';
      d1List.appendChild(piiLi);

      resources.kv.forEach(name => {
        const li = document.createElement('li');
        li.textContent = name;
        kvList.appendChild(li);
      });

      resources.keys.forEach(name => {
        const li = document.createElement('li');
        li.textContent = name;
        keysList.appendChild(li);
      });
    }

    // Update provision button state based on completion status
    function updateProvisionButtons() {
      const btnProvision = document.getElementById('btn-provision');
      const btnGotoDeploy = document.getElementById('btn-goto-deploy');
      const btnSaveConfig = document.getElementById('btn-save-config-provision');

      if (provisioningCompleted) {
        btnProvision.textContent = t('web.btn.reprovision');
        btnProvision.classList.remove('btn-primary');
        btnProvision.classList.add('btn-warning');
        btnProvision.disabled = false;
        btnGotoDeploy.classList.remove('hidden');
        btnSaveConfig.classList.remove('hidden');
      } else {
        btnProvision.textContent = t('web.btn.createResources');
        btnProvision.classList.remove('btn-warning');
        btnProvision.classList.add('btn-primary');
        btnProvision.disabled = false;
        btnGotoDeploy.classList.add('hidden');
        btnSaveConfig.classList.add('hidden');
      }
    }

    // Save configuration to file (AuthrimConfigSchema format)
    function saveConfigToFile() {
      if (!config || !config.env) {
        alert('No configuration to save');
        return;
      }

      const now = new Date().toISOString();
      const env = config.env;

      // Calculate auto-generated URLs
      const workersDomain = env + '-ar-router.workers.dev';
      const pagesDomain = env + '-ar-ui.pages.dev';

      // Build issuer URL based on tenant settings
      let issuerAutoUrl = 'https://' + workersDomain;
      if (config.tenant && config.tenant.baseDomain) {
        if (config.tenant.nakedDomain) {
          issuerAutoUrl = 'https://' + config.tenant.baseDomain;
        } else {
          const tenantName = config.tenant.name || 'default';
          issuerAutoUrl = 'https://' + tenantName + '.' + config.tenant.baseDomain;
        }
      }

      // Build config in AuthrimConfigSchema format
      const configToSave = {
        version: '1.0.0',
        createdAt: now,
        updatedAt: now,
        environment: {
          prefix: env,
        },
        urls: {
          api: {
            custom: config.apiDomain || null,
            auto: config.apiDomain ? issuerAutoUrl : 'https://' + workersDomain,
          },
          loginUi: {
            custom: config.loginUiDomain || null,
            auto: 'https://' + pagesDomain,
          },
          adminUi: {
            custom: config.adminUiDomain || null,
            auto: 'https://' + pagesDomain + '/admin',
          },
        },
        tenant: {
          name: config.tenant?.name || 'default',
          displayName: config.tenant?.displayName || 'Default Tenant',
          multiTenant: config.tenant?.multiTenant || false,
          baseDomain: config.tenant?.baseDomain || undefined,
        },
        components: config.components || {
          api: true,
          loginUi: true,
          adminUi: true,
          saml: false,
          async: false,
          vc: false,
          bridge: true,
          policy: true,
        },
        keys: {
          secretsPath: './keys/',  // Relative path within .authrim/{env}/ structure
        },
        database: config.database || {
          core: { location: 'auto', jurisdiction: 'none' },
          pii: { location: 'auto', jurisdiction: 'none' },
        },
        features: {
          email: {
            provider: config.email?.provider || 'none',
            fromAddress: config.email?.fromAddress || undefined,
            fromName: config.email?.fromName || undefined,
            configured: config.email?.provider === 'resend' && config.email?.apiKey ? true : false,
          },
        },
      };

      // Remove undefined values for cleaner output
      if (!configToSave.tenant.baseDomain) {
        delete configToSave.tenant.baseDomain;
      }
      if (!configToSave.features.email.fromAddress) {
        delete configToSave.features.email.fromAddress;
      }
      if (!configToSave.features.email.fromName) {
        delete configToSave.features.email.fromName;
      }

      const blob = new Blob([JSON.stringify(configToSave, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'authrim-config.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    // Save config button handlers
    document.getElementById('btn-save-config-provision').addEventListener('click', saveConfigToFile);
    document.getElementById('btn-save-config-complete').addEventListener('click', saveConfigToFile);

    // Back to main button (from complete screen)
    document.getElementById('btn-back-to-main').addEventListener('click', () => {
      showSection('welcome');
      setStep(1);
    });

    // =============================================================================
    // Environment Management
    // =============================================================================

    // Menu handler for environment management
    document.getElementById('menu-manage-env').addEventListener('click', () => {
      loadEnvironments();
      showSection('envList');
    });

    // Load environments
    async function loadEnvironments() {
      const status = document.getElementById('env-list-status');
      const loading = document.getElementById('env-list-loading');
      const content = document.getElementById('env-list-content');
      const output = document.getElementById('env-scan-output');
      const noEnvsMessage = document.getElementById('no-envs-message');

      status.textContent = t('web.status.scanning');
      status.className = 'status-badge status-running';
      loading.classList.remove('hidden');
      content.classList.add('hidden');
      output.textContent = '';

      // Poll for progress
      let lastProgressLength = 0;
      const pollInterval = setInterval(async () => {
        try {
          const statusResult = await api('/deploy/status');
          if (statusResult.progress && statusResult.progress.length > lastProgressLength) {
            const newMessages = statusResult.progress.slice(lastProgressLength);
            newMessages.forEach(msg => {
              output.textContent += msg + '\\n';
            });
            lastProgressLength = statusResult.progress.length;
          }
        } catch (e) {}
      }, 500);

      try {
        const result = await api('/environments');
        clearInterval(pollInterval);

        if (result.success) {
          detectedEnvironments = result.environments || [];

          status.textContent = t('web.status.found', { count: detectedEnvironments.length });
          status.className = 'status-badge status-success';
          loading.classList.add('hidden');
          content.classList.remove('hidden');

          renderEnvironmentCards();
        } else {
          throw new Error(result.error);
        }
      } catch (error) {
        clearInterval(pollInterval);
        status.textContent = t('web.status.error');
        status.className = 'status-badge status-error';
        output.textContent += '\\n❌ Error: ' + error.message;
      }
    }

    // Render environment cards
    function renderEnvironmentCards() {
      const container = document.getElementById('env-cards');
      const noEnvsMessage = document.getElementById('no-envs-message');

      // Clear existing cards using safe method
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }

      if (detectedEnvironments.length === 0) {
        noEnvsMessage.classList.remove('hidden');
        return;
      }

      noEnvsMessage.classList.add('hidden');

      for (const env of detectedEnvironments) {
        const card = document.createElement('div');
        card.className = 'env-card';
        card.id = 'env-card-' + env.env.replace(/[^a-zA-Z0-9-]/g, '_');

        const info = document.createElement('div');
        info.className = 'env-card-info';

        const nameRow = document.createElement('div');
        nameRow.style.cssText = 'display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;';

        const name = document.createElement('div');
        name.className = 'env-card-name';
        name.textContent = env.env;
        nameRow.appendChild(name);

        // Badge placeholder for admin status (will be populated async)
        const badgeContainer = document.createElement('span');
        badgeContainer.id = 'admin-badge-' + env.env.replace(/[^a-zA-Z0-9-]/g, '_');
        nameRow.appendChild(badgeContainer);

        info.appendChild(nameRow);

        const stats = document.createElement('div');
        stats.className = 'env-card-stats';

        const statItems = [
          { icon: '🔧', label: 'Workers', count: env.workers.length },
          { icon: '📊', label: 'D1', count: env.d1.length },
          { icon: '🗄️', label: 'KV', count: env.kv.length },
          { icon: '📨', label: 'Queues', count: env.queues.length },
          { icon: '📁', label: 'R2', count: env.r2.length },
        ];

        for (const item of statItems) {
          if (item.count > 0) {
            const stat = document.createElement('span');
            stat.className = 'env-card-stat';
            stat.textContent = item.icon + ' ' + item.count + ' ' + item.label;
            stats.appendChild(stat);
          }
        }

        info.appendChild(stats);
        card.appendChild(info);

        // Make entire card clickable
        card.addEventListener('click', () => showEnvDetail(env));
        container.appendChild(card);

        // Check admin status and add badge if needed
        checkAndAddAdminBadge(env);
      }
    }

    // Check admin status and add badge to environment card
    async function checkAndAddAdminBadge(env) {
      const configKv = env.kv.find(kv =>
        kv.name.toUpperCase().includes('AUTHRIM_CONFIG') ||
        kv.name.toUpperCase().includes('AUTHRIM-CONFIG')
      );

      if (!configKv || !configKv.id) return;

      try {
        const response = await api('/admin/status/' + encodeURIComponent(configKv.id));
        if (response.success && !response.adminSetupCompleted) {
          const badgeContainer = document.getElementById('admin-badge-' + env.env.replace(/[^a-zA-Z0-9-]/g, '_'));
          if (badgeContainer) {
            const badge = document.createElement('span');
            badge.className = 'status-badge status-warning';
            badge.style.cssText = 'font-size: 0.75rem; padding: 0.125rem 0.5rem;';
            badge.textContent = t('web.status.adminNotConfigured');
            badgeContainer.appendChild(badge);
          }
        }
      } catch (error) {
        console.error('Failed to check admin status for ' + env.env + ':', error);
      }
    }

    // Show environment details
    function showEnvDetail(env) {
      selectedEnvForDetail = env;

      document.getElementById('detail-env-name').textContent = env.env;

      // Render resource lists with loading state
      renderResourceList('detail-workers-list', 'detail-workers-count', env.workers, 'name', 'worker');
      renderResourceList('detail-d1-list', 'detail-d1-count', env.d1, 'name', 'd1');
      renderResourceList('detail-kv-list', 'detail-kv-count', env.kv, 'name', 'kv');
      renderResourceList('detail-queues-list', 'detail-queues-count', env.queues, 'name', 'queue');
      renderResourceList('detail-r2-list', 'detail-r2-count', env.r2, 'name', 'r2');
      renderResourceList('detail-pages-list', 'detail-pages-count', env.pages || [], 'name', 'pages');

      // Hide empty sections
      document.getElementById('detail-queues-section').style.display = env.queues.length === 0 ? 'none' : 'block';
      document.getElementById('detail-r2-section').style.display = env.r2.length === 0 ? 'none' : 'block';
      document.getElementById('detail-pages-section').style.display = (env.pages || []).length === 0 ? 'none' : 'block';

      // Check and show/hide admin setup section
      const adminSetupSection = document.getElementById('admin-setup-section');
      const resultDiv = document.getElementById('admin-setup-result');
      const btn = document.getElementById('btn-start-admin-setup');

      // Reset state
      adminSetupSection.classList.add('hidden');
      resultDiv.classList.add('hidden');
      btn.disabled = false;
      btn.textContent = '🔐 Start Admin Account Setup with Passkey';

      // Find AUTHRIM_CONFIG KV namespace
      const configKv = env.kv.find(kv =>
        kv.name.toUpperCase().includes('AUTHRIM_CONFIG') ||
        kv.name.toUpperCase().includes('AUTHRIM-CONFIG')
      );

      if (configKv && configKv.id) {
        // Check admin setup status asynchronously
        checkAndShowAdminSetup(configKv.id);
      }

      // Reset and load worker version comparison
      resetWorkerUpdateUI();
      loadWorkerVersionComparison(env.env);

      showSection('envDetail');

      // Load details asynchronously
      loadResourceDetails(env);
    }

    // ===========================================
    // Worker Update Functions
    // ===========================================

    let workerVersionComparison = [];
    let currentEnvForUpdate = null;

    // Reset worker update UI
    function resetWorkerUpdateUI() {
      workerVersionComparison = [];
      const tbody = document.getElementById('worker-version-tbody');
      tbody.textContent = '';
      const loadingRow = document.createElement('tr');
      const loadingCell = document.createElement('td');
      loadingCell.colSpan = 4;
      loadingCell.style.cssText = 'text-align: center; padding: 1rem; color: var(--text-muted);';
      loadingCell.textContent = t('web.status.loading');
      loadingRow.appendChild(loadingCell);
      tbody.appendChild(loadingRow);
      document.getElementById('update-summary').textContent = '';
      document.getElementById('btn-update-workers').disabled = true;
      document.getElementById('worker-update-progress').classList.add('hidden');
      document.getElementById('worker-update-log').textContent = '';
    }

    // Load and compare worker versions
    async function loadWorkerVersionComparison(envName) {
      currentEnvForUpdate = envName;
      const tbody = document.getElementById('worker-version-tbody');

      try {
        const response = await api('/update/compare/' + encodeURIComponent(envName));

        if (response.success) {
          workerVersionComparison = response.comparison;
          renderVersionTable(response.comparison);

          // Update summary
          const summary = response.summary;
          const summaryText = summary.needsUpdate > 0
            ? (t('web.envDetail.updatesAvailable', { count: summary.needsUpdate }) || summary.needsUpdate + ' update(s) available')
            : (t('web.envDetail.allUpToDate') || 'All up to date');
          document.getElementById('update-summary').textContent = summaryText;

          // Enable button if there are updates
          document.getElementById('btn-update-workers').disabled = summary.needsUpdate === 0;
        } else {
          tbody.textContent = '';
          const errorRow = document.createElement('tr');
          const errorCell = document.createElement('td');
          errorCell.colSpan = 4;
          errorCell.style.cssText = 'color: var(--error); padding: 1rem;';
          errorCell.textContent = response.error || 'Failed to load versions';
          errorRow.appendChild(errorCell);
          tbody.appendChild(errorRow);
        }
      } catch (error) {
        console.error('Failed to load version comparison:', error);
        tbody.textContent = '';
        const errorRow = document.createElement('tr');
        const errorCell = document.createElement('td');
        errorCell.colSpan = 4;
        errorCell.style.cssText = 'color: var(--error); padding: 1rem;';
        errorCell.textContent = error.message;
        errorRow.appendChild(errorCell);
        tbody.appendChild(errorRow);
      }
    }

    // Render version comparison table
    function renderVersionTable(comparison) {
      const tbody = document.getElementById('worker-version-tbody');
      tbody.textContent = '';

      if (comparison.length === 0) {
        const emptyRow = document.createElement('tr');
        const emptyCell = document.createElement('td');
        emptyCell.colSpan = 4;
        emptyCell.style.cssText = 'text-align: center; padding: 1rem; color: var(--text-muted);';
        emptyCell.textContent = t('web.status.none');
        emptyRow.appendChild(emptyCell);
        tbody.appendChild(emptyRow);
        return;
      }

      for (const item of comparison) {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border-light)';

        // Worker name
        const tdName = document.createElement('td');
        tdName.style.cssText = 'padding: 0.5rem; font-weight: 500;';
        tdName.textContent = item.component;
        tr.appendChild(tdName);

        // Deployed version
        const tdDeployed = document.createElement('td');
        tdDeployed.style.cssText = 'padding: 0.5rem; font-family: var(--font-mono);';
        tdDeployed.textContent = item.deployedVersion || '-';
        if (!item.deployedVersion) tdDeployed.style.color = 'var(--text-muted)';
        tr.appendChild(tdDeployed);

        // Local version
        const tdLocal = document.createElement('td');
        tdLocal.style.cssText = 'padding: 0.5rem; font-family: var(--font-mono);';
        tdLocal.textContent = item.localVersion || '-';
        tr.appendChild(tdLocal);

        // Status
        const tdStatus = document.createElement('td');
        tdStatus.style.cssText = 'padding: 0.5rem; text-align: center;';

        const badge = document.createElement('span');
        badge.style.cssText = 'padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 500;';

        if (item.needsUpdate) {
          if (!item.deployedVersion) {
            badge.textContent = t('web.envDetail.notDeployed') || 'Not Deployed';
            badge.style.background = 'var(--error-bg)';
            badge.style.color = 'var(--error)';
          } else {
            badge.textContent = t('web.envDetail.needsUpdate') || 'Update';
            badge.style.background = 'var(--warning-bg)';
            badge.style.color = 'var(--warning)';
          }
        } else {
          badge.textContent = t('web.envDetail.upToDate') || 'Current';
          badge.style.background = 'var(--success-bg)';
          badge.style.color = 'var(--success)';
        }

        tdStatus.appendChild(badge);
        tr.appendChild(tdStatus);

        tbody.appendChild(tr);
      }
    }

    // Start worker update
    async function startWorkerUpdate() {
      const btn = document.getElementById('btn-update-workers');
      const progressDiv = document.getElementById('worker-update-progress');
      const logDiv = document.getElementById('worker-update-log');
      const onlyChanged = document.getElementById('update-only-changed').checked;

      btn.disabled = true;
      const btnSpan = btn.querySelector('span');
      if (btnSpan) btnSpan.textContent = t('web.status.deploying') || 'Updating...';
      progressDiv.classList.remove('hidden');
      logDiv.textContent = '';

      const addLog = (msg) => {
        const line = document.createElement('div');
        line.textContent = msg;
        logDiv.appendChild(line);
        logDiv.scrollTop = logDiv.scrollHeight;
      };

      try {
        addLog('Starting worker update for ' + currentEnvForUpdate + '...');

        const response = await api('/update/workers', {
          method: 'POST',
          body: JSON.stringify({
            env: currentEnvForUpdate,
            onlyChanged: onlyChanged
          })
        });

        if (response.progress && Array.isArray(response.progress)) {
          for (const msg of response.progress) {
            addLog(msg);
          }
        }

        if (response.success) {
          addLog('');
          addLog('✅ Update completed successfully!');
          const summary = response.summary;
          addLog('Summary: ' + summary.successCount + '/' + summary.totalComponents + ' workers updated');

          // Refresh version table
          await loadWorkerVersionComparison(currentEnvForUpdate);
        } else {
          addLog('');
          addLog('❌ Update failed: ' + (response.error || 'Unknown error'));
        }
      } catch (error) {
        addLog('❌ Error: ' + error.message);
      } finally {
        btn.disabled = false;
        const btnSpan2 = btn.querySelector('span');
        if (btnSpan2) btnSpan2.textContent = t('web.envDetail.updateAllWorkers') || 'Update Workers';
      }
    }

    // Event listeners for Worker Update
    document.getElementById('btn-update-workers')?.addEventListener('click', startWorkerUpdate);
    document.getElementById('btn-refresh-versions')?.addEventListener('click', () => {
      if (currentEnvForUpdate) {
        resetWorkerUpdateUI();
        loadWorkerVersionComparison(currentEnvForUpdate);
      }
    });

    // ===========================================
    // Admin Setup Functions
    // ===========================================

    // Check admin setup status and show section if needed
    async function checkAndShowAdminSetup(kvNamespaceId) {
      try {
        const response = await api('/admin/status/' + encodeURIComponent(kvNamespaceId));
        if (response.success && !response.adminSetupCompleted) {
          document.getElementById('admin-setup-section').classList.remove('hidden');
        }
      } catch (error) {
        console.error('Failed to check admin status:', error);
      }
    }

    // Helper to render resource list
    function renderResourceList(listId, countId, resources, nameKey, resourceType) {
      const list = document.getElementById(listId);
      const count = document.getElementById(countId);

      list.innerHTML = '';
      count.textContent = '(' + resources.length + ')';

      if (resources.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'resource-empty';
        empty.textContent = t('web.status.none');
        list.appendChild(empty);
        return;
      }

      for (const resource of resources) {
        const item = document.createElement('div');
        item.className = 'resource-item';
        item.id = 'resource-' + resourceType + '-' + (resource.name || resource.title || '').replace(/[^a-zA-Z0-9-]/g, '_');

        const nameDiv = document.createElement('div');
        nameDiv.className = 'resource-item-name';
        nameDiv.textContent = resource[nameKey] || resource.title || resource.id || 'Unknown';
        item.appendChild(nameDiv);

        // Add loading placeholder for D1 and Workers
        if (resourceType === 'd1' || resourceType === 'worker') {
          const detailsDiv = document.createElement('div');
          detailsDiv.className = 'resource-item-details resource-item-loading';
          detailsDiv.textContent = t('web.status.loading');
          item.appendChild(detailsDiv);
        }

        list.appendChild(item);
      }
    }

    // Load resource details asynchronously
    async function loadResourceDetails(env) {
      // Load D1 and Worker details in parallel
      const d1Promises = env.d1.map(db => loadD1Details(db.name));
      const workerPromises = env.workers.map(w => loadWorkerDetails(w.name));

      // Wait for all to complete (don't block on errors)
      await Promise.allSettled([...d1Promises, ...workerPromises]);
    }

    // Load D1 database details
    async function loadD1Details(name) {
      try {
        const result = await fetch('/api/d1/' + encodeURIComponent(name) + '/info').then(r => r.json());

        const itemId = 'resource-d1-' + name.replace(/[^a-zA-Z0-9-]/g, '_');
        const item = document.getElementById(itemId);
        if (!item) return;

        const detailsDiv = item.querySelector('.resource-item-details');
        if (!detailsDiv) return;

        if (result.success && result.info) {
          const info = result.info;
          detailsDiv.className = 'resource-item-details';
          detailsDiv.innerHTML = '';

          if (info.databaseSize) {
            const span = document.createElement('span');
            span.textContent = '📦 ' + info.databaseSize;
            detailsDiv.appendChild(span);
          }
          if (info.region) {
            const span = document.createElement('span');
            span.textContent = '🌍 ' + info.region;
            detailsDiv.appendChild(span);
          }
          if (info.createdAt) {
            const span = document.createElement('span');
            span.textContent = '📅 ' + formatDate(info.createdAt);
            detailsDiv.appendChild(span);
          }
        } else {
          detailsDiv.className = 'resource-item-details resource-item-error';
          detailsDiv.textContent = t('web.status.failedToLoad');
        }
      } catch (e) {
        console.error('Failed to load D1 details:', e);
      }
    }

    // Load Worker deployment details
    async function loadWorkerDetails(name) {
      try {
        const result = await fetch('/api/worker/' + encodeURIComponent(name) + '/deployments').then(r => r.json());

        const itemId = 'resource-worker-' + name.replace(/[^a-zA-Z0-9-]/g, '_');
        const item = document.getElementById(itemId);
        if (!item) return;

        const detailsDiv = item.querySelector('.resource-item-details');
        if (!detailsDiv) return;

        if (result.success && result.deployments) {
          const info = result.deployments;
          detailsDiv.className = 'resource-item-details';
          detailsDiv.innerHTML = '';

          if (!info.exists) {
            detailsDiv.className = 'resource-item-details resource-item-not-deployed';
            detailsDiv.textContent = '⚠️ Not deployed';
            return;
          }

          if (info.lastDeployedAt) {
            const span = document.createElement('span');
            span.textContent = '🚀 ' + formatDate(info.lastDeployedAt);
            detailsDiv.appendChild(span);
          }
          if (info.author) {
            const span = document.createElement('span');
            span.textContent = '👤 ' + info.author;
            detailsDiv.appendChild(span);
          }
          if (info.versionId) {
            const span = document.createElement('span');
            span.textContent = '🏷️ ' + info.versionId.substring(0, 8) + '...';
            detailsDiv.appendChild(span);
          }
        } else {
          detailsDiv.className = 'resource-item-details resource-item-not-deployed';
          detailsDiv.textContent = '⚠️ Not deployed';
        }
      } catch (e) {
        console.error('Failed to load Worker details:', e);
      }
    }

    // Format ISO date to readable format with timezone
    function formatDate(isoString) {
      try {
        const date = new Date(isoString);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        // Get timezone abbreviation
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const tzAbbr = date.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();
        return dateStr + ' (' + tzAbbr + ')';
      } catch {
        return isoString;
      }
    }

    // Show delete confirmation
    function showDeleteConfirmation(env) {
      selectedEnvForDelete = env;

      document.getElementById('delete-env-name').textContent = env.env;
      document.getElementById('delete-workers-count').textContent = '(' + env.workers.length + ' workers)';
      document.getElementById('delete-d1-count').textContent = '(' + env.d1.length + ' databases)';
      document.getElementById('delete-kv-count').textContent = '(' + env.kv.length + ' namespaces)';
      document.getElementById('delete-queues-count').textContent = '(' + env.queues.length + ' queues)';
      document.getElementById('delete-r2-count').textContent = '(' + env.r2.length + ' buckets)';
      document.getElementById('delete-pages-count').textContent = '(' + (env.pages || []).length + ' projects)';

      // Reset checkboxes
      document.getElementById('delete-workers').checked = true;
      document.getElementById('delete-d1').checked = true;
      document.getElementById('delete-kv').checked = true;
      document.getElementById('delete-queues').checked = true;
      document.getElementById('delete-r2').checked = true;
      document.getElementById('delete-pages').checked = true;

      // Reset UI state
      document.getElementById('delete-options-section').classList.remove('hidden');
      document.getElementById('delete-log').classList.add('hidden');
      document.getElementById('delete-result').classList.add('hidden');
      document.getElementById('delete-result').textContent = '';
      document.getElementById('btn-confirm-delete').classList.remove('hidden');
      document.getElementById('btn-confirm-delete').disabled = false;

      showSection('envDelete');
    }

    // Back buttons for environment management
    document.getElementById('btn-back-env-list').addEventListener('click', () => {
      showSection('topMenu');
    });

    document.getElementById('btn-refresh-env-list').addEventListener('click', () => {
      loadEnvironments();
    });

    document.getElementById('btn-back-env-detail').addEventListener('click', () => {
      showSection('envList');
    });

    document.getElementById('btn-delete-from-detail').addEventListener('click', () => {
      if (selectedEnvForDetail) {
        showDeleteConfirmation(selectedEnvForDetail);
      }
    });

    // Admin setup button
    document.getElementById('btn-start-admin-setup').addEventListener('click', async () => {
      if (!selectedEnvForDetail) return;

      const btn = document.getElementById('btn-start-admin-setup');
      const resultDiv = document.getElementById('admin-setup-result');
      const urlInput = document.getElementById('admin-setup-url');
      const openLink = document.getElementById('btn-open-setup-url');

      btn.disabled = true;
      btn.textContent = '⏳ Generating token...';

      try {
        // Find AUTHRIM_CONFIG KV namespace
        const configKv = selectedEnvForDetail.kv.find(kv =>
          kv.name.toUpperCase().includes('AUTHRIM_CONFIG') ||
          kv.name.toUpperCase().includes('AUTHRIM-CONFIG')
        );

        if (!configKv) {
          alert('Could not find AUTHRIM_CONFIG KV namespace for this environment');
          btn.disabled = false;
          btn.textContent = '🔐 Start Admin Account Setup with Passkey';
          return;
        }

        // Find router worker to construct base URL
        const router = selectedEnvForDetail.workers.find(w =>
          w.name.toLowerCase().includes('router')
        );

        let baseUrl = '';
        if (router && router.name) {
          // Construct URL from worker name with subdomain
          // Format: https://{worker-name}.{subdomain}.workers.dev
          if (workersSubdomain) {
            baseUrl = 'https://' + router.name + '.' + workersSubdomain + '.workers.dev';
          } else {
            // Fallback without subdomain (shouldn't happen in practice)
            baseUrl = 'https://' + router.name + '.workers.dev';
          }
        } else {
          // Fallback - ask for URL
          baseUrl = prompt('Enter the base URL for the router (e.g., https://myenv-ar-router.subdomain.workers.dev):');
          if (!baseUrl) {
            btn.disabled = false;
            btn.textContent = '🔐 Start Admin Account Setup with Passkey';
            return;
          }
        }

        const response = await api('/admin/generate-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kvNamespaceId: configKv.id,
            baseUrl: baseUrl,
          }),
        });

        if (response.success && response.setupUrl) {
          urlInput.value = response.setupUrl;
          openLink.href = response.setupUrl;
          resultDiv.classList.remove('hidden');
          btn.textContent = '✓ Token Generated';
        } else {
          alert('Failed to generate token: ' + (response.error || 'Unknown error'));
          btn.disabled = false;
          btn.textContent = '🔐 Start Admin Account Setup with Passkey';
        }
      } catch (error) {
        alert('Error: ' + error.message);
        btn.disabled = false;
        btn.textContent = '🔐 Start Admin Account Setup with Passkey';
      }
    });

    // Copy setup URL button
    document.getElementById('btn-copy-setup-url').addEventListener('click', () => {
      const urlInput = document.getElementById('admin-setup-url');
      urlInput.select();
      document.execCommand('copy');
      const btn = document.getElementById('btn-copy-setup-url');
      const originalText = btn.textContent;
      btn.textContent = '✓ Copied!';
      setTimeout(() => { btn.textContent = originalText; }, 2000);
    });

    document.getElementById('btn-back-env-delete').addEventListener('click', () => {
      // Go back to detail view if we came from there
      if (selectedEnvForDetail) {
        showSection('envDetail');
      } else {
        showSection('envList');
      }
    });

    // Delete environment
    document.getElementById('btn-confirm-delete').addEventListener('click', async () => {
      if (!selectedEnvForDelete) return;

      const btn = document.getElementById('btn-confirm-delete');
      const log = document.getElementById('delete-log');
      const output = document.getElementById('delete-output');
      const result = document.getElementById('delete-result');
      const progressUI = document.getElementById('delete-progress-ui');

      btn.disabled = true;
      btn.classList.add('hidden');
      document.getElementById('delete-options-section').classList.add('hidden');
      progressUI.classList.remove('hidden');
      log.classList.add('hidden'); // Log is hidden by default, toggled via button
      result.classList.add('hidden');
      output.textContent = '';

      const deleteOptions = {
        deleteWorkers: document.getElementById('delete-workers').checked,
        deleteD1: document.getElementById('delete-d1').checked,
        deleteKV: document.getElementById('delete-kv').checked,
        deleteQueues: document.getElementById('delete-queues').checked,
        deleteR2: document.getElementById('delete-r2').checked,
        deletePages: document.getElementById('delete-pages').checked,
      };

      // Count actual resources to delete based on environment info
      let deleteCompleted = 0;
      let totalToDelete = 0;
      if (deleteOptions.deleteWorkers) totalToDelete += selectedEnvForDelete.workers?.length || 0;
      if (deleteOptions.deleteD1) totalToDelete += selectedEnvForDelete.d1?.length || 0;
      if (deleteOptions.deleteKV) totalToDelete += selectedEnvForDelete.kv?.length || 0;
      if (deleteOptions.deleteQueues) totalToDelete += selectedEnvForDelete.queues?.length || 0;
      if (deleteOptions.deleteR2) totalToDelete += selectedEnvForDelete.r2?.length || 0;
      if (deleteOptions.deletePages) totalToDelete += selectedEnvForDelete.pages?.length || 0;
      updateProgressUI('delete', 0, totalToDelete, 'Starting deletion...');

      // Poll for progress
      let lastProgressLength = 0;
      const pollInterval = setInterval(async () => {
        try {
          const statusResult = await api('/deploy/status');
          if (statusResult.progress && statusResult.progress.length > lastProgressLength) {
            const newMessages = statusResult.progress.slice(lastProgressLength);
            newMessages.forEach(msg => {
              output.textContent += msg + '\\n';
              // Update progress UI based on message content
              const taskInfo = parseProgressMessage(msg);
              if (taskInfo) {
                updateProgressUI('delete', deleteCompleted, totalToDelete, taskInfo);
              }
              // Count completed items (lines with checkmark)
              if (msg.includes('✓') || msg.includes('✅') || msg.includes('Deleted')) {
                deleteCompleted++;
                updateProgressUI('delete', deleteCompleted, totalToDelete, taskInfo || ('Deleted ' + deleteCompleted + ' items'));
              }
            });
            lastProgressLength = statusResult.progress.length;
            scrollToBottom(log);
          }
        } catch (e) {}
      }, 500);

      try {
        const deleteResult = await api('/environments/' + selectedEnvForDelete.env + '/delete', {
          method: 'POST',
          body: deleteOptions,
        });

        clearInterval(pollInterval);

        // Show final progress
        if (deleteResult.progress) {
          output.textContent = deleteResult.progress.join('\\n');
        }

        result.classList.remove('hidden');

        if (deleteResult.success) {
          // Final progress update
          updateProgressUI('delete', totalToDelete, totalToDelete, '✅ Deletion complete!');
          result.textContent = '';
          result.appendChild(createAlert('success', '✅ Environment deleted successfully!'));

          // Refresh environment list after a short delay
          setTimeout(() => {
            loadEnvironments();
            showSection('envList');
          }, 2000);
        } else {
          result.textContent = '';
          result.appendChild(createAlert('error', '❌ Some errors occurred: ' + (deleteResult.errors || []).join(', ')));
          btn.classList.remove('hidden');
          btn.disabled = false;
        }
      } catch (error) {
        clearInterval(pollInterval);
        result.classList.remove('hidden');
        result.textContent = '';
        result.appendChild(createAlert('error', '❌ Error: ' + error.message));
        btn.classList.remove('hidden');
        btn.disabled = false;
      }
    });

    // Initialize
    if (MANAGE_ONLY) {
      // Skip prerequisites UI and go directly to environment management
      // Prerequisites were already checked by CLI
      loadEnvironments();
      showSection('envList');
    } else {
      checkPrerequisites();
    }
  </script>
</body>
</html>`;
}
