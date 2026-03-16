/**
 * Admin Info / Metadata API Client
 *
 * Fetches issuer info and all derived endpoint URLs for a given tenant.
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

export interface TenantEndpoints {
	well_known: {
		openid_configuration: string;
		oauth_authorization_server: string;
		jwks: string;
		webfinger: string;
	};
	oidc: {
		authorization: string;
		token: string;
		userinfo: string;
		introspection: string;
		revocation: string;
		end_session: string;
	};
	oauth_extensions: {
		device_authorization: string;
		pushed_authorization_request: string;
		dynamic_client_registration: string;
	};
	saml: {
		sso: string;
		metadata: string;
		acs: string;
		slo: string;
	};
	vc: {
		credential_issuer_metadata: string;
		credential: string;
		batch_credential: string;
		deferred_credential: string;
		vp_token_request: string;
	};
	ciba: {
		backchannel_authentication: string;
	};
	scim: {
		base: string;
		users: string;
		groups: string;
		service_provider_config: string;
	};
	admin_api: {
		base: string;
		users: string;
		clients: string;
		sessions: string;
		audit_logs: string;
		settings: string;
		tenants: string;
		custom_claims: string;
		organizations: string;
		roles: string;
		webhooks: string;
	};
}

export interface TenantInfo extends TenantEndpoints {
	tenant_id: string;
	tenant_name: string;
	issuer: string;
	components: {
		login_ui: boolean;
		admin_ui: boolean;
		saml: boolean;
		async: boolean;
		vc: boolean;
	};
	login_ui_url: string | null;
	admin_ui_url: string | null;
	api_url: string;
}

export async function getTenantInfo(tenantId: string): Promise<TenantInfo> {
	const response = await fetch(`${API_BASE_URL}/api/admin/tenants/${tenantId}/info`, {
		credentials: 'include'
	});

	if (!response.ok) {
		const err = await response.json().catch(() => ({ error: 'unknown_error' }));
		throw new Error(err.message || err.error || 'Failed to fetch tenant info');
	}

	return response.json();
}
