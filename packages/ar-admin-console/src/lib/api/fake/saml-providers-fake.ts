import type { SamlProvidersClient, SamlServiceProviderOption } from '../saml-providers';

/** The SAML service providers of the mock tenant: one in use, one turned off. */
export const MOCK_SAML_SERVICE_PROVIDERS: readonly SamlServiceProviderOption[] = [
	{ entityId: 'https://lms.example.edu/shibboleth', name: 'Learning portal', enabled: true },
	{ entityId: 'https://wiki.example.com/saml/metadata', name: 'Team wiki', enabled: false }
];

export function createFakeSamlProviders(
	providers: readonly SamlServiceProviderOption[] = MOCK_SAML_SERVICE_PROVIDERS
): SamlProvidersClient {
	return {
		async listServiceProviders() {
			return providers.map((provider) => ({ ...provider }));
		}
	};
}
