/**
 * Tenant info API: what the tenant is called, the addresses it is reached at, which parts of
 * Authrim this environment runs, and the endpoint URLs apps and partners are given. Read-only;
 * nothing here is set from the console (the addresses come from the environment and the tenant's
 * domain).
 *
 * The Admin API answers in its own shape (snake_case, endpoints grouped by protocol). This module
 * turns that into what a page works with (camelCase, endpoint groups in a fixed order), so no page
 * has to know the wire shape. Pages take a `TenantInfoClient` rather than calling fetch, so
 * Storybook and tests hand them an in-memory one (`fake/tenant-info-fake.ts`).
 */
import { adminFetch, API_BASE_URL } from './admin-request';
import { errorFromResponse } from './api-error';

/** The groups of endpoints, in the order they are shown. */
export const ENDPOINT_GROUPS = [
	'well_known',
	'oidc',
	'oauth_extensions',
	'saml',
	'vc',
	'ciba',
	'scim',
	'admin_api'
] as const;
export type EndpointGroupId = (typeof ENDPOINT_GROUPS)[number];

export interface Endpoint {
	/** The API's own name for it (`token`, `idp_metadata`…). */
	id: string;
	url: string;
}

export interface EndpointGroup {
	id: EndpointGroupId;
	endpoints: Endpoint[];
}

/** The parts of Authrim this environment runs. */
export interface Components {
	loginUi: boolean;
	adminUi: boolean;
	saml: boolean;
	async: boolean;
	vc: boolean;
}

export interface ProfileChoice {
	id: string;
	label: string;
	/** Not set for the tenant: it follows the environment's. */
	inherited: boolean;
}

export interface RuntimeProfiles {
	registryBackend: string;
	audit: ProfileChoice;
	residency: ProfileChoice;
}

export interface TenantInfo {
	tenantId: string;
	name: string;
	/** The tenant's address; tokens carry it as `iss`. */
	issuer: string;
	apiUrl: string;
	components: Components;
	/** Where people sign in for this tenant. */
	loginUrl: string | null;
	/** The sign-in UI's base address set for the tenant, when it has one. */
	loginBaseUrl: string | null;
	/** The shared sign-in and tenant-finding pages (only when tenants have their own addresses). */
	sharedLoginUrl: string | null;
	discoverUrl: string | null;
	adminUrl: string | null;
	/** Null when they could not be read; `profilesError` then says why. */
	profiles: RuntimeProfiles | null;
	profilesError: string | null;
	endpoints: EndpointGroup[];
}

export interface TenantInfoClient {
	get(tenantId: string, signal?: AbortSignal): Promise<TenantInfo>;
}

// ---------------------------------------------------------------------------------------------
// From the wire

type Row = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const orNull = (value: unknown): string | null =>
	typeof value === 'string' && value !== '' ? value : null;
const flag = (value: unknown) => value === true;
const record = (value: unknown): Row =>
	value !== null && typeof value === 'object' ? (value as Row) : {};

function choice(value: unknown): ProfileChoice {
	const row = record(value);
	return { id: text(row.id), label: text(row.label), inherited: flag(row.inherited) };
}

/** The endpoints of one group, without the entries that are only kept for older callers. */
const DEPRECATED = new Set(['saml.metadata']);

export function tenantInfoFromRow(row: Row): TenantInfo {
	const components = record(row.components);
	const profiles = row.runtime_profiles ? record(row.runtime_profiles) : null;
	const effective = record(profiles?.effective);
	return {
		tenantId: text(row.tenant_id),
		name: text(row.tenant_name),
		issuer: text(row.issuer),
		apiUrl: text(row.api_url),
		components: {
			loginUi: flag(components.login_ui),
			adminUi: flag(components.admin_ui),
			saml: flag(components.saml),
			async: flag(components.async),
			vc: flag(components.vc)
		},
		loginUrl: orNull(row.login_ui_url),
		loginBaseUrl: orNull(row.login_ui_base_url),
		sharedLoginUrl: orNull(row.global_login_ui_url),
		discoverUrl: orNull(row.discover_url),
		adminUrl: orNull(row.admin_ui_url),
		profiles: profiles
			? {
					registryBackend: text(profiles.registry_backend),
					audit: choice(effective.audit),
					residency: choice(effective.residency)
				}
			: null,
		profilesError: orNull(row.runtime_profiles_error),
		endpoints: ENDPOINT_GROUPS.map((id) => ({
			id,
			endpoints: Object.entries(record(row[id]))
				.filter(([name, url]) => typeof url === 'string' && !DEPRECATED.has(`${id}.${name}`))
				.map(([name, url]) => ({ id: name, url: url as string }))
		})).filter((group) => group.endpoints.length > 0)
	};
}

// ---------------------------------------------------------------------------------------------
// Over HTTP

export const httpTenantInfo: TenantInfoClient = {
	async get(tenantId, signal) {
		// A tenant-inventory route: it names the tenant in the path, so no tenant header is sent.
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(tenantId)}/info`,
			{ signal, skipTenantHeader: true }
		);
		if (!response.ok) throw await errorFromResponse(response);
		return tenantInfoFromRow((await response.json()) as Row);
	}
};
