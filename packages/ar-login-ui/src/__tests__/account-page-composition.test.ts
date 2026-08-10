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

	it('renders the account shell immediately and resolves account sections independently', () => {
		expect(source).not.toContain('<Spinner size="lg" />');
		expect(source).toContain('loading={profileLoading}');
		expect(source).toContain("loadingAreas={initialLoadingAreas(['devices'])}");
		expect(source).toContain('loading={consentsLoading}');
		expect(source).toContain('loading={operationsLoading}');
		expect(source).not.toContain('loading={profileLoading || consentsLoading}');
		expect(source).not.toContain('loading={profileLoading || operationsLoading}');
		expect(source).not.toContain('if (profileLoading) return areas;');
		expect(source).toContain('aria-busy={profileLoading || capabilitiesLoading}');
		expect(source).toContain('const profileRequest = accountAPI.getProfile()');
		expect(source).toContain('.getDevices()');
		expect(source).toContain('.getCapabilities()');
		expect(source.indexOf('const accountLoadRequest = loadAccountPage()')).toBeLessThan(
			source.indexOf('passkeySupported = await passkeySupportRequest')
		);
	});

	it('scopes manual security refreshes to the widget that requested them', () => {
		expect(source).toContain('async function refreshSecurity(areas?: SecurityArea[])');
		expect(source).toContain(
			"requestedAreas.includes('passkeys') ? accountAPI.getPasskeys() : null"
		);
		expect(source).toContain("loading={securityAreasRefreshing(['passkeys'])}");
		expect(source).not.toContain('loading={securityLoading}');
	});

	it('scopes security errors to the widget that owns the failed action', () => {
		expect(source).toContain(
			"setSecurityError('passkeys', localizedPasskeyRegistrationError(error))"
		);
		expect(source).toContain("error={securityErrorFor(['passkeys'])}");
		expect(source).toContain("error={securityErrorFor(['sessions'])}");
		expect(source).not.toContain('error={securityError}');
	});

	it('does not render skeleton boxes until their configured placement is known and visible', () => {
		const compositionGate = source.indexOf('{#if capabilitiesLoading || !capabilitiesResolved}');
		const configuredComposition = source.indexOf(
			'{:else if accountCapabilities?.account_page}',
			compositionGate
		);
		const fallbackComposition = source.indexOf(
			'\n\t\t\t{:else}\n\t\t\t\t<AccountProfileSection',
			configuredComposition
		);

		expect(compositionGate).toBeGreaterThan(-1);
		expect(configuredComposition).toBeGreaterThan(compositionGate);
		expect(fallbackComposition).toBeGreaterThan(configuredComposition);
		expect(source).not.toContain(
			'return authenticationMethodsLoading || Boolean(authenticationMethods?.passkey?.enabled);'
		);
		expect(source).not.toContain('return consentsLoading || consents.length > 0;');
		expect(source).not.toContain('return sessionsLoading || sessions.length > 1;');
	});

	it('hydrates the published composition and condition inputs before the first widget render', () => {
		expect(source).toContain('initialCapabilities?: AccountCapabilities | null;');
		expect(source).toContain(
			'initialAuthenticationMethods?: AuthenticationMethodsResponse | null;'
		);
		expect(source).toContain('initialPlacementConditions.consentRecordsAvailable');
		expect(source).toContain('initialPlacementConditions.multipleSessions');
		expect(source).toContain('capabilitiesLoading = $state(!embeddedCapabilitiesResolved)');
	});
});
