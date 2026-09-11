import { adminFetch, API_BASE_URL } from './admin-request';
export interface ClientGuestPolicy {
	enabled: boolean;
	allowedScopes: string[];
	preserveSubOnUpgrade: true;
	allowPromptNone: boolean;
	allowedUpgradeMethods: ('email' | 'passkey')[];
}
export const defaultClientGuestPolicy = (): ClientGuestPolicy => ({
	enabled: false,
	allowedScopes: ['openid', 'account:lifecycle:read'],
	preserveSubOnUpgrade: true,
	allowPromptNone: false,
	allowedUpgradeMethods: ['email', 'passkey']
});
export const adminClientGuestAPI = {
	async get(
		clientId: string,
		tenantId: string
	): Promise<{ version: number; policy: ClientGuestPolicy }> {
		const result = await adminFetch(
			`${API_BASE_URL}/api/admin/clients/${encodeURIComponent(clientId)}/profile`,
			{ tenantId }
		);
		if (result.status === 404) return { version: 0, policy: defaultClientGuestPolicy() };
		if (!result.ok) throw new Error('guest_policy_load_failed');
		return readGuestProfile(result);
	},
	async save(
		clientId: string,
		tenantId: string,
		version: number,
		policy: ClientGuestPolicy
	): Promise<{ version: number; policy: ClientGuestPolicy }> {
		const result = await adminFetch(
			`${API_BASE_URL}/api/admin/clients/${encodeURIComponent(clientId)}/profile`,
			{
				method: 'PUT',
				tenantId,
				includeJsonContentType: true,
				body: JSON.stringify({ ifMatch: String(version), profile: { guestAuth: policy } })
			}
		);
		if (!result.ok)
			throw new Error(
				result.status === 409
					? 'guest_policy_conflict'
					: result.status === 412
						? 'guest_policy_tenant_required'
						: 'guest_policy_save_failed'
			);
		return readGuestProfile(result);
	}
};

async function readGuestProfile(
	result: Response
): Promise<{ version: number; policy: ClientGuestPolicy }> {
	const data = (await result.json()) as {
		profile: { version: number; guestAuth?: Partial<ClientGuestPolicy> };
	};
	return {
		version: data.profile.version,
		policy: {
			...defaultClientGuestPolicy(),
			...data.profile.guestAuth,
			preserveSubOnUpgrade: true
		}
	};
}
