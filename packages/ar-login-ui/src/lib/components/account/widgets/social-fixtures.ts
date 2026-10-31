/** Linked external accounts and providers for the social accounts widget's stories and tests. */
import type { AccountLinkedIdentity } from '$lib/api/account';
import type { ExternalProvider } from '$lib/api/authentication-methods';
import { FIXTURE_NOW } from './fixtures';

const DAY = 24 * 60 * 60 * 1000;

export const linkedIdentity = (
	overrides: Partial<AccountLinkedIdentity> = {}
): AccountLinkedIdentity => ({
	id: 'linked-google',
	providerId: 'prov_google',
	providerSlug: 'google',
	providerName: 'Google',
	providerEmail: 'person@gmail.example',
	linkedAt: FIXTURE_NOW - 40 * DAY,
	lastLoginAt: FIXTURE_NOW - 2 * DAY,
	...overrides
});

export const socialProviders = (): ExternalProvider[] => [
	{
		id: 'google',
		name: 'Google',
		type: 'oidc',
		startMode: 'oauth_redirect',
		enabled: true,
		loginEnabled: true
	},
	{
		id: 'github',
		name: 'GitHub',
		type: 'oauth2',
		startMode: 'oauth_redirect',
		enabled: true,
		loginEnabled: true
	}
];
