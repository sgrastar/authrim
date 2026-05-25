import { adminFetch, API_BASE_URL } from '$lib/api/admin-request';

export interface TenantVanityDomain {
	id: string;
	tenant_id: string;
	hostname: string;
	is_active: boolean;
	is_primary: boolean;
	status: 'pending' | 'pending_manual' | 'active' | 'failed' | 'deleted';
	cloudflare_zone_id: string | null;
	cloudflare_custom_hostname_id: string | null;
	ssl_status: string | null;
	ownership_status: string | null;
	validation_method: string | null;
	validation_records: unknown;
	last_sync_at: number | null;
	created_by: string | null;
	created_at: number;
	updated_at: number;
}

interface VanityDomainListResponse {
	domains: TenantVanityDomain[];
	cloudflare_configured: boolean;
}

interface VanityDomainCreateResponse {
	domain: TenantVanityDomain;
	cloudflare_configured: boolean;
	manual_setup_required: boolean;
	cloudflare_error: string | null;
}

interface VanityDomainMutationResponse {
	domain: TenantVanityDomain;
	cloudflare_configured?: boolean;
}

async function parseError(response: Response, fallback: string): Promise<Error> {
	const error = await response.json().catch(() => ({}));
	return new Error(error.error_description || error.message || fallback);
}

export const tenantVanityDomainsAPI = {
	async list(tenantId: string): Promise<VanityDomainListResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/tenant-vanity-domains`, {
			tenantId
		});
		if (!response.ok) throw await parseError(response, 'Failed to fetch vanity domains');
		return response.json();
	},

	async create(tenantId: string, hostname: string): Promise<VanityDomainCreateResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/tenant-vanity-domains`, {
			method: 'POST',
			includeJsonContentType: true,
			tenantId,
			body: JSON.stringify({ hostname, is_primary: true })
		});
		if (!response.ok) throw await parseError(response, 'Failed to create vanity domain');
		return response.json();
	},

	async sync(tenantId: string, id: string): Promise<VanityDomainMutationResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenant-vanity-domains/${encodeURIComponent(id)}/sync`,
			{
				method: 'POST',
				tenantId
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to sync vanity domain');
		return response.json();
	},

	async verify(tenantId: string, id: string): Promise<VanityDomainMutationResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenant-vanity-domains/${encodeURIComponent(id)}/verify`,
			{
				method: 'POST',
				tenantId
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to verify vanity domain');
		return response.json();
	},

	async setPrimary(tenantId: string, id: string): Promise<TenantVanityDomain> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenant-vanity-domains/${encodeURIComponent(id)}/primary`,
			{
				method: 'POST',
				tenantId
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to set primary vanity domain');
		return response.json();
	},

	async delete(tenantId: string, id: string): Promise<void> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenant-vanity-domains/${encodeURIComponent(id)}`,
			{
				method: 'DELETE',
				tenantId
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to delete vanity domain');
	}
};

export const platformTenantVanityDomainsAPI = {
	async list(tenantId?: string): Promise<VanityDomainListResponse> {
		const query = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : '';
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/tenant-vanity-domains${query}`,
			{
				skipTenantHeader: true
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to fetch vanity domains');
		return response.json();
	},

	async sync(id: string): Promise<VanityDomainMutationResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/tenant-vanity-domains/${encodeURIComponent(id)}/sync`,
			{
				method: 'POST',
				skipTenantHeader: true
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to sync vanity domain');
		return response.json();
	},

	async verify(id: string): Promise<VanityDomainMutationResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/tenant-vanity-domains/${encodeURIComponent(id)}/verify`,
			{
				method: 'POST',
				skipTenantHeader: true
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to verify vanity domain');
		return response.json();
	},

	async setPrimary(id: string): Promise<TenantVanityDomain> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/tenant-vanity-domains/${encodeURIComponent(id)}/primary`,
			{
				method: 'POST',
				skipTenantHeader: true
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to set primary vanity domain');
		return response.json();
	},

	async delete(id: string): Promise<void> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/tenant-vanity-domains/${encodeURIComponent(id)}`,
			{
				method: 'DELETE',
				skipTenantHeader: true
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to delete vanity domain');
	}
};
