import type { ClientOption, ClientsClient } from '../clients';

/** The clients of the mock tenant: an app of its own and a partner's. */
export const MOCK_CLIENTS: readonly ClientOption[] = [
	{
		id: 'client_member_app',
		name: 'Member app',
		redirectUris: ['https://app.example.com/callback', 'https://app.example.com/auth/return']
	},
	{
		id: 'client_partner_portal',
		name: 'Partner portal',
		redirectUris: ['https://partners.example.com/oidc/callback']
	}
];

export function createFakeClients(clients: readonly ClientOption[] = MOCK_CLIENTS): ClientsClient {
	return {
		async list() {
			return clients.map((client) => ({ ...client, redirectUris: [...client.redirectUris] }));
		}
	};
}
