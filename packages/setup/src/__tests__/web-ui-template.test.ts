import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { WILDCARD_DNS_MANUAL_COPY } from '../core/wildcard-dns-manual-action.js';
import de from '../i18n/locales/de.js';
import en from '../i18n/locales/en.js';
import es from '../i18n/locales/es.js';
import fr from '../i18n/locales/fr.js';
import id from '../i18n/locales/id.js';
import ja from '../i18n/locales/ja.js';
import ko from '../i18n/locales/ko.js';
import pt from '../i18n/locales/pt.js';
import ru from '../i18n/locales/ru.js';
import zhCN from '../i18n/locales/zh-CN.js';
import zhTW from '../i18n/locales/zh-TW.js';
import { SUPPORTED_LOCALES } from '../i18n/types.js';
import { SETUP_WEB_FONT_FACE } from '../web/ui-fonts.js';
import { getHtmlTemplate } from '../web/ui.js';
import { SETUP_WEB_UI_STYLE } from '../web/ui-style.js';

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
  const localeCases = [
    { locale: 'en', translations: en, expected: 'Choose How to Start' },
    { locale: 'ja', translations: ja, expected: '開始方法を選択' },
    { locale: 'zh-CN', translations: zhCN, expected: '选择开始方式' },
    { locale: 'zh-TW', translations: zhTW, expected: '選擇開始方式' },
    { locale: 'es', translations: es, expected: 'Elige cómo empezar' },
    { locale: 'pt', translations: pt, expected: 'Escolha como começar' },
    { locale: 'fr', translations: fr, expected: 'Choisir comment démarrer' },
    { locale: 'de', translations: de, expected: 'Startmethode wählen' },
    { locale: 'ko', translations: ko, expected: '시작 방법 선택' },
    { locale: 'ru', translations: ru, expected: 'Выберите способ начала' },
    { locale: 'id', translations: id, expected: 'Pilih cara memulai' },
  ] as const;

  it('renders start screen and step hero copy for every supported locale', () => {
    expect(localeCases.map((entry) => entry.locale).sort()).toEqual(
      SUPPORTED_LOCALES.map((entry) => entry.code).sort()
    );

    for (const { locale, translations, expected } of localeCases) {
      const html = getHtmlTemplate(
        'session-token',
        false,
        locale,
        translations as Record<string, string>,
        SUPPORTED_LOCALES
      );

      expect(html).toContain(`<html lang="${locale}">`);
      expect(html).toContain(expected);
      expect(html).toContain('const _setupUiCopy =');
      expect(html).toContain('function refreshSetupCopyElements()');
      expect(html).toContain('data-setup-copy="startNewTitle"');
    }
  });

  it('resolves every setup web UI translation key for every supported locale', () => {
    const keyPattern = /^[a-z][a-z0-9]*(\.[a-zA-Z0-9_-]+)+$/;
    const collectMatches = (html: string, regex: RegExp) => {
      const keys = new Set<string>();
      let match: RegExpExecArray | null;
      while ((match = regex.exec(html)) !== null) {
        if (keyPattern.test(match[1])) keys.add(match[1]);
      }
      return keys;
    };

    for (const { locale, translations } of localeCases) {
      const html = getHtmlTemplate(
        'session-token',
        false,
        locale,
        translations as Record<string, string>,
        SUPPORTED_LOCALES
      );
      const usedKeys = new Set<string>([
        ...collectMatches(html, /data-i18n="([^"]+)"/g),
        ...collectMatches(html, /data-i18n-placeholder="([^"]+)"/g),
        ...collectMatches(html, /data-i18n-title="([^"]+)"/g),
        ...collectMatches(html, /t\('([^']+)'/g),
      ]);
      const fallbackKeys = collectMatches(
        html,
        /['"]([a-z][a-z0-9]*(?:\.[a-zA-Z0-9_-]+)+)['"]\s*:/g
      );
      const missing = [...usedKeys].filter(
        (key) =>
          !(key in translations) &&
          !fallbackKeys.has(key) &&
          !key.startsWith('setup.step.') &&
          !key.startsWith('setup.start.')
      );

      expect(missing, `${locale} missing translations`).toEqual([]);
    }
  });

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
      '<input class="f-input" type="text" id="tenant-name" placeholder="default" value="default"'
    );
    expect(html).toContain(
      '<button type="button" id="tenant-name-random" class="btn btn-ghost sm" data-i18n="web.domain.generateRandom">Generate Random</button>'
    );
    expect(html).toContain('function generateRandomTenantIdInBrowser()');
    expect(html).toContain('start with a lowercase letter');
    expect(html).toContain('1-63 characters');
    expect(html).not.toContain(
      '<input class="f-input" type="text" id="tenant-name" placeholder="default" value="default" disabled readonly'
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

  it('renders the Classic setup chrome from the extracted stylesheet', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).not.toContain('<style></style>');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
    expect(html).toContain('Public Sans');
    expect(html).toContain('Spline Sans Mono');
    expect(html).toContain('class="setup-masthead"');
    expect(html).toContain('class="setup-wordmark">Authrim<sup>SETUP</sup>');
    expect(html).toContain('class="setup-hero setup-enter"');
    expect(html).toContain('class="setup-prereq-section setup-section-enter"');
    expect(html).toContain('function replaySetupEntrance(section)');
    expect(html).toContain("hero.classList.add('setup-enter')");
    expect(html).toContain("section.classList.add('setup-section-enter')");
    expect(html).toContain('id="setup-hero-number"');
    expect(html).toContain('data-label="Prepare"');
    expect(html).toContain('data-label="Complete"');
    expect(html).toContain('id="step-9"');
    expect(html).toContain('for (let i = 1; i <= 9; i++)');
    expect(html).toContain("el.className = 'step ' + (i < step ? 'step-complete'");
    expect(html).toContain('class="modepanel primary" id="menu-new-setup"');
    expect(html).toContain('class="modepanel" id="menu-load-config"');
    expect(html).not.toContain('class="modepanel selected" id="menu-load-config"');
    expect(html).not.toContain('Continue after the checks pass');
    expect(html).not.toContain('Preparation is complete');
    expect(html).not.toContain('Check complete');
    expect(html).not.toContain('wrangler login and re-check');
    expect(html).not.toContain('API Token Permissions');
    expect(html).not.toContain('APIトークン権限');
    expect(html).not.toContain('prereq-capability-checks');
    expect(html).not.toContain('Workers Scripts:Edit');
    expect(html).not.toContain('D1:Edit');
    expect(html).not.toContain('Zone DNS:Edit');
    expect(html).not.toContain('saved locally');
    expect(html).toContain('placeholder="prod, main, tokyo, acme-dev"');
    expect(html).not.toContain('value="prod" data-i18n-placeholder="web.form.envNamePlaceholder"');
    expect(html).not.toContain("document.getElementById('env').value = 'prod'");
    expect(html).not.toContain('class="mp-num">02 — A</span>');
    expect(html).not.toContain('class="mp-num">02 — B</span>');
    expect(html).not.toContain('class="mp-num">02 — C</span>');
    expect(html).toContain('<span class="st"></span>');
    expect(html).toContain("status.textContent = '';");
    expect(html).not.toContain('status.textContent = isSelected');
    expect(html).not.toContain('Detected environments');
    expect(html).not.toContain('last scan');
    expect(html).not.toContain('setup-runtime-meta');
    expect(html).not.toContain('setup-auth-status');
    expect(html).not.toContain('root-level');
    expect(html).not.toContain('both supported');
    expect(html).not.toContain('Progress</td>');
    expect(html).not.toContain("components.saml ? 'SAML'");
    expect(html).toContain('confirmLoadedConfigEnvironmentConflict');
    expect(html).toContain('function formatEnvironmentExistsAlert(envName, existingEnv)');
    expect(html).toContain("t('env.alreadyExists', { env: envName })");
    expect(html).toContain('別の名前を選択するか、「環境を管理する」から先に削除してください。');
    expect(html).not.toContain(
      'Please choose a different name or use "Manage Environments" to delete it first.'
    );
    expect(html).toContain("spinner.className = 'check-spinner'");
    expect(html).toContain('updateEnvCardIssuerFromConfig');
    expect(html).toContain('resolveEnvDetailIssuerUrl(env, configResponse.config)');
    expect(html).toContain('class="env-loading-indicator"');
    expect(html).toContain("row.className = 'e-kv e-kv-issuer'");
    expect(html).not.toContain("className = 'e-st");
    expect(html).not.toContain('admin-badge');
    expect(html).toContain('if (response.adminSetupCompleted) {');
    expect(html).toContain("section.classList.add('hidden');");
    expect(html).not.toContain('If every administrator is locked out');
    expect(html).not.toContain('管理者が全員ロックアウト');
    expect(html).toContain('class="setup-recap"');
    expect(html).toContain('data-i18n="web.common.setupTool">Setup Tool</span> v0.3.2');
    expect(html).not.toContain('Mock list');
    expect(html).not.toContain('v0.9.4');
    expect(html).not.toContain('4分12秒で完了');
    expect(html).not.toContain('completed in 4m');
    expect(html).not.toContain('構成は authrim-config.json に記録済みです。');
    expect(html).not.toContain('Configuration was recorded in authrim-config.json.');
    expect(html).not.toContain('14 Worker・3 D1・9 KVのデプロイがすべてエラーなしで完了しました。');
    expect(html).not.toContain(
      '14 Workers, 3 D1 databases, and 9 KV namespaces completed without errors.'
    );
    expect(html).not.toContain('管理者をパスキーで登録');
    expect(html).not.toContain('OAuthクライアントを作成');
    expect(html).not.toContain('アプリにOIDCを設定');
    expect(html).not.toContain('適合性テストを実行');
    expect(html).not.toContain('Register the administrator with a passkey');
    expect(html).not.toContain('Create an OAuth client');
    expect(html).not.toContain('Configure OIDC in your app');
    expect(html).not.toContain('Run conformance tests');
    expect(html).toContain('function getCompleteHeroAside()');
    expect(html).toContain("const workerLabel = t('web.envDetail.workers');");
    expect(html).toContain("const completeLabel = t('web.status.complete')");
    expect(html).toContain('const hasDeploySummary = hasApiSummary || hasUiSummary;');
    expect(html).toContain('const success = hasDeploySummary ? apiSuccess + uiSuccess : 0;');
    expect(html).toContain('if (!workers.hasDeploySummary) {');
    expect(html).not.toContain('<div class="mode-icon">🆕</div>');
    expect(html).not.toContain('<div class="mode-icon">📂</div>');
    expect(html).not.toContain('<div class="mode-icon">⚙️</div>');
    expect(html).toContain('function runThemeTransition(newTheme)');
    expect(html).toContain('window.requestAnimationFrame(applyTheme)');
    expect(html).toContain('themeTransitionCleanupTimer = window.setTimeout');
    expect(html).toContain("'theme-transition-to-dark'");
    expect(html).toContain("'theme-transition-to-light'");
    expect(SETUP_WEB_UI_STYLE).toContain('--paper: #f9f8f3');
    expect(SETUP_WEB_UI_STYLE).toContain('--fill-strong: #234168');
    expect(SETUP_WEB_UI_STYLE).toContain('@keyframes authrim-rise');
    expect(SETUP_WEB_UI_STYLE).toContain('@keyframes authrim-dusk');
    expect(SETUP_WEB_UI_STYLE).toContain('@keyframes authrim-dawn');
    expect(SETUP_WEB_UI_STYLE).toContain('html.theme-transitioning::after');
    expect(SETUP_WEB_UI_STYLE).toContain('html.theme-transitioning *');
    expect(SETUP_WEB_UI_STYLE).toContain('transition-duration: 1800ms !important;');
    expect(SETUP_WEB_UI_STYLE).not.toContain('html.theme-transitioning .setup-wordmark');
    expect(SETUP_WEB_UI_STYLE).not.toContain('html.theme-transitioning .setup-hero-title');
    expect(SETUP_WEB_UI_STYLE).not.toContain('radial-gradient(circle at 18% 12%');
    expect(SETUP_WEB_UI_STYLE).toContain('.setup-hero.setup-enter .setup-hero-number');
    expect(SETUP_WEB_UI_STYLE).toContain('.setup-section-enter .row');
    expect(SETUP_WEB_UI_STYLE).toContain('.setup-section-enter .modepanel:nth-child(3)');
    expect(SETUP_WEB_UI_STYLE).toContain('.setup-masthead');
    expect(SETUP_WEB_UI_STYLE).toContain('.setup-hero');
    expect(SETUP_WEB_UI_STYLE).toContain('.rowlabel .idx');
    expect(SETUP_WEB_UI_STYLE).toContain('.domain-row .domain-default');
    expect(SETUP_WEB_UI_STYLE).toContain('.fieldset.domain-row');
    expect(SETUP_WEB_UI_STYLE).toContain('#tenant-url-examples td');
    expect(SETUP_WEB_UI_STYLE).toContain('overflow-wrap: anywhere');
    expect(SETUP_WEB_UI_STYLE).toContain('.inline-input-row .f-input');
    expect(SETUP_WEB_UI_STYLE).toContain('[data-theme="dark"] .step-active');
    expect(SETUP_WEB_UI_STYLE).toContain('[data-theme="dark"] .step-complete');
    expect(SETUP_WEB_UI_STYLE).toContain('[data-theme="dark"] .checkitem.on:not(.lock) .sq');
    expect(SETUP_WEB_UI_STYLE).toContain('[data-theme="dark"] .radiocard.on .dot');
    expect(SETUP_WEB_UI_STYLE).toContain('[data-theme="dark"] .switchline:has(input:checked) .sw');
    expect(SETUP_WEB_UI_STYLE).toContain('.region .dot::before');
    expect(SETUP_WEB_UI_STYLE).toContain(
      '[data-theme="dark"] .region:has(input:checked) .dot::before'
    );
    expect(SETUP_WEB_UI_STYLE).toContain('.modepanel:hover');
    expect(SETUP_WEB_UI_STYLE).toContain('.step-complete::before');
    expect(SETUP_WEB_UI_STYLE).toContain('[data-theme="dark"] .modal-content');
    expect(SETUP_WEB_UI_STYLE).toContain(
      'background: color-mix(in srgb, var(--card) 94%, var(--paper));'
    );
    expect(SETUP_WEB_UI_STYLE).not.toContain('.st.pass::before');
    expect(SETUP_WEB_UI_STYLE).toContain(
      'grid-template-columns: 72px minmax(0, 1fr) minmax(260px, max-content);'
    );
    expect(SETUP_WEB_UI_STYLE).toContain('.checkline:not(.loading) .st');
    expect(SETUP_WEB_UI_STYLE).toContain('.env-management-surface .tab.on .cnt');
    expect(SETUP_WEB_FONT_FACE).toContain('@font-face');
    expect(SETUP_WEB_FONT_FACE).toContain('/assets/fonts/');
    expect(SETUP_WEB_FONT_FACE).not.toContain('fonts.gstatic.com');
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

    expect(html).toContain('data-i18n="web.domain.loginUiOrigin"');
    expect(html).toContain('data-i18n="web.preview.tenantDiscover"');
    expect(html).toContain('preview-component-badge');
    expect(html).toContain('data-i18n="web.preview.conflictWarningTitle"');
    expect(html).toContain('⚠️ Configuration issue');
    expect(html).toContain(
      '</div>\n' +
        '            <div id="preview-config-warning" class="hint-box error-hint" style="display:none;" role="alert">'
    );
    expect(html).toContain(
      "tenantDiscoverTable.textContent = 'https://' + loginUiBase + '/discover'"
    );
    expect(html).toContain("previewAdmin.textContent = 'https://' + adminUiBase + '/admin'");
    expect(html).toContain("adminApiModeEl.textContent = 'cross-site-proxy'");
    expect(html).toContain('id="preview-admin">{env}-ar-admin-ui.workers.dev</td>');
    expect(html).not.toContain('id="preview-workers"');
    expect(html).not.toContain('Login UI (Worker):');
    expect(html).not.toContain('id="section-mode"');
    expect(html).not.toContain('id="mode-quick"');
  });

  it('renders Login UI and Admin UI as selectable components while advanced API components stay hidden', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('class="checkitem lock"');
    expect(html).toContain('data-i18n="web.config.apiRequired"');
    expect(html).toContain('data-i18n="web.config.apiDesc"');
    expect(html).toContain('data-i18n="web.comp.loginUiDesc"');
    expect(html).toContain('data-i18n="web.comp.adminUiDesc"');
    expect(html).not.toContain('Login UI (ar-login-ui)');
    expect(html).not.toContain('Admin UI (ar-admin-ui)');
    expect(html).not.toContain('They can also be deployed later from environment management.');
    expect(html).not.toContain(
      'UUIDs are only recommended when preserving existing external IDs during migration.'
    );
    expect(html).not.toContain('id="comp-api"');
    expect(html).toContain('id="comp-login-ui"');
    expect(html).toContain('id="comp-admin-ui"');
    expect(html).toContain("document.getElementById('comp-login-ui')");
    expect(html).toContain("document.getElementById('comp-admin-ui')");
    expect(html).not.toContain('<div class="standard-component-title">');
    expect(html).not.toContain('standard-component-badge');
    expect(html).not.toContain('<span class="preview-component-badge">SAML IdP</span>');
    expect(html).not.toContain('<span class="preview-component-badge">Device Flow/CIBA</span>');
    expect(html).not.toContain('<span class="preview-component-badge">VC SD-JWT</span>');
    expect(html).not.toContain("'SAML IdP', 'Device Flow/CIBA', 'VC SD-JWT'");
    expect(html).toContain('loginUi: loginUiEnabled');
    expect(html).toContain('adminUi: adminUiEnabled');
  });

  it('renders Cloudflare Queues as an explicit disabled-by-default setup choice', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('id="feature-queue-enabled"');
    expect(html).toContain('Disabled by default');
    expect(html).toContain('data-i18n="features.queuePrompt"');
    expect(html).toContain('data-i18n="web.email.queuePlanGuide"');
    expect(html).toContain('data-i18n="web.email.queueResourceNote"');
    expect(html).toContain('class="setup-email-section hidden"');
    expect(html).toContain('class="radiocard email-choice-card"');
    expect(html).toContain('value="later" checked');
    expect(html).not.toContain('value="resend" checked');
    expect(html).toContain(
      'class="region auto-region"><input type="radio" name="db-core-location" value="auto" checked>'
    );
    expect(html).toContain(
      'class="region auto-region"><input type="radio" name="db-pii-location" value="auto" checked>'
    );
    expect(html).toContain('data-i18n="web.db.storageProfileDesc"');
    expect(SETUP_WEB_UI_STYLE).toContain('.topo tr');
    expect(SETUP_WEB_UI_STYLE).toContain('.region.auto-region');
    expect(SETUP_WEB_UI_STYLE).toContain('.db-profile-card .st');
    expect(SETUP_WEB_UI_STYLE).toContain('.email-choice-card .st');
    expect(html).toContain('queue: { enabled: false }');
    expect(html).toContain('createQueues: config.features?.queue?.enabled === true');
  });

  it('renders the keys saved panel with classic styles and a copy button', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('id="keys-saved-info" class="cred"');
    expect(html).toContain('class="c-v" id="keys-path"');
    expect(html).toContain('.authrim-keys/prod/');
    expect(html).not.toContain('.authrim/prod/keys/');
    expect(html).toContain('class="copy" id="keys-copy-btn"');
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
    expect(html).not.toContain('id="provision-ledger"');
    expect(SETUP_WEB_UI_STYLE).toContain('.provgrid-progress-only');
    expect(SETUP_WEB_UI_STYLE).toContain('scroll-behavior: smooth;');
    expect(html).toContain("const target = element.querySelector?.('pre') || element;");
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
