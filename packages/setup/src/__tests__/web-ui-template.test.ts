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
import { CONTROL_OPERATION_RESULT_TRANSLATION_KEYS, getHtmlTemplate } from '../web/ui.js';
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

function extractInlineObject(
  html: string,
  variableName: string
): Record<string, Record<string, string> | string[]> {
  const marker = `const ${variableName} = `;
  const markerIndex = html.indexOf(marker);
  const objectStart = html.indexOf('{', markerIndex);
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  expect(markerIndex, `${variableName} declaration`).toBeGreaterThanOrEqual(0);
  expect(objectStart, `${variableName} object`).toBeGreaterThanOrEqual(0);

  for (let index = objectStart; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) {
      return vm.runInNewContext(`(${html.slice(objectStart, index + 1)})`);
    }
  }

  throw new Error(`Could not extract ${variableName}`);
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

  it('localizes Control operation outcomes, R2 recovery, and progress copy', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'ja',
      ja as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(CONTROL_OPERATION_RESULT_TRANSLATION_KEYS).toMatchObject({
      succeeded: 'web.control.operationSucceeded',
      awaiting_quarantine: 'web.control.operationAwaitingQuarantine',
      blocked: 'web.control.operationBlocked',
    });
    expect(Object.keys(CONTROL_OPERATION_RESULT_TRANSLATION_KEYS)).toEqual([
      'awaiting_migration',
      'awaiting_worker_bindings',
      'awaiting_smoke',
      'awaiting_quarantine',
      'retry_required',
      'lease_unavailable',
      'succeeded',
      'blocked',
    ]);
    expect(html).toContain('CONTROL_OPERATION_RESULT_TRANSLATION_KEYS[result.result?.state]');
    expect(html).toContain("t('web.envDetail.r2OwnershipRecoverySummary'");
    expect(html).toContain("t('web.envDetail.r2IdentityMismatchSummary'");
    expect(html).toContain("t('web.status.percentComplete', { percent })");
    expect(html).toContain("t('web.status.resourceProgress'");
    expect(html).not.toContain("status.textContent = 'Running provisioning operation...'");
    expect(html).not.toContain("result.error || 'Could not create the Cloudflare token link.'");
  });

  it('provides explicit environment-management copy instead of English fallback', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );
    const base = extractInlineObject(html, 'envManagementCopyByLocale');
    const dynamic = extractInlineObject(html, 'envDynamicCopyByLocale');
    const rows = extractInlineObject(html, 'envManagementSupplementalRows') as Record<
      string,
      string[]
    >;
    const supplementalLocales = SUPPORTED_LOCALES.map(({ code }) => code).filter(
      (locale) => locale !== 'en' && locale !== 'ja'
    );
    const english = {
      ...(base.en as Record<string, string>),
      ...(dynamic.en as Record<string, string>),
    };

    for (const [localeIndex, locale] of supplementalLocales.entries()) {
      const baseLocale = (base[locale] ?? {}) as Record<string, string>;
      const dynamicLocale = (dynamic[locale] ?? {}) as Record<string, string>;
      const supplemental = Object.fromEntries(
        Object.entries(rows).map(([key, translations]) => {
          expect(translations, `${key} translations`).toHaveLength(supplementalLocales.length);
          expect(translations[localeIndex], `${locale} ${key}`).toBeTruthy();
          return [key, translations[localeIndex]];
        })
      );
      const keysRequiringExplicitTranslation = Object.keys(english).filter(
        (key) => !(key in baseLocale) && !(key in dynamicLocale)
      );

      expect(
        keysRequiringExplicitTranslation.filter((key) => !(key in supplemental)),
        `${locale} environment-management English fallbacks`
      ).toEqual([]);

      for (const key of keysRequiringExplicitTranslation) {
        const expectedPlaceholders = english[key].match(/{{[a-zA-Z0-9_-]+}}/g) ?? [];
        const actualPlaceholders = supplemental[key].match(/{{[a-zA-Z0-9_-]+}}/g) ?? [];
        expect(actualPlaceholders.sort(), `${locale} ${key} placeholders`).toEqual(
          expectedPlaceholders.sort()
        );
      }
    }
  });

  it('localizes setup-operation conflicts from their stable API error code', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'ja',
      ja as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain("result?.errorCode === 'setup_operation_in_progress'");
    expect(html).toContain("result.error = t('web.status.operationInProgress')");
    expect(html).toContain(".replaceAll('⚠️', t('web.status.warning'))");
  });

  it('shows retryable deletion inventory errors without an empty error alert', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'ja',
      ja as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain("result?.errorCode === 'environment_inventory_unavailable'");
    expect(html).toContain("result.error = t('web.delete.inventoryUnavailable')");
    expect(html).toContain('function apiErrorMessages(result)');
    expect(html).toContain("summary !== messages.join(', ')");
    expect(html).toContain("messages.length > 0 ? messages : [t('web.status.unknownError')]");
    expect(html).not.toContain("(deleteResult.errors || []).join(', ')");
  });

  it('distinguishes final environment cleanup from a successful partial deletion', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'ja',
      ja as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('deleteResult.environmentDeleted === true');
    expect(html).toContain("'web.delete.success' : 'web.delete.partialSuccess'");
    expect(html).toContain('環境と残りのローカル状態は保持されています。');
  });

  it('finishes an empty environment without making unobserved legacy Pages inventory strict', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'ja',
      ja as Record<string, string>,
      SUPPORTED_LOCALES
    );

    for (const resourceType of ['queues', 'r2']) {
      expect(html).toContain(`document.getElementById('delete-${resourceType}').checked = true;`);
    }
    expect(html).toContain(
      "document.getElementById('delete-pages').checked = (env.pages || []).length > 0;"
    );
    expect(html).toContain('finalizeEnvironment: true,');
    expect(html).not.toContain(
      "document.getElementById('delete-queues').checked = env.queues.length > 0;"
    );
    expect(html).not.toContain("document.getElementById('delete-r2').checked = env.r2.length > 0;");
  });

  it('renders R2 and DNS deletion manual actions independently with dashboard links', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'ja',
      ja as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('function appendManualR2CleanupNotice(parent, targets)');
    expect(html).toContain('function appendManualDnsCleanupNotice(parent, issues)');
    expect(html).toContain('function appendManualControlTokenCleanupNotice(parent, targets)');
    expect(html).toContain(
      "item.textContent = t('web.delete.manualControlTokenId', { tokenId: String(tokenId) });"
    );
    expect(html).toContain('if (manualR2Targets.length > 0)');
    expect(html).toContain('if (manualDnsIssues.length > 0)');
    expect(html).toContain('const environmentDeleted = deleteResult.environmentDeleted === true;');
    expect(html).toContain(
      "t(environmentDeleted ? 'web.delete.complete' : 'web.delete.manualActionRequired')"
    );
    expect(html).toContain('appendManualR2CleanupNotice(result, manualR2Targets)');
    expect(html).toContain('appendManualDnsCleanupNotice(result, manualDnsIssues)');
    expect(html).toContain(
      'appendManualControlTokenCleanupNotice(result, manualControlTokenTargets)'
    );
    expect(html).toContain('if (environmentDeleted) {');
    expect(html).toContain('await loadEnvironments();');
    expect(html).toContain('if (target.dashboardUrl)');
    expect(html).toContain('link.href = target.dashboardUrl');
    expect(html).toContain("t('web.deploy.openCloudflareDns')");
    expect(html).toContain("'https://dash.cloudflare.com/'");
  });

  it('reports key replacement only after guarded generation succeeds', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'ja',
      ja as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('keyResult.reusedExistingKeys === true');
    expect(html).toContain('Existing environment keys reused');
    expect(html).not.toContain("output.textContent += '   Existing keys will be overwritten.");
  });

  it('shows one description and one example for each user ID format', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('data-i18n="userId.nanoidDesc"');
    expect(html).toContain('data-i18n="userId.uuidDesc"');
    expect(html).toContain('V1StGXR8_Z5jdHi6B-myT');
    expect(html).toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(html).toContain('id="user-id-format-description"');
    expect(html).toContain('id="user-id-format-example-value"');
    expect(html).toContain("descriptionKey = selected === 'uuid'");
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

  it('renders deletion progress from structured resource counts without irreversible footer copy', () => {
    const html = getHtmlTemplate(
      'session-token',
      true,
      'ja',
      ja as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('data-i18n="web.delete.resourcesLabel">resources</span>');
    expect(html).not.toContain('web.delete.resourcesIrreversible');
    expect(html).not.toContain('リソース - 戻すことはできません');
    expect(html).not.toContain('This action is irreversible');
    expect(html).not.toMatch(/cannot be undone|取り消せません|irreversible/iu);
    expect(en['web.delete.warning']).not.toMatch(/irreversible|cannot be undone/iu);
    expect(ja['web.delete.warning']).not.toMatch(/取り消せません|元に戻せません/iu);
    expect(html).toContain("statusResult.operationProgress?.operation === 'delete'");
    expect(html).toContain("progressBar.classList.toggle('indeterminate', indeterminate)");
    expect(SETUP_WEB_UI_STYLE).toContain('.setup-progress-fill.indeterminate');
    expect(SETUP_WEB_UI_STYLE).toContain('@keyframes delete-progress-indeterminate');
  });

  it('uses the shared solid progress treatment in light and dark themes', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    for (const progressBarId of [
      'provision-progress-bar',
      'deploy-progress-bar',
      'delete-progress-bar',
      'release-update-progress-bar',
    ]) {
      expect(html).toMatch(
        new RegExp(`id="${progressBarId}"[^>]*class="[^"]*setup-progress-fill`, 'u')
      );
    }
    expect(html.match(/class="[^"]*setup-progress-track[^"]*"/gu)).toHaveLength(4);
    expect(html).toContain('function updateProgressBarVisual(');
    expect(html).toContain("progressBar.classList.toggle('is-complete', status === 'complete')");
    expect(html).toContain("progressBar.classList.toggle('is-error', status === 'error')");
    expect(html).toContain("markProgressBarError('provision')");
    expect(html).toContain("markProgressBarError('delete')");

    expect(SETUP_WEB_UI_STYLE).toContain('--progress-fill: #9a7b36;');
    expect(SETUP_WEB_UI_STYLE).toContain('--progress-fill: #c9a86a;');
    expect(SETUP_WEB_UI_STYLE).toContain('.setup-progress-fill::after');
    expect(SETUP_WEB_UI_STYLE).toContain('background: var(--progress-head);');
    expect(SETUP_WEB_UI_STYLE).toContain('.setup-progress-fill.is-complete');
    expect(SETUP_WEB_UI_STYLE).toContain('.setup-progress-fill.is-error');
    expect(SETUP_WEB_UI_STYLE).toContain('@media (prefers-reduced-motion: reduce) {');
    expect(SETUP_WEB_UI_STYLE).not.toContain('repeating-linear-gradient');
  });

  it('offers in-place initial deployment recovery after a failed deploy request', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain(
      "recoveryStatus = await api('/deploy/recovery/' + encodeURIComponent(config.env))"
    );
    expect(html).toContain("btn.textContent = t('web.envDetail.initialDeployRecoveryAction')");
    expect(html).toContain('describeInitialDeploymentRecovery(recoveryStatus)');
    expect(html).toContain("result?.status === 'recreate_required'");
    expect(html).toContain("result.reasonCode === 'initial_manifest_changed'");
    expect(html).toContain('Delete this incomplete environment and create it again.');
    expect(html).toContain(
      "document.getElementById('btn-resume-initial-deploy')?.classList.add('hidden')"
    );
    expect(html).toContain('class="inline-action-spinner hidden"');
    expect(html).toContain("spinner?.classList.remove('hidden')");
    expect(html).toContain("button.setAttribute('aria-busy', 'true')");
    expect(html).toContain('const envName = selectedEnvForDetail?.env || config?.env');
    expect(html).toContain("'/deploy/recovery/' + encodeURIComponent(envName)");
    expect(html).toContain("'/config?env=' + encodeURIComponent(envName)");
    expect(html).toContain('recoveryStatus.requiresBootstrapToken !== true');
    expect(html).toContain('!resumeControlBootstrapReady');
  });

  it('does not label endpoint URLs as verified before initial deployment verification completes', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'ja',
      ja as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('id="detail-url-deployment-status"');
    expect(html).toContain("status.textContent = t('web.envDetail.deploymentChecking')");
    expect(html).toContain("result.status === 'complete'");
    expect(html).toContain('result.completedSteps?.verificationComplete === true');
    expect(html).toContain("status.textContent = t('web.envDetail.deploymentIncomplete')");
    expect(html).toContain("status.dataset.state = 'incomplete'");
    expect(html).toContain("status.textContent = t('web.envDetail.deploymentStatusUnknown')");
    expect(html).toContain('デプロイ未完了');
    expect(html).not.toContain('<em data-i18n="web.envDetail.verified">verified ✓</em>');
  });

  it('keeps setup prelude sections dismissed after deployment starts', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain("restoreSetupProgressPreludes(['deploy-manual-wildcard-warning'])");
    expect(html).not.toContain(
      "restoreSetupProgressPreludes([\n          'control-token-bootstrap-row'"
    );
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
    expect(html).toContain("section.className = 'alert ok';");
    expect(html).toContain("heading.setAttribute('data-i18n', 'web.env.adminConfigured');");
    expect(html).toContain("description.classList.add('hidden');");
    expect(html).not.toContain('If every administrator is locked out');
    expect(html).not.toContain('管理者が全員ロックアウト');
    expect(html).toContain('class="setup-recap"');
    expect(html).toContain('data-i18n="web.common.setupTool">Setup Tool</span> v0.4.0');
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
    expect(html).toContain('class="twocol ui-update-grid"');
    expect(html).toContain('id="env-release-update"');
    expect(html).toContain('id="btn-start-release-update"');
    expect(html).toContain('id="btn-start-database-only-update"');
    expect(html).toContain('startReleaseUpdate(true)');
    expect(html).toContain('response.inProgress === true');
    expect(html).toContain("api('/update/release'");
    expect(html).toContain('loadReleaseUpdateStatus(env.env)');
    expect(html).toContain('class="bigtable ui-update-card"');
    expect(html).toContain('id="full-environment-deploy-card"');
    expect(html).toContain('id="btn-deploy-full-environment"');
    expect(html).toContain('id="full-environment-deploy-progress"');
    expect(html).toContain('onlyChanged: false');
    expect(html).toContain("'/deploy/component/' + encodeURIComponent(componentName)");
    expect(html).toContain('getFullDeployUiComponents');
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
    expect(SETUP_WEB_UI_STYLE).toContain('body.env-management-mode .setup-hero-number');
    expect(SETUP_WEB_UI_STYLE).toContain('.env-management-surface .tabpane.env-tab-enter');
    expect(SETUP_WEB_UI_STYLE).toContain('.env-full-deploy-card');
    expect(SETUP_WEB_UI_STYLE).toContain('.release-update-card');
    expect(SETUP_WEB_UI_STYLE).toContain('.env-release-badge');
    expect(SETUP_WEB_UI_STYLE).toContain(
      '.env-management-surface #env-control-automatic-provisioning:not(.hidden)'
    );
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
    expect(html).toContain("activePane.classList.add('env-tab-enter');");
    expect(html).toContain("t('web.env.adminConfigured')");
    expect(html).toContain("button.classList.add('hidden');");
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
    expect(html).toContain('<h2 data-i18n="web.db.controlPlaneTitle">D1 Control Plane</h2>');
    expect(html).toContain('name="automatic-provisioning" value="on" checked');
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

  it('starts the deployment screen in a clean ready state without mock progress data', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('id="deploy-ready-text" class="deploy-ready-card"');
    expect(html).toContain('id="deploy-progress-ui" class="deploy-progress-panel hidden"');
    expect(html).toContain('class="logbox hidden" id="deploy-log"');
    expect(html).toContain('<span id="deploy-percent">0</span>');
    expect(html).toContain('id="deploy-phase-rail"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="1"');
    expect(html.match(/data-deploy-phase="\d+"/gu)).toHaveLength(10);
    expect(html).toContain('id="deploy-log-ora"');
    expect(html).toContain("const WEB_ORA_FRAMES = ['⠋', '⠙'");
    expect(html).toContain("setLogVisibility('deploy-log-toggle', 'deploy-log', false)");
    expect(html).toContain('statusResult.deploymentProgress');
    expect(html).toContain('id="deploy-current-message-line"');
    expect(html).toContain('id="deploy-current-message"');
    expect(html).toContain('currentMessage.textContent = oraMessage');
    expect(html).toContain('oraText.textContent = oraMessage');
    expect(html).toContain("const finalStatus = await api('/deploy/status')");
    expect(html).toContain('renderDeploymentSnapshot(finalStatus.deploymentProgress)');
    expect(html).toContain('if (!renderedServerSnapshot)');
    expect(html).not.toContain("btnCancel.classList.remove('hidden')");
    expect(html).not.toContain("btnGotoComplete.classList.remove('hidden')");
    expect(html).not.toContain('prod-ar-userinfo uploading...');
    expect(html).not.toContain('bindings: D1(3) KV(9) DO(12)');
    expect(SETUP_WEB_UI_STYLE).toContain('.deploy-ready-card');
    expect(SETUP_WEB_UI_STYLE).toContain('.ora-log-line');
    expect(SETUP_WEB_UI_STYLE).toContain('.deploy-current-message');
    expect(SETUP_WEB_UI_STYLE).toContain('.deploy-phase-rail');
  });

  it('dismisses setup guidance when provisioning or deployment starts', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('id="provision-preflight-row" data-setup-progress-prelude');
    expect(html).toContain('id="control-token-bootstrap-row" data-setup-progress-prelude');
    expect(html).toContain('id="deploy-manual-wildcard-warning" data-setup-progress-prelude');
    expect(html).toContain("dismissSetupProgressPreludes(['provision-preflight-row'])");
    expect(html).toContain(
      "'control-token-bootstrap-row',\n        'deploy-manual-wildcard-warning'"
    );
    expect(html).toContain("window.matchMedia('(prefers-reduced-motion: reduce)').matches");
    expect(SETUP_WEB_UI_STYLE).toContain('.setup-progress-prelude-exit');
    expect(SETUP_WEB_UI_STYLE).toContain('authrim-prelude-exit 0.22s');
  });

  it('hides running-stage guidance and restores only explicitly requested manual guidance', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );
    const transitionSource = html.match(
      /const setupProgressPreludeHideTimers = new Map\(\);[\s\S]*?(?=\n\s{4}function showSection\(name\))/u
    )?.[0];
    expect(transitionSource).toBeTruthy();

    const classes = new Set<string>();
    const element = {
      dataset: {} as Record<string, string>,
      classList: {
        add: (...names: string[]) => names.forEach((name) => classes.add(name)),
        contains: (name: string) => classes.has(name),
        remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
      },
    };
    let finishTransition: (() => void) | undefined;
    const context = vm.createContext({
      clearTimeout: () => undefined,
      document: {
        getElementById: (id: string) => (id === 'prelude' ? element : null),
      },
      setTimeout: (callback: () => void) => {
        finishTransition = callback;
        return 1;
      },
      window: {
        matchMedia: () => ({ matches: false }),
      },
    });

    vm.runInContext(`${transitionSource}\ndismissSetupProgressPreludes(['prelude']);`, context);
    expect(classes.has('setup-progress-prelude-exit')).toBe(true);
    expect(element.dataset.setupProgressPreludeWasVisible).toBe('true');

    expect(finishTransition).toBeTypeOf('function');
    finishTransition?.();
    expect(classes.has('setup-progress-prelude-exit')).toBe(false);
    expect(classes.has('hidden')).toBe(true);

    vm.runInContext("restoreSetupProgressPreludes(['prelude']);", context);
    expect(classes.has('hidden')).toBe(false);
    expect(element.dataset.setupProgressPreludeWasVisible).toBeUndefined();

    expect(html).toContain('function restoreSetupProgressPreludes(ids)');
    expect(html).toContain("restoreSetupProgressPreludes(['deploy-manual-wildcard-warning'])");
  });

  it('uses monotonic phase-based deployment progress instead of log-count percentages', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('function renderDeploymentSnapshot(snapshot)');
    expect(html).toContain('Math.max(lastRenderedDeployStep');
    expect(html).toContain("snapshot.status === 'error' ||");
    expect(html).toContain('snapshot.terminal === true');
    expect(html).toContain("rail.setAttribute('aria-valuenow', String(step))");
    expect(html).toContain("rail.setAttribute('aria-valuetext', phaseLabel)");
    expect(html).toContain('oraText.textContent !== oraMessage');
    expect(html).toContain('const renderedPhase = DEPLOY_PHASE_IDS[step - 1] || snapshot.phase');
    expect(html).toContain("t('web.deploy.phase.progress', { current: step, total })");
    expect(html).toContain("message: t('web.deploy.manualWildcardTitle')");
    expect(SETUP_WEB_UI_STYLE).toContain('.deploy-phase-rail span.running');
    expect(SETUP_WEB_UI_STYLE).toContain('.deploy-phase-rail span.waiting');
    expect(html).not.toContain('const deployProgress = createDeployProgressTracker()');
    expect(html).not.toContain('function createDeployProgressTracker()');
    expect(html).not.toContain("Processing... ' + completedCount + ' steps completed");
    expect(html).not.toContain('totalComponents = Math.max');
  });

  it('localizes deployment phase labels and accessibility text', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'ja',
      ja as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain("preparation: 'web.deploy.phase.preparation'");
    expect(html).toContain("t('web.deploy.phase.aria', { current: step, total })");
    expect(html).toContain("'web.deploy.phase.preparation': 'デプロイを準備しています'");
    expect(html).toContain("'web.deploy.phase.complete': 'デプロイが完了しました'");
    expect(html.match(/'web.deploy.phase.preparation'/gu)).toHaveLength(
      SUPPORTED_LOCALES.length + 1
    );
    expect(html.match(/'web.delete.manualR2Summary'/gu)).toHaveLength(SUPPORTED_LOCALES.length + 1);
    expect(html.match(/'web.delete.manualActionRequired'/gu)).toHaveLength(
      SUPPORTED_LOCALES.length + 1
    );
  });

  it('resets deletion UI when a new environment is selected without resetting locale refreshes', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('function showDeleteConfirmation(env, resetState = true)');
    expect(html).toContain('if (resetState) {\n        resetDeleteSection();\n      }');
    expect(html).toContain('showDeleteConfirmation(selectedEnvForDelete, false)');
    expect(html).toContain("document.getElementById('delete-output').textContent = ''");
    expect(html).toContain("resetProgressContainer('delete')");
    expect(html).toContain("resetLogToggle('delete-log-toggle', 'delete-log')");
  });

  it('localizes deletion inventory progress for every supported locale', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );
    const progressCopy = extractInlineObject(html, 'deleteProgressCopyByLocale');
    const english = progressCopy.en as Record<string, string>;

    for (const { code } of SUPPORTED_LOCALES) {
      const localized = progressCopy[code] as Record<string, string>;
      expect(localized, `${code} deletion progress copy`).toBeTruthy();
      expect(Object.keys(localized).sort(), `${code} deletion progress keys`).toEqual(
        Object.keys(english).sort()
      );
      for (const [key, englishText] of Object.entries(english)) {
        const expectedPlaceholders = englishText.match(/{{[a-zA-Z0-9_-]+}}/g) ?? [];
        const actualPlaceholders = localized[key].match(/{{[a-zA-Z0-9_-]+}}/g) ?? [];
        expect(actualPlaceholders.sort(), `${code} ${key} placeholders`).toEqual(
          expectedPlaceholders.sort()
        );
      }
    }

    const parserSource = html.match(
      /function getDeleteProgressTask\(message\) \{[\s\S]*?(?=\n\s{4}function createProvisionProgressTracker)/u
    )?.[0];
    expect(parserSource).toBeTruthy();
    const context = vm.createContext({
      t: (key: string, params?: { resource?: string }) =>
        params?.resource ? `${key}:${params.resource}` : key,
    });
    vm.runInContext(parserSource!, context);

    expect(vm.runInContext("getDeleteProgressTask('Scanning R2 buckets...')", context)).toBe(
      'web.delete.progress.scanningResource:R2'
    );
    expect(
      vm.runInContext(
        "getDeleteProgressTask('🔎 Verifying Cloudflare inventory after deletion...')",
        context
      )
    ).toBe('web.delete.progress.verifyingInventory');
    expect(html).toContain('getDeleteProgressTask(msg) || parseProgressMessage(msg)');
  });

  it('hides stale environment counts while a Cloudflare rescan is running', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('id="env-list-progress-summary"');
    expect(html).toContain(
      'function renderEnvironmentListSummary(count, scanState = environmentScanState)'
    );
    expect(html).toContain("environmentScanState = 'scanning'");
    expect(html).toContain("summary.textContent = t('web.env.scanningEnvironments')");
    expect(html).toContain("summary.setAttribute('aria-busy', 'true')");
    expect(html).toContain("environmentScanState = 'complete'");
    expect(html).toContain(
      'renderEnvironmentListSummary(detectedEnvironments.length, environmentScanState)'
    );
    expect(html).toContain('const scanGeneration = ++environmentScanGeneration');
    expect(html).toContain('refreshButton.disabled = true');
    expect(html).toContain('scanGeneration !== environmentScanGeneration');
    const loadEnvironmentsBody = html.match(
      /async function loadEnvironments\(\) \{[\s\S]*?(?=\n\s{4}function getEnvironmentIssuerPreview)/u
    )?.[0];
    expect(loadEnvironmentsBody).not.toContain("api('/deploy/status')");
  });

  it('hydrates Cloudflare account context in manage-only mode', () => {
    const html = getHtmlTemplate(
      'session-token',
      true,
      'ja',
      ja as Record<string, string>,
      SUPPORTED_LOCALES
    );

    expect(html).toContain('async function loadRuntimeContext()');
    expect(html).toContain("const result = await api('/prerequisites')");
    expect(html).toContain('async function initializeManageOnly()');
    expect(html).toContain("setEnvManagementHero('envList')");
    expect(html).toContain('await Promise.allSettled([runtimeContextPromise, loadEnvironments()])');
    expect(html).toContain('unknownAccountValues.has(recapAccount)');
    expect(html).toContain('initializeManageOnly();');
  });

  it('keeps provisioning progress complete after trailing log messages and polling races', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );
    const trackerSource = html.match(
      /function createProvisionProgressTracker\(totalResources\) \{[\s\S]*?(?=\n\s{4}\/\/ Safe DOM element creation helpers)/u
    )?.[0];
    expect(trackerSource).toBeTruthy();
    const progressUpdates: Array<{ current: number; total: number; task: string }> = [];
    const context = vm.createContext({
      updateProgressUI: (_prefix: string, current: number, total: number, task: string) => {
        progressUpdates.push({ current, total, task });
      },
      parseProgressMessage: () => null,
      t: (key: string) => key,
    });
    vm.runInContext(
      `${trackerSource}
       const tracker = createProvisionProgressTracker(8);
       tracker.handle('D1 Databases (6/6) ✓');
       tracker.handle('Provisioning complete!');
       tracker.handle('Config saved: /tmp/config.json');
       tracker.complete();
       tracker.handle('Log: Progress log saved');`,
      context
    );

    expect(progressUpdates.at(-1)).toEqual({
      current: 8,
      total: 8,
      task: 'web.status.complete',
    });
    expect(progressUpdates.filter((update) => update.current === 8)).toHaveLength(2);
    expect(progressUpdates.at(-1)?.current).not.toBe(4);
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
    expect(html).toContain(
      '<section class="row wide hidden" id="deploy-manual-wildcard-warning" data-setup-progress-prelude>'
    );
    expect(html).toContain('data-i18n="web.deploy.manualDnsSectionTitle"');
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
    expect(html).toContain("status.textContent = t('web.deploy.manualWildcardTitle');");
    expect(html).toContain(
      "document.getElementById('deploy-manual-wildcard-recheck').addEventListener('click'"
    );
    expect(html).toContain('recheckButton.disabled = true;');
    expect(html).toContain('deployButton.click();');
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

  it('keeps Automatic provisioning optional and handles bootstrap input as a password', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );
    expect(html).toContain('name="automatic-provisioning" value="on" checked');
    expect(html).toContain('name="automatic-provisioning" value="off"');
    expect(html).toContain('id="btn-create-control-bootstrap-token"');
    expect(html).toContain('data-i18n="web.deploy.bootstrapTokenDescription"');
    expect(en['web.deploy.bootstrapTokenRequired']).toContain('Control Worker needs');
    expect(en['web.deploy.bootstrapTokenRequired']).toContain('D1, Workers, KV, and R2');
    expect(html).toMatch(/type="password"\s+id="control-bootstrap-token"\s+autocomplete="off"/u);
    expect(html).toContain("api('/cloudflare/control-token-template'");
    expect(html).toContain("bootstrapTokenInput.value = '';");
    expect(html).toContain('id="env-control-automatic-provisioning"');
    expect(html).toMatch(
      /type="password"\s+id="env-control-bootstrap-token"\s+autocomplete="off"/u
    );
    expect(html).toContain("api('/control/automatic-provisioning/prepare'");
    expect(html).toContain("api('/deploy/component/ar-control'");
    expect(html).toContain("api('/control/automatic-provisioning/complete'");
    expect(html).toContain("api('/control/automatic-provisioning/cleanup-bootstrap'");
    expect(html).toContain("api('/control/automatic-provisioning/cancel-pending'");
    expect(html).toContain('error.cleanupRequired === false');
    expect(html).toContain('completionError.bootstrapRetainedForRetry =');
    expect(html).toContain('completionError.cutoverPending = completed.cutoverPending === true');
    expect(html).toContain("const recoveringCutover = envControlBootstrapPhase !== 'none'");
    expect(html).toContain('if (!recoveringCutover) {');
    expect(html).toContain('if (recoveringCutover || error.cutoverPending === true)');
    expect(html).toContain('if (error.bootstrapRetainedForRetry === true)');
    expect(html).toContain("t('web.envDetail.bootstrapRetainedForRetry')");
    expect(html.indexOf('if (error.bootstrapRetainedForRetry === true)')).toBeLessThan(
      html.indexOf("api('/control/automatic-provisioning/cleanup-bootstrap'")
    );
    expect(html).toContain('Automatic provisioning returned to Off.');
    expect(html).toContain("api('/control/automatic-provisioning/status?env='");
    expect(html).toContain('if (!bootstrapToken && !recoveringCutover) {');
    expect(html).not.toContain('if (!bootstrapToken || !envControlBootstrapOwnership)');
    expect(html).toContain('if (error.recoveryTokenRequired === true)');
    expect(html.indexOf("api('/deploy/component/ar-control'")).toBeLessThan(
      html.indexOf("api('/control/automatic-provisioning/complete'")
    );
    expect(html).not.toContain('body: { env: envName, dryRun: false, bootstrapToken');
    expect(html).not.toContain('CLOUDFLARE_D1_API_TOKEN: bootstrapToken');
    expect(html).toContain("bootstrapToken = '';");
  });

  it('prioritizes canonical pending Control operations without tenant reselection', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );
    expect(html).toContain('id="pending-control-operations"');
    expect(html).toContain("api('/control/pending-operations')");
    expect(html).toContain('pendingControlOperations[0]');
    expect(html).toContain('operation.tenantId');
    expect(html).toContain("api('/control/pending-operations/execute'");
    expect(html).toContain('Run pending operation');
    expect(html).toContain('let inFlightMutationRequests = 0;');
    expect(html).toContain('inFlightMutationRequests === 0');
    expect(html).not.toContain('pending.tenantId =');
  });

  it('stops provisioning and keeps deploy blocked when key generation fails', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );

    const keyRequest = html.indexOf("api('/keys/generate'");
    const keyGuard = html.indexOf('if (!keyResult.success)', keyRequest);
    const keySuccessOutput = html.indexOf('RSA key pair generated', keyRequest);
    const provisionRequest = html.indexOf("api('/provision'", keyRequest);

    expect(keyRequest).toBeGreaterThanOrEqual(0);
    expect(keyGuard).toBeGreaterThan(keyRequest);
    expect(keySuccessOutput).toBeGreaterThan(keyGuard);
    expect(provisionRequest).toBeGreaterThan(keyGuard);
    expect(html).toContain("throw new Error(apiErrorMessages(keyResult).join('; '))");
    expect(html).toContain('btnGotoDeploy.disabled = !provisioningCompleted;');
  });

  it('offers the same server-owned capacity profiles without raw D1 inputs', () => {
    const html = getHtmlTemplate(
      'session-token',
      false,
      'en',
      en as Record<string, string>,
      SUPPORTED_LOCALES
    );
    expect(html).toContain('id="control-capacity-profile"');
    expect(html).toContain('value="minimum"');
    expect(html).toContain('value="recommended" selected');
    expect(html).toContain('value="extra_headroom"');
    expect(html).toContain('id="control-capacity-scope"');
    expect(html).toContain("api('/control/capacity/' + action");
    expect(html).toContain("'/control/capacity/tenants?environmentId='");
    expect(html).not.toContain('id="control-capacity-database-name"');
    expect(html).not.toContain('id="control-capacity-binding-ref"');
    expect(html).not.toContain('id="control-capacity-d1-count"');
  });
});
