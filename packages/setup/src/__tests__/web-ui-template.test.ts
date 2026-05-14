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
    expect(html).toContain('テナントID');
    expect(html).toContain(
      'テナント識別子です。1〜63文字で、先頭は小文字の英字、使用できるのは小文字英字・数字・ハイフンです。URLに使わない場合でも内部設定に使います。'
    );
    expect(html).toContain('テナントURLの見え方');
    expect(html).toContain('ID des ersten Tenants');
    expect(html).toContain("copyByLocale[locale.split('-')[0]]");
    expect(html).toContain('copyByLocale.en');
  });

  it('renders the tenant ID input editable by default', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain(
      '<input type="text" id="tenant-name" placeholder="default" value="default"'
    );
    expect(html).toContain(
      '<button type="button" id="tenant-name-random" class="btn-secondary">Generate Random</button>'
    );
    expect(html).toContain('function generateRandomTenantIdInBrowser()');
    expect(html).toContain('start with a lowercase letter');
    expect(html).toContain('1-63 characters');
    expect(html).not.toContain(
      '<input type="text" id="tenant-name" placeholder="default" value="default" disabled readonly'
    );
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
    expect(html).toContain(
      "copyTextWithFeedback(document.getElementById('keys-copy-btn'), keysPath)"
    );
  });

  it('renders copy buttons for detailed progress logs', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('.progress-log-copy-btn');
    expect(html).toContain('id="provision-log-copy-btn"');
    expect(html).toContain('id="deploy-log-copy-btn"');
    expect(html).toContain('id="delete-log-copy-btn"');
    expect(html).toContain("setupLogCopyButton('provision-log-copy-btn', 'provision-output')");
    expect(html).toContain("setupLogCopyButton('deploy-log-copy-btn', 'deploy-output')");
    expect(html).toContain("setupLogCopyButton('delete-log-copy-btn', 'delete-output')");
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
    expect(html).toContain('"review":"Review"');
    expect(html).toContain('"review":"需确认"');
    expect(html).toContain('createPrereqCustomDomainReviewAlert');
    expect(html).toContain('domain.prereq.reviewTitle');
    expect(html).toContain('domain.action.reloadPage');
  });

  it('renders structured zone diagnostics with action buttons', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('class="domain-check-status"');
    expect(html).toContain('createZoneDiagnosticAlert');
    expect(html).toContain('createZoneActionButton');
    expect(html).toContain('Open Cloudflare Dashboard');
    expect(html).toContain('Custom-domain checks need a quick review');
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
