import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import type { AccountConsent } from '$lib/api/account';
import AccountConsentSection from './AccountConsentSection.svelte';

type AccountStatementConsent = Extract<AccountConsent, { kind: 'statement' }>;

function documentConsent(
	overrides: Partial<AccountStatementConsent> = {}
): AccountStatementConsent {
	return {
		kind: 'statement',
		recordType: 'document_acceptance',
		id: 'document-1',
		statementId: 'tos-a',
		versionId: 'tos-a-v1',
		version: '1',
		status: 'granted',
		title: 'Terms of Service',
		updatedAt: 1_700_000_000,
		gateKind: 'legal_document',
		...overrides
	};
}

describe('AccountConsentSection withdrawal controls', () => {
	it('warns about cross-service impact and offers withdrawal for a current Flow document', () => {
		setLocale('en');
		const body = render(AccountConsentSection, {
			props: {
				consents: [documentConsent()],
				onWithdraw: () => undefined
			}
		}).body;

		expect(body).toContain('shared by every service');
		expect(body).toContain('Withdraw consent');
		expect(body).toContain('type="button"');
	});

	it('does not offer another withdrawal for historical or legacy-only document rows', () => {
		setLocale('en');
		const body = render(AccountConsentSection, {
			props: {
				consents: [
					documentConsent({ status: 'withdrawn' }),
					documentConsent({ id: 'legacy-document', gateKind: undefined })
				],
				onWithdraw: () => undefined
			}
		}).body;

		expect(body).not.toContain('Withdraw consent');
	});

	it('disables the matching release button while withdrawal is in progress', () => {
		setLocale('en');
		const oauthConsent: AccountConsent = {
			kind: 'oauth_client',
			recordType: 'release_grant',
			id: 'oauth-1',
			clientId: 'client-a',
			scopes: ['openid'],
			grantedAt: 1_700_000_000
		};
		const body = render(AccountConsentSection, {
			props: {
				consents: [oauthConsent],
				withdrawingId: 'oauth-1',
				onWithdraw: () => undefined
			}
		}).body;

		expect(body).toContain('disabled');
		expect(body).toContain('Withdrawing…');
	});
});
