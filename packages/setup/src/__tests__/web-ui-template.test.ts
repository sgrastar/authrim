import { describe, expect, it } from 'vitest';
import en from '../i18n/locales/en.js';
import { SUPPORTED_LOCALES } from '../i18n/types.js';
import { getHtmlTemplate } from '../web/ui.js';

describe('getHtmlTemplate', () => {
  it('embeds multilingual API domain copy for dynamic tenant URL hints', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'ja',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('<html lang="ja">');
    expect(html).toContain('最初のテナントID');
    expect(html).toContain('テナントURLの見え方');
    expect(html).toContain('ID des ersten Tenants');
    expect(html).toContain("copyByLocale[locale.split('-')[0]]");
    expect(html).toContain('copyByLocale.en');
  });

  it('renders the keys saved panel with dark-mode styles and a copy button', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('.keys-saved-box');
    expect(html).toContain('[data-theme="dark"] .keys-saved-box');
    expect(html).toContain('class="keys-path-code" id="keys-path"');
    expect(html).toContain('class="btn-secondary keys-copy-btn" id="keys-copy-btn"');
    expect(html).toContain('data-copy-label');
    expect(html).toContain("copyTextWithFeedback(document.getElementById('keys-copy-btn'), keysPath)");
  });

  it('renders prerequisite capability list styles and client-side renderer', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('.prereq-capability-list');
    expect(html).toContain('.prereq-capability-pill.ok');
    expect(html).toContain('.prereq-capability-pill.review');
    expect(html).toContain('function renderPrereqCapabilities(container, result)');
    expect(html).toContain('Estimated Feature Availability');
    expect(html).toContain('PREREQ_CAPABILITY_COPY');
    expect(html).toContain('\"review\":\"Review\"');
    expect(html).toContain('\"review\":\"需确认\"');
  });

  it('embeds manual wildcard DNS guidance for deploy warnings', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'ja',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('function getWildcardDnsManualCopy()');
    expect(html).toContain('deploy-manual-wildcard-warning');
    expect(html).toContain('deploy-manual-wildcard-dashboard-link');
    expect(html).toContain('deploy-manual-wildcard-docs-link');
    expect(html).toContain('deploy-manual-wildcard-example-image');
    expect(html).toContain('manual-guide-visual');
    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain('ワイルドカード DNS の手動設定が必要です');
    expect(html).toContain('Manual wildcard DNS setup is required');
    expect(html).toContain('WILDCARD_DNS_MANUAL_COPY_DATA');
    expect(html).toContain('CLOUDFLARE_DNS_RECORDS_DOCS');
  });

  it('downloads config files with the environment name in the filename', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain("a.download = 'authrim-' + env + '-config.json';");
  });
});
