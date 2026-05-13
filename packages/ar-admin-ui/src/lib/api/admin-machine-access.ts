import { adminFetch } from '$lib/api/admin-request';

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

export type AdminMachinePrincipalType =
	| 'setup_tool'
	| 'admin_ui_bff'
	| 'automation'
	| 'ci'
	| 'mcp_server'
	| 'ai_agent'
	| 'internal_service'
	| 'integration';

export type AdminMachinePrincipalStatus = 'active' | 'disabled' | 'deleted';
export type AdminMachineCredentialStatus = 'active' | 'rotating' | 'revoked' | 'expired';
export type AdminMachineCredentialAlgorithm = 'ES256' | 'PS256' | 'RS256';
export type AdminMachineTenantScopeMode = 'none' | 'all' | 'allow';

export interface AdminMachineTenantScope {
	scopeMode: AdminMachineTenantScopeMode;
	tenantId: string | null;
}

export interface AdminMachineCredential {
	id: string;
	principalId: string;
	kid: string;
	publicJwkJson: string;
	alg: AdminMachineCredentialAlgorithm;
	displayName: string;
	description: string | null;
	status: AdminMachineCredentialStatus;
	notBefore: number | null;
	expiresAt: number | null;
	lastUsedAt: number | null;
	lastUsedIp: string | null;
	lastUsedUserAgent: string | null;
	createdAt: number;
	updatedAt: number;
	revokedAt: number | null;
	revokeReason: string | null;
}

export interface AdminMachinePrincipal {
	id: string;
	clientId: string;
	displayName: string;
	description: string | null;
	principalType: AdminMachinePrincipalType;
	status: AdminMachinePrincipalStatus;
	defaultAudience: string;
	tokenTtlSeconds: number;
	createdAt: number;
	updatedAt: number;
	disabledAt: number | null;
	permissions: string[];
	tenantScopes: AdminMachineTenantScope[];
	credentials: AdminMachineCredential[];
}

export interface ListPrincipalsResponse {
	items: AdminMachinePrincipal[];
	page: number;
	limit: number;
}

export interface CreatePrincipalInput {
	client_id: string;
	display_name: string;
	description?: string;
	principal_type: AdminMachinePrincipalType;
	token_ttl_seconds?: number;
	permissions?: string[];
	tenant_scopes?: Array<{ scope_mode: AdminMachineTenantScopeMode; tenant_id?: string | null }>;
}

export interface UpdatePrincipalInput {
	display_name?: string;
	description?: string | null;
	token_ttl_seconds?: number;
	permissions?: string[];
	tenant_scopes?: Array<{ scope_mode: AdminMachineTenantScopeMode; tenant_id?: string | null }>;
}

export interface CreateCredentialInput {
	kid: string;
	display_name: string;
	description?: string;
	alg: AdminMachineCredentialAlgorithm;
	public_jwk: unknown;
	not_before?: number | null;
	expires_at?: number | null;
	permissions?: string[];
	tenant_scopes?: Array<{ scope_mode: AdminMachineTenantScopeMode; tenant_id?: string | null }>;
}

export interface RotateCredentialInput extends CreateCredentialInput {
	overlap_seconds?: number;
}

async function parseError(response: Response, fallback: string): Promise<Error> {
	const error = await response.json().catch(() => ({}));
	return new Error(error.error_description || error.message || fallback);
}

export const adminMachineAccessAPI = {
	async list(params: {
		status?: AdminMachinePrincipalStatus;
		principal_type?: AdminMachinePrincipalType;
		page?: number;
		limit?: number;
	} = {}): Promise<ListPrincipalsResponse> {
		const query = new URLSearchParams();
		if (params.status) query.set('status', params.status);
		if (params.principal_type) query.set('principal_type', params.principal_type);
		if (params.page) query.set('page', String(params.page));
		if (params.limit) query.set('limit', String(params.limit));

		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/machine-access/principals${query.size ? `?${query}` : ''}`
		);
		if (!response.ok) throw await parseError(response, 'Failed to fetch machine principals');
		return response.json();
	},

	async get(id: string): Promise<AdminMachinePrincipal> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/machine-access/principals/${encodeURIComponent(id)}`
		);
		if (!response.ok) throw await parseError(response, 'Failed to fetch machine principal');
		const data = await response.json();
		return data.principal;
	},

	async create(input: CreatePrincipalInput): Promise<AdminMachinePrincipal> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/machine-access/principals`, {
			method: 'POST',
			includeJsonContentType: true,
			body: JSON.stringify(input)
		});
		if (!response.ok) throw await parseError(response, 'Failed to create machine principal');
		const data = await response.json();
		return data.principal;
	},

	async update(id: string, input: UpdatePrincipalInput): Promise<AdminMachinePrincipal> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/machine-access/principals/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to update machine principal');
		const data = await response.json();
		return data.principal;
	},

	async disable(id: string, reason: string): Promise<AdminMachinePrincipal> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/machine-access/principals/${encodeURIComponent(id)}/disable`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({ reason })
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to disable machine principal');
		const data = await response.json();
		return data.principal;
	},

	async enable(id: string): Promise<AdminMachinePrincipal> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/machine-access/principals/${encodeURIComponent(id)}/enable`,
			{ method: 'POST' }
		);
		if (!response.ok) throw await parseError(response, 'Failed to enable machine principal');
		const data = await response.json();
		return data.principal;
	},

	async createCredential(
		principalId: string,
		input: CreateCredentialInput
	): Promise<AdminMachineCredential> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/machine-access/principals/${encodeURIComponent(
				principalId
			)}/credentials`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to create machine credential');
		const data = await response.json();
		return data.credential;
	},

	async rotateCredential(
		principalId: string,
		credentialId: string,
		input: RotateCredentialInput
	): Promise<AdminMachineCredential> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/machine-access/principals/${encodeURIComponent(
				principalId
			)}/credentials/${encodeURIComponent(credentialId)}/rotate`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify(input)
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to rotate machine credential');
		const data = await response.json();
		return data.credential;
	},

	async emergencyRevokeCredential(
		principalId: string,
		credentialId: string,
		reason: string
	): Promise<AdminMachineCredential> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/machine-access/principals/${encodeURIComponent(
				principalId
			)}/credentials/${encodeURIComponent(credentialId)}/emergency-revoke`,
			{
				method: 'POST',
				includeJsonContentType: true,
				body: JSON.stringify({ reason })
			}
		);
		if (!response.ok) throw await parseError(response, 'Failed to revoke machine credential');
		const data = await response.json();
		return data.credential;
	}
};
