import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import en from '../i18n/locales/en.js';
import ja from '../i18n/locales/ja.js';
import { SUPPORTED_LOCALES } from '../i18n/types.js';
import { getHtmlTemplate } from '../web/ui.js';

function template(manageOnly = false): string {
  return getHtmlTemplate('session-token', manageOnly, 'ja', ja, SUPPORTED_LOCALES);
}

/** Extract the browser function, keeping its real control flow in the test. */
function browserFunction(html: string, name: string): string {
  const declaration = new RegExp(`(?:async )?function ${name}\\(`, 'u').exec(html);
  if (!declaration) throw new Error(`Missing browser function: ${name}`);
  const start = declaration.index;
  const body = html.indexOf('{', start);
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let comment: 'line' | 'block' | null = null;
  for (let index = body; index < html.length; index += 1) {
    const char = html[index];
    const next = html[index + 1];
    if (comment === 'line') {
      if (char === '\n') comment = null;
      continue;
    }
    if (comment === 'block') {
      if (char === '*' && next === '/') {
        comment = null;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && (next === '/' || next === '*')) {
      comment = next === '/' ? 'line' : 'block';
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return html.slice(start, index + 1);
  }
  throw new Error(`Unclosed browser function: ${name}`);
}

function openingTag(html: string, id: string): string {
  const result = new RegExp(`<[^>]+\\bid="${id}"[^>]*>`, 'u').exec(html)?.[0];
  if (!result) throw new Error(`Missing element: ${id}`);
  return result;
}

function entryHarness(manageOnly = false) {
  const showSection = vi.fn();
  const checkPrerequisites = vi.fn().mockResolvedValue(true);
  const initializeManageOnly = vi.fn().mockResolvedValue(undefined);
  const focus = vi.fn();
  const context = vm.createContext({
    MANAGE_ONLY: manageOnly,
    selectedSetupPlatform: null,
    showSection,
    checkPrerequisites,
    initializeManageOnly,
    document: { getElementById: () => ({ focus }) },
  });
  const html = template(manageOnly);
  for (const name of ['showPlatformSelection', 'selectSetupPlatform', 'initializeSetupEntry']) {
    vm.runInContext(browserFunction(html, name), context);
  }
  return { context, showSection, checkPrerequisites, initializeManageOnly, focus };
}

describe('setup cloud platform selection', () => {
  it('shows cloud selection before Cloudflare prerequisites on a fresh setup page', () => {
    const html = template();
    expect(openingTag(html, 'section-platform')).not.toMatch(/class="[^"]*\bhidden\b/u);
    expect(openingTag(html, 'section-prerequisites')).toMatch(/class="[^"]*\bhidden\b/u);
    expect(openingTag(html, 'section-aws-setup')).toMatch(/class="[^"]*\bhidden\b/u);
    expect(html.indexOf('id="section-platform"')).toBeLessThan(
      html.indexOf('id="section-prerequisites"')
    );
  });

  it('uses native buttons and puts both AWS limitations inside its selectable button', () => {
    const html = template();
    for (const id of ['btn-platform-cloudflare', 'btn-platform-aws']) {
      expect(openingTag(html, id)).toMatch(/^<button\b/u);
      expect(openingTag(html, id)).toContain('type="button"');
      expect(openingTag(html, id)).not.toMatch(/\bdisabled(?:\s|=|>)/u);
    }
    const opening = openingTag(html, 'btn-platform-aws');
    const start = html.indexOf(opening);
    const button = html.slice(start, html.indexOf('</button>', start));
    expect(button).toContain('data-i18n="web.platform.development"');
    expect(button).toContain('data-i18n="web.platform.awsScope"');
    expect(ja['web.platform.development']).toBe('開発中');
    expect(ja['web.platform.awsScope']).toBe('現在はSAML DR対応のみ');
    expect(en['web.platform.development']).toBe('In development');
    expect(en['web.platform.awsScope']).toBe('Currently supports SAML DR only');
  });

  it('does not run Cloudflare prerequisite checks when ordinary setup starts', async () => {
    const harness = entryHarness();
    await vm.runInContext('initializeSetupEntry()', harness.context);
    expect(harness.showSection).toHaveBeenCalledExactlyOnceWith('platform');
    expect(harness.context.selectedSetupPlatform).toBeNull();
    expect(harness.checkPrerequisites).not.toHaveBeenCalled();
    expect(harness.initializeManageOnly).not.toHaveBeenCalled();
  });

  it('keeps the existing direct management entry instead of showing cloud selection', async () => {
    const harness = entryHarness(true);
    await vm.runInContext('initializeSetupEntry()', harness.context);
    expect(harness.initializeManageOnly).toHaveBeenCalledTimes(1);
    expect(harness.showSection).not.toHaveBeenCalled();
    expect(harness.checkPrerequisites).not.toHaveBeenCalled();
  });

  it('runs the existing preparation flow only after Cloudflare is selected', async () => {
    const harness = entryHarness();
    await vm.runInContext("selectSetupPlatform('cloudflare')", harness.context);
    expect(harness.context.selectedSetupPlatform).toBe('cloudflare');
    expect(harness.showSection).toHaveBeenCalledExactlyOnceWith('prerequisites');
    expect(harness.checkPrerequisites).toHaveBeenCalledTimes(1);
    expect(harness.showSection.mock.invocationCallOrder[0]).toBeLessThan(
      harness.checkPrerequisites.mock.invocationCallOrder[0]
    );
  });

  it('opens the AWS setup workflow without invoking the Cloudflare path', async () => {
    const harness = entryHarness();
    await vm.runInContext("selectSetupPlatform('aws')", harness.context);
    expect(harness.context.selectedSetupPlatform).toBe('aws');
    expect(harness.showSection).toHaveBeenCalledExactlyOnceWith('awsSetup');
    expect(harness.checkPrerequisites).not.toHaveBeenCalled();
    expect(harness.initializeManageOnly).not.toHaveBeenCalled();
    const html = template();
    const start = html.indexOf('id="section-aws-setup"');
    const end = html.indexOf('id="section-prerequisites"', start);
    const awsGuide = html.slice(start, end < 0 ? undefined : end);
    expect(awsGuide).toContain('id="btn-aws-plan"');
    expect(awsGuide).toContain('id="aws-database"');
    expect(awsGuide).toContain('id="btn-aws-resume"');
    expect(openingTag(html, 'btn-aws-platform-back')).toMatch(/^<button\b/u);
  });

  it('returns to cloud selection and clears the selected provider', async () => {
    const harness = entryHarness();
    await vm.runInContext("selectSetupPlatform('aws')", harness.context);
    harness.showSection.mockClear();
    await vm.runInContext('showPlatformSelection()', harness.context);
    expect(harness.context.selectedSetupPlatform).toBeNull();
    expect(harness.showSection).toHaveBeenCalledExactlyOnceWith('platform');
    expect(harness.checkPrerequisites).not.toHaveBeenCalled();
    expect(openingTag(template(), 'btn-platform-back')).toMatch(/^<button\b/u);
  });

  it('rejects unknown provider values without selecting a cloud or invoking checks', async () => {
    const harness = entryHarness();
    await vm.runInContext("selectSetupPlatform('other')", harness.context);
    expect(harness.context.selectedSetupPlatform).toBeNull();
    expect(harness.showSection).not.toHaveBeenCalled();
    expect(harness.checkPrerequisites).not.toHaveBeenCalled();
  });

  it('keeps AWS selected if an earlier Cloudflare check finishes after switching back', async () => {
    const harness = entryHarness();
    let finishCheck: (() => void) | undefined;
    harness.checkPrerequisites.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishCheck = resolve))
    );
    const pending = vm.runInContext("selectSetupPlatform('cloudflare')", harness.context);
    vm.runInContext('showPlatformSelection()', harness.context);
    await vm.runInContext("selectSetupPlatform('aws')", harness.context);
    finishCheck!();
    await pending;
    expect(harness.context.selectedSetupPlatform).toBe('aws');
    expect(harness.showSection).toHaveBeenLastCalledWith('awsSetup');
    expect(harness.checkPrerequisites).toHaveBeenCalledTimes(1);
  });

  it.each([
    { section: 'platform', selected: null, title: 'web.platform.title' },
    { section: 'awsSetup', selected: 'aws', title: 'web.platform.awsTitle' },
  ])(
    'preserves $section and its target when the language changes',
    ({ section, selected, title }) => {
      let translations: Record<string, string> = ja;
      const element = () => ({
        textContent: '',
        innerHTML: '',
        classList: { add: vi.fn() },
      });
      const heading = element();
      const aside = element();
      const meta = element();
      const kicker = element();
      const stepIndicator = element();
      const setStep = vi.fn();
      const checkPrerequisites = vi.fn();
      const elements = new Map([
        ['setup-hero-title', heading],
        ['setup-hero-aside', aside],
        ['setup-primary-meta', meta],
        ['step-indicator', stepIndicator],
      ]);
      const context = vm.createContext({
        selectedSetupPlatform: selected,
        currentStep: 1,
        config: {},
        sections: Object.fromEntries(
          ['platform', 'awsSetup'].map((name) => [
            name,
            { classList: { contains: () => name !== section } },
          ])
        ),
        lastPrerequisitesResult: null,
        getSetupUiRuntimeCopy: () => ({ startTarget: 'Target' }),
        getPrereqUiCopy: () => ({}),
        refreshSetupCopyElements: vi.fn(),
        setStep,
        checkPrerequisites,
        t: (key: string) => translations[key],
        document: {
          getElementById: (id: string) => elements.get(id) ?? null,
          querySelector: () => kicker,
        },
      });
      const html = template();
      for (const name of [
        'escapeHtml',
        'updateSetupPrimaryMeta',
        'setPlatformHero',
        'refreshSetupStaticCopy',
      ]) {
        vm.runInContext(browserFunction(html, name), context);
      }
      for (const locale of [ja, en]) {
        translations = locale;
        vm.runInContext('refreshSetupStaticCopy()', context);
        expect(heading.textContent).toBe(locale[title as keyof typeof locale]);
        expect(meta.innerHTML).toContain(
          selected === 'aws' ? '<b>AWS</b>' : `<b>${locale['web.platform.targetPending']}</b>`
        );
        expect(meta.innerHTML).not.toContain('Cloudflare');
        expect(context.selectedSetupPlatform).toBe(selected);
        expect(setStep).not.toHaveBeenCalled();
        expect(checkPrerequisites).not.toHaveBeenCalled();
      }
      expect(stepIndicator.classList.add).toHaveBeenCalledWith('hidden');
    }
  );
});
