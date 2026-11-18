import type { ClientOption, ClientsClient } from '../clients';

/** The clients of the mock tenant: an app of its own and a partner's. */
export const MOCK_CLIENTS: readonly ClientOption[] = [
	{
		enabled: true,
		id: 'client_member_app',
		name: 'Member app',
		redirectUris: ['https://app.example.com/callback', 'https://app.example.com/auth/return']
	},
	{
		enabled: true,
		id: 'client_partner_portal',
		name: 'Partner portal',
		redirectUris: ['https://partners.example.com/oidc/callback']
	}
];

/** The clients Authrim registered for the tenant itself; the console lists them apart. */
export const MOCK_SYSTEM_CLIENTS: readonly ClientOption[] = [
	{
		enabled: true,
		id: 'client_login_ui',
		name: 'Login UI',
		redirectUris: ['https://login.example.com/callback'],
		systemManaged: true
	},
	{
		enabled: true,
		id: 'client_downstream_introspection',
		name: 'Downstream Grant Introspection',
		redirectUris: ['https://downstream-introspection.authrim.invalid/callback'],
		systemManaged: true
	}
];

export function createFakeClients(clients: readonly ClientOption[] = MOCK_CLIENTS): ClientsClient {
	return {
		async list() {
			return clients.map((client) => ({ ...client, redirectUris: [...client.redirectUris] }));
		}
	};
}
