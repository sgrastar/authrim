import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { WILDCARD_DNS_MANUAL_COPY } from '../core/wildcard-dns-manual-action.js';
import en from '../i18n/locales/en.js';
import { SUPPORTED_LOCALES } from '../i18n/types.js';
import { getHtmlTemplate } from '../web/ui.js';

function extractInlineScripts(html: string): string[] {
  const scripts: string[] = [];
  const lower = html.toLowerCase();
  let offset = 0;

  while (offset < html.length) {
    const openStart = lower.indexOf('<script', offset);
    if (openStart < 0) {
      break;
    }

    const openEnd = html.indexOf('>', openStart);
    if (openEnd < 0) {
      break;
    }

    const closeStart = lower.indexOf('</script', openEnd + 1);
    if (closeStart < 0) {
      break;
    }

    const closeEnd = html.indexOf('>', closeStart);
    if (closeEnd < 0) {
      break;
    }

    scripts.push(html.slice(openEnd + 1, closeStart));
    offset = closeEnd + 1;
  }

  return scripts;
}

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

  it('embeds browser-safe domain helpers without dev-transform helpers', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('function isValidCustomDomain(domain)');
    expect(html).toContain('function validateSetupDomainInputs(input)');
    expect(html).toContain('function computeApiDomainUiState(input)');
    expect(html).not.toContain('__name');
  });

  it('emits syntactically valid inline browser scripts', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );
    const scripts = extractInlineScripts(html);

    expect(scripts.length).toBeGreaterThan(0);
    scripts.forEach((script, index) => {
      expect(() => new vm.Script(script, { filename: `setup-inline-${index}.js` })).not.toThrow();
    });
  });

  it('extracts inline browser scripts with case and closing tag whitespace variants', () => {
    const scripts = extractInlineScripts(
      '<SCRIPT type="module">const first = 1;</script ><script>const second = 2;</SCRIPT>'
    );

    expect(scripts).toEqual(['const first = 1;', 'const second = 2;']);
  });

  it('renders multi-tenant preview labels and access paths consistently', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('Login UI Origin:');
    expect(html).toContain('preview-component-badge');
    expect(html).toContain('grid-template-columns: var(--preview-label-width) minmax(0, 1fr)');
    expect(html).toContain('data-i18n="web.preview.conflictWarningTitle"');
    expect(html).toContain('⚠️ Configuration issue');
    expect(html).toContain('setPreviewValue(');
    expect(html).toContain("'https://' + loginUiBase,");
    expect(html).toContain("'https://' + (loginDomain || baseDomain) + '/discover'");
    expect(html).toContain("'/admin/info");
    expect(html).not.toContain('id="preview-workers"');
    expect(html).not.toContain('Login UI (Worker):');
    expect(html).not.toContain('id="section-mode"');
    expect(html).not.toContain('id="mode-quick"');
  });

  it('renders core components as standard items without setup checkboxes', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('standard-component-title');
    expect(html).toContain('data-i18n="web.config.apiRequired"');
    expect(html).toContain('data-i18n="web.comp.loginUi"');
    expect(html).toContain('data-i18n="web.comp.adminUi"');
    expect(html).not.toContain('id="comp-api"');
    expect(html).not.toContain('id="comp-login-ui"');
    expect(html).not.toContain('id="comp-admin-ui"');
    expect(html).not.toContain("document.getElementById('comp-login-ui')");
    expect(html).not.toContain("document.getElementById('comp-admin-ui')");
    expect(html).not.toContain('standard-component-badge');
    expect(html).not.toContain('<span class="preview-component-badge">SAML IdP</span>');
    expect(html).not.toContain('<span class="preview-component-badge">Device Flow/CIBA</span>');
    expect(html).not.toContain('<span class="preview-component-badge">VC SD-JWT</span>');
    expect(html).not.toContain("'SAML IdP', 'Device Flow/CIBA', 'VC SD-JWT'");
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

  it('uses monotonic phase-based deployment progress instead of log-count percentages', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('function createDeployProgressTracker()');
    expect(html).toContain("setProgress(68, 'Verifying Worker deployments...')");
    expect(html).toContain("Deploying API Workers (' + completed + '/' + expectedWorkers + ')");
    expect(html).not.toContain("Processing... ' + completedCount + ' steps completed");
    expect(html).not.toContain('totalComponents = Math.max');
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
    expect(html).toContain('id="login-domain-zone-status"');
    expect(html).toContain('id="admin-domain-zone-status"');
    expect(html).toContain('function uiDomainRequiresOwnRoute(domain)');
    expect(html).toContain("checkUiCustomDomainZone('login'");
    expect(html).toContain("checkUiCustomDomainZone('admin'");
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
    expect(html).toContain('Cloudflare Edge 証明書も必要です');
    expect(html).toContain('Certificate note: a Cloudflare Edge certificate must also cover');
    expect(Object.keys(WILDCARD_DNS_MANUAL_COPY).sort()).toEqual(
      SUPPORTED_LOCALES.map((locale) => locale.code).sort()
    );
    for (const locale of SUPPORTED_LOCALES) {
      const copy = WILDCARD_DNS_MANUAL_COPY[locale.code];
      const steps = copy.steps(
        '{zoneName}',
        '*.{baseDomain}',
        '{baseDomain}',
        '{dashboardRecordName}'
      );
      expect(html).toContain(steps.at(-1));
    }
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
