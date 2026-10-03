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
		expect(source).toContain('placementVisible(item)');
		expect(source).toContain("case 'passkey_enabled'");
		expect(source).toContain("case 'consent_records_available'");
	});

	it('hides any widget placement disabled for the current guest account', () => {
		expect(source).toContain(
			'isPlacementVisibleForRegistrationState(placement, profile?.registration_state)'
		);
		expect(source).toContain('placementVisible(item)');
	});

	// Link validation itself: account-screen-href.test.ts; the link block: AccountScreenBlock.test.ts.
	it('renders only validated links, anchored to placements the page shows', () => {
		expect(source).toContain("href={field.block_type === 'link' ? safeHref(field.href) : null}");
		expect(source).toContain('return safeAccountScreenHref(value, (placementId) => {');
		expect(source).toContain('return Boolean(target?.enabled && placementVisible(target));');
	});

	// The placement's classes and styles: AccountScreenPlacement.test.ts.
	it('renders full-width overview placements as a visible card spanning the account grid', () => {
		expect(source).toContain("full={placement.width === 'full'}");
		expect(source).toContain("overview={screen.screen_key === 'account_overview'}");
	});

	// The footer, preference controls and viewport height: AccountShell.test.ts.
	it('draws the page in the account shell with its title, sign-out and re-authentication', () => {
		expect(source).toMatch(/<AccountShell\s/);
		expect(source).toContain('locale={currentLocale}');
		expect(source).toContain('pageError={accountError}');
		expect(source).toMatch(/\{#snippet dialog\(\)\}\s*<AccountReauthDialog/);
		expect(source).not.toContain('<style>');
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
		expect(source).toContain("loading={securityAreaLoading('devices')}");
		expect(source).toContain("loading={securityAreaLoading('sessions')}");
		expect(source).toContain('loading={consentsLoading}');
		expect(source).toContain('loading={operationsLoading}');
		expect(source).not.toContain('loading={profileLoading || consentsLoading}');
		expect(source).not.toContain('loading={profileLoading || operationsLoading}');
		expect(source).not.toContain('if (profileLoading) return areas;');
		expect(source).toContain('busy={profileLoading || capabilitiesLoading}');
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
		expect(source).toContain("refreshing={securityAreasRefreshing(['passkeys'])}");
		expect(source).toContain("onRefresh={() => refreshSecurity(['passkeys'])}");
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
		const fallbackComposition = source
			.slice(configuredComposition)
			.search(/\n\t*\{:else\}\n\t*<AccountProfileWidget/);

		expect(compositionGate).toBeGreaterThan(-1);
		expect(configuredComposition).toBeGreaterThan(compositionGate);
		expect(fallbackComposition).toBeGreaterThan(0);
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

it('passes the localized configured title into the guest widget and guards both logout paths', () => {
	expect(source).toMatch(/<AccountUpgradeSection\s+title=\{accountWidgetTitle\(field\)\}/);
	expect(source).toContain("await handleLogout('/login?prompt=login')");
	expect(source).toContain('onLogout={() => handleLogout()}');
	expect(source).toContain('await logoutWithGuestWarning(');
});
