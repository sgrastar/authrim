/**
 * In-memory tenant info API for Storybook and tests. Answers with a made-up tenant whose
 * addresses are built from an issuer the way the Admin API builds them.
 */
import { ApiError } from '../api-error';
import { tenantInfoFromRow, type TenantInfo, type TenantInfoClient } from '../tenant-info';

export interface FakeTenantInfoOptions {
	/** Milliseconds each call takes. */
	delay?: number;
	/** Fail with this status (403 no access, 404 no such tenant, 503 settings unreadable). */
	fail?: 403 | 404 | 503 | 500;
	/** The profiles could not be read. */
	profilesUnreadable?: boolean;
	/** Tenants do not have addresses of their own (one tenant on the deployment). */
	singleTenant?: boolean;
	/** Parts of Authrim this environment does not run. */
	without?: ('login_ui' | 'admin_ui' | 'saml' | 'async' | 'vc')[];
}

const ISSUER = 'https://acme.auth.example.com';

export function wireRow(options: FakeTenantInfoOptions = {}): Record<string, unknown> {
	const off = new Set(options.without ?? []);
	const issuer = ISSUER;
	return {
		tenant_id: 'acme',
		tenant_name: 'Acme Corporation',
		issuer,
		components: {
			login_ui: !off.has('login_ui'),
			admin_ui: !off.has('admin_ui'),
			saml: !off.has('saml'),
			async: !off.has('async'),
			vc: !off.has('vc')
		},
		login_ui_url: `${issuer}/login`,
		login_ui_base_url: 'https://login.example.com',
		global_login_ui_url: options.singleTenant ? null : 'https://login.example.com/login',
		discover_url: options.singleTenant ? null : 'https://login.example.com/discover',
		admin_ui_url: off.has('admin_ui') ? null : 'https://admin.example.com',
		api_url: issuer,
		runtime_profiles: options.profilesUnreadable
			? null
			: {
					registry_backend: 'kv',
					effective: {
						audit: { id: 'standard', label: 'Standard audit', inherited: true },
						residency: { id: 'jp', label: 'Japan only', inherited: false }
					}
				},
		runtime_profiles_error: options.profilesUnreadable ? 'residency_profile_not_found:jp' : null,
		well_known: {
			openid_configuration: `${issuer}/.well-known/openid-configuration`,
			oauth_authorization_server: `${issuer}/.well-known/oauth-authorization-server`,
			jwks: `${issuer}/.well-known/jwks.json`,
			webfinger: `${issuer}/.well-known/webfinger`
		},
		oidc: {
			authorization: `${issuer}/authorize`,
			token: `${issuer}/token`,
			userinfo: `${issuer}/userinfo`,
			introspection: `${issuer}/introspect`,
			revocation: `${issuer}/revoke`,
			end_session: `${issuer}/logout`
		},
		oauth_extensions: {
			device_authorization: `${issuer}/device_authorization`,
			pushed_authorization_request: `${issuer}/par`,
			dynamic_client_registration: `${issuer}/register`
		},
		saml: {
			sso: `${issuer}/saml/idp/sso`,
			idp_metadata: `${issuer}/saml/idp/metadata`,
			sp_metadata: `${issuer}/saml/sp/metadata`,
			metadata: `${issuer}/saml/sp/metadata`,
			acs: `${issuer}/saml/sp/acs`,
			slo: `${issuer}/saml/sp/slo`
		},
		vc: {
			credential_issuer_metadata: `${issuer}/.well-known/openid-credential-issuer`,
			credential: `${issuer}/vci/credential`,
			batch_credential: `${issuer}/vci/batch_credential`,
			deferred_credential: `${issuer}/vci/deferred`,
			vp_token_request: `${issuer}/vp/authorize`
		},
		ciba: { backchannel_authentication: `${issuer}/bc-authorize` },
		scim: {
			base: `${issuer}/scim/v2`,
			users: `${issuer}/scim/v2/Users`,
			groups: `${issuer}/scim/v2/Groups`,
			service_provider_config: `${issuer}/scim/v2/ServiceProviderConfig`
		},
		admin_api: {
			base: `${issuer}/api/admin`,
			users: `${issuer}/api/admin/users`,
			clients: `${issuer}/api/admin/clients`,
			sessions: `${issuer}/api/admin/sessions`,
			audit_logs: `${issuer}/api/admin/audit-logs`,
			settings: `${issuer}/api/admin/settings/meta`,
			tenants: `${issuer}/api/admin/tenants`,
			custom_claims: `${issuer}/api/admin/custom-claims`,
			organizations: `${issuer}/api/admin/organizations`,
			roles: `${issuer}/api/admin/roles`,
			webhooks: `${issuer}/api/admin/webhooks`
		}
	};
}

export function createFakeTenantInfo(options: FakeTenantInfoOptions = {}): TenantInfoClient {
	return {
		async get(): Promise<TenantInfo> {
			if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
			if (options.fail) throw new ApiError(options.fail, 'error', 'failed');
			return tenantInfoFromRow(wireRow(options));
		}
	};
}
