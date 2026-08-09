import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
	fileURLToPath(new URL('../lib/components/AccountPage.svelte', import.meta.url)),
	'utf8'
);

describe('Account Page published composition', () => {
	it('uses localized page copy and evaluates allowlisted placement conditions', () => {
		expect(source).toContain('localizedPageCopy().title');
		expect(source).toContain('currentLocale = locale as Locales');
		expect(source).toContain('screen.localizations?.[locale]?.fields');
		expect(source).toContain('languageStore.defaultLocale');
		expect(source).toContain('placementVisible(item.condition)');
		expect(source).toContain("case 'passkey_enabled'");
		expect(source).toContain("case 'consent_records_available'");
	});

	it('renders only validated links and uses the dynamic viewport height', () => {
		expect(source).toContain("field.block_type === 'link' && safeHref(field.href)");
		expect(source).toContain('min-height: 100dvh');
		expect(source).not.toContain('min-height: 100vh');
	});

	it('shares the configured footer and preference controls with authentication pages', () => {
		expect(source).toContain('<ConfiguredFooter locale={currentLocale} class="account-footer" />');
		expect(source).toContain('{#if loginUIPageStore.showTopbar}');
		expect(source).toContain('data-position={loginUIPageStore.topbarPosition}');
		expect(source).toContain('showThemeToggle={loginUIPageStore.themeToggleEnabled}');
		expect(source).toContain('showLanguageSelect={loginUIPageStore.languageSelectEnabled}');
	});

	it('connects identifier replacement to reauthentication and bounded status polling', () => {
		expect(source).toContain("{ type: 'change-email'; email: string }");
		expect(source).toContain("requestReauth({ type: 'change-email', email: email.trim() })");
		expect(source).toContain('accountAPI.completeIdentifierReplacement(');
		expect(source).toContain('attempt < 120 && generation === emailChangePollGeneration');
		expect(source).toContain('emailChangePollGeneration += 1');
	});
});
