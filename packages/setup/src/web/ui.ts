/**
 * HTML Template for Authrim Setup Web UI
 *
 * A simple, self-contained UI for the setup wizard.
 * Follows the setup flow defined in the design document.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locale, LocaleInfo } from '../i18n/types.js';
import { SETUP_CAPABILITY_COPY } from '../core/setup-capability-copy.js';
import {
  CLOUDFLARE_DNS_RECORDS_DOCS_URL,
  WILDCARD_DNS_MANUAL_COPY,
  getCloudflareDnsRecordsDashboardUrl,
} from '../core/wildcard-dns-manual-action.js';

const CLOUDFLARE_DNS_ADD_RECORD_IMAGE_DATA_URI = `data:image/png;base64,${readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'cloudflare-dns-add-record-example.png')
).toString('base64')}`;

const DOMAIN_FORM_BROWSER_SCRIPT = String.raw`
    function isValidCustomDomain(domain) {
      const normalized = String(domain || '').trim();
      if (normalized.length === 0 || normalized.length > 253) {
        return false;
      }

      const labels = normalized.split('.');
      if (labels.length < 2 || labels.some(function(label) {
        return label.length === 0 || label.length > 63;
      })) {
        return false;
      }

      if (labels.some(function(label) {
        return label.toLowerCase().startsWith('xn--');
      })) {
        return false;
      }

      const tld = labels[labels.length - 1];
      if (!/^[a-z]{2,63}$/i.test(tld)) {
        return false;
      }

      return labels.every(function(label) {
        return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label);
      });
    }

    function validateSetupDomainInputs(input) {
      function normalizeDomain(value) {
        return String(value || '')
          .trim()
          .replace(/^https?:\/\//i, '')
          .replace(/\/.*$/, '')
          .replace(/\\.+$/, '')
          .toLowerCase();
      }

      function getZoneName(hostname) {
        const parts = hostname.split('.').filter(Boolean);
        const twoPartTlds = new Set([
          'co.uk',
          'org.uk',
          'gov.uk',
          'ac.uk',
          'co.jp',
          'or.jp',
          'ne.jp',
          'co.nz',
          'org.nz',
          'net.nz',
          'co.kr',
          'or.kr',
          'ne.kr',
          'co.in',
          'firm.in',
          'net.in',
          'org.in',
          'gen.in',
          'co.id',
          'web.id',
          'ac.id',
          'or.id',
          'co.za',
          'org.za',
          'net.za',
          'com.au',
          'net.au',
          'org.au',
          'com.br',
          'net.br',
          'org.br',
        ]);
        const lastTwo = parts.slice(-2).join('.');
        if (twoPartTlds.has(lastTwo) && parts.length >= 3) {
          return parts.slice(-3).join('.');
        }
        return parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
      }

      function prefixLabelsFor(hostname, parentDomain) {
        if (!hostname || !parentDomain || hostname === parentDomain) {
          return [];
        }
        const suffix = '.' + parentDomain;
        if (!hostname.endsWith(suffix)) {
          return [];
        }
        return hostname.slice(0, -suffix.length).split('.').filter(Boolean);
      }

      function buildBaseMessage(hostname) {
        return (
          'Base Domain must be the parent domain used by tenant URLs. "' + hostname + '" has ' +
          'two or more labels before the registered domain, which would create unsupported ' +
          'two-label tenant hosts.'
        );
      }

      function buildUiMessage(label, hostname, suggestion) {
        return (
          label + ' domain "' + hostname + '" is too deep for the standard tenant domain model. ' +
          'Use a one-label host such as "' + suggestion + '" instead.'
        );
      }

      const issues = [];
      const apiDomain = normalizeDomain(input.apiDomain);
      const loginUiDomain = normalizeDomain(input.loginUiDomain);
      const adminUiDomain = normalizeDomain(input.adminUiDomain);

      if (apiDomain && isValidCustomDomain(apiDomain)) {
        const zoneName = getZoneName(apiDomain);
        const apiPrefixLabels = prefixLabelsFor(apiDomain, zoneName);
        if (apiPrefixLabels.length >= 2) {
          const suggested = apiPrefixLabels[apiPrefixLabels.length - 1] + '.' + zoneName;
          issues.push({
            field: 'apiDomain',
            message: buildBaseMessage(apiDomain),
            suggestion: suggested,
          });
        }
      }

      [
        ['loginUiDomain', 'Login UI', loginUiDomain],
        ['adminUiDomain', 'Admin UI', adminUiDomain],
      ].forEach(function(entry) {
        const field = entry[0];
        const label = entry[1];
        const hostname = entry[2];
        if (!hostname || !isValidCustomDomain(hostname)) {
          return;
        }

        const parentDomain =
          apiDomain && hostname.endsWith('.' + apiDomain) ? apiDomain : getZoneName(hostname);
        const uiPrefixLabels = prefixLabelsFor(hostname, parentDomain);
        if (uiPrefixLabels.length >= 2) {
          const suggestion = uiPrefixLabels.join('-') + '.' + parentDomain;
          issues.push({
            field: field,
            message: buildUiMessage(label, hostname, suggestion),
            suggestion: suggestion,
          });
        }
      });

      return issues;
    }

    function computeApiDomainUiState(input) {
      const baseDomain = input.baseDomain.trim();
      const tenantName = input.tenantName.trim() || 'default';
      const primaryTenant = (input.primaryTenant || '').trim();
      const hasBaseDomain = baseDomain.length > 0;
      const multiTenantEnabled = hasBaseDomain && input.multiTenantChecked;
      const nakedDomainEnabled = multiTenantEnabled && input.nakedDomainChecked;
      const nakedTenantName = primaryTenant || tenantName;
      const exampleRows = [];

      if (multiTenantEnabled) {
        if (nakedDomainEnabled) {
          exampleRows.push({
            kind: 'initial-tenant',
            tenantName: nakedTenantName,
            url: 'https://' + baseDomain,
          });
          if (nakedTenantName !== tenantName) {
            exampleRows.push({
              kind: 'initial-tenant-explicit',
              tenantName: tenantName,
              url: 'https://' + tenantName + '.' + baseDomain,
            });
          }
          exampleRows.push({
            kind: 'other-tenant',
            url: 'https://{tenantName}.' + baseDomain,
          });
        } else {
          exampleRows.push({
            kind: 'initial-tenant',
            tenantName: tenantName,
            url: 'https://' + tenantName + '.' + baseDomain,
          });
          exampleRows.push({
            kind: 'other-tenant',
            url: 'https://{tenantName}.' + baseDomain,
          });
        }
      }

      return {
        hasBaseDomain: hasBaseDomain,
        hasValidBaseDomain: isValidCustomDomain(baseDomain),
        multiTenantEnabled: multiTenantEnabled,
        showWorkersDevNote: !hasBaseDomain,
        showNakedDomainControls: multiTenantEnabled,
        showTenantFields: !hasBaseDomain || (multiTenantEnabled && !nakedDomainEnabled),
        showPrimaryTenantRow: false,
        showExamples: multiTenantEnabled,
        baseDomainPlaceholder: nakedDomainEnabled
          ? 'example.com'
          : multiTenantEnabled
            ? 'tenant.example.com'
            : 'oidc.example.com',
        multiTenantHintMode: !hasBaseDomain
          ? 'needs-custom-domain'
          : multiTenantEnabled
            ? 'multi-tenant'
            : 'single-tenant',
        nakedDomainHintMode: !multiTenantEnabled
          ? 'hidden'
          : nakedDomainEnabled
            ? 'omit-tenant'
            : 'include-tenant',
        exampleRows: exampleRows,
      };
    }
`;

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
  const wildcardDnsManualCopyJson = JSON.stringify(
    Object.fromEntries(
      Object.entries(WILDCARD_DNS_MANUAL_COPY).map(([code, copy]) => [
        code,
        {
          title: copy.title,
          summaryTemplate: copy.summary('{baseDomain}'),
          timing: copy.timing,
          stepsTemplate: copy.steps(
            '{zoneName}',
            '*.{baseDomain}',
            '{baseDomain}',
            '{dashboardRecordName}'
          ),
          retryHint: copy.retryHint,
          continueHint: copy.continueHint,
          dashboardLinkLabel: copy.dashboardLinkLabel,
          docsLinkLabel: copy.docsLinkLabel,
          confirmSuffix: copy.confirmSuffix,
        },
      ])
    )
  );
  const cloudflareDnsAddRecordImageDataUriJson = JSON.stringify(
    CLOUDFLARE_DNS_ADD_RECORD_IMAGE_DATA_URI
  );

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

    .inline-field {
      display: flex;
      gap: 0.75rem;
      align-items: center;
    }

    .inline-field input {
      flex: 1;
      min-width: 0;
    }

    .inline-field button {
      flex: 0 0 auto;
      white-space: nowrap;
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

    .standard-component-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-weight: 600;
      margin-bottom: 0.25rem;
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

    .hint-box.error-hint {
      background: rgba(220, 38, 38, 0.1);
      color: #dc2626;
      border-color: rgba(220, 38, 38, 0.35);
    }

    [data-theme="dark"] .hint-box.error-hint {
      background: rgba(248, 113, 113, 0.12);
      color: #f87171;
      border-color: rgba(248, 113, 113, 0.3);
    }

    .preview-tenant-block {
      margin-top: 0.5rem;
      margin-bottom: 0.5rem;
      padding: 0.6rem 0.75rem;
      border-left: 2px solid var(--primary);
      border-radius: 0 4px 4px 0;
      background: rgba(0, 0, 0, 0.03);
    }

    [data-theme="dark"] .preview-tenant-block {
      background: rgba(255, 255, 255, 0.03);
    }

    .preview-tenant-name {
      font-weight: 600;
      font-size: 0.83rem;
      margin-bottom: 0.25rem;
      color: var(--text-primary);
    }

    .preview-tenant-row {
      display: grid;
      grid-template-columns: 6.25rem minmax(0, 1fr);
      column-gap: 0.75rem;
      font-size: 0.79rem;
      margin-top: 0.15rem;
      align-items: baseline;
    }

    .preview-tenant-label {
      color: var(--text-muted);
      white-space: nowrap;
    }

    .preview-tenant-url {
      color: var(--primary);
      overflow-wrap: break-word;
      word-break: normal;
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
      --preview-label-width: 13.75rem;
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
      display: grid;
      grid-template-columns: var(--preview-label-width) minmax(0, 1fr);
      column-gap: 1rem;
      align-items: start;
      padding: 0.375rem 0;
      font-size: 0.875rem;
    }

    .infra-label {
      color: var(--text-muted);
      white-space: nowrap;
    }

    .infra-value {
      font-family: var(--font-mono);
      font-size: 0.8rem;
      color: var(--primary);
      min-width: 0;
      overflow-wrap: break-word;
      word-break: normal;
    }

    .infra-value-note {
      display: block;
      margin-top: 0.2rem;
      color: var(--text-muted);
      font-family: var(--font-sans);
      font-size: 0.8rem;
      line-height: 1.35;
    }

    .preview-component-list {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      align-items: center;
      font-family: var(--font-sans);
    }

    .preview-component-badge {
      display: inline-flex;
      align-items: center;
      min-height: 1.5rem;
      padding: 0.2rem 0.55rem;
      border: 1px solid rgba(59, 130, 246, 0.35);
      border-radius: 999px;
      background: rgba(59, 130, 246, 0.09);
      color: var(--primary);
      font-size: 0.78rem;
      font-weight: 600;
      line-height: 1.15;
      white-space: nowrap;
    }

    [data-theme="dark"] .preview-component-badge {
      background: rgba(96, 165, 250, 0.12);
      border-color: rgba(96, 165, 250, 0.35);
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

    .issuer-preview-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 0.5rem;
    }

    .issuer-preview-table th,
    .issuer-preview-table td {
      padding: 0.45rem 0;
      border-top: 1px solid rgba(5, 150, 105, 0.14);
      vertical-align: top;
    }

    [data-theme="dark"] .issuer-preview-table th,
    [data-theme="dark"] .issuer-preview-table td {
      border-top-color: rgba(52, 211, 153, 0.18);
    }

    .issuer-preview-table th {
      width: 44%;
      text-align: left;
      color: var(--text-muted);
      font-size: 0.75rem;
      font-weight: 600;
      padding-right: 0.75rem;
    }

    .issuer-preview-table td {
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

    .progress-log-actions {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 0.75rem;
    }

    .progress-log-copy-btn {
      background: #1e293b;
      border-color: #334155;
      color: #e2e8f0;
      padding: 0.35rem 0.75rem;
      font-size: 0.75rem;
    }

    .progress-log-copy-btn:hover:not(:disabled) {
      background: #334155;
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

    .manual-guide-visual {
      margin-top: 0.875rem;
      border-radius: 18px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(15, 23, 42, 0.5);
      box-shadow: 0 22px 48px rgba(15, 23, 42, 0.26);
    }

    .manual-guide-visual img {
      display: block;
      width: 100%;
      height: auto;
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

    [data-theme="dark"] .manual-guide-visual {
      background: rgba(2, 6, 23, 0.88);
      border-color: rgba(148, 163, 184, 0.22);
    }

    .manual-wildcard-warning {
      line-height: 1.55;
    }

    .manual-wildcard-warning strong {
      display: block;
      margin-bottom: 0.4rem;
    }

    .manual-guide-timing {
      margin: 0.35rem 0 0;
      font-weight: 600;
    }

    .manual-guide-steps {
      margin-top: 0.7rem;
      display: grid;
      gap: 0.65rem;
    }

    .manual-guide-step-text,
    .manual-guide-retry {
      margin: 0;
    }

    .manual-guide-values {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 0.45rem;
      margin: 0;
    }

    .manual-guide-value {
      min-width: 0;
      min-height: 4.7rem;
      padding: 0.5rem 0.6rem;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.5);
      border: 1px solid rgba(217, 119, 6, 0.18);
      display: grid;
      grid-template-rows: 1rem minmax(1.7rem, 1fr);
      gap: 0.25rem;
      position: relative;
    }

    .manual-guide-value-main {
      grid-column: span 2;
    }

    .manual-guide-value-secondary {
      grid-column: span 3;
    }

    [data-theme="dark"] .manual-guide-value {
      background: rgba(2, 6, 23, 0.24);
      border-color: rgba(251, 191, 36, 0.2);
    }

    .manual-guide-value dt {
      margin: 0 0 0.18rem;
      font-family: var(--font-sans);
      font-size: 0.72rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      opacity: 0.78;
      padding-right: 3.25rem;
    }

    .manual-guide-value dd {
      margin: 0;
      min-width: 0;
      font-family: var(--font-mono);
      font-size: 0.82rem;
      font-weight: 700;
      overflow-wrap: break-word;
      color: inherit;
    }

    .manual-guide-value-body {
      min-width: 0;
    }

    .manual-guide-copy-btn {
      position: absolute;
      top: 0.45rem;
      right: 0.5rem;
      padding: 0.22rem 0.45rem;
      border-radius: 6px;
      border: 1px solid rgba(217, 119, 6, 0.25);
      background: rgba(255, 255, 255, 0.42);
      color: inherit;
      font-family: var(--font-sans);
      font-size: 0.72rem;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
    }

    .manual-guide-copy-btn:disabled {
      cursor: default;
      opacity: 0.85;
    }

    [data-theme="dark"] .manual-guide-copy-btn {
      background: rgba(15, 23, 42, 0.5);
      border-color: rgba(251, 191, 36, 0.24);
    }

    @media (max-width: 720px) {
      .manual-guide-values {
        grid-template-columns: 1fr;
      }

      .manual-guide-value-main,
      .manual-guide-value-secondary {
        grid-column: auto;
      }
    }

    .prereq-capabilities {
      margin-top: 1rem;
      padding: 1rem 1.125rem;
      border-radius: 12px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-light);
    }

    .prereq-capabilities-title {
      font-size: 0.95rem;
      font-weight: 700;
      margin-bottom: 0.2rem;
      color: var(--text);
    }

    .prereq-capabilities-hint {
      font-size: 0.82rem;
      color: var(--text-muted);
      margin-bottom: 0.85rem;
      line-height: 1.5;
    }

    .prereq-capability-list {
      display: grid;
      gap: 0.65rem;
    }

    .prereq-capability-item {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 0.75rem 0.85rem;
      border-radius: 10px;
      background: var(--card-bg);
      border: 1px solid var(--border-light);
    }

    .prereq-capability-body {
      min-width: 0;
      flex: 1;
    }

    .prereq-capability-name {
      font-size: 0.9rem;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 0.15rem;
      display: flex;
      align-items: center;
      gap: 0.3rem;
    }

    .prereq-capability-desc {
      font-size: 0.82rem;
      line-height: 1.45;
      color: var(--text-muted);
    }

    .prereq-capability-pill {
      flex: 0 0 auto;
      min-width: 52px;
      text-align: center;
      padding: 0.32rem 0.55rem;
      border-radius: 999px;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }

    .prereq-capability-pill.ok {
      background: rgba(5, 150, 105, 0.1);
      color: var(--success);
      border: 1px solid rgba(5, 150, 105, 0.22);
    }

    .prereq-capability-pill.review {
      background: rgba(217, 119, 6, 0.1);
      color: var(--warning);
      border: 1px solid rgba(217, 119, 6, 0.22);
    }

    .prereq-capability-pill.ng {
      background: rgba(220, 38, 38, 0.1);
      color: var(--error);
      border: 1px solid rgba(220, 38, 38, 0.22);
    }

    .prereq-capability-hint {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.1rem;
      height: 1.1rem;
      border-radius: 50%;
      font-size: 0.68rem;
      font-weight: 700;
      line-height: 1;
      cursor: default;
      flex: 0 0 auto;
      background: rgba(120, 120, 120, 0.12);
      color: var(--text-muted);
      border: 1px solid rgba(120, 120, 120, 0.3);
      user-select: none;
    }

    .prereq-capability-hint::before {
      content: attr(data-tip);
      position: absolute;
      top: calc(100% + 0.4rem);
      left: 50%;
      transform: translateX(-50%);
      background: var(--card-bg);
      color: var(--text-muted);
      font-size: 0.78rem;
      font-weight: 400;
      line-height: 1.4;
      white-space: nowrap;
      padding: 0.4rem 0.65rem;
      border-radius: 8px;
      border: 1px solid var(--border-light);
      box-shadow: 0 2px 8px rgba(0,0,0,0.12);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s;
      z-index: 10;
    }

    .prereq-capability-hint:hover::before {
      opacity: 1;
    }

    [data-theme="dark"] .prereq-capability-hint::before {
      background: var(--bg);
      box-shadow: 0 2px 10px rgba(0,0,0,0.4);
    }

    [data-theme="dark"] .prereq-capability-item {
      background: rgba(28, 25, 23, 0.68);
    }

    [data-theme="dark"] .prereq-capability-pill.ok {
      background: rgba(52, 211, 153, 0.12);
      border-color: rgba(52, 211, 153, 0.24);
    }

    [data-theme="dark"] .prereq-capability-pill.review {
      background: rgba(251, 191, 36, 0.14);
      border-color: rgba(251, 191, 36, 0.26);
    }

    [data-theme="dark"] .prereq-capability-pill.ng {
      background: rgba(248, 113, 113, 0.12);
      border-color: rgba(248, 113, 113, 0.24);
    }

    .zone-diagnostic {
      margin-top: 0.9rem;
      margin-bottom: 0;
    }

    .zone-diagnostic-title {
      font-weight: 700;
      margin-bottom: 0.35rem;
      color: inherit;
    }

    .zone-diagnostic-body,
    .zone-diagnostic-next {
      color: inherit;
      opacity: 0.92;
    }

    .zone-diagnostic-next {
      margin-top: 0.45rem;
      white-space: pre-line;
    }

    .zone-diagnostic-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.6rem;
      margin-top: 0.8rem;
    }

    .zone-diagnostic-actions .btn-secondary {
      min-width: 0;
    }

    .domain-check-status {
      margin-top: 0.75rem;
    }

    .keys-saved-box {
      margin-top: 1rem;
      padding: 1rem 1.125rem;
      border-radius: 12px;
      background: linear-gradient(180deg, rgba(37, 99, 235, 0.08), rgba(14, 165, 233, 0.05));
      color: #1e3a8a;
      border: 1px solid rgba(37, 99, 235, 0.22);
    }

    [data-theme="dark"] .keys-saved-box {
      background: linear-gradient(180deg, rgba(30, 64, 175, 0.22), rgba(8, 47, 73, 0.18));
      color: #bfdbfe;
      border-color: rgba(96, 165, 250, 0.3);
    }

    .keys-saved-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }

    .keys-saved-title {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      font-weight: 700;
    }

    .keys-path-row {
      display: flex;
      align-items: stretch;
      gap: 0.5rem;
    }

    .keys-path-code {
      flex: 1;
      min-width: 0;
      display: block;
      padding: 0.75rem 0.875rem;
      border-radius: 8px;
      font-family: var(--font-mono);
      font-size: 0.9rem;
      line-height: 1.4;
      word-break: break-all;
      background: rgba(255, 255, 255, 0.82);
      color: var(--primary);
      border: 1px solid rgba(148, 163, 184, 0.35);
    }

    [data-theme="dark"] .keys-path-code {
      background: rgba(15, 23, 42, 0.82);
      color: #93c5fd;
      border-color: rgba(96, 165, 250, 0.2);
    }

    .keys-copy-btn {
      white-space: nowrap;
      align-self: center;
      min-width: 96px;
    }

    @media (max-width: 640px) {
      .keys-saved-header,
      .keys-path-row {
        flex-direction: column;
        align-items: stretch;
      }

      .keys-copy-btn {
        width: 100%;
      }
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

    function appendTranslatedRichText(parent, key, params = {}) {
      const template = _translations[key] || key;
      const parts = template.split(/(<strong>|<\\/strong>|\\{\\{[a-zA-Z0-9_]+\\}\\})/g);
      const stack = [parent];

      for (const part of parts) {
        if (!part) continue;
        if (part === '<strong>') {
          const strong = document.createElement('strong');
          stack[stack.length - 1].appendChild(strong);
          stack.push(strong);
          continue;
        }
        if (part === '</strong>') {
          if (stack.length > 1) stack.pop();
          continue;
        }

        const placeholderMatch = part.match(/^\\{\\{([a-zA-Z0-9_]+)\\}\\}$/);
        const text = placeholderMatch
          ? String(params[placeholderMatch[1]] ?? '')
          : part;
        stack[stack.length - 1].appendChild(document.createTextNode(text));
      }
    }

${DOMAIN_FORM_BROWSER_SCRIPT}

    function getApiDomainUiCopy() {
      const locale = String(_currentLocale || 'en').toLowerCase();
      const copyByLocale = {
        ja: {
          initialTenantLabel: '最初のテナントID',
          singleTenantLabel: 'テナントID',
          randomTenantButtonLabel: 'ランダムで決める',
          initialTenantHintGeneric:
            '最初に作成するテナント識別子です。1〜63文字で、先頭は小文字の英字、使用できるのは小文字英字・数字・ハイフンです。URLに使わない場合でも内部設定に使います。',
          singleTenantHintGeneric:
            'テナント識別子です。1〜63文字で、先頭は小文字の英字、使用できるのは小文字英字・数字・ハイフンです。URLに使わない場合でも内部設定に使います。',
          initialTenantHintSubdomain: (_tenantName, baseDomain, url) =>
            '最初のテナントは ' + url + ' を使います。',
          primaryTenantLabel: 'URLにテナント名を含めないテナント',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            url + ' で表示するテナントIDです。空欄なら ' + tenantName + ' を使います。',
          multiTenantHintNeedsDomain:
            'カスタムドメインを入力すると、テナントごとのURLを有効にできます。',
          multiTenantHintSingleTenant:
            '今は1つのURLだけを使います。必要になったらテナントごとのURLに切り替えられます。',
          multiTenantHintEnabled: (baseDomain) => baseDomain + ' 配下にテナントごとのURLを作成します。',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            '最初のテナントも ' + url + ' を使います。',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' のURLは ' + url + ' になります。',
          examplesTitle: 'テナントURLの見え方',
          tableHeaderLabel: 'ケース',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => '最初のテナント (' + tenantName + ') のURL',
          rowInitialTenantExplicit: (tenantName) =>
            '最初のテナント名をURLに含める場合 (' + tenantName + ')',
          rowOtherTenant: '他のテナントのURL',
        },
        de: {
          initialTenantLabel: 'ID des ersten Tenants',
          initialTenantHintGeneric:
            'Bezeichner für den ersten Tenant. Er bleibt erhalten, auch wenn die URL keinen Tenant-Teil anzeigt.',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            'Der erste Tenant verwendet ' + url + '.',
          primaryTenantLabel: 'Tenant für die Domain ohne Tenant-Segment',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            'Tenant-ID für ' + url + '. Leer lassen, um ' + tenantName + ' zu verwenden.',
          multiTenantHintNeedsDomain:
            'Geben Sie eine benutzerdefinierte Domain ein, um tenant-spezifische URLs zu aktivieren.',
          multiTenantHintSingleTenant:
            'Derzeit wird nur eine URL verwendet. Sie können später auf tenant-spezifische URLs umstellen.',
          multiTenantHintEnabled: (baseDomain) =>
            'Tenant-spezifische URLs werden unter ' + baseDomain + ' erstellt.',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            'Der erste Tenant verwendet ebenfalls ' + url + '.',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' verwendet ' + url + '.',
          examplesTitle: 'So sehen die Tenant-URLs aus',
          tableHeaderLabel: 'Fall',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => 'URL des ersten Tenants (' + tenantName + ')',
          rowInitialTenantExplicit: (tenantName) =>
            'Erster Tenant, wenn das Tenant-Segment in der URL enthalten ist (' + tenantName + ')',
          rowOtherTenant: 'URL für andere Tenants',
        },
        es: {
          initialTenantLabel: 'ID del primer tenant',
          initialTenantHintGeneric:
            'Identificador del primer tenant que crea. Se conserva incluso si la URL no muestra un segmento de tenant.',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            'El primer tenant usará ' + url + '.',
          primaryTenantLabel: 'Tenant que usa la URL sin nombre de tenant',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            'ID del tenant que se mostrará en ' + url + '. Déjelo vacío para usar ' + tenantName + '.',
          multiTenantHintNeedsDomain:
            'Ingrese un dominio personalizado para habilitar URLs por tenant.',
          multiTenantHintSingleTenant:
            'Por ahora solo se usa una URL. Más tarde puede cambiar a URLs por tenant.',
          multiTenantHintEnabled: (baseDomain) =>
            'Las URLs por tenant se crearán bajo ' + baseDomain + '.',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            'El primer tenant también usará ' + url + '.',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' usará ' + url + '.',
          examplesTitle: 'Cómo se verán las URLs de tenant',
          tableHeaderLabel: 'Caso',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => 'URL del primer tenant (' + tenantName + ')',
          rowInitialTenantExplicit: (tenantName) =>
            'Primer tenant cuando el segmento de tenant se incluye en la URL (' + tenantName + ')',
          rowOtherTenant: 'URL de otros tenants',
        },
        fr: {
          initialTenantLabel: 'ID du premier tenant',
          initialTenantHintGeneric:
            'Identifiant du premier tenant créé. Il est conservé même si l’URL n’affiche pas de segment tenant.',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            'Le premier tenant utilisera ' + url + '.',
          primaryTenantLabel: 'Tenant utilisant l’URL sans segment tenant',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            'ID du tenant servi sur ' + url + '. Laissez vide pour utiliser ' + tenantName + '.',
          multiTenantHintNeedsDomain:
            'Saisissez un domaine personnalisé pour activer des URL par tenant.',
          multiTenantHintSingleTenant:
            'Une seule URL est utilisée pour le moment. Vous pourrez passer plus tard à des URL par tenant.',
          multiTenantHintEnabled: (baseDomain) =>
            'Des URL par tenant seront créées sous ' + baseDomain + '.',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            'Le premier tenant utilisera aussi ' + url + '.',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' utilisera ' + url + '.',
          examplesTitle: 'Apparence des URL de tenant',
          tableHeaderLabel: 'Cas',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => 'URL du premier tenant (' + tenantName + ')',
          rowInitialTenantExplicit: (tenantName) =>
            'Premier tenant lorsque le segment tenant est inclus dans l’URL (' + tenantName + ')',
          rowOtherTenant: 'URL des autres tenants',
        },
        id: {
          initialTenantLabel: 'ID tenant pertama',
          initialTenantHintGeneric:
            'Identifier untuk tenant pertama yang Anda buat. Tetap dipakai walaupun URL tidak menampilkan segmen tenant.',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            'Tenant pertama akan menggunakan ' + url + '.',
          primaryTenantLabel: 'Tenant yang menggunakan URL tanpa nama tenant',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            'ID tenant yang dilayani di ' + url + '. Kosongkan untuk menggunakan ' + tenantName + '.',
          multiTenantHintNeedsDomain:
            'Masukkan domain kustom untuk mengaktifkan URL per tenant.',
          multiTenantHintSingleTenant:
            'Saat ini hanya satu URL yang digunakan. Anda bisa beralih ke URL per tenant nanti.',
          multiTenantHintEnabled: (baseDomain) =>
            'URL per tenant akan dibuat di bawah ' + baseDomain + '.',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            'Tenant pertama juga akan menggunakan ' + url + '.',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' akan menggunakan ' + url + '.',
          examplesTitle: 'Bentuk URL tenant',
          tableHeaderLabel: 'Kasus',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => 'URL tenant pertama (' + tenantName + ')',
          rowInitialTenantExplicit: (tenantName) =>
            'Tenant pertama ketika segmen tenant disertakan di URL (' + tenantName + ')',
          rowOtherTenant: 'URL tenant lain',
        },
        ko: {
          initialTenantLabel: '첫 번째 테넌트 ID',
          initialTenantHintGeneric:
            '처음 생성하는 테넌트의 식별자입니다. URL에 테넌트 세그먼트가 없어도 내부 설정에 사용됩니다.',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            '첫 번째 테넌트는 ' + url + ' 를 사용합니다.',
          primaryTenantLabel: '테넌트 이름 없는 URL을 사용하는 테넌트',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            url + ' 에서 사용할 테넌트 ID입니다. 비워 두면 ' + tenantName + ' 를 사용합니다.',
          multiTenantHintNeedsDomain:
            '테넌트별 URL을 사용하려면 사용자 지정 도메인을 입력하세요.',
          multiTenantHintSingleTenant:
            '현재는 하나의 URL만 사용합니다. 나중에 테넌트별 URL로 전환할 수 있습니다.',
          multiTenantHintEnabled: (baseDomain) => baseDomain + ' 아래에 테넌트별 URL이 생성됩니다.',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            '첫 번째 테넌트도 ' + url + ' 를 사용합니다.',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' 의 URL은 ' + url + ' 입니다.',
          examplesTitle: '테넌트 URL 예시',
          tableHeaderLabel: '구분',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => '첫 번째 테넌트 URL (' + tenantName + ')',
          rowInitialTenantExplicit: (tenantName) =>
            'URL에 테넌트 세그먼트가 포함된 첫 번째 테넌트 (' + tenantName + ')',
          rowOtherTenant: '다른 테넌트 URL',
        },
        pt: {
          initialTenantLabel: 'ID do primeiro tenant',
          initialTenantHintGeneric:
            'Identificador do primeiro tenant que você criar. Ele continua sendo usado mesmo quando a URL não expõe um segmento de tenant.',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            'O primeiro tenant usará ' + url + '.',
          primaryTenantLabel: 'Tenant que usa a URL sem nome de tenant',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            'ID do tenant servido em ' + url + '. Deixe em branco para usar ' + tenantName + '.',
          multiTenantHintNeedsDomain:
            'Digite um domínio personalizado para habilitar URLs por tenant.',
          multiTenantHintSingleTenant:
            'No momento apenas uma URL é usada. Você pode mudar para URLs por tenant depois.',
          multiTenantHintEnabled: (baseDomain) =>
            'URLs por tenant serão criadas sob ' + baseDomain + '.',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            'O primeiro tenant também usará ' + url + '.',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' usará ' + url + '.',
          examplesTitle: 'Como as URLs de tenant ficarão',
          tableHeaderLabel: 'Caso',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => 'URL do primeiro tenant (' + tenantName + ')',
          rowInitialTenantExplicit: (tenantName) =>
            'Primeiro tenant quando o segmento de tenant é incluído na URL (' + tenantName + ')',
          rowOtherTenant: 'URL de outros tenants',
        },
        ru: {
          initialTenantLabel: 'ID первого тенанта',
          initialTenantHintGeneric:
            'Идентификатор первого создаваемого тенанта. Он сохраняется, даже если URL не содержит сегмент тенанта.',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            'Первый тенант будет использовать ' + url + '.',
          primaryTenantLabel: 'Тенант, использующий URL без имени тенанта',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            'ID тенанта для ' + url + '. Оставьте пустым, чтобы использовать ' + tenantName + '.',
          multiTenantHintNeedsDomain:
            'Введите пользовательский домен, чтобы включить URL для отдельных тенантов.',
          multiTenantHintSingleTenant:
            'Сейчас используется только один URL. Позже можно переключиться на URL для отдельных тенантов.',
          multiTenantHintEnabled: (baseDomain) =>
            'URL для отдельных тенантов будут созданы под ' + baseDomain + '.',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            'Первый тенант также будет использовать ' + url + '.',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' будет использовать ' + url + '.',
          examplesTitle: 'Как будут выглядеть URL тенантов',
          tableHeaderLabel: 'Случай',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => 'URL первого тенанта (' + tenantName + ')',
          rowInitialTenantExplicit: (tenantName) =>
            'Первый тенант, когда сегмент тенанта включён в URL (' + tenantName + ')',
          rowOtherTenant: 'URL других тенантов',
        },
        'zh-cn': {
          initialTenantLabel: '第一个租户 ID',
          initialTenantHintGeneric:
            '这是您创建的第一个租户标识。即使 URL 不显示租户段，也会在内部配置中使用。',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            '第一个租户将使用 ' + url + '。',
          primaryTenantLabel: '使用无租户名 URL 的租户',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            url + ' 对应的租户 ID。留空则使用 ' + tenantName + '。',
          multiTenantHintNeedsDomain:
            '输入自定义域名后，才能启用按租户区分的 URL。',
          multiTenantHintSingleTenant:
            '当前只使用一个 URL，之后可以再切换为按租户区分的 URL。',
          multiTenantHintEnabled: (baseDomain) =>
            '将在 ' + baseDomain + ' 下创建按租户区分的 URL。',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            '第一个租户也会使用 ' + url + '。',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' 将使用 ' + url + '。',
          examplesTitle: '租户 URL 的显示方式',
          tableHeaderLabel: '场景',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => '第一个租户的 URL（' + tenantName + '）',
          rowInitialTenantExplicit: (tenantName) =>
            '当 URL 中包含租户段时的第一个租户（' + tenantName + '）',
          rowOtherTenant: '其他租户的 URL',
        },
        'zh-tw': {
          initialTenantLabel: '第一個租戶 ID',
          initialTenantHintGeneric:
            '這是您建立的第一個租戶識別碼。即使 URL 不顯示租戶段，內部設定仍會使用它。',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            '第一個租戶將使用 ' + url + '。',
          primaryTenantLabel: '使用無租戶名稱 URL 的租戶',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            url + ' 對應的租戶 ID。留空則使用 ' + tenantName + '。',
          multiTenantHintNeedsDomain:
            '輸入自訂網域後，才能啟用依租戶區分的 URL。',
          multiTenantHintSingleTenant:
            '目前只使用一個 URL，之後可以再切換成依租戶區分的 URL。',
          multiTenantHintEnabled: (baseDomain) =>
            '將在 ' + baseDomain + ' 下建立依租戶區分的 URL。',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            '第一個租戶也會使用 ' + url + '。',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' 將使用 ' + url + '。',
          examplesTitle: '租戶 URL 的顯示方式',
          tableHeaderLabel: '情境',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => '第一個租戶的 URL（' + tenantName + '）',
          rowInitialTenantExplicit: (tenantName) =>
            '當 URL 包含租戶段時的第一個租戶（' + tenantName + '）',
          rowOtherTenant: '其他租戶的 URL',
        },
        en: {
          initialTenantLabel: 'Initial Tenant ID',
          singleTenantLabel: 'Tenant ID',
          randomTenantButtonLabel: 'Generate Random',
          initialTenantHintGeneric:
            'Identifier for the first tenant you create. Use 1-63 characters, start with a lowercase letter, and use only lowercase letters, digits, and hyphens. It is kept even when the URL does not expose a tenant segment.',
          singleTenantHintGeneric:
            'Tenant identifier. Use 1-63 characters, start with a lowercase letter, and use only lowercase letters, digits, and hyphens. It is kept even when the URL does not expose a tenant segment.',
          initialTenantHintSubdomain: (_tenantName, _baseDomain, url) =>
            'The first tenant will use ' + url + '.',
          primaryTenantLabel: 'Tenant that uses the naked URL',
          primaryTenantHint: (_baseDomain, tenantName, url) =>
            'Tenant ID served at ' + url + '. Leave empty to use ' + tenantName + '.',
          multiTenantHintNeedsDomain:
            'Enter a custom domain to enable tenant-specific URLs.',
          multiTenantHintSingleTenant:
            'Only one URL is used right now. You can switch to tenant-specific URLs later.',
          multiTenantHintEnabled: (baseDomain) =>
            'Tenant-specific URLs will be created under ' + baseDomain + '.',
          nakedDomainHintInclude: (_tenantName, _baseDomain, url) =>
            'The first tenant will also use ' + url + '.',
          nakedDomainHintOmit: (tenantName, _baseDomain, url) =>
            tenantName + ' will use ' + url + '.',
          examplesTitle: 'How tenant URLs will look',
          tableHeaderLabel: 'Case',
          tableHeaderUrl: 'URL',
          rowInitialTenant: (tenantName) => 'First tenant URL (' + tenantName + ')',
          rowInitialTenantExplicit: (tenantName) =>
            'First tenant when the tenant segment is included (' + tenantName + ')',
          rowOtherTenant: 'Other tenant URL',
        },
      };

      const selected =
        copyByLocale[locale] ||
        copyByLocale[locale.split('-')[0]] ||
        copyByLocale.en;

      return selected;
    }

    const PREREQ_CAPABILITY_COPY = ${JSON.stringify(SETUP_CAPABILITY_COPY)};
    const CLOUDFLARE_DNS_RECORDS_DOCS = ${JSON.stringify(CLOUDFLARE_DNS_RECORDS_DOCS_URL)};
    const CLOUDFLARE_DASHBOARD_URL = 'https://dash.cloudflare.com/';

    function getPrereqCapabilityCopy() {
      const locale = String(_currentLocale || 'en');
      return (
        PREREQ_CAPABILITY_COPY[locale] ||
        PREREQ_CAPABILITY_COPY[locale.split('-')[0]] ||
        PREREQ_CAPABILITY_COPY.en
      );
    }

    function renderPrereqCapabilities(container, result) {
      if (!container) return;

      const statuses = result.capabilityStatuses || {};
      const diagnostics = result.capabilityDiagnostics || {};
      const copy = getPrereqCapabilityCopy();
      const wrapper = document.createElement('div');
      wrapper.className = 'prereq-capabilities';

      const title = document.createElement('div');
      title.className = 'prereq-capabilities-title';
      title.textContent = copy.title;
      wrapper.appendChild(title);

      const hint = document.createElement('div');
      hint.className = 'prereq-capabilities-hint';
      hint.textContent = copy.hint;
      wrapper.appendChild(hint);

      const list = document.createElement('div');
      list.className = 'prereq-capability-list';

      function getStatusMeta(status, okDescription, reviewDescription, ngDescription) {
        if (status === 'ok') {
          return { status: 'ok', description: okDescription, badgeLabel: copy.ok };
        }
        if (status === 'review') {
          return { status: 'review', description: reviewDescription, badgeLabel: copy.review };
        }
        return { status: 'ng', description: ngDescription, badgeLabel: copy.ng };
      }

      const items = [
        Object.assign(
          {
          label: copy.workersDeploy,
          },
          getStatusMeta(
            statuses.workersDeploy,
            copy.workersDeployOk,
            copy.workersDeployReview,
            copy.workersDeployNg
          )
        ),
        Object.assign(
          {
          label: copy.customDomain,
          },
          getStatusMeta(
            statuses.customDomain,
            copy.customDomainOk,
            copy.customDomainReviewZoneRead,
            diagnostics.zoneReadAvailable ? copy.customDomainNgNoZone : copy.workersDeployNg
          )
        ),
        Object.assign(
          {
          label: copy.pages,
          },
          getStatusMeta(
            statuses.pages,
            copy.pagesOk,
            copy.pagesReview,
            copy.workersDeployNg
          )
        ),
      ];

      items.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'prereq-capability-item';

        const body = document.createElement('div');
        body.className = 'prereq-capability-body';

        const name = document.createElement('div');
        name.className = 'prereq-capability-name';
        name.textContent = item.label;

        if (item.status === 'ok') {
          const hint = document.createElement('span');
          hint.className = 'prereq-capability-hint';
          hint.textContent = '?';
          hint.setAttribute('data-tip', item.description);
          name.appendChild(hint);
        }

        body.appendChild(name);

        if (item.status !== 'ok') {
          const desc = document.createElement('div');
          desc.className = 'prereq-capability-desc';
          desc.textContent = item.description;
          body.appendChild(desc);
        }

        const right = document.createElement('div');
        right.style.cssText = 'display:flex; align-items:center; gap:0.4rem; flex:0 0 auto;';

        const pill = document.createElement('span');
        pill.className = 'prereq-capability-pill ' + item.status;
        pill.textContent = item.badgeLabel;
        right.appendChild(pill);

        row.appendChild(body);
        row.appendChild(right);
        list.appendChild(row);
      });

      wrapper.appendChild(list);

      if (statuses.customDomain === 'review') {
        wrapper.appendChild(createPrereqCustomDomainReviewAlert());
      }

      container.appendChild(wrapper);
    }

    function createZoneActionButton(action, onRetry) {
      if (action === 'run_wrangler_login' || action === 'check_cloudflare_permissions') {
        return null;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-secondary';

      if (action === 'retry_check') {
        button.textContent = t('domain.action.retryCheck');
        button.addEventListener('click', () => onRetry?.());
        return button;
      }

      if (action === 'reload_page') {
        button.textContent = t('domain.action.reloadPage');
        button.addEventListener('click', () => window.location.reload());
        return button;
      }

      if (action === 'open_cloudflare_dashboard') {
        button.textContent = t('domain.action.openCloudflareDashboard');
        button.addEventListener('click', () =>
          window.open(CLOUDFLARE_DASHBOARD_URL, '_blank', 'noopener,noreferrer')
        );
        return button;
      }

      return null;
    }

    function createZoneDiagnosticAlert(result, params) {
      const diagnostic = result?.diagnostic;
      if (!diagnostic) {
        return null;
      }

      const code = diagnostic.code;
      const alertType =
        diagnostic.severity === 'success'
          ? 'success'
          : diagnostic.severity === 'error'
            ? 'error'
            : 'warning';
      const alert = document.createElement('div');
      alert.className = 'alert alert-' + alertType + ' zone-diagnostic';

      const title = document.createElement('div');
      title.className = 'zone-diagnostic-title';
      title.textContent = t('domain.diagnostic.' + code + '.title', params);
      alert.appendChild(title);

      const body = document.createElement('div');
      body.className = 'zone-diagnostic-body';
      body.textContent = t('domain.diagnostic.' + code + '.body', params);
      alert.appendChild(body);

      const nextText = t('domain.diagnostic.' + code + '.next', params);
      if (nextText && nextText !== 'domain.diagnostic.' + code + '.next') {
        const next = document.createElement('div');
        next.className = 'zone-diagnostic-next';
        next.textContent = nextText;
        alert.appendChild(next);
      }

      const actionButtons = (diagnostic.actions || [])
        .map((action) => createZoneActionButton(action, params.onRetry))
        .filter(Boolean);

      if (actionButtons.length > 0) {
        const actions = document.createElement('div');
        actions.className = 'zone-diagnostic-actions';
        actionButtons.forEach((button) => actions.appendChild(button));
        alert.appendChild(actions);
      }

      return alert;
    }

    function createPrereqCustomDomainReviewAlert() {
      const alert = document.createElement('div');
      alert.className = 'alert alert-warning zone-diagnostic';

      const title = document.createElement('div');
      title.className = 'zone-diagnostic-title';
      title.textContent = t('domain.prereq.reviewTitle');
      alert.appendChild(title);

      const body = document.createElement('div');
      body.className = 'zone-diagnostic-body';
      body.textContent = t('domain.prereq.reviewBody');
      alert.appendChild(body);

      const actions = document.createElement('div');
      actions.className = 'zone-diagnostic-actions';
      const retryButton = createZoneActionButton('retry_check', checkPrerequisites);
      const reloadButton = createZoneActionButton('reload_page');

      if (retryButton) actions.appendChild(retryButton);
      if (reloadButton) actions.appendChild(reloadButton);
      alert.appendChild(actions);

      return alert;
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
      if (typeof window.refreshApiDomainUi === 'function') {
        window.refreshApiDomainUi();
      }
      if (typeof window.renderDeployManualWildcardWarning === 'function') {
        window.renderDeployManualWildcardWarning();
      }
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

    // Initialize translations on page load (must wait for DOM to be ready)
    document.addEventListener('DOMContentLoaded', function() {
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
    });
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

    <!-- Step 1.6: Load Config -->
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
          <div class="standard-component-title">
            🔐 <span data-i18n="web.config.apiRequired">API (required)</span>
          </div>
          <p style="margin: 0.25rem 0 0.5rem 0; font-size: 0.85rem;" data-i18n="web.config.apiDesc">
            OIDC Provider endpoints: authorize, token, userinfo, discovery, management APIs.
          </p>
        </div>

        <!-- Login UI Component -->
        <div class="component-card">
          <label class="checkbox-item" style="margin: 0; padding: 0; border: none; background: transparent;">
            <input type="checkbox" id="comp-login-ui" checked>
            <strong>🖥️ <span data-i18n="web.comp.loginUi">Login UI</span></strong>
          </label>
          <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem;" data-i18n="web.comp.loginUiDesc">
            User-facing login, registration, consent, and account management pages.
          </p>
        </div>

        <!-- Admin UI Component -->
        <div class="component-card">
          <label class="checkbox-item" style="margin: 0; padding: 0; border: none; background: transparent;">
            <input type="checkbox" id="comp-admin-ui" checked>
            <strong>⚙️ <span data-i18n="web.comp.adminUi">Admin UI</span></strong>
          </label>
          <p style="margin: 0.25rem 0 0 0; font-size: 0.85rem;" data-i18n="web.comp.adminUiDesc">
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
        <span id="env-error" style="display: none; color: var(--error); font-size: 0.85rem;" data-i18n="web.form.envNameError">Only lowercase letters, numbers, and hyphens are allowed (must start with a letter)</span>
      </div>

      <!-- 3. Domain Configuration -->
      <!-- 3.1 API / Issuer Domain -->
      <div class="domain-section">
        <h4>🌐 <span data-i18n="web.section.apiDomain">API / Issuer Domain</span></h4>

        <div class="form-group" style="margin-bottom: 0.75rem;">
          <label for="base-domain" data-i18n="web.form.baseDomain">Base Domain (API Domain)</label>
          <input type="text" id="base-domain" placeholder="oidc.example.com" data-i18n-placeholder="web.form.baseDomainPlaceholder">
          <small style="color: var(--text-muted)" data-i18n="web.form.baseDomainHint">Custom domain for Authrim. Leave empty to use workers.dev</small>
          <div id="base-domain-depth-error" class="alert alert-warning" style="display: none; margin-top: 0.5rem;" role="alert"></div>
          <div id="domain-check-row" style="display: none; margin-top: 0.5rem;">
            <button type="button" id="check-domain-btn" class="btn btn-secondary" style="padding: 0.3rem 0.75rem; font-size: 0.85rem;" data-i18n="domain.checkZoneButton">
              Check Zone
            </button>
            <div id="domain-check-status" class="domain-check-status" aria-live="polite"></div>
          </div>
          <label class="checkbox-item" id="custom-domain-binding-row" style="display: none; align-items: center; gap: 0.5rem; margin-top: 0.75rem;">
            <input type="checkbox" id="custom-domain-binding" checked>
            <span data-i18n="domain.configureBinding">Configure custom domain binding for Workers</span>
          </label>
          <label class="checkbox-item" id="multi-tenant-label" style="display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; opacity: 0.5;">
            <input type="checkbox" id="enable-multi-tenant" disabled>
            <span data-i18n="web.form.multiTenantEnable">Enable multi-tenant mode</span>
          </label>
          <small id="multi-tenant-hint" style="color: var(--text-muted); margin-left: 1.5rem;" data-i18n="web.form.multiTenantHint">
            Create tenant subdomains under your custom domain
          </small>
          <label class="checkbox-item" id="naked-domain-label" style="display: none; align-items: center; gap: 0.5rem; margin-top: 0.5rem;">
            <input type="checkbox" id="naked-domain">
            <span data-i18n="web.form.nakedDomain">Exclude tenant name from URL</span>
          </label>
          <small id="naked-domain-hint" style="color: var(--text-muted); margin-left: 1.5rem; display: none;" data-i18n="web.form.nakedDomainHint">
            Use https://example.com instead of https://{tenant}.example.com
          </small>
          <small id="workers-dev-note" style="color: #d97706; margin-left: 1.5rem; display: none;" data-i18n="web.form.nakedDomainWarning">
            ⚠️ Tenant subdomains require a custom domain. Workers.dev does not support wildcard subdomains.
          </small>
          <div id="tenant-url-examples" class="issuer-preview" style="display: none; margin-top: 0.75rem;">
            <div class="label" id="tenant-url-examples-title">How tenant URLs will look</div>
            <table class="issuer-preview-table" aria-live="polite">
              <thead>
                <tr>
                  <th id="tenant-url-examples-header-label">Case</th>
                  <th id="tenant-url-examples-header-url">URL</th>
                </tr>
              </thead>
              <tbody id="tenant-url-examples-body"></tbody>
            </table>
          </div>
        </div>

        <!-- Tenant (hidden when naked domain is checked) -->
        <div id="tenant-fields">
          <div class="form-group" style="margin-bottom: 0.5rem;">
            <label for="tenant-name" id="tenant-id-label">Initial Tenant ID</label>
            <div class="inline-field">
              <input type="text" id="tenant-name" placeholder="default" value="default" data-i18n-placeholder="web.form.tenantIdPlaceholder">
              <button type="button" id="tenant-name-random" class="btn-secondary">Generate Random</button>
            </div>
            <small id="tenant-id-hint" style="color: var(--text-muted)">Identifier for the first tenant you create.</small>
            <small id="tenant-workers-note" style="color: #6b7280; display: none;" data-i18n="web.form.tenantIdWorkerNote">
              (Tenant ID is used internally. URL subdomain requires custom domain.)
            </small>
          </div>
        </div>

        <div class="form-group" style="margin-bottom: 0;">
          <label for="tenant-display" data-i18n="web.form.tenantDisplay">Tenant Display Name</label>
          <input type="text" id="tenant-display" placeholder="My Company" value="" data-i18n-placeholder="web.form.tenantDisplayPlaceholder">
          <small style="color: var(--text-muted)" data-i18n="web.form.tenantDisplayHint">Name shown on login page and consent screen</small>
        </div>

        <!-- Primary Tenant (for naked domain) -->
        <div class="form-group" id="primary-tenant-row" style="margin-bottom: 0.75rem;">
          <label for="primary-tenant" id="primary-tenant-label">Tenant that uses the naked URL</label>
          <input type="text" id="primary-tenant" placeholder="Leave empty to use initial tenant">
          <small id="primary-tenant-hint" style="color: var(--text-muted)">Tenant ID to use when accessing the naked domain. Leave empty to use the first tenant above.</small>
        </div>

        <div class="form-group" style="margin-bottom: 0;">
          <label for="user-id-format" data-i18n="web.form.userIdFormat">User ID Format</label>
          <select id="user-id-format">
            <option value="nanoid" selected data-i18n="web.form.userIdNanoid">NanoID (recommended)</option>
            <option value="uuid" data-i18n="web.form.userIdUuid">UUID v4</option>
          </select>
          <small style="color: var(--text-muted)" data-i18n="web.form.userIdFormatHint">Format for generating user IDs. Cannot be changed after users are created.</small>
        </div>
      </div>

      <!-- 3.2 UI Domains -->
      <div class="domain-section" id="ui-domains-section">
        <h4>🖥️ <span data-i18n="web.section.uiDomains">UI Domains (Optional)</span></h4>
        <div class="section-hint" data-i18n="web.section.uiDomainsHint">
          Custom domains for Login/Admin UIs. Each can be set independently.
          Leave empty to use the UI Worker default.
        </div>

        <div class="domain-row" id="login-domain-row">
          <span class="domain-label" data-i18n="web.domain.loginUi">Login UI</span>
          <div class="domain-input-wrapper">
            <input type="text" id="login-domain" placeholder="login.example.com" data-i18n-placeholder="web.form.loginDomainPlaceholder">
            <span class="domain-default" id="login-default">{env}-ar-login-ui.workers.dev</span>
          </div>
          <div id="login-domain-depth-error" class="alert alert-warning" style="display: none; margin-top: 0.5rem;" role="alert"></div>
          <div id="login-domain-zone-status" class="domain-check-status" style="margin-top: 0.5rem;" aria-live="polite"></div>
        </div>

        <div class="domain-row" id="admin-domain-row">
          <span class="domain-label" data-i18n="web.domain.adminUi">Admin UI</span>
          <div class="domain-input-wrapper">
            <input type="text" id="admin-domain" placeholder="admin.example.com" data-i18n-placeholder="web.form.adminDomainPlaceholder">
            <span class="domain-default" id="admin-default">{env}-ar-admin-ui.workers.dev</span>
          </div>
          <div id="admin-domain-depth-error" class="alert alert-warning" style="display: none; margin-top: 0.5rem;" role="alert"></div>
          <div id="admin-domain-zone-status" class="domain-check-status" style="margin-top: 0.5rem;" aria-live="polite"></div>
        </div>

        <div class="section-hint hint-box" style="margin-top: 0.75rem;" data-i18n="web.section.corsHint">
          💡 CORS: Cross-origin requests from Login/Admin UI to API are automatically allowed.
        </div>
      </div>

      <!-- 4. Preview Section (at the bottom) -->
      <div class="infra-section" id="config-preview">
        <h4>📋 <span data-i18n="web.section.configPreview">Configuration Preview</span></h4>

        <!-- Common row (always visible) -->
        <div class="infra-item">
          <span class="infra-label" data-i18n="web.preview.components">Components:</span>
          <span class="infra-value preview-component-list" id="preview-components">
            <span class="preview-component-badge">API</span>
            <span class="preview-component-badge">Login UI</span>
            <span class="preview-component-badge">Admin UI</span>
          </span>
        </div>

        <!-- Single-tenant Issuer row (shown only when multi-tenant=off) -->
        <div class="infra-item" id="preview-issuer-row">
          <span class="infra-label" data-i18n="web.preview.issuerUrl">Issuer URL:</span>
          <span class="infra-value" id="preview-issuer">https://{tenant}.{base-domain}</span>
        </div>

        <!-- Multi-tenant expansion preview (shown only when multi-tenant=on) -->
        <div id="preview-multi-tenant-section" style="display:none;">
          <!-- Tenant cards (rendered by JS) -->
          <div id="preview-mt-rows" aria-live="polite"></div>

          <!-- Login UI deployment origin -->
          <div class="infra-item" id="preview-login-pages-row" style="margin-top: 0.25rem;">
            <span class="infra-label" data-i18n="web.preview.pagesUrl">Login UI Origin:</span>
            <span class="infra-value" id="preview-login-pages">{env}-ar-login-ui.workers.dev</span>
          </div>

          <!-- Tenant selection common entry -->
          <div class="infra-item" id="preview-tenant-discover-row" style="margin-top: 0.25rem;">
            <span class="infra-label" data-i18n="web.preview.tenantDiscover">Tenant Selection (Common Entry):</span>
            <span class="infra-value" id="preview-tenant-discover">{env}-ar-login-ui.workers.dev/discover</span>
          </div>

          <!-- Admin UI access target -->
          <div class="infra-item" id="preview-admin-access-row">
            <span class="infra-label" data-i18n="web.preview.adminAccess">Admin UI Access:</span>
            <span class="infra-value" id="preview-admin-access">https://{env}-ar-admin-ui.workers.dev/admin</span>
          </div>

          <!-- Invalid-configuration warning (shown only when the condition matches) -->
          <div id="preview-config-warning" class="hint-box error-hint" style="display:none; margin-top:0.75rem;" role="alert">
            <strong id="preview-warning-title" data-i18n="web.preview.conflictWarningTitle">⚠️ Configuration issue</strong>
            <div id="preview-warning-message" style="margin-top: 0.25rem;"></div>
            <div id="preview-warning-action" style="margin-top: 0.5rem; font-weight: 600;"></div>
          </div>
        </div>

        <!-- Single-tenant Login UI / Admin UI row (shown only when multi-tenant=off) -->
        <div class="infra-item" id="preview-login-row">
          <span class="infra-label" data-i18n="web.preview.loginUi">Login UI:</span>
          <span class="infra-value" id="preview-login">{env}-ar-login-ui.workers.dev</span>
        </div>
        <div class="infra-item" id="preview-admin-row">
          <span class="infra-label" data-i18n="web.preview.adminUi">Admin UI:</span>
          <span class="infra-value" id="preview-admin">{env}-ar-admin-ui.workers.dev</span>
        </div>
        <div class="infra-item" id="preview-admin-api-mode-row">
          <span class="infra-label">Admin UI API mode:</span>
          <span class="infra-value" id="preview-admin-api-mode">cross-site-proxy</span>
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

      <div class="database-card" style="margin-bottom: 1rem;">
        <h3 data-i18n="web.db.storageProfileTitle">Storage Deployment Profile</h3>
        <div class="db-description">
          <p data-i18n="web.db.storageProfileDesc">Select how user core/PII data is placed for this deployment.</p>
        </div>
        <div class="radio-group">
          <label class="radio-item">
            <input type="radio" name="storage-profile" value="builtin:storage:shared-d1" checked>
            <span style="display: flex; flex-direction: column; gap: 0.25rem;">
              <strong data-i18n="web.db.sharedD1Title">Shared D1</strong>
              <small style="color: var(--text-muted);" data-i18n="web.db.sharedD1Desc">One deployment-wide core D1 and PII D1. Lowest setup cost and the default path.</small>
            </span>
          </label>
          <label class="radio-item">
            <input type="radio" name="storage-profile" value="builtin:storage:tenant-d1">
            <span style="display: flex; flex-direction: column; gap: 0.25rem;">
              <strong data-i18n="web.db.tenantD1Title">Tenant D1</strong>
              <small style="color: var(--text-muted);" data-i18n="web.db.tenantD1Desc">One core/PII D1 pair per tenant. Requires tenant database provisioning before tenant activation.</small>
            </span>
          </label>
        </div>
        <div id="tenant-d1-slot-config" class="tenant-d1-slot-config" style="margin-top: 1rem; display: none;">
          <h3 data-i18n="web.db.preallocatedSlotsTitle">Preallocated tenant slots</h3>
          <div class="db-description">
            <p data-i18n="web.db.preallocatedSlotsDesc">Each tenant slot creates two D1 databases: core and PII.</p>
          </div>
          <label for="tenant-d1-preallocated-slots" style="display: flex; align-items: center; justify-content: space-between; gap: 1rem;">
            <span data-i18n="web.db.slotsLabel">Slots</span>
            <strong id="tenant-d1-preallocated-slots-value">3</strong>
          </label>
          <input id="tenant-d1-preallocated-slots" type="range" min="1" max="500" step="1" value="3" style="width: 100%;">
          <small style="color: var(--text-muted);" data-i18n="web.db.slotsHelp">Default is 3. Maximum is 500 slots.</small>
        </div>
      </div>

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

    <!-- Step 4: Optional Features and Email Provider Configuration -->
    <div id="section-email" class="card hidden">
      <h2 class="card-title" data-i18n="features.title">Feature Flags</h2>

      <div class="component-card" style="margin-bottom: 1.5rem;">
        <label class="checkbox-item" style="margin: 0; padding: 0; border: none; background: transparent;">
          <input type="checkbox" id="feature-queue-enabled">
          <strong>Cloudflare Queues</strong>
        </label>
        <p style="margin: 0.25rem 0 0.5rem 0; font-size: 0.85rem; color: var(--text-muted);">
          Optional queue-backed delivery for async audit fan-out and logging operations. Disabled by default.
        </p>
        <div class="hint-box" style="margin-top: 0.75rem;">
          Workers Free can use Queues, but the practical allowance is about 3,000 delivered messages/day.
          Authrim typically uses one queued message for an async audit fan-out item, a logging delivery retry,
          an export build job, or a key rewrap retry job. Each delivered message usually consumes write, read,
          and delete operations; retries consume more.
        </div>
      </div>

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
	          <input type="radio" name="email-setup-choice" value="cloudflare">
	          <span style="display: flex; flex-direction: column; gap: 0.25rem;">
	            <strong data-i18n="web.email.configureCloudflare">Configure Cloudflare Email Service</strong>
	            <small style="color: var(--text-muted);" data-i18n="web.email.configureCloudflareHint">Use the native Workers Email Service binding. Requires a Workers Paid plan and Cloudflare DNS.</small>
	          </span>
	        </label>
        <label class="radio-item" style="padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px; margin-top: 0.5rem;">
          <input type="radio" name="email-setup-choice" value="resend">
          <span style="display: flex; flex-direction: column; gap: 0.25rem;">
            <strong data-i18n="web.email.configureResend">Configure Resend</strong>
            <small style="color: var(--text-muted);" data-i18n="web.email.configureResendHint">Set up email sending with Resend (recommended for production).</small>
          </span>
        </label>
      </div>

	      <!-- Cloudflare Configuration Form (hidden by default) -->
	      <div id="cloudflare-config-form" class="hidden" style="background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem;">
	        <h3 style="margin: 0 0 1rem 0; font-size: 1rem;">☁️ <span data-i18n="web.email.cloudflareSetup">Cloudflare Email Service</span></h3>

	        <div class="alert alert-warning" style="margin-bottom: 1rem;">
	          <strong data-i18n="web.email.cloudflareRequirements">Requirements</strong>
	          <ul style="margin: 0.5rem 0 0 1rem; padding: 0;">
	            <li data-i18n="web.email.cloudflareRequirementPaid">Workers Paid Plan is required</li>
	            <li data-i18n="web.email.cloudflareRequirementDns">Cloudflare DNS/domain onboarding is required</li>
	            <li data-i18n="web.email.cloudflareRequirementManual">Domain setup in the Cloudflare dashboard is still manual</li>
	          </ul>
	        </div>

	        <div class="form-group">
	          <label for="cloudflare-from-address" data-i18n="web.email.fromEmailAddress">From Email Address</label>
	          <input type="email" id="cloudflare-from-address" placeholder="noreply@yourdomain.com" autocomplete="off">
	          <small style="color: var(--text-muted);" data-i18n="web.email.cloudflareFromHint">Must be from a domain onboarded to Cloudflare Email Service</small>
	        </div>

	        <div class="form-group">
	          <label for="cloudflare-from-name" data-i18n="web.email.fromDisplayName">From Display Name (optional)</label>
	          <input type="text" id="cloudflare-from-name" placeholder="Authrim" autocomplete="off">
	          <small style="color: var(--text-muted);" data-i18n="web.email.fromDisplayHint">Displayed as the sender name in email clients</small>
	        </div>
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
          <div class="resource-category" id="preview-queues-category">
            <strong>Queues:</strong>
            <ul id="preview-queues"></ul>
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
        <div class="progress-log-actions">
          <button type="button" class="btn-secondary progress-log-copy-btn" id="provision-log-copy-btn">
            <span data-copy-label data-i18n="web.envDetail.copyBtn">Copy</span>
          </button>
        </div>
        <pre id="provision-output"></pre>
      </div>

      <!-- Keys saved location (shown after completion) -->
      <div id="keys-saved-info" class="keys-saved-box hidden">
        <div class="keys-saved-header">
          <strong class="keys-saved-title">🔑 <span data-i18n="web.provision.keysSavedTo">Keys saved to:</span></strong>
          <button type="button" class="btn-secondary keys-copy-btn" id="keys-copy-btn">
            <span data-copy-label data-i18n="web.envDetail.copyBtn">Copy</span>
          </button>
        </div>
        <div class="keys-path-row">
          <code class="keys-path-code" id="keys-path"></code>
        </div>
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
      <div id="deploy-manual-wildcard-warning" class="alert alert-warning manual-wildcard-warning hidden" style="margin-bottom: 1rem;">
        <strong id="deploy-manual-wildcard-title"></strong>
        <p id="deploy-manual-wildcard-summary" style="margin-top: 0.5rem;"></p>
        <p id="deploy-manual-wildcard-timing" class="manual-guide-timing"></p>
        <div id="deploy-manual-wildcard-steps" class="manual-guide-steps"></div>
        <div class="manual-guide-visual">
          <img
            id="deploy-manual-wildcard-example-image"
            alt="Cloudflare DNS Add record example"
            src=${cloudflareDnsAddRecordImageDataUriJson}
          >
        </div>
        <p id="deploy-manual-wildcard-retry" class="manual-guide-retry" style="margin-top: 0.75rem;"></p>
        <div class="button-group" style="margin-top: 0.75rem;">
          <a id="deploy-manual-wildcard-dashboard-link" class="btn-secondary hidden" target="_blank" rel="noreferrer">Open Cloudflare DNS</a>
          <a id="deploy-manual-wildcard-docs-link" class="btn-secondary" target="_blank" rel="noreferrer">Open DNS docs</a>
        </div>
      </div>

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
        <div class="progress-log-actions">
          <button type="button" class="btn-secondary progress-log-copy-btn" id="deploy-log-copy-btn">
            <span data-copy-label data-i18n="web.envDetail.copyBtn">Copy</span>
          </button>
        </div>
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

      <div class="resource-section" style="margin-bottom: 1.5rem;">
        <div class="resource-section-title">
          🔗 URLs
        </div>
        <div id="detail-url-list" class="resource-list">
          <div style="color: var(--text-muted); padding: 0.75rem 0;" data-i18n="web.status.loading">Loading...</div>
        </div>
      </div>

      <div class="resource-section" id="env-email-section" style="margin-bottom: 1.5rem;">
        <div class="resource-section-title">
          📧 <span data-i18n="web.envDetail.emailSettings">Email Settings</span>
        </div>
        <p style="margin: 0.75rem 0; color: var(--text-muted); font-size: 0.9rem;" data-i18n="web.envDetail.emailDesc">
          Enable Cloudflare Email Service later for this environment. This updates .authrim, regenerates wrangler bindings, uploads email secrets, and redeploys ar-auth and ar-management.
        </p>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.75rem; margin-top: 1rem;">
          <div style="padding: 0.9rem; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;">
            <div style="font-size: 0.8rem; color: var(--text-muted);" data-i18n="web.envDetail.emailCurrentProvider">Current Provider</div>
            <div id="env-email-provider" style="margin-top: 0.35rem; font-weight: 600;">-</div>
          </div>
          <div style="padding: 0.9rem; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;">
            <div style="font-size: 0.8rem; color: var(--text-muted);" data-i18n="web.envDetail.emailCurrentStatus">Status</div>
            <div id="env-email-status" style="margin-top: 0.35rem; font-weight: 600;">-</div>
          </div>
          <div style="padding: 0.9rem; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;">
            <div style="font-size: 0.8rem; color: var(--text-muted);" data-i18n="web.envDetail.emailCurrentFrom">From Address</div>
            <div id="env-email-from" style="margin-top: 0.35rem; font-weight: 600; word-break: break-word;">-</div>
          </div>
        </div>

        <div class="alert alert-warning" style="margin-top: 1rem;">
          <strong data-i18n="web.envDetail.emailCloudflareRequirements">Requirements</strong>
          <ul style="margin: 0.5rem 0 0 1.25rem;">
            <li data-i18n="web.envDetail.emailCloudflareRequirementPaid">Workers Paid Plan is required</li>
            <li data-i18n="web.envDetail.emailCloudflareRequirementDns">Cloudflare DNS/domain onboarding is required</li>
            <li data-i18n="web.envDetail.emailCloudflareRequirementManual">Domain setup in the Cloudflare dashboard is still manual</li>
          </ul>
        </div>

        <div style="margin-top: 1rem; display: grid; gap: 1rem;">
          <div>
            <label for="env-email-from-address" style="display: block; margin-bottom: 0.5rem; font-weight: 600;" data-i18n="web.envDetail.emailFromAddress">From Email Address</label>
            <input type="email" id="env-email-from-address" placeholder="noreply@yourdomain.com" autocomplete="off">
            <div style="margin-top: 0.35rem; font-size: 0.8rem; color: var(--text-muted);" data-i18n="web.envDetail.emailCloudflareFromHint">
              Must be from a domain onboarded to Cloudflare Email Service.
            </div>
          </div>
          <div>
            <label for="env-email-from-name" style="display: block; margin-bottom: 0.5rem; font-weight: 600;" data-i18n="web.envDetail.emailFromName">From Display Name (optional)</label>
            <input type="text" id="env-email-from-name" placeholder="Authrim" autocomplete="off">
          </div>
        </div>

        <div style="margin-top: 1rem; display: flex; gap: 0.75rem; flex-wrap: wrap;">
          <button class="btn-primary" id="btn-enable-cloudflare-email">
            ☁️ <span data-i18n="web.envDetail.emailEnableCloudflare">Enable Cloudflare Email Service</span>
          </button>
        </div>

        <div id="env-email-progress" class="hidden" style="margin-top: 1rem;">
          <div style="font-weight: 500; margin-bottom: 0.5rem;" data-i18n="web.envDetail.emailProgress">Email Setup Progress:</div>
          <div id="env-email-log" class="progress-log" style="max-height: 240px; overflow-y: auto; background: var(--bg); padding: 0.75rem; border-radius: 6px; font-family: var(--font-mono); font-size: 0.8rem; line-height: 1.5;"></div>
        </div>
      </div>

      <div class="resource-section" id="env-tenant-d1-section" style="margin-bottom: 1.5rem;">
        <div class="resource-section-title">
          🧩 Tenant D1 Pool
        </div>
        <p id="env-tenant-d1-summary" style="margin: 0.75rem 0; color: var(--text-muted); font-size: 0.9rem;">
          Loading tenant storage status...
        </p>

        <div id="env-tenant-d1-stats" class="hidden" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.75rem; margin-top: 1rem;">
          <div style="padding: 0.9rem; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;">
            <div style="font-size: 0.8rem; color: var(--text-muted);">Capacity</div>
            <div id="env-tenant-d1-capacity" style="margin-top: 0.35rem; font-weight: 600;">-</div>
          </div>
          <div style="padding: 0.9rem; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;">
            <div style="font-size: 0.8rem; color: var(--text-muted);">Available</div>
            <div id="env-tenant-d1-available" style="margin-top: 0.35rem; font-weight: 600;">-</div>
          </div>
          <div style="padding: 0.9rem; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;">
            <div style="font-size: 0.8rem; color: var(--text-muted);">Assigned</div>
            <div id="env-tenant-d1-assigned" style="margin-top: 0.35rem; font-weight: 600;">-</div>
          </div>
          <div style="padding: 0.9rem; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;">
            <div style="font-size: 0.8rem; color: var(--text-muted);">Needs Reset</div>
            <div id="env-tenant-d1-reset-required" style="margin-top: 0.35rem; font-weight: 600;">-</div>
          </div>
        </div>

        <div id="env-tenant-d1-expand" class="hidden" style="margin-top: 1rem; display: grid; gap: 0.75rem;">
          <label for="env-tenant-d1-add-slots" style="display: block; font-weight: 600;">Add Tenant D1 Slots</label>
          <div style="display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center;">
            <input id="env-tenant-d1-add-slots" type="number" min="1" max="500" value="1" style="max-width: 140px;">
            <button class="btn-primary" id="btn-expand-tenant-d1-pool">
              ➕ Expand Pool and Deploy
            </button>
            <button class="btn-secondary" id="btn-refresh-tenant-d1-pool">
              🔄 Refresh
            </button>
          </div>
          <div style="font-size: 0.8rem; color: var(--text-muted);">
            This updates the environment config, creates additional core/PII D1 databases, refreshes Worker bindings, and redeploys workers.
          </div>
        </div>

      <div id="env-tenant-d1-progress" class="hidden" style="margin-top: 1rem;">
          <div style="font-weight: 500; margin-bottom: 0.5rem;">Tenant D1 Pool Progress:</div>
          <div id="env-tenant-d1-log" class="progress-log" style="max-height: 260px; overflow-y: auto; background: var(--bg); padding: 0.75rem; border-radius: 6px; font-family: var(--font-mono); font-size: 0.8rem; line-height: 1.5;"></div>
        </div>
      </div>

      <div class="resource-section" id="env-r2-provision-section" style="margin-bottom: 1.5rem;">
        <div class="resource-section-title">
          📁 Dedicated R2 Buckets
        </div>
        <p id="env-r2-provision-summary" style="margin: 0.75rem 0; color: var(--text-muted); font-size: 0.9rem;">
          Loading R2 bucket status...
        </p>

        <div id="env-r2-provision-actions" style="margin-top: 1rem; display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center;">
          <button class="btn-primary" id="btn-provision-r2-buckets">
            📁 Provision R2 and Deploy
          </button>
          <button class="btn-secondary" id="btn-refresh-r2-buckets">
            🔄 Refresh
          </button>
        </div>

        <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.75rem;">
          This creates Authrim R2 buckets, records lock bindings, enables the R2 feature flag, and redeploys workers.
        </div>

        <div id="env-r2-provision-progress" class="hidden" style="margin-top: 1rem;">
          <div style="font-weight: 500; margin-bottom: 0.5rem;">R2 Provisioning Progress:</div>
          <div id="env-r2-provision-log" class="progress-log" style="max-height: 240px; overflow-y: auto; background: var(--bg); padding: 0.75rem; border-radius: 6px; font-family: var(--font-mono); font-size: 0.8rem; line-height: 1.5;"></div>
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
            🔄 <span data-i18n="web.envDetail.workerUpdate">Update All Workers</span>
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
                  <th style="text-align: center; padding: 0.5rem;" data-i18n="web.envDetail.action">Action</th>
                </tr>
              </thead>
              <tbody id="worker-version-tbody">
                <tr><td colspan="5" style="text-align: center; padding: 1rem; color: var(--text-muted);" data-i18n="web.status.loading">Loading...</td></tr>
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
              🚀 <span data-i18n="web.envDetail.updateAllWorkers">Update All Workers</span>
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

        <!-- UI Update Section (Admin UI, Login UI) -->
        <div class="resource-section" id="ui-update-section" style="margin-top: 1.5rem; border-top: 1px solid var(--border); padding-top: 1.5rem;">
          <div class="resource-section-title">
            📱 <span data-i18n="web.envDetail.uiUpdate">Update UI (Workers)</span>
          </div>
          <p style="margin: 0.75rem 0; color: var(--text-muted); font-size: 0.9rem;" data-i18n="web.envDetail.uiUpdateDesc">
            Update Admin UI or Login UI individually. These are deployed to Cloudflare Workers.
          </p>

          <!-- UI Components -->
          <div id="ui-components-list" style="margin-top: 1rem; display: flex; flex-direction: column; gap: 0.75rem;">
            <!-- Admin UI -->
            <div class="ui-component-card" style="display: flex; justify-content: space-between; align-items: center; padding: 1rem; background: var(--bg); border-radius: 8px; border: 1px solid var(--border);">
              <div>
                <div style="font-weight: 600;">🖥️ Admin UI</div>
                <div style="font-size: 0.85rem; color: var(--text-muted);">ar-admin-ui • Cloudflare Worker</div>
              </div>
              <button class="btn-primary btn-sm" id="btn-update-admin-ui" style="padding: 0.5rem 1rem; font-size: 0.85rem;">
                🚀 <span data-i18n="web.envDetail.updateNow">Update</span>
              </button>
            </div>

            <!-- Login UI -->
            <div class="ui-component-card" style="display: flex; justify-content: space-between; align-items: center; padding: 1rem; background: var(--bg); border-radius: 8px; border: 1px solid var(--border);">
              <div>
                <div style="font-weight: 600;">🔐 Login UI</div>
                <div style="font-size: 0.85rem; color: var(--text-muted);">ar-login-ui • Cloudflare Worker</div>
              </div>
              <button class="btn-primary btn-sm" id="btn-update-login-ui" style="padding: 0.5rem 1rem; font-size: 0.85rem;">
                🚀 <span data-i18n="web.envDetail.updateNow">Update</span>
              </button>
            </div>
          </div>

          <!-- UI Update Progress -->
          <div id="ui-update-progress" class="hidden" style="margin-top: 1rem;">
            <div style="font-weight: 500; margin-bottom: 0.5rem;" data-i18n="web.envDetail.updateProgress">Update Progress:</div>
            <div id="ui-update-log" class="progress-log" style="max-height: 200px; overflow-y: auto; background: var(--bg); padding: 0.75rem; border-radius: 6px; font-family: var(--font-mono); font-size: 0.8rem; line-height: 1.5;"></div>
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

        <!-- Legacy Pages Projects -->
        <div class="resource-section" id="detail-pages-section">
          <div class="resource-section-title">
            📄 <span data-i18n="web.envDetail.pagesProjects">Legacy Pages Projects</span> <span class="count" id="detail-pages-count">(0)</span>
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
              <strong data-i18n="web.delete.pagesProjects">Legacy Pages Projects</strong>
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
        <div class="progress-log-actions">
          <button type="button" class="btn-secondary progress-log-copy-btn" id="delete-log-copy-btn">
            <span data-copy-label data-i18n="web.envDetail.copyBtn">Copy</span>
          </button>
        </div>
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
    let config = {};
    let loadedConfig = null;
    let provisioningCompleted = false;
    let provisionPollInterval = null;
    let lastPrerequisitesResult = null;

    function normalizeStorageProfileId(value) {
      return value === 'builtin:storage:tenant-d1'
        ? 'builtin:storage:tenant-d1'
        : 'builtin:storage:shared-d1';
    }

    function buildProfilesConfig(storageProfileId) {
      return {
        defaults: {
          storage: normalizeStorageProfileId(storageProfileId),
          audit: 'builtin:audit:standard',
          residency: 'builtin:residency:default',
        },
        registry: {
          backend: 'kv',
        },
        references: {
          hyperdrive: {},
        },
        seed: {
          storage: [],
          audit: [],
          residency: [],
        },
      };
    }

    function getSelectedStorageProfileId() {
      return normalizeStorageProfileId(
        document.querySelector('input[name="storage-profile"]:checked')?.value
      );
    }

    function getTenantD1PreallocatedSlots() {
      const value = Number.parseInt(
        document.getElementById('tenant-d1-preallocated-slots')?.value || '3',
        10
      );
      return Number.isInteger(value) ? Math.min(500, Math.max(1, value)) : 3;
    }

    function setTenantD1PreallocatedSlots(value) {
      const normalized = Math.min(500, Math.max(1, Number.parseInt(value || '3', 10) || 3));
      const input = document.getElementById('tenant-d1-preallocated-slots');
      const label = document.getElementById('tenant-d1-preallocated-slots-value');
      if (input) input.value = String(normalized);
      if (label) label.textContent = String(normalized);
    }

    function updateTenantD1SlotConfigVisibility() {
      const visible = getSelectedStorageProfileId() === 'builtin:storage:tenant-d1';
      const panel = document.getElementById('tenant-d1-slot-config');
      if (panel) panel.style.display = visible ? 'block' : 'none';
    }

    function setSelectedStorageProfileId(profileId) {
      const normalized = normalizeStorageProfileId(profileId);
      document.querySelectorAll('input[name="storage-profile"]').forEach((input) => {
        input.checked = input.value === normalized;
      });
      updateTenantD1SlotConfigVisibility();
    }

    document.querySelectorAll('input[name="storage-profile"]').forEach((input) => {
      input.addEventListener('change', updateTenantD1SlotConfigVisibility);
    });
    document.getElementById('tenant-d1-preallocated-slots')?.addEventListener('input', (event) => {
      setTenantD1PreallocatedSlots(event.currentTarget.value);
    });

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
    let selectedEnvDetailConfig = null;
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

    const WILDCARD_DNS_MANUAL_COPY_DATA = ${wildcardDnsManualCopyJson};

    function getWildcardDnsManualCopy() {
      const locale = String(_currentLocale || 'en');
      return (
        WILDCARD_DNS_MANUAL_COPY_DATA[locale] ||
        WILDCARD_DNS_MANUAL_COPY_DATA[locale.split('-')[0]] ||
        WILDCARD_DNS_MANUAL_COPY_DATA.en
      );
    }

    function buildWildcardDnsManualMessage(baseDomain, includeConfirmSuffix = false) {
      const copy = getWildcardDnsManualCopy();
      const recordName = '*.' + baseDomain;
      const zoneName = getManualWildcardDnsZoneName(baseDomain);
      const dashboardRecordName = getManualWildcardDnsRecordName(baseDomain, zoneName);
      const summary = copy.summaryTemplate.replaceAll('{baseDomain}', baseDomain);
      const steps = copy.stepsTemplate.map((step) =>
        step
          .replaceAll('*.{baseDomain}', recordName)
          .replaceAll('{baseDomain}', baseDomain)
          .replaceAll('{zoneName}', zoneName)
          .replaceAll('{dashboardRecordName}', dashboardRecordName)
      );
      const lines = [
        copy.title,
        copy.timing,
        '',
        ...steps.map((step, index) => (index + 1) + '. ' + step),
        '',
        copy.retryHint,
        copy.continueHint,
      ];

      if (summary) {
        lines.splice(1, 0, summary);
      }

      if (includeConfirmSuffix) {
        lines.push('', copy.confirmSuffix);
      }

      return lines.join('\\n');
    }

    function getManualWildcardDnsBaseDomain() {
      return config?.tenant?.multiTenant === true ? config.tenant.baseDomain : '';
    }

    function getManualWildcardDnsZoneName(domain) {
      const normalized = String(domain || '').trim().toLowerCase();
      if (!normalized) return '';
      const parts = normalized.split('.').filter(Boolean);
      const twoPartTlds = new Set([
        'co.uk',
        'org.uk',
        'gov.uk',
        'ac.uk',
        'co.jp',
        'or.jp',
        'ne.jp',
        'co.nz',
        'org.nz',
        'net.nz',
        'co.kr',
        'or.kr',
        'ne.kr',
        'co.in',
        'firm.in',
        'net.in',
        'org.in',
        'gen.in',
        'co.id',
        'web.id',
        'ac.id',
        'or.id',
        'co.za',
        'org.za',
        'net.za',
        'com.au',
        'net.au',
        'org.au',
        'com.br',
        'net.br',
        'org.br',
      ]);
      const lastTwo = parts.slice(-2).join('.');
      if (twoPartTlds.has(lastTwo) && parts.length >= 3) {
        return parts.slice(-3).join('.');
      }
      return parts.length >= 2 ? parts.slice(-2).join('.') : normalized;
    }

    function getManualWildcardDnsRecordName(baseDomain, zoneName) {
      if (baseDomain === zoneName) {
        return '*';
      }

      const suffix = '.' + zoneName;
      if (baseDomain.endsWith(suffix)) {
        return '*.' + baseDomain.slice(0, -suffix.length);
      }

      return '*.' + baseDomain;
    }

    function getManualWildcardDnsDashboardUrl() {
      const accountId = lastPrerequisitesResult?.auth?.accountId || null;
      const baseDomain = getManualWildcardDnsBaseDomain();
      return ${getCloudflareDnsRecordsDashboardUrl.toString()}(accountId, baseDomain);
    }

    function shouldPromptManualWildcardDnsBeforeDeploy() {
      const baseDomain = getManualWildcardDnsBaseDomain();
      const status = lastPrerequisitesResult?.capabilityStatuses?.multiTenant;
      return !!baseDomain && status && status !== 'ok';
    }

    function renderDeployManualWildcardWarning() {
      const warning = document.getElementById('deploy-manual-wildcard-warning');
      const baseDomain = getManualWildcardDnsBaseDomain();

      if (!shouldPromptManualWildcardDnsBeforeDeploy()) {
        warning.classList.add('hidden');
        return;
      }

      const copy = getWildcardDnsManualCopy();
      const recordName = '*.' + baseDomain;
      const zoneName = getManualWildcardDnsZoneName(baseDomain);
      const dashboardRecordName = getManualWildcardDnsRecordName(baseDomain, zoneName);
      const dashboardUrl = getManualWildcardDnsDashboardUrl();
      const summary = copy.summaryTemplate.replaceAll('{baseDomain}', baseDomain);
      const stepsTemplate = copy.stepsTemplate.map((step) =>
        step
          .replaceAll('*.{baseDomain}', recordName)
          .replaceAll('{baseDomain}', baseDomain)
          .replaceAll('{zoneName}', zoneName)
          .replaceAll('{dashboardRecordName}', dashboardRecordName)
      );

      document.getElementById('deploy-manual-wildcard-title').textContent = copy.title;
      const summaryEl = document.getElementById('deploy-manual-wildcard-summary');
      summaryEl.textContent = summary;
      summaryEl.style.display = summary ? '' : 'none';
      document.getElementById('deploy-manual-wildcard-timing').textContent = copy.timing;
      document.getElementById('deploy-manual-wildcard-retry').textContent = copy.retryHint;

      const steps = document.getElementById('deploy-manual-wildcard-steps');
      steps.textContent = '';

      const valueRows = [];
      const textSteps = [];
      stepsTemplate.forEach((step) => {
        const separatorIndex = step.indexOf(':');
        const label = separatorIndex >= 0 ? step.slice(0, separatorIndex).trim() : '';
        const value = separatorIndex >= 0 ? step.slice(separatorIndex + 1).trim() : '';
        if (['Type', 'Name (required)', 'Target (required)', 'Proxy status', 'TTL'].includes(label)) {
          valueRows.push({ label, value });
        } else if (step) {
          textSteps.push(step);
        }
      });

      if (textSteps[0]) {
        const intro = document.createElement('p');
        intro.className = 'manual-guide-step-text';
        intro.textContent = textSteps[0];
        steps.appendChild(intro);
      }

      if (valueRows.length > 0) {
        const values = document.createElement('dl');
        values.className = 'manual-guide-values';
        valueRows.forEach(({ label, value }) => {
          const item = document.createElement('div');
          const isSecondary = ['Proxy status', 'TTL'].includes(label);
          const isCopyable = ['Name (required)', 'Target (required)'].includes(label);
          item.className =
            'manual-guide-value ' +
            (isSecondary ? 'manual-guide-value-secondary' : 'manual-guide-value-main');
          const dt = document.createElement('dt');
          dt.textContent = label.replace(' (required)', '');
          const body = document.createElement('div');
          body.className = 'manual-guide-value-body';
          const dd = document.createElement('dd');
          dd.textContent = value;
          body.appendChild(dd);
          if (isCopyable) {
            const copyButton = document.createElement('button');
            copyButton.type = 'button';
            copyButton.className = 'manual-guide-copy-btn';
            const copyLabel = document.createElement('span');
            copyLabel.setAttribute('data-copy-label', '');
            copyLabel.textContent = t('web.envDetail.copyBtn');
            copyButton.appendChild(copyLabel);
            copyButton.addEventListener('click', () =>
              copyTextWithFeedback(copyButton, value, 'web.envDetail.copyBtn')
            );
            body.appendChild(copyButton);
          }
          item.appendChild(dt);
          item.appendChild(body);
          values.appendChild(item);
        });
        steps.appendChild(values);
      }

      textSteps.slice(1).forEach((step) => {
        const detail = document.createElement('p');
        detail.className = 'manual-guide-step-text';
        detail.textContent = step;
        steps.appendChild(detail);
      });

      const dashboardLink = document.getElementById('deploy-manual-wildcard-dashboard-link');
      dashboardLink.textContent = copy.dashboardLinkLabel;
      if (dashboardUrl) {
        dashboardLink.href = dashboardUrl;
        dashboardLink.classList.remove('hidden');
      } else {
        dashboardLink.removeAttribute('href');
        dashboardLink.classList.add('hidden');
      }

      const docsLink = document.getElementById('deploy-manual-wildcard-docs-link');
      docsLink.textContent = copy.docsLinkLabel;
      docsLink.href = CLOUDFLARE_DNS_RECORDS_DOCS;

      warning.classList.remove('hidden');
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

    async function copyTextWithFeedback(button, text, copyKey = 'web.envDetail.copyBtn') {
      if (!button || !text) return;

      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const tempInput = document.createElement('input');
        tempInput.value = text;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand('copy');
        document.body.removeChild(tempInput);
      }

      const label = button.querySelector('[data-copy-label]') || button;
      label.textContent = t('web.complete.copied');
      button.disabled = true;

      setTimeout(() => {
        label.textContent = t(copyKey);
        button.disabled = false;
      }, 2000);
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

    function setupLogCopyButton(buttonId, outputId) {
      const button = document.getElementById(buttonId);
      const output = document.getElementById(outputId);
      if (!button || !output) return;

      button.addEventListener('click', async () => {
        await copyTextWithFeedback(button, output.textContent || '');
      });
    }

    // Setup all log toggles
    setupLogToggle('deploy-log-toggle', 'deploy-log');
    setupLogToggle('provision-log-toggle', 'provision-log');
    setupLogToggle('delete-log-toggle', 'delete-log');
    setupLogCopyButton('deploy-log-copy-btn', 'deploy-output');
    setupLogCopyButton('provision-log-copy-btn', 'provision-output');
    setupLogCopyButton('delete-log-copy-btn', 'delete-output');

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
          const displayCurrent = Math.min(current, total);
          progressText.textContent = displayCurrent + ' / ' + total + ' resources';
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

    function getExpectedDeployWorkerCount() {
      return 12;
    }

    function createDeployProgressTracker() {
      let percent = 0;
      let currentTask = t('web.status.initializing') || 'Initializing...';
      let expectedWorkers = getExpectedDeployWorkerCount();
      let finalUiStarted = false;
      const workerCompleted = new Set();
      const counters = {};

      function setProgress(nextPercent, task) {
        const normalized = Math.max(0, Math.min(Math.round(nextPercent), 99));
        percent = Math.max(percent, normalized);
        if (task) currentTask = task;
        updateProgressUI('deploy', percent, 100, currentTask);
      }

      function complete(task) {
        percent = 100;
        currentTask = task || 'Deployment complete!';
        updateProgressUI('deploy', 100, 100, currentTask);
      }

      function bump(key, start, end, step, task) {
        counters[key] = (counters[key] || 0) + 1;
        setProgress(Math.min(start + counters[key] * step, end), task);
      }

      function trackWorkerSuccess(message) {
        const match = message.match(/^\\s*✓\\s+([a-z0-9-]+-ar-[a-z0-9-]+)\\s+deployed successfully/i);
        if (!match) return false;

        workerCompleted.add(match[1]);
        const completed = workerCompleted.size;
        const workerPercent = 45 + (Math.min(completed, expectedWorkers) / expectedWorkers) * 21;
        setProgress(workerPercent, 'Deploying API Workers (' + completed + '/' + expectedWorkers + ')');
        return true;
      }

      return {
        handle(message) {
          const taskInfo = parseProgressMessage(message);
          const totalMatch = message.match(/^Total:\\s+(\\d+)\\s*$/);
          if (totalMatch) {
            expectedWorkers = Math.max(parseInt(totalMatch[1], 10), 1);
            setProgress(66, 'API Workers deployed (' + workerCompleted.size + '/' + expectedWorkers + ')');
            return;
          }

          if (message.includes('Clearing build cache')) {
            setProgress(2, 'Preparing build...');
          } else if (message.includes('Building packages')) {
            setProgress(6, 'Building packages...');
          } else if (message.includes('Packages built successfully')) {
            setProgress(12, 'Packages built successfully');
          } else if (message.includes('Uploading secrets from')) {
            setProgress(14, 'Uploading secrets...');
          } else if (message.includes('uploaded')) {
            bump('secrets', 14, 29, 1, 'Uploading secrets...');
          } else if (message.includes('Refreshing wrangler.toml')) {
            setProgress(31, 'Refreshing Worker configuration...');
          } else if (message.includes('wrangler.toml files refreshed')) {
            setProgress(34, 'Worker configuration refreshed');
          } else if (message.includes('Ensuring wildcard DNS')) {
            setProgress(36, 'Checking wildcard DNS...');
          } else if (message.includes('Wildcard DNS resolves')) {
            setProgress(38, 'Wildcard DNS ready');
          } else if (message.includes('Preparing UI Worker binding targets')) {
            setProgress(39, 'Preparing UI Worker bindings...');
          } else if (
            !finalUiStarted &&
            (message.includes('Building ar-login-ui') || message.includes('Building ar-admin-ui'))
          ) {
            bump('uiBindingBuild', 39, 42, 1.5, taskInfo || 'Preparing UI Worker bindings...');
          } else if (!finalUiStarted && message.includes('deployed as UI Worker')) {
            bump('uiBindingDeploy', 42, 44, 1, 'UI Worker bindings ready');
          } else if (message.includes('Starting Authrim deployment')) {
            setProgress(45, 'Deploying API Workers (0/' + expectedWorkers + ')');
          } else if (trackWorkerSuccess(message)) {
            return;
          } else if (message.includes('Deployment Summary')) {
            setProgress(66, 'API Worker deployment summary');
          } else if (message.includes('Verifying Worker deployments')) {
            setProgress(68, 'Verifying Worker deployments...');
          } else if (message.includes('Worker deployments are visible')) {
            setProgress(71, 'Worker deployments are visible');
          } else if (message.includes('Verifying Worker HTTP health')) {
            setProgress(73, 'Checking Worker health...');
          } else if (message.includes('Worker HTTP health checks passed')) {
            setProgress(76, 'Worker health checks passed');
          } else if (message.includes('Waiting for API router')) {
            setProgress(78, 'Waiting for API router...');
          } else if (message.includes('API router is reachable')) {
            setProgress(80, 'API router is reachable');
          } else if (message.includes('Running D1 database migrations')) {
            setProgress(82, 'Running database migrations...');
          } else if (message.includes('Database migrations completed successfully')) {
            setProgress(87, 'Database migrations complete');
          } else if (
            message.includes('Ensuring initial tenant') ||
            message.includes('Ensuring initial admin roles') ||
            message.includes('Ensuring setup machine access') ||
            message.includes('Seeding runtime profiles') ||
            message.includes('runtime snapshot')
          ) {
            bump('bootstrap', 87, 91, 1, taskInfo || 'Finalizing runtime bootstrap...');
          } else if (message.includes('Deploying Login/Admin UI')) {
            finalUiStarted = true;
            setProgress(92, 'Deploying Login/Admin UI...');
          } else if (
            finalUiStarted &&
            (message.includes('Building ar-login-ui') || message.includes('Building ar-admin-ui'))
          ) {
            bump('finalUiBuild', 92, 95, 1.5, taskInfo || 'Building UI Workers...');
          } else if (finalUiStarted && message.includes('deployed as UI Worker')) {
            bump('finalUiDeploy', 95, 98, 1.5, 'Deploying UI Workers...');
          } else if (message.includes('All UI packages deployed to Workers')) {
            setProgress(98, 'UI Workers deployed');
          } else if (message.includes('Deployment complete')) {
            complete('✓ Deployment complete!');
          } else if (taskInfo) {
            setProgress(percent, taskInfo);
          }
        },
        complete,
      };
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

    function createUrlItem(label, text, href) {
      const div = document.createElement('div');
      div.className = 'url-item';

      const labelSpan = document.createElement('span');
      labelSpan.className = 'url-label';
      labelSpan.textContent = label;

      let valueEl;
      if (href) {
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.className = 'url-value';
        link.textContent = text;
        valueEl = link;
      } else {
        const span = document.createElement('span');
        span.className = 'url-value';
        span.textContent = text;
        valueEl = span;
      }

      div.appendChild(labelSpan);
      div.appendChild(valueEl);
      return div;
    }

    async function resetServerState() {
      try {
        await api('/reset', { method: 'POST' });
      } catch (error) {
        console.warn('Failed to reset setup state:', error);
      }
    }

    function resetLogToggle(toggleId, logId) {
      const toggle = document.getElementById(toggleId);
      const log = document.getElementById(logId);
      if (toggle && log) {
        log.classList.add('hidden');
        toggle.classList.remove('open');
        const label = toggle.querySelector('span:last-child');
        if (label) {
          label.textContent = t('web.provision.showLog');
        }
      }
    }

    function resetProgressContainer(prefix) {
      const progressBar = document.getElementById(prefix + '-progress-bar');
      const progressText = document.getElementById(prefix + '-progress-text');
      const currentTaskEl = document.getElementById(prefix + '-current-task');
      const spinner = document.getElementById(prefix + '-spinner');
      const progressDiv = document.getElementById(prefix + '-progress-ui');

      if (progressBar) progressBar.style.width = '0%';
      if (spinner) spinner.style.display = 'block';
      if (progressDiv) progressDiv.classList.add('hidden');

      if (currentTaskEl) {
        currentTaskEl.textContent = t('web.provision.initializing') || 'Initializing...';
      }

      if (progressText) {
        progressText.textContent =
          prefix === 'deploy' ? '0% complete' : '0 / 0 resources';
      }
    }

    function resetDynamicCompleteSections() {
      const dynamicSection = document.getElementById('complete-admin-setup-section');
      if (dynamicSection) {
        dynamicSection.remove();
      }
    }

    function resetLoadConfigUI() {
      loadedConfig = null;

      const configFile = document.getElementById('config-file');
      if (configFile) configFile.value = '';

      document.getElementById('config-file-name').textContent = '';
      document.getElementById('config-validation-error').classList.add('hidden');
      document.getElementById('config-validation-success').classList.add('hidden');
      document.getElementById('config-preview-section').classList.add('hidden');
      document.getElementById('config-preview-content').textContent = '';
      document.getElementById('btn-load-config').disabled = true;

      const errorList = document.getElementById('config-validation-errors');
      while (errorList.firstChild) {
        errorList.removeChild(errorList.firstChild);
      }
    }

    function resetConfigurationForm() {
      config = {};
      provisioningCompleted = false;
      domainZoneId = null;

      document.getElementById('advanced-options').classList.remove('hidden');

      document.getElementById('env').value = '';
      document.getElementById('base-domain').value = '';
      document.getElementById('login-domain').value = '';
      document.getElementById('admin-domain').value = '';
      document.getElementById('tenant-name').value = 'default';
      document.getElementById('tenant-display').value = '';
      document.getElementById('primary-tenant').value = '';
      document.getElementById('enable-multi-tenant').checked = false;
      document.getElementById('naked-domain').checked = false;
      document.getElementById('user-id-format').value = 'nanoid';

      document.getElementById('domain-check-row').style.display = 'none';
      document.getElementById('domain-check-status').replaceChildren();
      document.getElementById('login-domain-zone-status').replaceChildren();
      document.getElementById('admin-domain-zone-status').replaceChildren();
      document.getElementById('custom-domain-binding-row').style.display = 'none';
      document.getElementById('custom-domain-binding').checked = true;

      const envInput = document.getElementById('env');
      const envError = document.getElementById('env-error');
      envInput.style.borderColor = '';
      if (envError) envError.style.display = 'none';

      updateBaseDomainUI();

      const loginDomainRow = document.getElementById('login-domain-row');
      const adminDomainRow = document.getElementById('admin-domain-row');
      loginDomainRow.style.opacity = '1';
      adminDomainRow.style.opacity = '1';
      document.getElementById('login-domain').disabled = false;
      document.getElementById('admin-domain').disabled = false;

      updatePreview();
    }

    function resetDatabaseAndEmailForm() {
      setSelectedStorageProfileId('builtin:storage:shared-d1');
      document.getElementById('feature-queue-enabled').checked = false;

      document.querySelectorAll('input[name="db-core-location"]').forEach((input) => {
        input.checked = input.value === 'auto';
      });
      document.querySelectorAll('input[name="db-pii-location"]').forEach((input) => {
        input.checked = input.value === 'auto';
      });

      document.querySelectorAll('input[name="email-setup-choice"]').forEach((input) => {
        input.checked = input.value === 'later';
      });
      document.getElementById('cloudflare-config-form').classList.add('hidden');
      document.getElementById('resend-config-form').classList.add('hidden');
      document.getElementById('cloudflare-from-address').value = '';
      document.getElementById('cloudflare-from-name').value = '';
      document.getElementById('resend-api-key').value = '';
      document.getElementById('email-from-address').value = '';
      document.getElementById('email-from-name').value = '';
      document.getElementById('btn-continue-email').disabled = false;
      document.getElementById('btn-continue-email').textContent = t('web.btn.continue');
    }

    function resetProvisionSection() {
      if (provisionPollInterval) {
        clearInterval(provisionPollInterval);
        provisionPollInterval = null;
      }

      document.getElementById('provision-status').textContent = t('web.provision.ready');
      document.getElementById('provision-status').className = 'status-badge status-pending';
      document.getElementById('resource-preview').classList.remove('hidden');
      document.getElementById('keys-saved-info').classList.add('hidden');
      document.getElementById('keys-path').textContent = '';
      document.getElementById('provision-output').textContent = '';
      document.getElementById('btn-provision').disabled = false;
      resetProgressContainer('provision');
      resetLogToggle('provision-log-toggle', 'provision-log');
      updateProvisionButtons();
    }

    function resetDeploySection() {
      document.getElementById('deploy-status').textContent = t('web.provision.ready');
      document.getElementById('deploy-status').className = 'status-badge status-pending';
      document.getElementById('deploy-ready-text').classList.remove('hidden');
      document.getElementById('deploy-output').textContent = '';
      document.getElementById('btn-deploy').disabled = false;
      document.getElementById('btn-deploy').classList.remove('hidden');
      resetProgressContainer('deploy');
      resetLogToggle('deploy-log-toggle', 'deploy-log');
    }

    function resetCompleteSection() {
      document.getElementById('urls').textContent = '';
      resetDynamicCompleteSections();
    }

    function resetDeleteSection() {
      document.getElementById('delete-output').textContent = '';
      document.getElementById('delete-result').classList.add('hidden');
      document.getElementById('delete-result').textContent = '';
      document.getElementById('delete-options-section').classList.remove('hidden');
      document.getElementById('btn-confirm-delete').classList.remove('hidden');
      document.getElementById('btn-confirm-delete').disabled = false;
      resetProgressContainer('delete');
      resetLogToggle('delete-log-toggle', 'delete-log');
    }

    async function resetSetupFlowState() {
      await resetServerState();
      resetLoadConfigUI();
      resetConfigurationForm();
      resetDatabaseAndEmailForm();
      resetProvisionSection();
      resetDeploySection();
      resetCompleteSection();
      resetDeleteSection();
      selectedEnvForDetail = null;
      selectedEnvForDelete = null;
      setStep(1);
    }

    // Check prerequisites
    async function checkPrerequisites() {
      const prereqStatus = document.getElementById('prereq-status');
      const prereqContent = document.getElementById('prereq-content');

      try {
        const result = await api('/prerequisites');
        lastPrerequisitesResult = result;

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
          renderPrereqCapabilities(prereqContent, result);
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
          renderPrereqCapabilities(prereqContent, result);
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
        renderPrereqCapabilities(prereqContent, result);

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
    document.getElementById('menu-new-setup').addEventListener('click', async () => {
      await resetSetupFlowState();
      document.getElementById('advanced-options').classList.remove('hidden');
      setStep(2);
      showSection('config');
      updatePreview();
    });

    document.getElementById('menu-load-config').addEventListener('click', () => {
      showSection('loadConfig');
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
        displayName: 'Initial Tenant',
        multiTenant: false,
      };

      const components = {
        api: true,
        ...(loadedConfig.components || {}),
        loginUi: loadedConfig.components?.loginUi ?? true,
        adminUi: loadedConfig.components?.adminUi ?? true,
        saml: true,
        async: true,
        vc: true,
        bridge: true,
        policy: true,
      };
      const profiles = loadedConfig.profiles || buildProfilesConfig('builtin:storage:shared-d1');
      const features = {
        queue: { enabled: loadedConfig.features?.queue?.enabled === true },
        r2: { enabled: loadedConfig.features?.r2?.enabled !== false },
        email: loadedConfig.features?.email || { provider: 'none' },
      };

      // Build internal config
      config = {
        env,
        apiDomain: stripProtocol(apiDomain) || null,
        loginUiDomain: stripProtocol(loginUiDomain) || null,
        adminUiDomain: stripProtocol(adminUiDomain) || null,
        tenant,
        components,
        profiles,
        features,
        zoneId: loadedConfig.urls?.api?.zoneId || null,
        customDomainBinding: loadedConfig.urls?.api?.customDomainBinding === true,
      };

      // Set form values
      document.getElementById('env').value = config.env;
      document.getElementById('base-domain').value = stripProtocol(config.tenant?.baseDomain || config.apiDomain);
      document.getElementById('login-domain').value = stripProtocol(config.loginUiDomain);
      document.getElementById('admin-domain').value = stripProtocol(config.adminUiDomain);
      document.getElementById('tenant-name').value = config.tenant?.name || 'default';
      document.getElementById('tenant-display').value = config.tenant?.displayName || 'Initial Tenant';
      document.getElementById('enable-multi-tenant').checked = config.tenant?.multiTenant === true;
      document.getElementById('naked-domain').checked = config.tenant?.nakedDomain || false;
      if (document.getElementById('user-id-format')) {
        document.getElementById('user-id-format').value = config.tenant?.userIdFormat || 'nanoid';
      }
      if (document.getElementById('primary-tenant')) {
        document.getElementById('primary-tenant').value = config.tenant?.primaryTenant || '';
      }
      updateBaseDomainUI();
      setSelectedStorageProfileId(config.profiles?.defaults?.storage);
      setTenantD1PreallocatedSlots(config.tenantD1?.preallocatedSlots || 3);
      document.getElementById('comp-login-ui').checked = config.components.loginUi !== false;
      document.getElementById('comp-admin-ui').checked = config.components.adminUi !== false;
      document.getElementById('feature-queue-enabled').checked =
        config.features?.queue?.enabled === true;
      updateComponentOptionUi();

      // Restore domain check UI if custom domain is set
      const loadedBaseDomain = document.getElementById('base-domain').value.trim();
      if (loadedBaseDomain && /^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$/i.test(loadedBaseDomain)) {
        document.getElementById('domain-check-row').style.display = 'block';
        // Auto-trigger zone check for loaded domain
        setTimeout(() => document.getElementById('check-domain-btn').click(), 300);
      }

      // Trigger env input to update preview/default labels
      document.getElementById('env').dispatchEvent(new Event('input'));

      // Show configuration screen for review/editing
      // User can modify settings before proceeding to provision
      // Loaded configurations always expose all component options for editing.
      document.getElementById('advanced-options').classList.remove('hidden');
      setStep(2);
      showSection('config');
      updatePreview();
    });

    // Configuration handlers
    // Update preview section when any input changes
    function getCurrentApiDomainUiState() {
      return computeApiDomainUiState({
        baseDomain: document.getElementById('base-domain').value.trim(),
        multiTenantChecked: document.getElementById('enable-multi-tenant').checked,
        nakedDomainChecked: document.getElementById('naked-domain').checked,
        tenantName: document.getElementById('tenant-name').value.trim(),
        primaryTenant: document.getElementById('primary-tenant').value.trim(),
      });
    }

    function getCurrentSetupDomainValidationIssues() {
      const loginUiEnabled = document.getElementById('comp-login-ui')?.checked !== false;
      const adminUiEnabled = document.getElementById('comp-admin-ui')?.checked !== false;
      return validateSetupDomainInputs({
        apiDomain: document.getElementById('base-domain').value.trim(),
        loginUiDomain: loginUiEnabled ? document.getElementById('login-domain').value.trim() : '',
        adminUiDomain: adminUiEnabled ? document.getElementById('admin-domain').value.trim() : '',
        tenantName: document.getElementById('tenant-name').value.trim(),
      });
    }

    function renderDomainDepthError(elementId, issue) {
      const el = document.getElementById(elementId);
      if (!el) return;
      if (!issue) {
        el.style.display = 'none';
        el.textContent = '';
        return;
      }

      el.textContent = issue.suggestion
        ? issue.message + ' Suggested host: ' + issue.suggestion
        : issue.message;
      el.style.display = 'block';
    }

    function refreshDomainDepthValidation() {
      const issues = getCurrentSetupDomainValidationIssues();
      const byField = new Map(issues.map((issue) => [issue.field, issue]));

      renderDomainDepthError('base-domain-depth-error', byField.get('apiDomain'));
      renderDomainDepthError('login-domain-depth-error', byField.get('loginUiDomain'));
      renderDomainDepthError('admin-domain-depth-error', byField.get('adminUiDomain'));

      const configureButton = document.getElementById('btn-configure');
      if (configureButton) {
        configureButton.disabled = issues.length > 0;
      }

      return issues;
    }

    function renderTenantUrlExamples(state, copy) {
      const body = document.getElementById('tenant-url-examples-body');
      body.textContent = '';

      state.exampleRows.forEach((row) => {
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        const td = document.createElement('td');

        if (row.kind === 'initial-tenant') {
          th.textContent = copy.rowInitialTenant(row.tenantName || 'default');
        } else if (row.kind === 'initial-tenant-explicit') {
          th.textContent = copy.rowInitialTenantExplicit(row.tenantName || 'default');
        } else {
          th.textContent = copy.rowOtherTenant;
        }

        td.textContent = row.url;
        tr.appendChild(th);
        tr.appendChild(td);
        body.appendChild(tr);
      });
    }

    function generateRandomTenantIdInBrowser() {
      const alphabet = 'abcdefghjkmnpqrstuvwxyz';
      const bytes = new Uint8Array(12);
      globalThis.crypto.getRandomValues(bytes);
      let body = '';
      for (let i = 0; i < bytes.length; i += 1) {
        body += alphabet[bytes[i] % alphabet.length];
      }
      return body;
    }

    function isValidTenantId(value) {
      return /^[a-z][a-z0-9-]{0,62}$/.test(String(value || '').trim());
    }

    function showTenantIdValidationError(inputId, label) {
      alert(label + ' must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.');
      document.getElementById(inputId)?.focus();
    }

    function refreshApiDomainUi() {
      const state = getCurrentApiDomainUiState();
      const copy = getApiDomainUiCopy();
      const baseDomain = document.getElementById('base-domain').value.trim();
      const tenantName = document.getElementById('tenant-name').value.trim() || 'default';
      const primaryTenant = document.getElementById('primary-tenant').value.trim() || tenantName;
      const singleTenantMode = !state.multiTenantEnabled;

      document.getElementById('tenant-id-label').textContent =
        singleTenantMode
          ? copy.singleTenantLabel || copy.initialTenantLabel
          : copy.initialTenantLabel;
      document.getElementById('tenant-name-random').textContent =
        copy.randomTenantButtonLabel || 'Generate Random';
      document.getElementById('primary-tenant-label').textContent = copy.primaryTenantLabel;
      document.getElementById('tenant-url-examples-title').textContent = copy.examplesTitle;
      document.getElementById('tenant-url-examples-header-label').textContent =
        copy.tableHeaderLabel;
      document.getElementById('tenant-url-examples-header-url').textContent = copy.tableHeaderUrl;

      if (state.multiTenantHintMode === 'needs-custom-domain') {
        document.getElementById('multi-tenant-hint').textContent = copy.multiTenantHintNeedsDomain;
      } else if (state.multiTenantHintMode === 'single-tenant') {
        document.getElementById('multi-tenant-hint').textContent = copy.multiTenantHintSingleTenant;
      } else {
        document.getElementById('multi-tenant-hint').textContent =
          copy.multiTenantHintEnabled(baseDomain);
      }

      if (state.showTenantFields && state.multiTenantEnabled) {
        document.getElementById('tenant-id-hint').textContent = copy.initialTenantHintSubdomain(
          tenantName,
          baseDomain,
          'https://' + tenantName + '.' + baseDomain
        );
      } else {
        document.getElementById('tenant-id-hint').textContent =
          singleTenantMode
            ? copy.singleTenantHintGeneric || copy.initialTenantHintGeneric
            : copy.initialTenantHintGeneric;
      }

      document.getElementById('primary-tenant-hint').textContent = copy.primaryTenantHint(
        baseDomain || 'example.com',
        primaryTenant,
        'https://' + (baseDomain || 'example.com')
      );

      if (state.nakedDomainHintMode === 'omit-tenant') {
        document.getElementById('naked-domain-hint').textContent = copy.nakedDomainHintOmit(
          primaryTenant,
          baseDomain,
          'https://' + (baseDomain || 'example.com')
        );
      } else if (state.nakedDomainHintMode === 'include-tenant') {
        document.getElementById('naked-domain-hint').textContent = copy.nakedDomainHintInclude(
          tenantName,
          baseDomain,
          'https://' + tenantName + '.' + baseDomain
        );
      } else {
        document.getElementById('naked-domain-hint').textContent = '';
      }

      renderTenantUrlExamples(state, copy);
    }

    window.refreshApiDomainUi = refreshApiDomainUi;
    window.renderDeployManualWildcardWarning = renderDeployManualWildcardWarning;

    function getOriginFromPreviewUrl(value) {
      try {
        return new URL(value).origin;
      } catch {
        return '';
      }
    }

    function hostWithinBaseDomain(host, baseDomain) {
      if (!host || !baseDomain) return false;
      const normalizedHost = host.toLowerCase();
      const normalizedBase = baseDomain.toLowerCase();
      return normalizedHost === normalizedBase || normalizedHost.endsWith('.' + normalizedBase);
    }

    function normalizeDomainHostname(value) {
      const raw = String(value || '').trim();
      if (!raw) return '';
      try {
        return new URL(raw.match(/^https?:\\/\\//i) ? raw : 'https://' + raw).hostname.toLowerCase();
      } catch {
        return raw
          .replace(/^https?:\\/\\//i, '')
          .replace(/\\/.*$/, '')
          .replace(/[.]+$/, '')
          .toLowerCase();
      }
    }

    function isImmediateSubdomainOfBaseDomain(host, baseDomain) {
      if (!host || !baseDomain || !host.endsWith('.' + baseDomain)) return false;
      const prefix = host.slice(0, -baseDomain.length - 1);
      return prefix.length > 0 && !prefix.includes('.');
    }

    function isRoutedByMultiTenantRouterHost(host, baseDomain) {
      return host === baseDomain || isImmediateSubdomainOfBaseDomain(host, baseDomain);
    }

    function uiDomainRequiresOwnRoute(domain) {
      const uiHost = normalizeDomainHostname(domain);
      if (!uiHost) return false;

      const apiHost = normalizeDomainHostname(document.getElementById('base-domain').value);
      if (apiHost && uiHost === apiHost) return false;

      const domainUiState = getCurrentApiDomainUiState();
      if (domainUiState.multiTenantEnabled && apiHost) {
        return !isRoutedByMultiTenantRouterHost(uiHost, apiHost);
      }

      return true;
    }

    function describeAdminPreviewMode(mode) {
      if (mode === 'same-origin') {
        return 'same-origin - relative Admin API calls on the same origin';
      }
      if (mode === 'same-site-cross-origin') {
        return 'same-site-cross-origin - direct Admin API calls with credentialed CORS';
      }
      return 'cross-site-proxy - Admin UI Worker BFF via Service Binding';
    }

    function resolveAdminPreviewMode(apiUrl, adminUrl, baseDomain) {
      const apiOrigin = getOriginFromPreviewUrl(apiUrl);
      const adminOrigin = getOriginFromPreviewUrl(adminUrl);
      if (apiOrigin && adminOrigin && apiOrigin === adminOrigin) {
        return 'same-origin';
      }

      try {
        const apiHost = new URL(apiUrl).hostname;
        const adminHost = new URL(adminUrl).hostname;
        if (
          hostWithinBaseDomain(apiHost, baseDomain) &&
          hostWithinBaseDomain(adminHost, baseDomain)
        ) {
          return 'same-site-cross-origin';
        }
      } catch {
        // Fall through to proxy mode for incomplete preview input.
      }

      return 'cross-site-proxy';
    }

    function updatePreview() {
      const env = document.getElementById('env').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || '{env}';
      const baseDomain = document.getElementById('base-domain').value.trim();
      const domainUiState = getCurrentApiDomainUiState();
      const multiTenantEnabled = domainUiState.multiTenantEnabled;
      const nakedDomain = multiTenantEnabled && document.getElementById('naked-domain').checked;
      const tenantName = document.getElementById('tenant-name').value.trim() || 'default';
      const loginDomain = document.getElementById('login-domain').value.trim();
      const adminDomain = document.getElementById('admin-domain').value.trim();
      const loginUiEnabled = document.getElementById('comp-login-ui')?.checked !== false;
      const adminUiEnabled = document.getElementById('comp-admin-ui')?.checked !== false;
      updateComponentOptionUi();
      refreshDomainDepthValidation();

      // Components - build list based on selections
      const components = [
        'API',
        ...(loginUiEnabled ? ['Login UI'] : []),
        ...(adminUiEnabled ? ['Admin UI'] : []),
      ];
      const previewComponents = document.getElementById('preview-components');
      previewComponents.textContent = '';
      components.forEach((component) => {
        const badge = document.createElement('span');
        badge.className = 'preview-component-badge';
        badge.textContent = component;
        previewComponents.appendChild(badge);
      });

      const setPreviewValue = (element, value, note) => {
        element.textContent = '';
        const main = document.createElement('span');
        main.textContent = value;
        element.appendChild(main);
        if (note) {
          const noteEl = document.createElement('span');
          noteEl.className = 'infra-value-note';
          noteEl.textContent = note;
          element.appendChild(noteEl);
        }
      };

      // Generate domains with account subdomain
      const workersDomain = workersSubdomain
        ? env + '-ar-router.' + workersSubdomain + '.workers.dev'
        : env + '-ar-router.workers.dev';
      const loginUiWorkerDomain = workersSubdomain
        ? env + '-ar-login-ui.' + workersSubdomain + '.workers.dev'
        : env + '-ar-login-ui.workers.dev';
      const adminUiWorkerDomain = workersSubdomain
        ? env + '-ar-admin-ui.' + workersSubdomain + '.workers.dev'
        : env + '-ar-admin-ui.workers.dev';

      // Issuer URL
      // Note: Tenant subdomain is only supported with custom domains, NOT workers.dev
      // Workers.dev doesn't support wildcard subdomains, so tenant prefix cannot be used

      if (multiTenantEnabled) {
        if (nakedDomain) {
          document.getElementById('preview-issuer').textContent = 'https://' + baseDomain;
        } else {
          document.getElementById('preview-issuer').textContent =
            'https://' + tenantName + '.' + baseDomain;
        }
      } else if (baseDomain) {
        document.getElementById('preview-issuer').textContent = 'https://' + baseDomain;
      } else {
        // Workers.dev - no tenant prefix (wildcard subdomains not supported)
        document.getElementById('preview-issuer').textContent = 'https://' + workersDomain;
      }

      document.getElementById('tenant-url-examples').style.display =
        domainUiState.showExamples ? 'block' : 'none';
      refreshApiDomainUi();

      const previewLogin = document.getElementById('preview-login');
      if (loginDomain) {
        previewLogin.textContent = 'https://' + loginDomain;
        previewLogin.style.color = '';
      } else {
        previewLogin.textContent = 'https://' + loginUiWorkerDomain;
        previewLogin.style.color = '';
      }
      document.getElementById('login-default').textContent = loginUiWorkerDomain;

      const previewAdmin = document.getElementById('preview-admin');
      if (adminDomain) {
        previewAdmin.textContent = 'https://' + adminDomain;
        previewAdmin.style.color = '';
      } else {
        previewAdmin.textContent = 'https://' + adminUiWorkerDomain;
        previewAdmin.style.color = '';
      }
      document.getElementById('admin-default').textContent = adminUiWorkerDomain;

      const apiPreviewUrl = document.getElementById('preview-issuer').textContent.trim();
      const adminPreviewUrl = previewAdmin.textContent.trim();
      const adminApiModeRow = document.getElementById('preview-admin-api-mode-row');
      const adminApiModeEl = document.getElementById('preview-admin-api-mode');
      if (adminUiEnabled && adminPreviewUrl.startsWith('https://')) {
        adminApiModeRow.style.display = '';
        adminApiModeEl.textContent = describeAdminPreviewMode(
          resolveAdminPreviewMode(apiPreviewUrl, adminPreviewUrl, baseDomain)
        );
      } else {
        adminApiModeRow.style.display = 'none';
      }

      // === Multi-tenant expansion preview ===
      const previewMtSection = document.getElementById('preview-multi-tenant-section');
      const previewIssuerRow = document.getElementById('preview-issuer-row');
      const previewLoginRow  = document.getElementById('preview-login-row');
      const previewAdminRow  = document.getElementById('preview-admin-row');

      if (multiTenantEnabled && baseDomain) {
        // Hide single-tenant rows and show the multi-tenant section
        previewIssuerRow.style.display = 'none';
        previewLoginRow.style.display  = 'none';
        previewAdminRow.style.display  = 'none';
        adminApiModeRow.style.display = 'none';
        previewMtSection.style.display = '';

        // Base URL of the first tenant
        const firstBase = nakedDomain
          ? 'https://' + baseDomain
          : 'https://' + tenantName + '.' + baseDomain;
        const otherBase = 'https://{tenantName}.' + baseDomain;

        // Render tenant cards (prevent XSS with createElement + textContent)
        const mtRowsContainer = document.getElementById('preview-mt-rows');
        mtRowsContainer.textContent = '';

        const makeUrlRow = (label, url) => {
          const row = document.createElement('div');
          row.className = 'preview-tenant-row';
          const lbl = document.createElement('span');
          lbl.className = 'preview-tenant-label';
          lbl.textContent = label;
          const val = document.createElement('span');
          val.className = 'preview-tenant-url';
          val.textContent = url;
          row.appendChild(lbl);
          row.appendChild(val);
          return row;
        };

        const makeBlock = (tenantLabel, baseUrl) => {
          const block = document.createElement('div');
          block.className = 'preview-tenant-block';
          const name = document.createElement('div');
          name.className = 'preview-tenant-name';
          name.textContent = tenantLabel;
          block.appendChild(name);
          block.appendChild(makeUrlRow('Issuer:', baseUrl));
          block.appendChild(makeUrlRow('Login URL:', baseUrl + '/login'));
          block.appendChild(makeUrlRow('OIDC Discovery:', baseUrl + '/.well-known/openid-configuration'));
          return block;
        };

        mtRowsContainer.appendChild(makeBlock(t('web.preview.firstTenant', { name: tenantName }), firstBase));
        mtRowsContainer.appendChild(makeBlock(t('web.preview.otherTenants'), otherBase));

        // Login UI deployment origin. Tenant login remains canonical on each issuer host.
        const loginPagesRow = document.getElementById('preview-login-pages-row');
        const tenantDiscoverRow = document.getElementById('preview-tenant-discover-row');
        const loginUiBase = loginDomain ? loginDomain : loginUiWorkerDomain;
        loginPagesRow.style.display = loginUiEnabled ? '' : 'none';
        setPreviewValue(
          document.getElementById('preview-login-pages'),
          'https://' + loginUiBase,
          t('web.preview.loginUiOriginNote')
        );
        // Tenant discovery uses the shared Login UI custom domain when one is configured.
        // Without a Login UI custom domain, the router-owned base domain remains the fallback.
        tenantDiscoverRow.style.display = loginUiEnabled ? '' : 'none';
        document.getElementById('preview-tenant-discover').textContent =
          'https://' + (loginDomain || baseDomain) + '/discover';

        // Admin UI access target
        const adminAccessRow = document.getElementById('preview-admin-access-row');
        const adminAccessEl  = document.getElementById('preview-admin-access');
        adminAccessRow.style.display = adminUiEnabled ? '' : 'none';
        const adminSameAsApi = adminDomain !== '' && adminDomain === baseDomain;
        if (adminSameAsApi) {
          setPreviewValue(adminAccessEl, firstBase + '/admin/info', t('web.preview.viaApiProxy'));
        } else if (adminDomain) {
          adminAccessEl.textContent = 'https://' + adminDomain + '/admin/info';
        } else {
          adminAccessEl.textContent = 'https://' + adminUiWorkerDomain + '/admin/info';
        }

        // Detect invalid settings and show a warning
        // sameAsApi with nakedDomain=false makes API calls to the naked domain return 404
        const loginSameAsApi = loginDomain !== '' && loginDomain === baseDomain;
        const adminSameAsApi2 = adminDomain !== '' && adminDomain === baseDomain;
        const hasConflict =
          ((loginUiEnabled && loginSameAsApi) || (adminUiEnabled && adminSameAsApi2)) &&
          !nakedDomain;

        const warningDiv = document.getElementById('preview-config-warning');
        if (hasConflict) {
          const conflictUI =
            loginUiEnabled && loginSameAsApi ? t('web.comp.loginUi') : t('web.comp.adminUi');
          warningDiv.style.display = '';
          document.getElementById('preview-warning-message').textContent =
            t('web.preview.conflictWarningMsg', { conflictUI, baseDomain });
          document.getElementById('preview-warning-action').textContent =
            t('web.preview.conflictActionMsg', { conflictUI, tenantName, baseDomain });
        } else {
          warningDiv.style.display = 'none';
        }

      } else {
        // Single-tenant mode: show existing rows
        previewIssuerRow.style.display = '';
        previewLoginRow.style.display  = loginUiEnabled ? '' : 'none';
        previewAdminRow.style.display  = adminUiEnabled ? '' : 'none';
        previewMtSection.style.display = 'none';
      }
    }

    function updateComponentOptionUi() {
      const loginUiEnabled = document.getElementById('comp-login-ui')?.checked !== false;
      const adminUiEnabled = document.getElementById('comp-admin-ui')?.checked !== false;
      const loginDomainRow = document.getElementById('login-domain-row');
      const adminDomainRow = document.getElementById('admin-domain-row');
      const loginDomainInput = document.getElementById('login-domain');
      const adminDomainInput = document.getElementById('admin-domain');

      if (loginDomainRow) loginDomainRow.style.display = loginUiEnabled ? '' : 'none';
      if (adminDomainRow) adminDomainRow.style.display = adminUiEnabled ? '' : 'none';
      if (loginDomainInput) loginDomainInput.disabled = !loginUiEnabled;
      if (adminDomainInput) adminDomainInput.disabled = !adminUiEnabled;
    }

    // Attach event listeners to all inputs
    ['env', 'base-domain', 'enable-multi-tenant', 'naked-domain', 'tenant-name', 'login-domain', 'admin-domain', 'comp-login-ui', 'comp-admin-ui'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', updatePreview);
        el.addEventListener('change', updatePreview);
      }
    });

    document.getElementById('tenant-name-random').addEventListener('click', () => {
      const tenantNameInput = document.getElementById('tenant-name');
      if (tenantNameInput.disabled) {
        return;
      }

      tenantNameInput.value = generateRandomTenantIdInBrowser();
      updatePreview();
    });

    // Validate environment name on blur
    const envInput = document.getElementById('env');
    const envError = document.getElementById('env-error');
    function validateEnvName(value) {
      return /^[a-z][a-z0-9-]*$/.test(value);
    }
    envInput.addEventListener('blur', () => {
      const value = envInput.value.trim();
      if (value && !validateEnvName(value)) {
        envInput.style.borderColor = 'var(--error)';
        if (envError) envError.style.display = 'block';
      } else {
        envInput.style.borderColor = '';
        if (envError) envError.style.display = 'none';
      }
    });
    envInput.addEventListener('input', () => {
      if (envInput.style.borderColor) {
        const value = envInput.value.trim();
        if (!value || validateEnvName(value)) {
          envInput.style.borderColor = '';
          if (envError) envError.style.display = 'none';
        }
      }
    });

    // Update UI based on base domain presence
    function updateBaseDomainUI() {
      const baseDomain = document.getElementById('base-domain').value.trim();
      const domainUiState = getCurrentApiDomainUiState();
      const multiTenantCheckbox = document.getElementById('enable-multi-tenant');
      const multiTenantLabel = document.getElementById('multi-tenant-label');
      const nakedDomainCheckbox = document.getElementById('naked-domain');
      const nakedDomainLabel = document.getElementById('naked-domain-label');
      const nakedDomainHint = document.getElementById('naked-domain-hint');
      const workersDevNote = document.getElementById('workers-dev-note');
      const tenantWorkersNote = document.getElementById('tenant-workers-note');
      const tenantFields = document.getElementById('tenant-fields');
      const tenantNameInput = document.getElementById('tenant-name');
      const tenantNameRandomButton = document.getElementById('tenant-name-random');
      const primaryTenantRow = document.getElementById('primary-tenant-row');
      const primaryTenantInput = document.getElementById('primary-tenant');

      if (baseDomain) {
        multiTenantCheckbox.disabled = false;
        multiTenantLabel.style.opacity = '1';
        workersDevNote.style.display = 'none';
      } else {
        // Workers.dev - tenant subdomains not supported
        multiTenantCheckbox.checked = false;
        multiTenantCheckbox.disabled = true;
        multiTenantLabel.style.opacity = '0.5';
        nakedDomainCheckbox.disabled = true;
        nakedDomainCheckbox.checked = false;
        nakedDomainLabel.style.opacity = '0.5';
        primaryTenantInput.value = '';
      }

      if (domainUiState.showNakedDomainControls) {
        nakedDomainCheckbox.disabled = false;
        nakedDomainLabel.style.display = 'flex';
        nakedDomainLabel.style.opacity = '1';
        nakedDomainHint.style.display = 'block';
      } else {
        nakedDomainCheckbox.disabled = true;
        nakedDomainCheckbox.checked = false;
        nakedDomainLabel.style.display = 'none';
        nakedDomainHint.style.display = 'none';
      }

      workersDevNote.style.display = domainUiState.showWorkersDevNote ? 'block' : 'none';
      tenantWorkersNote.style.display = domainUiState.showWorkersDevNote ? 'block' : 'none';
      tenantFields.style.display = domainUiState.showTenantFields ? 'block' : 'none';
      primaryTenantRow.style.display = domainUiState.showPrimaryTenantRow ? 'block' : 'none';

      if (domainUiState.showTenantFields) {
        tenantNameInput.disabled = false;
        tenantNameInput.readOnly = false;
        tenantNameRandomButton.disabled = false;
      } else {
        tenantNameInput.disabled = true;
        tenantNameInput.readOnly = true;
        tenantNameRandomButton.disabled = true;
      }

      document.getElementById('base-domain').placeholder = domainUiState.baseDomainPlaceholder;
      document.getElementById('tenant-url-examples').style.display =
        domainUiState.showExamples ? 'block' : 'none';
      refreshApiDomainUi();
    }

    // Base domain change - update UI for tenant subdomain options
    document.getElementById('base-domain').addEventListener('input', () => {
      updateBaseDomainUI();
      updatePreview();
      // Show/hide domain check row
      const domainCheckRow = document.getElementById('domain-check-row');
      const baseDomain = document.getElementById('base-domain').value.trim();
      if (baseDomain && isValidCustomDomain(baseDomain)) {
        domainCheckRow.style.display = 'block';
      } else {
        domainCheckRow.style.display = 'none';
        document.getElementById('domain-check-status').replaceChildren();
        document.getElementById('custom-domain-binding-row').style.display = 'none';
      }
    });

    document.getElementById('enable-multi-tenant').addEventListener('change', (e) => {
      updateBaseDomainUI();
      updatePreview();
    });

    // Check Domain button handler
    let domainZoneId = null;
    document.getElementById('check-domain-btn').addEventListener('click', async () => {
      const domain = document.getElementById('base-domain').value.trim();
      if (!domain) return;

      const statusEl = document.getElementById('domain-check-status');
      const bindingRow = document.getElementById('custom-domain-binding-row');
      statusEl.replaceChildren(createAlert('info', t('domain.checkingZone', { domain })));
      domainZoneId = null;

      try {
        const result = await api('/cloudflare/check-zone', {
          method: 'POST',
          body: { domain },
        });
        const zoneName = result.zone?.name || result.zoneName || domain;
        const diagnosticAlert = createZoneDiagnosticAlert(result, {
          domain,
          zone: zoneName,
          onRetry: () => document.getElementById('check-domain-btn').click(),
        });

        statusEl.replaceChildren();
        if (diagnosticAlert) {
          statusEl.appendChild(diagnosticAlert);
        }

        bindingRow.style.display = result.diagnostic?.allowBinding ? 'flex' : 'none';
        domainZoneId = result.found && result.zone ? result.zone.id : null;
      } catch (e) {
        const diagnosticAlert = createZoneDiagnosticAlert(
          {
            found: false,
            zoneName: domain,
            diagnostic: {
              code: 'api_error',
              severity: 'error',
              allowBinding: false,
              actions: ['retry_check', 'reload_page'],
            },
          },
          {
            domain,
            zone: domain,
            onRetry: () => document.getElementById('check-domain-btn').click(),
          }
        );

        statusEl.replaceChildren();
        if (diagnosticAlert) {
          statusEl.appendChild(diagnosticAlert);
        }
        bindingRow.style.display = 'none';
        domainZoneId = null;
      }
    });

    async function checkUiCustomDomainZone(field, options) {
      const inputId = field === 'login' ? 'login-domain' : 'admin-domain';
      const statusId = field === 'login' ? 'login-domain-zone-status' : 'admin-domain-zone-status';
      const label = field === 'login' ? 'Login UI' : 'Admin UI';
      const domain = document.getElementById(inputId).value.trim();
      const statusEl = document.getElementById(statusId);
      const blockOnFailure = options?.blockOnFailure === true;

      statusEl.replaceChildren();
      if (!domain || !isValidCustomDomain(domain) || !uiDomainRequiresOwnRoute(domain)) {
        return true;
      }

      statusEl.replaceChildren(
        createAlert(
          'info',
          label + ': ' + t('domain.checkingZone', { domain })
        )
      );

      try {
        const result = await api('/cloudflare/check-zone', {
          method: 'POST',
          body: { domain },
        });
        const zoneName = result.zone?.name || result.zoneName || domain;
        const diagnosticAlert = createZoneDiagnosticAlert(result, {
          domain,
          zone: zoneName,
          onRetry: () => checkUiCustomDomainZone(field, options),
        });

        statusEl.replaceChildren();
        if (diagnosticAlert) {
          statusEl.appendChild(diagnosticAlert);
        }

        const ok = Boolean(result.found && result.zone);
        if (!ok && blockOnFailure) {
          statusEl.appendChild(
            createAlert(
              'error',
              label +
                ' custom domain requires a direct Worker custom-domain route. Confirm that the Cloudflare zone is available before continuing.'
            )
          );
        }
        return ok || !blockOnFailure;
      } catch (e) {
        const diagnosticAlert = createZoneDiagnosticAlert(
          {
            found: false,
            zoneName: domain,
            diagnostic: {
              code: 'api_error',
              severity: 'error',
              allowBinding: false,
              actions: ['retry_check', 'reload_page'],
            },
          },
          {
            domain,
            zone: domain,
            onRetry: () => checkUiCustomDomainZone(field, options),
          }
        );

        statusEl.replaceChildren();
        if (diagnosticAlert) {
          statusEl.appendChild(diagnosticAlert);
        }
        if (blockOnFailure) {
          statusEl.appendChild(
            createAlert(
              'error',
              label +
                ' custom domain route cannot be verified right now. Retry the zone check before continuing.'
            )
          );
        }
        return !blockOnFailure;
      }
    }

    // Auto-check domain on blur (debounced)
    let domainCheckTimer;
    document.getElementById('base-domain').addEventListener('blur', () => {
      clearTimeout(domainCheckTimer);
      domainCheckTimer = setTimeout(() => {
        const domain = document.getElementById('base-domain').value.trim();
        if (domain && isValidCustomDomain(domain)) {
          document.getElementById('check-domain-btn').click();
        }
      }, 500);
    });

    let loginDomainCheckTimer;
    let adminDomainCheckTimer;
    document.getElementById('login-domain').addEventListener('blur', () => {
      clearTimeout(loginDomainCheckTimer);
      loginDomainCheckTimer = setTimeout(() => {
        checkUiCustomDomainZone('login', { blockOnFailure: false });
      }, 500);
    });
    document.getElementById('admin-domain').addEventListener('blur', () => {
      clearTimeout(adminDomainCheckTimer);
      adminDomainCheckTimer = setTimeout(() => {
        checkUiCustomDomainZone('admin', { blockOnFailure: false });
      }, 500);
    });

    ['login-domain', 'admin-domain', 'base-domain', 'enable-multi-tenant', 'naked-domain'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        document.getElementById('login-domain-zone-status').replaceChildren();
        document.getElementById('admin-domain-zone-status').replaceChildren();
      });
      el.addEventListener('change', () => {
        document.getElementById('login-domain-zone-status').replaceChildren();
        document.getElementById('admin-domain-zone-status').replaceChildren();
      });
    });

    // Initial UI state
    updateBaseDomainUI();

    // Naked domain toggle - show/hide tenant name field and update placeholder
    document.getElementById('naked-domain').addEventListener('change', () => {
      updateBaseDomainUI();
      updatePreview();
    });

    document.getElementById('btn-back-mode').addEventListener('click', () => {
      setStep(1);
      showSection('topMenu');
    });

    document.getElementById('btn-configure').addEventListener('click', async () => {
      const domainDepthIssues = refreshDomainDepthValidation();
      if (domainDepthIssues.length > 0) {
        const firstIssue = domainDepthIssues[0];
        const focusMap = {
          apiDomain: 'base-domain',
          loginUiDomain: 'login-domain',
          adminUiDomain: 'admin-domain',
        };
        document.getElementById(focusMap[firstIssue.field])?.focus();
        return;
      }

      // Get and validate environment name
      const envRaw = document.getElementById('env').value.trim();
      if (!envRaw || !validateEnvName(envRaw)) {
        document.getElementById('env').style.borderColor = 'var(--error)';
        const errEl = document.getElementById('env-error');
        if (errEl) errEl.style.display = 'block';
        document.getElementById('env').focus();
        return;
      }
      const env = envRaw;

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
        configureBtn.disabled = refreshDomainDepthValidation().length > 0;
      }

      const baseDomain = document.getElementById('base-domain').value.trim();
      const hasCustomApiDomain = !!baseDomain;
      const multiTenantEnabled =
        hasCustomApiDomain && document.getElementById('enable-multi-tenant').checked;
      const nakedDomain = multiTenantEnabled && document.getElementById('naked-domain').checked;
      const tenantName = multiTenantEnabled
        ? (document.getElementById('tenant-name').value.trim() || 'default')
        : 'default';
      const tenantDisplayName = document.getElementById('tenant-display').value.trim() || 'Initial Tenant';
      const userIdFormat = document.getElementById('user-id-format').value || 'nanoid';
      const primaryTenant = multiTenantEnabled && nakedDomain
        ? tenantName
        : undefined;
      const loginDomain = document.getElementById('login-domain').value.trim();
      const adminDomain = document.getElementById('admin-domain').value.trim();
      const loginUiEnabled = document.getElementById('comp-login-ui')?.checked !== false;
      const adminUiEnabled = document.getElementById('comp-admin-ui')?.checked !== false;

      if (!isValidTenantId(tenantName)) {
        showTenantIdValidationError('tenant-name', 'Initial Tenant ID');
        return;
      }
      const loginZoneOk =
        !loginUiEnabled || (await checkUiCustomDomainZone('login', { blockOnFailure: true }));
      const adminZoneOk =
        !adminUiEnabled || (await checkUiCustomDomainZone('admin', { blockOnFailure: true }));
      if (!loginZoneOk || !adminZoneOk) {
        document.getElementById(!loginZoneOk ? 'login-domain' : 'admin-domain').focus();
        return;
      }

      config = {
        env,
        apiDomain: baseDomain || null,
        loginUiDomain: loginDomain || null,
        adminUiDomain: adminDomain || null,
        tenant: {
          name: tenantName,
          displayName: tenantDisplayName,
          multiTenant: multiTenantEnabled,
          baseDomain: multiTenantEnabled ? baseDomain : undefined,
          nakedDomain: nakedDomain,
          userIdFormat: userIdFormat,
          primaryTenant: primaryTenant,
        },
        components: {
          api: true,
          loginUi: loginUiEnabled,
          adminUi: adminUiEnabled,
          saml: true,
          async: true,
          vc: true,
          bridge: true, // Standard component
          policy: true, // Standard component
        },
        features: {
          queue: { enabled: false },
          r2: { enabled: true },
          email: { provider: 'none' },
        },
        profiles: buildProfilesConfig('builtin:storage:shared-d1'),
        zoneId: domainZoneId || null,
        customDomainBinding: baseDomain
          ? (document.getElementById('custom-domain-binding')?.checked ?? false)
          : false,
      };

      // Create default config with component settings
      const customDomainBinding = document.getElementById('custom-domain-binding')?.checked ?? false;
      await api('/config/default', {
        method: 'POST',
        body: {
          env,
          apiDomain: config.apiDomain,
          loginUiDomain: loginDomain,
          adminUiDomain: adminDomain,
          tenant: config.tenant,
          components: config.components,
          zoneId: domainZoneId || null,
          customDomainBinding: config.apiDomain ? customDomainBinding : false,
          profiles: config.profiles,
        },
      });

      // Update resource preview with the selected env
      updateResourcePreview(env);
      updateProvisionButtons();
      renderDeployManualWildcardWarning();

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
      const storageProfileId = getSelectedStorageProfileId();
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
      config.tenantD1 = {
        ...(config.tenantD1 || {}),
        preallocatedSlots: getTenantD1PreallocatedSlots(),
      };
      config.profiles = {
        ...(config.profiles || buildProfilesConfig(storageProfileId)),
        defaults: {
          ...((config.profiles && config.profiles.defaults) || {}),
          storage: storageProfileId,
          audit: config.profiles?.defaults?.audit || 'builtin:audit:standard',
          residency: config.profiles?.defaults?.residency || 'builtin:residency:default',
        },
        registry: config.profiles?.registry || { backend: 'kv' },
        references: config.profiles?.references || { hyperdrive: {} },
        seed: config.profiles?.seed || { storage: [], audit: [], residency: [] },
      };

      // Proceed to email configuration
      setStep(5);
      showSection('email');
    });

    // Email configuration handlers
    // Toggle resend config form visibility
    document.querySelectorAll('input[name="email-setup-choice"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const cloudflareForm = document.getElementById('cloudflare-config-form');
        const resendForm = document.getElementById('resend-config-form');
        const choice = document.querySelector('input[name="email-setup-choice"]:checked').value;
        if (choice === 'cloudflare') {
          cloudflareForm.classList.remove('hidden');
          resendForm.classList.add('hidden');
        } else if (choice === 'resend') {
          cloudflareForm.classList.add('hidden');
          resendForm.classList.remove('hidden');
        } else {
          cloudflareForm.classList.add('hidden');
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
      const queueEnabled = document.getElementById('feature-queue-enabled').checked === true;
      config.features = {
        ...(config.features || {}),
        queue: { enabled: queueEnabled },
        r2: config.features?.r2 || { enabled: true },
        email: config.features?.email || { provider: 'none' },
      };

      if (choice === 'cloudflare' || choice === 'resend') {
        // Validate and store email configuration
        const isCloudflare = choice === 'cloudflare';
        const apiKey = document.getElementById('resend-api-key').value.trim();
        const fromAddress = isCloudflare
          ? document.getElementById('cloudflare-from-address').value.trim()
          : document.getElementById('email-from-address').value.trim();
        const fromName = isCloudflare
          ? document.getElementById('cloudflare-from-name').value.trim()
          : document.getElementById('email-from-name').value.trim();

	        // Validate API key format
	        if (!isCloudflare && !apiKey) {
	          alert(t('web.email.resendApiKeyMissing'));
	          return;
	        }
	        if (!isCloudflare && !apiKey.startsWith('re_')) {
	          if (!confirm(t('web.email.resendApiKeyConfirmInvalid'))) {
	            return;
	          }
	        }

	        // Validate email address
	        if (!fromAddress) {
	          alert(t('web.email.fromEmailMissing'));
	          return;
	        }
	        if (!fromAddress.includes('@')) {
	          alert(t('web.email.fromEmailInvalid'));
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
              provider: isCloudflare ? 'cloudflare' : 'resend',
              apiKey: isCloudflare ? undefined : apiKey,
              fromAddress: fromAddress,
              fromName: fromName || undefined,
            },
	          });

	          if (!result.success) {
	            throw new Error(result.error || t('web.email.saveConfigFailed'));
	          }

          // Store email configuration (without apiKey for config file)
          config.email = {
            provider: isCloudflare ? 'cloudflare' : 'resend',
            fromAddress: fromAddress,
            fromName: fromName || undefined,
            configured: true,
          };
          config.features.email = {
            ...config.email,
          };
	        } catch (error) {
	          alert(t('web.email.saveConfigFailed') + ': ' + error.message);
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
        config.features.email = {
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
      renderDeployManualWildcardWarning();
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
                const displayCompleted = Math.min(provisionCompleted, totalResources);
                updateProgressUI('provision', provisionCompleted, totalResources, taskInfo || ('Completed ' + displayCompleted + ' / ' + totalResources + ' items'));
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

        // Show keys saved location (external: .authrim-keys/{env}/)
        keysPath.textContent = workingDirectory ? workingDirectory + '/.authrim-keys/' + config.env + '/' : './.authrim-keys/' + config.env + '/';

        // Provision resources
        output.textContent += '☁️ Provisioning Cloudflare resources...\\n';
        scrollToBottom(log);

        const result = await api('/provision', {
          method: 'POST',
          body: {
            env: config.env,
            databaseConfig: config.database,
            createQueues: config.features?.queue?.enabled === true,
            createR2: true,
            storageProfileId: config.profiles?.defaults?.storage || 'builtin:storage:shared-d1',
          },
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
          if (result.savedPaths) {
            output.textContent += '📁 Config: ' + result.savedPaths.config + '\\n';
            output.textContent += '📁 Lock:   ' + result.savedPaths.lock + '\\n';
            if (result.savedPaths.log) {
              output.textContent += '📝 Log:    ' + result.savedPaths.log + '\\n';
            }
          }
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
          if (result.logPath) {
            output.textContent += '\\n📝 Log: ' + result.logPath + '\\n';
          }
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

    document.getElementById('keys-copy-btn').addEventListener('click', async () => {
      const keysPath = document.getElementById('keys-path').textContent || '';
      await copyTextWithFeedback(document.getElementById('keys-copy-btn'), keysPath);
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

      const deployProgress = createDeployProgressTracker();
      let pollInterval = null;
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
        pollInterval = setInterval(async () => {
          try {
            const statusResult = await api('/deploy/status');
            const progress = statusResult.progress || [];
            if (progress.length < lastProgressLength) {
              lastProgressLength = 0;
            }
            if (progress.length > lastProgressLength) {
              const newMessages = progress.slice(lastProgressLength);
              newMessages.forEach(msg => {
                output.textContent += msg + '\\n';
                deployProgress.handle(msg);
              });
              lastProgressLength = progress.length;
              scrollToBottom(log);
            }
          } catch (e) {
            // Ignore transient polling errors while deployment is running.
          }
        }, 1000);

        const result = await api('/deploy', {
          method: 'POST',
          body: {
            env: config.env,
            dryRun: false,
          },
        });

        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }

        if (result.success) {
          // Final progress update
          deployProgress.complete('✓ Deployment complete!');
          output.textContent += '\\n✓ Deployment complete!\\n';
          if (result.logPath) {
            output.textContent += '📝 Log: ' + result.logPath + '\\n';
          }
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
            const apiDomain = stripProtocol(config.apiDomain);
            if (config.tenant?.multiTenant && config.tenant.name && !config.tenant.nakedDomain) {
              apiUrl = 'https://' + config.tenant.name + '.' + apiDomain;
            } else {
              apiUrl = 'https://' + apiDomain;
            }
          } else {
            // Workers.dev - no tenant prefix (wildcard subdomains not supported)
            apiUrl = 'https://' + workersDomain;
          }
          // Login UI URL for setup page (setup page is in Login UI, not API)
          const loginUiWorkerDomain = workersSubdomain
            ? config.env + '-ar-login-ui.' + workersSubdomain + '.workers.dev'
            : config.env + '-ar-login-ui.workers.dev';
          const loginUiUrl = config.loginUiDomain
            ? ensureHttpsUrl(config.loginUiDomain)
            : 'https://' + loginUiWorkerDomain;

          output.textContent += '  API URL: ' + apiUrl + '\\n';
          output.textContent += '  Login UI URL: ' + loginUiUrl + '\\n';
          output.textContent += '  Keys Dir: .authrim-keys/' + config.env + '/\\n';
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

          // Show completion with setup URL, expiration time, and debug info
          showComplete({
            ...result,
            setupUrl: adminSetupResult.setupUrl,
            expiresAt: adminSetupResult.expiresAt,
            adminSetupDebug: adminSetupResult,
          });
        } else if (result.manualAction?.kind === 'wildcard-dns' && result.manualAction.baseDomain) {
          output.textContent += '\\n' + buildWildcardDnsManualMessage(result.manualAction.baseDomain) + '\\n';
          if (result.logPath) {
            output.textContent += '\\n📝 Log: ' + result.logPath + '\\n';
          }
          scrollToBottom(log);
          status.textContent = t('web.status.error');
          status.className = 'status-badge status-warning';
          btn.disabled = false;
          btn.classList.remove('hidden');
          return;
        } else {
          if (result.logPath) {
            output.textContent += '\\n📝 Log: ' + result.logPath + '\\n';
          }
          throw new Error(result.error || 'Deployment failed');
        }
      } catch (error) {
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
        output.textContent += '\\n✗ Error: ' + error.message + '\\n';
        scrollToBottom(log);
        status.textContent = t('web.status.error');
        status.className = 'status-badge status-error';
        btn.disabled = false;
        btn.classList.remove('hidden');
      }
    });

    // Show completion
    function showComplete(result) {
      const urlsEl = document.getElementById('urls');
      const env = config.env;
      const completeEnv = {
        env,
        workers: [
          ...(config.components?.loginUi === false ? [] : [{ name: env + '-ar-login-ui' }]),
          ...(config.components?.adminUi === false ? [] : [{ name: env + '-ar-admin-ui' }]),
        ],
      };
      const completeUrls = buildEnvDetailUrls(completeEnv, config);
      const labelMap = {
        Issuer: 'Issuer:',
        'API Health': 'API Health:',
        'OIDC Discovery': 'Discovery:',
        'Tenant Discovery': 'Tenant Discovery:',
        'Login UI': 'Login UI:',
        'Admin UI': 'Admin UI:',
      };

      // Clear and rebuild URLs section safely
      urlsEl.textContent = '';

      for (const item of completeUrls) {
        urlsEl.appendChild(
          createUrlItem(labelMap[item.label] || (item.label + ':'), item.value, item.href)
        );
      }

      // Show custom domain propagation note when any custom domain is set
      if (config.apiDomain || config.loginUiDomain || config.adminUiDomain) {
        const domainNoteDiv = document.createElement('div');
        domainNoteDiv.className = 'hint-box';
        domainNoteDiv.style.marginTop = '0.75rem';
        domainNoteDiv.setAttribute('data-i18n', 'web.complete.customDomainNote');
        domainNoteDiv.textContent = t('web.complete.customDomainNote');
        urlsEl.appendChild(domainNoteDiv);
      }

      // Create Admin Setup section (separate, prominent box)
      resetDynamicCompleteSections();

      const adminSetupSection = document.createElement('div');
      adminSetupSection.id = 'complete-admin-setup-section';
      adminSetupSection.style.cssText = 'margin-top: 1.5rem; padding: 1.25rem; background: linear-gradient(135deg, rgba(37, 99, 235, 0.1) 0%, rgba(59, 130, 246, 0.05) 100%); border: 2px solid var(--primary); border-radius: 12px;';

      if (result && result.setupUrl) {
        // Format expiration time
        let expiresText = 'in 1 hour';
        if (result.expiresAt) {
          const expiresDate = new Date(result.expiresAt);
          const month = expiresDate.getMonth() + 1;
          const day = expiresDate.getDate();
          const hours = expiresDate.getHours().toString().padStart(2, '0');
          const minutes = expiresDate.getMinutes().toString().padStart(2, '0');
          expiresText = \`\${month}/\${day} \${hours}:\${minutes}\`;
        }

        // Header row
        const headerDiv = document.createElement('div');
        headerDiv.style.cssText = 'display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem;';
        const iconSpan = document.createElement('span');
        iconSpan.style.fontSize = '1.5rem';
        iconSpan.textContent = '🔐';
        const titleH4 = document.createElement('h4');
        titleH4.style.cssText = 'margin: 0; font-size: 1.1rem; font-weight: 600; color: var(--primary);';
        titleH4.textContent = t('web.complete.adminAccountTitle');
        titleH4.setAttribute('data-i18n', 'web.complete.adminAccountTitle');
        const importantBadge = document.createElement('span');
        importantBadge.style.cssText = 'background: var(--warning); color: white; font-size: 0.7rem; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 600;';
        importantBadge.textContent = t('web.complete.adminAccountImportant');
        importantBadge.setAttribute('data-i18n', 'web.complete.adminAccountImportant');
        headerDiv.appendChild(iconSpan);
        headerDiv.appendChild(titleH4);
        headerDiv.appendChild(importantBadge);

        // Description
        const descP = document.createElement('p');
        descP.style.cssText = 'margin: 0 0 0.75rem; font-size: 0.9rem; color: var(--text-muted);';
        descP.textContent = t('web.complete.adminAccountDesc');
        descP.setAttribute('data-i18n', 'web.complete.adminAccountDesc');

        // URL input + copy button row
        const inputRow = document.createElement('div');
        inputRow.style.cssText = 'display: flex; gap: 0.5rem; align-items: center;';
        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.value = result.setupUrl;
        urlInput.readOnly = true;
        urlInput.style.cssText = 'flex: 1; min-width: 200px; padding: 0.625rem 0.75rem; border: 1px solid var(--border); border-radius: 8px; font-family: var(--font-mono); font-size: 0.8rem; background: var(--card-bg); color: var(--text);';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn-secondary';
        copyBtn.style.whiteSpace = 'nowrap';
        copyBtn.textContent = t('web.complete.copy');
        copyBtn.setAttribute('data-i18n', 'web.complete.copy');
        const setupUrlForCopy = result.setupUrl;
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(setupUrlForCopy);
          copyBtn.removeAttribute('data-i18n'); // prevent updateAllTranslations from overwriting "Copied"
          copyBtn.textContent = t('web.complete.copied');
          setTimeout(() => {
            copyBtn.textContent = t('web.complete.copy');
            copyBtn.setAttribute('data-i18n', 'web.complete.copy');
          }, 2000);
        });
        inputRow.appendChild(urlInput);
        inputRow.appendChild(copyBtn);

        // Open Setup button
        const openDiv = document.createElement('div');
        openDiv.style.cssText = 'text-align: center; margin-top: 1rem;';
        const openLink = document.createElement('a');
        openLink.href = result.setupUrl;
        openLink.target = '_blank';
        openLink.className = 'btn-primary';
        openLink.textContent = t('web.complete.openSetup');
        openLink.setAttribute('data-i18n', 'web.complete.openSetup');
        openDiv.appendChild(openLink);

        // Warning hint with limited rich text from trusted translations.
        const hintDiv = document.createElement('div');
        hintDiv.className = 'hint-box';
        hintDiv.style.marginTop = '0.75rem';
        const warningPrefix = document.createTextNode('⚠️ ');
        hintDiv.appendChild(warningPrefix);
        const warningSpan = document.createElement('span');
        appendTranslatedRichText(warningSpan, 'web.complete.urlWarning', { date: expiresText });
        hintDiv.appendChild(warningSpan);

        adminSetupSection.appendChild(headerDiv);
        adminSetupSection.appendChild(descP);
        adminSetupSection.appendChild(inputRow);
        adminSetupSection.appendChild(openDiv);
        adminSetupSection.appendChild(hintDiv);
      } else {
        // Header row
        const headerDiv = document.createElement('div');
        headerDiv.style.cssText = 'display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;';
        const iconSpan = document.createElement('span');
        iconSpan.style.fontSize = '1.5rem';
        iconSpan.textContent = '🔐';
        const titleH4 = document.createElement('h4');
        titleH4.style.cssText = 'margin: 0; font-size: 1.1rem; font-weight: 600; color: var(--text-muted);';
        titleH4.textContent = t('web.complete.adminAccountTitle');
        titleH4.setAttribute('data-i18n', 'web.complete.adminAccountTitle');
        headerDiv.appendChild(iconSpan);
        headerDiv.appendChild(titleH4);

        const descP = document.createElement('p');
        descP.style.cssText = 'margin: 0; font-size: 0.9rem; color: var(--text-muted);';
        descP.textContent = t('web.complete.adminSetupUnavailable');
        descP.setAttribute('data-i18n', 'web.complete.adminSetupUnavailable');

        adminSetupSection.appendChild(headerDiv);
        adminSetupSection.appendChild(descP);

        if (result && result.adminSetupDebug) {
          const debug = result.adminSetupDebug;
          const debugP = document.createElement('p');
          debugP.style.cssText = 'margin: 0.5rem 0 0; font-size: 0.85rem;';
          if (debug.alreadyCompleted) {
            debugP.style.color = 'var(--text-muted)';
            debugP.textContent = t('web.complete.adminSetupUnavailable');
            debugP.setAttribute('data-i18n', 'web.complete.adminSetupUnavailable');
          } else if (debug.error) {
            debugP.style.color = 'var(--error)';
            debugP.textContent = 'Error: ' + debug.error;
          }
          if (debugP.textContent) adminSetupSection.appendChild(debugP);
        }
      }
      urlsEl.parentNode.insertBefore(adminSetupSection, urlsEl.nextSibling);

      setStep(8);
      showSection('complete');
    }

    // Resource naming functions
    function getResourceNames(env) {
      // Keys are stored in external directory: .authrim-keys/{env}/
      const keysDir = workingDirectory ? workingDirectory + '/.authrim-keys/' + env : '.authrim-keys/' + env;
      return {
        d1: [
          env + '-authrim-core-db',
          env + '-authrim-pii-db',
          env + '-authrim-admin-db'
        ],
        kv: [
          env + '-CLIENTS_CACHE',
          env + '-INITIAL_ACCESS_TOKENS',
          env + '-SETTINGS',
          env + '-REBAC_CACHE',
          env + '-USER_CACHE',
          env + '-AUTHRIM_CONFIG',
          env + '-TENANT_RUNTIME_REGISTRY',
          env + '-STATE_STORE',
          env + '-CONSENT_CACHE'
        ],
        queues: [
          env + '-audit-queue',
          env + '-logging-delivery-critical-queue',
          env + '-logging-delivery-queue',
          env + '-logging-delivery-bulk-queue'
        ],
        keys: [
          keysDir + '/private.pem (RSA Private Key)',
          keysDir + '/public.jwk.json (JWK Public Key)',
          keysDir + '/rp_token_encryption_key.txt',
          keysDir + '/object_encryption_root_key.txt',
          keysDir + '/version_manager_secret.txt',
          keysDir + '/admin_api_secret.txt',
          keysDir + '/key_manager_secret.txt',
          keysDir + '/setup_machine_private.pem',
          keysDir + '/setup_machine_public.jwk.json',
          keysDir + '/admin_ui_bff_private.pem',
          keysDir + '/admin_ui_bff_public.jwk.json',
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
      const queueList = document.getElementById('preview-queues');
      const queueCategory = document.getElementById('preview-queues-category');
      const keysList = document.getElementById('preview-keys');

      d1List.innerHTML = '';
      kvList.innerHTML = '';
      queueList.innerHTML = '';
      keysList.innerHTML = '';

      // Get region info from config
      const coreRegion = config.database?.core || { location: 'auto', jurisdiction: 'none' };
      const piiRegion = config.database?.pii || { location: 'auto', jurisdiction: 'none' };

      // D1 databases with region info
      const coreDbName = env + '-authrim-core-db';
      const piiDbName = env + '-authrim-pii-db';
      const adminDbName = env + '-authrim-admin-db';
      // admin-db uses the same region as pii-db (both contain sensitive data)
      const adminRegion = piiRegion;

      appendDatabasePreviewItem(d1List, coreDbName, getRegionLabel(coreRegion.location, coreRegion.jurisdiction));
      appendDatabasePreviewItem(d1List, piiDbName, getRegionLabel(piiRegion.location, piiRegion.jurisdiction));
      appendDatabasePreviewItem(d1List, adminDbName, getRegionLabel(adminRegion.location, adminRegion.jurisdiction));
      if (config.profiles?.defaults?.storage === 'builtin:storage:tenant-d1') {
        const slots = config.tenantD1?.preallocatedSlots || 3;
        const li = document.createElement('li');
        li.textContent = 'Preallocated tenant D1 slots: ' + slots + ' (' + (slots * 2) + ' D1 databases)';
        li.style.color = 'var(--text-muted)';
        d1List.appendChild(li);
      }

      resources.kv.forEach(name => {
        const li = document.createElement('li');
        li.textContent = name;
        kvList.appendChild(li);
      });

      const queueEnabled = config.features?.queue?.enabled === true;
      queueCategory.style.display = queueEnabled ? 'block' : 'none';
      if (queueEnabled) {
        resources.queues.forEach(name => {
          const li = document.createElement('li');
          li.textContent = name;
          queueList.appendChild(li);
        });
      }

      resources.keys.forEach(name => {
        const li = document.createElement('li');
        li.textContent = name;
        keysList.appendChild(li);
      });
    }

    function appendDatabasePreviewItem(list, dbName, regionLabel) {
      const li = document.createElement('li');
      li.appendChild(document.createTextNode(dbName + ' '));
      const regionSpan = document.createElement('span');
      regionSpan.style.cssText = 'color: var(--text-muted); font-size: 0.85em;';
      regionSpan.textContent = '(' + regionLabel + ')';
      li.appendChild(regionSpan);
      list.appendChild(li);
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

      // Calculate auto-generated URLs (use workersSubdomain if available for full-form URL)
      const workersDomain = workersSubdomain
        ? env + '-ar-router.' + workersSubdomain + '.workers.dev'
        : env + '-ar-router.workers.dev';
      const loginUiWorkerDomain = workersSubdomain
        ? env + '-ar-login-ui.' + workersSubdomain + '.workers.dev'
        : env + '-ar-login-ui.workers.dev';
      const adminUiWorkerDomain = workersSubdomain
        ? env + '-ar-admin-ui.' + workersSubdomain + '.workers.dev'
        : env + '-ar-admin-ui.workers.dev';
      const apiCustomUrl = config.apiDomain || null;
      const loginUiCustomUrl = config.loginUiDomain || null;
      const adminUiCustomUrl = config.adminUiDomain || null;

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
            custom: apiCustomUrl,
            // api.auto must always be the workers.dev URL (used for proxy backend and CORS).
            // The custom domain (issuer URL) belongs in api.custom, not api.auto.
            auto: 'https://' + workersDomain,
            zoneId: config.zoneId || null,
            customDomainBinding: config.customDomainBinding === true,
          },
          loginUi: {
            custom: loginUiCustomUrl,
            auto: 'https://' + loginUiWorkerDomain,
            sameAsApi: Boolean(apiCustomUrl && loginUiCustomUrl === apiCustomUrl),
          },
          adminUi: {
            custom: adminUiCustomUrl,
            auto: 'https://' + adminUiWorkerDomain,
            sameAsApi: Boolean(apiCustomUrl && adminUiCustomUrl === apiCustomUrl),
          },
        },
        tenant: {
          name: config.tenant?.name || 'default',
          displayName: config.tenant?.displayName || 'Initial Tenant',
          multiTenant: config.tenant?.multiTenant || false,
          baseDomain: config.tenant?.baseDomain || undefined,
          nakedDomain: config.tenant?.nakedDomain ?? false,
          userIdFormat: config.tenant?.userIdFormat || 'nanoid',
          primaryTenant: config.tenant?.primaryTenant || undefined,
        },
        components: {
          api: true,
          ...(config.components || {}),
          loginUi: config.components?.loginUi ?? true,
          adminUi: config.components?.adminUi ?? true,
          saml: true,
          async: true,
          vc: true,
          bridge: true,
          policy: true,
        },
        keys: {
          secretsPath: (workingDirectory || '.') + '/.authrim-keys/' + config.env + '/',
          storageType: 'external',
        },
        database: config.database || {
          core: { location: 'auto', jurisdiction: 'none' },
          pii: { location: 'auto', jurisdiction: 'none' },
        },
        profiles: config.profiles || buildProfilesConfig('builtin:storage:shared-d1'),
        features: {
          queue: {
            enabled: config.features?.queue?.enabled === true,
          },
          r2: {
            enabled: config.features?.r2?.enabled !== false,
          },
          email: {
            provider: config.email?.provider || 'none',
            fromAddress: config.email?.fromAddress || undefined,
            fromName: config.email?.fromName || undefined,
            configured: config.email?.provider && config.email?.provider !== 'none' ? true : false,
          },
        },
      };

      // Remove undefined values for cleaner output
      if (!configToSave.tenant.baseDomain) {
        delete configToSave.tenant.baseDomain;
      }
      if (!configToSave.tenant.primaryTenant) {
        delete configToSave.tenant.primaryTenant;
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
      a.download = 'authrim-' + env + '-config.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    // Save config button handlers
    document.getElementById('btn-save-config-provision').addEventListener('click', saveConfigToFile);
    document.getElementById('btn-save-config-complete').addEventListener('click', saveConfigToFile);

    // Back to main button (from complete screen)
    document.getElementById('btn-back-to-main').addEventListener('click', async () => {
      await resetSetupFlowState();
      showSection('topMenu');
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
      selectedEnvDetailConfig = null;

      document.getElementById('detail-env-name').textContent = env.env;
      renderEnvDetailUrls(env);
      loadEnvEmailStatus(env.env);
      document.getElementById('env-email-progress').classList.add('hidden');
      document.getElementById('env-email-log').textContent = '';
      document.getElementById('btn-enable-cloudflare-email').disabled = false;
      const enableCloudflareBtnSpan = document
        .getElementById('btn-enable-cloudflare-email')
        ?.querySelector('span');
      if (enableCloudflareBtnSpan) {
        enableCloudflareBtnSpan.textContent =
          t('web.envDetail.emailEnableCloudflare') || 'Enable Cloudflare Email Service';
      }

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

      document.getElementById('env-tenant-d1-progress').classList.add('hidden');
      document.getElementById('env-tenant-d1-log').textContent = '';
      loadTenantD1PoolStatus(env.env);
      document.getElementById('env-r2-provision-progress').classList.add('hidden');
      document.getElementById('env-r2-provision-log').textContent = '';
      document.getElementById('btn-provision-r2-buckets').disabled = false;
      loadR2ProvisionStatus(env.env);

      // Reset and load worker version comparison
      resetWorkerUpdateUI();
      loadWorkerVersionComparison(env.env);

      showSection('envDetail');

      // Load details asynchronously
      loadResourceDetails(env);
    }

    function stripTrailingSlash(url) {
      const value = String(url || '');
      return value.endsWith('/') ? value.slice(0, -1) : value;
    }

    function stripProtocol(urlOrDomain) {
      return String(urlOrDomain || '').trim().replace(/^https?:[/][/]/, '').replace(/[/]+$/, '');
    }

    function ensureHttpsUrl(urlOrDomain) {
      const normalized = stripProtocol(urlOrDomain);
      return normalized ? 'https://' + normalized : '';
    }

    function firstConfiguredValue(...values) {
      for (const value of values) {
        const normalized = String(value || '').trim();
        if (normalized) return normalized;
      }
      return '';
    }

    function firstConfiguredUrl(...values) {
      const value = firstConfiguredValue(...values);
      return value ? stripTrailingSlash(ensureHttpsUrl(value)) : '';
    }

    function isMultiTenantConfigured(config) {
      return !!(
        config &&
        config.tenant &&
        config.tenant.multiTenant === true &&
        config.tenant.baseDomain &&
        String(config.tenant.baseDomain).trim()
      );
    }

    function createEnvDetailUrlRow(label, value, description, href) {
      const row = document.createElement('div');
      row.style.cssText = 'display: flex; flex-direction: column; gap: 0.35rem; padding: 0.875rem 1rem; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;';

      const top = document.createElement('div');
      top.style.cssText = 'display: flex; justify-content: space-between; gap: 1rem; align-items: center; flex-wrap: wrap;';

      const labelEl = document.createElement('div');
      labelEl.style.cssText = 'font-weight: 600;';
      labelEl.textContent = label;
      top.appendChild(labelEl);

      if (href) {
        const open = document.createElement('a');
        open.href = href;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        open.className = 'btn-secondary';
        open.style.cssText = 'padding: 0.35rem 0.75rem; font-size: 0.8rem; white-space: nowrap;';
        open.textContent = 'Open';
        top.appendChild(open);
      }

      const urlEl = href ? document.createElement('a') : document.createElement('div');
      if (href) {
        urlEl.href = href;
        urlEl.target = '_blank';
        urlEl.rel = 'noopener noreferrer';
        urlEl.style.cssText = 'font-family: var(--font-mono); font-size: 0.85rem; color: var(--primary); word-break: break-all;';
      } else {
        urlEl.style.cssText = 'font-family: var(--font-mono); font-size: 0.85rem; color: var(--text-muted); word-break: break-all;';
      }
      urlEl.textContent = value;

      row.appendChild(top);
      row.appendChild(urlEl);

      if (description) {
        const descEl = document.createElement('div');
        descEl.style.cssText = 'font-size: 0.8rem; color: var(--text-muted);';
        descEl.textContent = description;
        row.appendChild(descEl);
      }

      return row;
    }

    function hasUiWorker(env, workerName) {
      return (env.workers || []).some((worker) => worker && worker.name === workerName);
    }

    function resolveEnvDetailIssuerUrl(env, config) {
      const envName = env.env;
      const workersDomain = workersSubdomain
        ? envName + '-ar-router.' + workersSubdomain + '.workers.dev'
        : envName + '-ar-router.workers.dev';
      const fallbackIssuer = 'https://' + workersDomain;

      if (isMultiTenantConfigured(config)) {
        const tenantName = (config.tenant.name || 'default').trim();
        const baseDomain = String(config.tenant.baseDomain).trim();
        return config.tenant.nakedDomain === true
          ? 'https://' + baseDomain
          : 'https://' + tenantName + '.' + baseDomain;
      }

      const apiUrl = firstConfiguredUrl(
        config?.urls?.api?.custom,
        config?.apiDomain,
        config?.urls?.api?.auto
      );
      return apiUrl ? stripTrailingSlash(apiUrl) : fallbackIssuer;
    }

    function resolveEnvDetailSharedLoginBase(env, config) {
      const envName = env.env;
      const fallbackLoginWorkerUrl = workersSubdomain
        ? 'https://' + envName + '-ar-login-ui.' + workersSubdomain + '.workers.dev'
        : 'https://' + envName + '-ar-login-ui.workers.dev';
      return firstConfiguredUrl(
        config?.urls?.loginUi?.custom,
        config?.loginUiDomain,
        config?.urls?.loginUi?.auto,
        fallbackLoginWorkerUrl
      );
    }

    function isWorkersDevUrl(url) {
      try {
        const hostname = new URL(url).hostname;
        return hostname === 'workers.dev' || hostname.endsWith('.workers.dev');
      } catch {
        return false;
      }
    }

    function resolveEnvDetailAdminBase(env, config) {
      const envName = env.env;
      const fallbackAdminWorkerUrl = workersSubdomain
        ? 'https://' + envName + '-ar-admin-ui.' + workersSubdomain + '.workers.dev'
        : 'https://' + envName + '-ar-admin-ui.workers.dev';
      return firstConfiguredUrl(
        config?.urls?.adminUi?.custom,
        config?.adminUiDomain,
        config?.urls?.adminUi?.auto,
        fallbackAdminWorkerUrl
      );
    }

    function buildEnvDetailUrls(env, config) {
      const envName = env.env;
      const loginProjectName = envName + '-ar-login-ui';
      const adminProjectName = envName + '-ar-admin-ui';
      const loginUiDeployed = hasUiWorker(env, loginProjectName);
      const adminUiDeployed = hasUiWorker(env, adminProjectName);
      const multiTenantConfigured = isMultiTenantConfigured(config);
      const issuerUrl = resolveEnvDetailIssuerUrl(env, config);
      const apiHealthUrl = issuerUrl + '/api/health';
      const discoveryUrl = issuerUrl + '/.well-known/openid-configuration';
      const loginSharedBaseUrl = resolveEnvDetailSharedLoginBase(env, config);
      const adminBaseUrl = resolveEnvDetailAdminBase(env, config);
      const loginEntryUrl = loginUiDeployed
        ? (
            multiTenantConfigured || config?.urls?.loginUi?.sameAsApi === true
              ? issuerUrl
              : loginSharedBaseUrl
          ) + '/login'
        : null;
      const tenantDiscoverBaseUrl =
        multiTenantConfigured && config?.tenant?.baseDomain
          ? (
              config?.urls?.loginUi?.sameAsApi !== true &&
              loginSharedBaseUrl &&
              !isWorkersDevUrl(loginSharedBaseUrl)
                ? loginSharedBaseUrl
                : 'https://' + String(config.tenant.baseDomain).trim()
            )
          : loginSharedBaseUrl;
      const tenantDiscoverUrl = multiTenantConfigured && loginUiDeployed
        ? tenantDiscoverBaseUrl + '/discover'
        : null;
      const adminEntryUrl = adminUiDeployed
        ? (
            config?.urls?.adminUi?.sameAsApi === true
              ? issuerUrl
              : adminBaseUrl
          ) + '/admin/info'
        : null;
      const notDeployed = t('web.envDetail.notDeployed') || 'Not Deployed';

      const urls = [
        {
          label: 'Issuer',
          value: issuerUrl,
          href: null,
          description: 'Canonical OIDC issuer value',
        },
        {
          label: 'API Health',
          value: apiHealthUrl,
          href: apiHealthUrl,
          description: 'API router health check',
        },
        {
          label: 'OIDC Discovery',
          value: discoveryUrl,
          href: discoveryUrl,
          description: 'OpenID Provider metadata endpoint',
        },
        {
          label: 'Login UI',
          value: loginEntryUrl || notDeployed,
          href: loginEntryUrl,
          description: multiTenantConfigured
            ? 'Tenant login entry point'
            : 'Login screen entry point',
        },
        {
          label: 'Admin UI',
          value: adminEntryUrl || notDeployed,
          href: adminEntryUrl,
          description: 'Admin console entry point',
        },
      ];

      if (tenantDiscoverUrl) {
        urls.splice(2, 0, {
          label: 'Tenant Discovery',
          value: tenantDiscoverUrl,
          href: tenantDiscoverUrl,
          description: 'Shared login entry point for tenant selection',
        });
      }

      return urls;
    }

    async function renderEnvDetailUrls(env) {
      const listEl = document.getElementById('detail-url-list');
      listEl.textContent = '';

      let config = null;
      try {
        const configResponse = await api('/config?env=' + encodeURIComponent(env.env));
        if (configResponse.exists && configResponse.config) {
          config = configResponse.config;
        }
      } catch (error) {
        console.warn('Failed to load config for env detail URLs:', error);
      }

      const urls = buildEnvDetailUrls(env, config);
      for (const item of urls) {
        listEl.appendChild(createEnvDetailUrlRow(item.label, item.value, item.description, item.href));
      }
    }

    function renderEnvEmailStatus(configResponse) {
      const providerEl = document.getElementById('env-email-provider');
      const statusEl = document.getElementById('env-email-status');
      const fromEl = document.getElementById('env-email-from');
      const fromAddressInput = document.getElementById('env-email-from-address');
      const fromNameInput = document.getElementById('env-email-from-name');
      const emailConfig = configResponse?.config?.features?.email || null;
      const provider = emailConfig?.provider || 'none';
      const configured = emailConfig?.configured === true;
      const fromAddress = emailConfig?.fromAddress || '';
      const fromName = emailConfig?.fromName || '';

      selectedEnvDetailConfig = configResponse?.config || null;

      providerEl.textContent =
        provider === 'none'
          ? (t('web.envDetail.emailProviderNone') || 'Not configured')
          : provider;
      statusEl.textContent = configured
        ? (t('web.envDetail.emailConfigured') || 'Configured')
        : (t('web.envDetail.emailNotConfigured') || 'Not configured');
      fromEl.textContent = fromAddress || '—';

      fromAddressInput.value = fromAddress;
      fromNameInput.value = fromName;
    }

    async function loadEnvEmailStatus(envName) {
      try {
        const configResponse = await api('/config?env=' + encodeURIComponent(envName));
        if (configResponse.exists && configResponse.config) {
          renderEnvEmailStatus(configResponse);
          return;
        }
      } catch (error) {
        console.warn('Failed to load env email config:', error);
      }

      renderEnvEmailStatus(null);
    }

    function renderTenantD1PoolStatus(response) {
      const summaryEl = document.getElementById('env-tenant-d1-summary');
      const statsEl = document.getElementById('env-tenant-d1-stats');
      const expandEl = document.getElementById('env-tenant-d1-expand');
      const addInput = document.getElementById('env-tenant-d1-add-slots');

      if (!response || !response.success) {
        summaryEl.textContent = response?.error || 'Failed to load tenant storage status.';
        statsEl.classList.add('hidden');
        expandEl.classList.add('hidden');
        return;
      }

      const pool = response.tenantD1Pool || {};
      if (!pool.enabled) {
        summaryEl.textContent =
          'Shared D1 mode: tenant additions use the existing deployment-wide core/PII D1 databases. No pool expansion is required.';
        statsEl.classList.add('hidden');
        expandEl.classList.add('hidden');
        return;
      }

      expandEl.classList.remove('hidden');
      const configuredSlots = Number(pool.configuredSlots || pool.capacity || 0);
      const maxAdd = Math.max(0, 500 - configuredSlots);
      addInput.max = String(maxAdd || 1);
      if (Number(addInput.value || '1') > maxAdd && maxAdd > 0) {
        addInput.value = String(maxAdd);
      }

      if (!pool.tableReady) {
        summaryEl.textContent =
          'Tenant D1 pool is configured, but slot inventory is not available yet. Run deployment to create slots and publish inventory.';
        statsEl.classList.add('hidden');
        document.getElementById('btn-expand-tenant-d1-pool').disabled = maxAdd <= 0;
        return;
      }

      const counts = pool.counts || {};
      document.getElementById('env-tenant-d1-capacity').textContent = String(pool.capacity ?? 0);
      document.getElementById('env-tenant-d1-available').textContent = String(pool.available ?? 0);
      document.getElementById('env-tenant-d1-assigned').textContent = String(counts.assigned || 0);
      document.getElementById('env-tenant-d1-reset-required').textContent = String(
        counts.reset_required || 0
      );
      summaryEl.textContent =
        'Tenant D1 pool mode: Admin UI can add tenants while available slots remain. Expand only when capacity is low or exhausted.';
      statsEl.classList.remove('hidden');
      document.getElementById('btn-expand-tenant-d1-pool').disabled = maxAdd <= 0;
    }

    async function loadTenantD1PoolStatus(envName) {
      const summaryEl = document.getElementById('env-tenant-d1-summary');
      summaryEl.textContent = 'Loading tenant storage status...';
      try {
        const response = await api('/tenant-d1/pool/' + encodeURIComponent(envName) + '/status');
        renderTenantD1PoolStatus(response);
      } catch (error) {
        renderTenantD1PoolStatus({ success: false, error: error.message });
      }
    }

    async function expandTenantD1PoolForEnv() {
      if (!selectedEnvForDetail) {
        alert('No environment selected');
        return;
      }

      const envName = selectedEnvForDetail.env;
      const addSlots = Number.parseInt(
        document.getElementById('env-tenant-d1-add-slots').value || '0',
        10
      );
      if (!Number.isInteger(addSlots) || addSlots < 1) {
        alert('Enter a positive slot count.');
        return;
      }

      const confirmed = confirm(
        'This will update the environment config, create additional tenant D1 databases, refresh Worker bindings, and redeploy workers. Continue?'
      );
      if (!confirmed) return;

      const btn = document.getElementById('btn-expand-tenant-d1-pool');
      const progressDiv = document.getElementById('env-tenant-d1-progress');
      const logDiv = document.getElementById('env-tenant-d1-log');
      btn.disabled = true;
      progressDiv.classList.remove('hidden');
      logDiv.textContent = '';

      const addLog = (message) => {
        const line = document.createElement('div');
        line.textContent = message;
        logDiv.appendChild(line);
        logDiv.scrollTop = logDiv.scrollHeight;
      };

      let pollInterval = null;
      try {
        addLog('Updating Tenant D1 pool config...');
        const expansion = await api('/tenant-d1/pool/' + encodeURIComponent(envName) + '/expand', {
          method: 'POST',
          body: { addSlots },
        });
        if (!expansion.success) {
          throw new Error(expansion.error || 'Failed to update Tenant D1 pool config');
        }
        addLog('Configured slots: ' + expansion.currentSlots + ' -> ' + expansion.nextSlots);
        addLog('Starting deployment...');

        let lastProgressLength = 0;
        pollInterval = setInterval(async () => {
          try {
            const statusResult = await api('/deploy/status');
            if (statusResult.progress && statusResult.progress.length > lastProgressLength) {
              const newMessages = statusResult.progress.slice(lastProgressLength);
              newMessages.forEach(addLog);
              lastProgressLength = statusResult.progress.length;
            }
          } catch (error) {
            // Ignore transient polling errors while deploy is running.
          }
        }, 1000);

        const deployResult = await api('/deploy', {
          method: 'POST',
          body: {
            env: envName,
            dryRun: false,
          },
        });

        if (!deployResult.success) {
          throw new Error(deployResult.error || 'Deployment failed');
        }

        addLog('✅ Tenant D1 pool expansion completed.');
        await loadTenantD1PoolStatus(envName);
        await loadWorkerVersionComparison(envName);
      } catch (error) {
        addLog('❌ ' + error.message);
      } finally {
        if (pollInterval !== null) {
          clearInterval(pollInterval);
        }
        btn.disabled = false;
      }
    }

    function renderR2ProvisionStatus(response) {
      const summaryEl = document.getElementById('env-r2-provision-summary');
      const provisionBtn = document.getElementById('btn-provision-r2-buckets');

      if (!response || !response.success) {
        summaryEl.textContent = response?.error || 'Failed to load R2 bucket status.';
        provisionBtn.disabled = false;
        return;
      }

      if (response.enabled) {
        summaryEl.textContent =
          'R2 buckets are configured: ' + response.configured + ' / ' + response.required + '.';
        provisionBtn.disabled = true;
        return;
      }

      summaryEl.textContent =
        'R2 buckets need provisioning: ' +
        response.configured +
        ' / ' +
        response.required +
        ' configured.';
      provisionBtn.disabled = false;
    }

    async function loadR2ProvisionStatus(envName) {
      const summaryEl = document.getElementById('env-r2-provision-summary');
      summaryEl.textContent = 'Loading R2 bucket status...';
      try {
        const response = await api('/r2/' + encodeURIComponent(envName) + '/status');
        renderR2ProvisionStatus(response);
      } catch (error) {
        renderR2ProvisionStatus({ success: false, error: error.message });
      }
    }

    async function provisionR2BucketsForEnv() {
      if (!selectedEnvForDetail) {
        alert('No environment selected');
        return;
      }

      const envName = selectedEnvForDetail.env;
      const confirmed = confirm(
        'This will create missing R2 buckets, refresh Worker bindings, and redeploy workers. Continue?'
      );
      if (!confirmed) return;

      const btn = document.getElementById('btn-provision-r2-buckets');
      const progressDiv = document.getElementById('env-r2-provision-progress');
      const logDiv = document.getElementById('env-r2-provision-log');
      btn.disabled = true;
      progressDiv.classList.remove('hidden');
      logDiv.textContent = '';

      const addLog = (message) => {
        const line = document.createElement('div');
        line.textContent = message;
        logDiv.appendChild(line);
        logDiv.scrollTop = logDiv.scrollHeight;
      };

      let pollInterval = null;
      try {
        addLog('Provisioning R2 buckets...');
        const provisionResult = await api('/r2/' + encodeURIComponent(envName) + '/provision', {
          method: 'POST',
        });
        if (!provisionResult.success) {
          throw new Error(provisionResult.error || 'Failed to provision R2 buckets');
        }
        addLog('Configured buckets: ' + provisionResult.buckets.length);
        addLog('Starting deployment...');

        let lastProgressLength = 0;
        pollInterval = setInterval(async () => {
          try {
            const statusResult = await api('/deploy/status');
            if (statusResult.progress && statusResult.progress.length > lastProgressLength) {
              const newMessages = statusResult.progress.slice(lastProgressLength);
              newMessages.forEach(addLog);
              lastProgressLength = statusResult.progress.length;
            }
          } catch (error) {
            // Ignore transient polling errors while deploy is running.
          }
        }, 1000);

        const deployResult = await api('/deploy', {
          method: 'POST',
          body: {
            env: envName,
            dryRun: false,
          },
        });

        if (!deployResult.success) {
          throw new Error(deployResult.error || 'Deployment failed');
        }

        addLog('✅ R2 bucket provisioning completed.');
        await loadR2ProvisionStatus(envName);
        await loadWorkerVersionComparison(envName);
      } catch (error) {
        addLog('❌ ' + error.message);
        btn.disabled = false;
      } finally {
        if (pollInterval !== null) {
          clearInterval(pollInterval);
        }
      }
    }

    async function enableCloudflareEmailForEnv() {
      if (!selectedEnvForDetail) {
        alert('No environment selected');
        return;
      }

      const btn = document.getElementById('btn-enable-cloudflare-email');
      const btnSpan = btn.querySelector('span');
      const progressDiv = document.getElementById('env-email-progress');
      const logDiv = document.getElementById('env-email-log');
      const fromAddress = document.getElementById('env-email-from-address').value.trim();
      const fromName = document.getElementById('env-email-from-name').value.trim();
      const currentProvider = selectedEnvDetailConfig?.features?.email?.provider;

      if (!fromAddress) {
        alert(t('web.envDetail.emailFromMissing') || 'Please enter a From email address.');
        return;
      }

      const emailInput = document.getElementById('env-email-from-address');
      if (emailInput && !emailInput.checkValidity()) {
        alert(t('web.envDetail.emailFromInvalid') || 'Please enter a valid email address.');
        return;
      }

      if (
        currentProvider &&
        currentProvider !== 'none' &&
        currentProvider !== 'cloudflare' &&
        !confirm(
          t('web.envDetail.emailSwitchProviderConfirm') ||
            'This environment already has another email provider configured. Switch it to Cloudflare Email Service?'
        )
      ) {
        return;
      }

      btn.disabled = true;
      if (btnSpan) {
        btnSpan.textContent = t('web.envDetail.emailDeploying') || 'Applying...';
      }
      progressDiv.classList.remove('hidden');
      logDiv.textContent = '';

      const addLog = (msg) => {
        const line = document.createElement('div');
        line.textContent = msg;
        logDiv.appendChild(line);
        logDiv.scrollTop = logDiv.scrollHeight;
      };

      try {
        addLog(t('web.envDetail.emailStarting') || 'Starting Cloudflare Email setup...');
        const response = await api('/env/email/cloudflare/enable', {
          method: 'POST',
          body: {
            env: selectedEnvForDetail.env,
            fromAddress,
            fromName,
          },
        });

        if (response.progress && Array.isArray(response.progress)) {
          for (const msg of response.progress) {
            addLog(msg);
          }
        }

        if (!response.success) {
          addLog('');
          addLog('❌ ' + (response.error || (t('web.envDetail.emailUpdateFailed') || 'Failed')));
          return;
        }

        addLog('');
        addLog('✅ ' + (t('web.envDetail.emailUpdatedSuccess') || 'Cloudflare Email enabled.'));
        await loadEnvEmailStatus(selectedEnvForDetail.env);
        resetWorkerUpdateUI();
        await loadWorkerVersionComparison(selectedEnvForDetail.env);
      } catch (error) {
        addLog('❌ ' + error.message);
      } finally {
        btn.disabled = false;
        if (btnSpan) {
          btnSpan.textContent =
            t('web.envDetail.emailEnableCloudflare') || 'Enable Cloudflare Email Service';
        }
      }
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
      loadingCell.colSpan = 5;
      loadingCell.style.cssText = 'text-align: center; padding: 1rem; color: var(--text-muted);';
      loadingCell.textContent = t('web.status.loading');
      loadingRow.appendChild(loadingCell);
      tbody.appendChild(loadingRow);
      document.getElementById('update-summary').textContent = '';
      document.getElementById('btn-update-workers').disabled = true;
      document.getElementById('worker-update-progress').classList.add('hidden');
      document.getElementById('worker-update-log').textContent = '';
      // Also reset UI update progress
      document.getElementById('ui-update-progress')?.classList.add('hidden');
      document.getElementById('ui-update-log') && (document.getElementById('ui-update-log').textContent = '');
    }

    function updateWorkerUpdateButtonState() {
      const updateButton = document.getElementById('btn-update-workers');
      const onlyChangedCheckbox = document.getElementById('update-only-changed');

      if (!updateButton || !onlyChangedCheckbox) {
        return;
      }

      if (workerVersionComparison.length === 0) {
        updateButton.disabled = true;
        return;
      }

      const onlyChanged = onlyChangedCheckbox.checked;
      const hasUpdates = workerVersionComparison.some((item) => item.needsUpdate);
      updateButton.disabled = onlyChanged ? !hasUpdates : false;
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
          updateWorkerUpdateButtonState();
        } else {
          tbody.textContent = '';
          const errorRow = document.createElement('tr');
          const errorCell = document.createElement('td');
          errorCell.colSpan = 5;
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
        errorCell.colSpan = 5;
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
        emptyCell.colSpan = 5;
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

        // Action column with individual update button
        const tdAction = document.createElement('td');
        tdAction.style.cssText = 'padding: 0.5rem; text-align: center;';

        const updateBtn = document.createElement('button');
        updateBtn.className = 'btn-sm';
        updateBtn.style.cssText = 'padding: 0.25rem 0.5rem; font-size: 0.75rem; cursor: pointer; border: 1px solid var(--primary); background: transparent; color: var(--primary); border-radius: 4px;';
        updateBtn.textContent = '⬆️';
        updateBtn.title = t('web.envDetail.updateThis') || 'Update this component';
        updateBtn.onclick = () => updateSingleComponent(item.component);
        tdAction.appendChild(updateBtn);
        tr.appendChild(tdAction);

        tbody.appendChild(tr);
      }
    }

    function startWorkerDeployStatusPolling(addLog) {
      let lastProgressLength = 0;
      const interval = setInterval(async () => {
        try {
          const statusResult = await api('/deploy/status');
          const progress = statusResult.progress || [];
          if (progress.length < lastProgressLength) {
            lastProgressLength = 0;
          }
          if (progress.length > lastProgressLength) {
            const newMessages = progress.slice(lastProgressLength);
            newMessages.forEach((msg) => addLog(msg));
            lastProgressLength = progress.length;
          }
        } catch (e) {
          // Ignore transient polling errors while deployment is running.
        }
      }, 1000);

      return {
        stop: () => clearInterval(interval),
        getLastProgressLength: () => lastProgressLength
      };
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
        const poller = startWorkerDeployStatusPolling(addLog);

        let response;
        try {
          response = await api('/update/workers', {
            method: 'POST',
            body: JSON.stringify({
              env: currentEnvForUpdate,
              onlyChanged: onlyChanged
            })
          });
        } finally {
          poller.stop();
        }

        if (response.progress && Array.isArray(response.progress)) {
          for (const msg of response.progress.slice(poller.getLastProgressLength())) {
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
          if (response.manualAction?.kind === 'wildcard-dns' && response.manualAction.baseDomain) {
            addLog('');
            buildWildcardDnsManualMessage(response.manualAction.baseDomain)
              .split('\\n')
              .forEach((line) => addLog(line));
          }
        }
      } catch (error) {
        addLog('❌ Error: ' + error.message);
      } finally {
        updateWorkerUpdateButtonState();
        const btnSpan2 = btn.querySelector('span');
        if (btnSpan2) btnSpan2.textContent = t('web.envDetail.updateAllWorkers') || 'Update All Workers';
      }
    }

    // Update a single worker component
    async function updateSingleComponent(componentName) {
      if (!currentEnvForUpdate) {
        alert('No environment selected');
        return;
      }

      const progressDiv = document.getElementById('worker-update-progress');
      const logDiv = document.getElementById('worker-update-log');

      progressDiv.classList.remove('hidden');
      logDiv.textContent = '';

      const addLog = (msg) => {
        const line = document.createElement('div');
        line.textContent = msg;
        logDiv.appendChild(line);
        logDiv.scrollTop = logDiv.scrollHeight;
      };

      addLog('Updating ' + componentName + ' for ' + currentEnvForUpdate + '...');

      try {
        const poller = startWorkerDeployStatusPolling(addLog);
        let response;
        try {
          response = await api('/deploy/component/' + encodeURIComponent(componentName), {
            method: 'POST',
            body: JSON.stringify({
              env: currentEnvForUpdate,
              skipBuild: true,
              dryRun: false
            })
          });
        } finally {
          poller.stop();
        }

        if (response.progress && Array.isArray(response.progress)) {
          for (const msg of response.progress.slice(poller.getLastProgressLength())) {
            addLog(msg);
          }
        }

        if (response.success) {
          addLog('');
          addLog('✅ ' + componentName + ' updated successfully!');
          if (response.workerName) addLog('  Worker: ' + response.workerName);
          if (response.version) addLog('  Version: ' + response.version);
          if (response.deployedAt) addLog('  Deployed at: ' + response.deployedAt);

          // Refresh version table
          await loadWorkerVersionComparison(currentEnvForUpdate);
        } else {
          addLog('');
          addLog('❌ Update failed: ' + (response.error || 'Unknown error'));
        }
      } catch (error) {
        addLog('❌ Error: ' + error.message);
      }
    }

    // Update UI component (Workers)
    async function updateUIComponent(componentName) {
      if (!currentEnvForUpdate) {
        alert('No environment selected');
        return;
      }

      const btn = componentName === 'ar-admin-ui'
        ? document.getElementById('btn-update-admin-ui')
        : document.getElementById('btn-update-login-ui');
      const progressDiv = document.getElementById('ui-update-progress');
      const logDiv = document.getElementById('ui-update-log');

      // Disable button and show progress
      btn.disabled = true;
      const originalText = btn.querySelector('span').textContent;
      btn.querySelector('span').textContent = t('web.status.deploying') || 'Updating...';
      progressDiv.classList.remove('hidden');
      logDiv.textContent = '';

      const addLog = (msg) => {
        const line = document.createElement('div');
        line.textContent = msg;
        logDiv.appendChild(line);
        logDiv.scrollTop = logDiv.scrollHeight;
      };

      addLog('Updating ' + componentName + ' for ' + currentEnvForUpdate + '...');
      addLog('This may take a few minutes (building and deploying to Workers)...');

      try {
        const poller = startWorkerDeployStatusPolling(addLog);
        let response;
        try {
          response = await api('/deploy/component/' + encodeURIComponent(componentName), {
            method: 'POST',
            body: JSON.stringify({
              env: currentEnvForUpdate,
              skipBuild: false,
              dryRun: false
            })
          });
        } finally {
          poller.stop();
        }

        if (response.progress && Array.isArray(response.progress)) {
          for (const msg of response.progress.slice(poller.getLastProgressLength())) {
            addLog(msg);
          }
        }

        if (response.success) {
          addLog('');
          addLog('✅ ' + componentName + ' updated successfully!');
          if (response.projectName) addLog('  Project: ' + response.projectName);
          if (response.deployedAt) addLog('  Deployed at: ' + response.deployedAt);
        } else {
          addLog('');
          addLog('❌ Update failed: ' + (response.error || 'Unknown error'));
        }
      } catch (error) {
        addLog('❌ Error: ' + error.message);
      } finally {
        btn.disabled = false;
        btn.querySelector('span').textContent = originalText;
      }
    }

    // Event listeners for Worker Update
    document.getElementById('btn-update-workers')?.addEventListener('click', startWorkerUpdate);
    document.getElementById('update-only-changed')?.addEventListener('change', () => {
      updateWorkerUpdateButtonState();
    });
    document.getElementById('btn-refresh-versions')?.addEventListener('click', () => {
      if (currentEnvForUpdate) {
        resetWorkerUpdateUI();
        loadWorkerVersionComparison(currentEnvForUpdate);
      }
    });

    // Event listeners for UI Update
    document.getElementById('btn-update-admin-ui')?.addEventListener('click', () => updateUIComponent('ar-admin-ui'));
    document.getElementById('btn-update-login-ui')?.addEventListener('click', () => updateUIComponent('ar-login-ui'));
    document.getElementById('btn-enable-cloudflare-email')?.addEventListener('click', enableCloudflareEmailForEnv);
    document.getElementById('btn-refresh-tenant-d1-pool')?.addEventListener('click', () => {
      if (selectedEnvForDetail) {
        loadTenantD1PoolStatus(selectedEnvForDetail.env);
      }
    });
    document.getElementById('btn-expand-tenant-d1-pool')?.addEventListener('click', expandTenantD1PoolForEnv);
    document.getElementById('btn-refresh-r2-buckets')?.addEventListener('click', () => {
      if (selectedEnvForDetail) {
        loadR2ProvisionStatus(selectedEnvForDetail.env);
      }
    });
    document.getElementById('btn-provision-r2-buckets')?.addEventListener('click', provisionR2BucketsForEnv);

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

        // Determine base URL: prefer custom domain from config, fallback to workers.dev
        let baseUrl = '';

        // Try to load config to get custom API domain
        try {
          const configResponse = await api('/config?env=' + encodeURIComponent(selectedEnvForDetail.env));
          if (configResponse.exists && configResponse.config) {
            baseUrl = configResponse.config.urls?.api?.custom || configResponse.config.urls?.api?.auto || '';
          }
        } catch (e) {
          // Config not available, will fallback to workers.dev
        }

        // Fallback to workers.dev URL if no config URL found
        if (!baseUrl) {
          const router = selectedEnvForDetail.workers.find(w =>
            w.name.toLowerCase().includes('router')
          );
          if (router && router.name) {
            if (workersSubdomain) {
              baseUrl = 'https://' + router.name + '.' + workersSubdomain + '.workers.dev';
            } else {
              baseUrl = 'https://' + router.name + '.workers.dev';
            }
          } else {
            baseUrl = prompt('Enter the base URL for the router (e.g., https://myenv-ar-router.subdomain.workers.dev):');
            if (!baseUrl) {
              btn.disabled = false;
              btn.textContent = '🔐 Start Admin Account Setup with Passkey';
              return;
            }
          }
        }

        const response = await api('/admin/generate-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kvNamespaceId: configKv.id,
            baseUrl: baseUrl,
            env: selectedEnvForDetail.env,
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
          setTimeout(async () => {
            await resetServerState();
            resetDeleteSection();
            selectedEnvForDelete = null;
            selectedEnvForDetail = null;
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
