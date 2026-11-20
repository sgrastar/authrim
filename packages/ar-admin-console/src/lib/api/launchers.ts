/**
 * Application launchers (`/api/admin/launchers`): the tiles of the account page, each opening an
 * application (a URL, an OIDC client, a SAML service provider) for the users it is shown to.
 * The list is in the order the account page shows it; `reorder` replaces that order. It holds the
 * platform's launchers shared with the tenant too (`shared`), as the tenant shows them.
 *
 * The platform's own launchers (`/api/admin/platform/launchers`) are read and written with the
 * same client shape (platform-launchers.ts), their sharing in `sharing`.
 */
import type {
	ApplicationLauncher,
	LauncherAttributeOperator,
	LauncherAttributeRule,
	LauncherVisibility,
	PlatformLauncherShareMode,
	SharedLauncherState
} from '@authrim/ar-lib-core/types/launchers';
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';
import { uploadLoginUiAsset } from './login-ui-themes';

export type {
	ApplicationLauncher,
	LauncherApplicationType,
	LauncherAttributeOperator,
	LauncherAttributeRule,
	LauncherIconType,
	LauncherLaunchType,
	LauncherVisibility,
	LauncherVisibilityMode,
	PlatformLauncherShareMode,
	SharedLauncherState
} from '@authrim/ar-lib-core/types/launchers';

/** Whom a platform launcher is shared with, and whether tenants may change it. */
export interface LauncherSharing {
	share_mode: PlatformLauncherShareMode;
	tenant_ids: string[];
	tenant_change_allowed: boolean;
	version: number;
}

/**
 * A launcher as the console holds it. `shared`: a platform launcher the tenant lists (null for
 * the tenant's own). `sharing`: the platform's own launcher's sharing (null in a tenant).
 */
export interface ConsoleLauncher extends ApplicationLauncher {
	shared: SharedLauncherState | null;
	sharing: LauncherSharing | null;
}

/** What is sent to create or change a launcher. */
export type LauncherInput = Omit<
	ApplicationLauncher,
	'id' | 'created_at' | 'updated_at' | 'sort_order'
> & {
	/** Left out on a change: the API keeps the launcher's place in the order. */
	sort_order?: number;
	/** The platform's launchers only. */
	share_mode?: PlatformLauncherShareMode;
	/** The platform's launchers only: the version the change is made from (a later one: 409). */
	version?: number;
	/** A shared launcher in a tenant: the platform version the admin was shown. */
	platform_version?: number;
	tenant_ids?: string[];
	tenant_change_allowed?: boolean;
};

export interface LauncherOidcClient {
	client_id: string;
	client_name: string;
	/** Where the client starts its own sign-in (OIDC third-party initiated login), if it can. */
	initiate_login_uri: string | null;
	logo_uri: string | null;
}

export interface LauncherGroup {
	id: string;
	group_key: string;
	display_name: string;
}

/** What the editor offers to choose from. */
export interface LauncherOptions {
	oidc_clients: LauncherOidcClient[];
	groups: LauncherGroup[];
	/** Attribute names known to the tenant (standard and custom). */
	attribute_keys: string[];
	/** The Phosphor icon names a tile may use. */
	phosphor_icons: string[];
}

/** A user a launcher can be shown to, as far as picking one needs. */
export interface LauncherUser {
	id: string;
	name: string;
	email: string;
}

export interface LaunchersClient {
	/** A tenant's launchers, or the platform's (shared with tenants). */
	readonly scope: 'tenant' | 'platform';
	list(signal?: AbortSignal): Promise<ConsoleLauncher[]>;
	get(id: string, signal?: AbortSignal): Promise<ConsoleLauncher>;
	options(signal?: AbortSignal): Promise<LauncherOptions>;
	create(input: LauncherInput): Promise<ConsoleLauncher>;
	update(id: string, input: LauncherInput): Promise<ConsoleLauncher>;
	/** Every launcher's ID, in the new order. Answers the launchers as they are now. */
	reorder(ids: string[]): Promise<ConsoleLauncher[]>;
	/** `version`: the platform's launchers only, the version the delete is made from. */
	remove(id: string, version?: number): Promise<void>;
	/** Drops the tenant's copy of a shared launcher (the platform's shows again). */
	revert(id: string): Promise<ConsoleLauncher>;
	/** Uploads a tile background image; answers the address a launcher stores. */
	uploadBackground(file: File): Promise<string>;
	/** Users whose name or email holds the text. */
	searchUsers(query: string, signal?: AbortSignal): Promise<LauncherUser[]>;
	/** The users with these IDs that can still be found (others are left out). */
	usersById(ids: readonly string[], signal?: AbortSignal): Promise<LauncherUser[]>;
}

const BASE = `${API_BASE_URL}/api/admin/launchers`;
/** At most this many chosen users are looked up by name; the rest show their ID. */
export const USER_LOOKUP_LIMIT = 50;

const object = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const OPERATORS = new Set<LauncherAttributeOperator>([
	'equals',
	'not_equals',
	'contains',
	'starts_with',
	'ends_with',
	'exists'
]);

function ruleFromRow(value: unknown): LauncherAttributeRule {
	const row = object(value);
	const operator = OPERATORS.has(row.operator as LauncherAttributeOperator)
		? (row.operator as LauncherAttributeOperator)
		: 'equals';
	return {
		id: text(row.id),
		attribute_key: text(row.attribute_key),
		operator,
		attribute_value: textOrNull(row.attribute_value)
	};
}

function visibilityFromRow(value: unknown): LauncherVisibility {
	const row = object(value);
	const mode = row.mode;
	return {
		mode: mode === 'users' || mode === 'groups' || mode === 'attributes' ? mode : 'everyone',
		attribute_match: row.attribute_match === 'any' ? 'any' : 'all',
		user_ids: strings(row.user_ids),
		group_ids: strings(row.group_ids),
		attribute_rules: Array.isArray(row.attribute_rules) ? row.attribute_rules.map(ruleFromRow) : []
	};
}

function sharedFromRow(value: unknown): SharedLauncherState | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	const row = object(value);
	const version = typeof row.platform_version === 'number' ? row.platform_version : 1;
	return {
		platform_version: version,
		tenant_change_allowed: row.tenant_change_allowed !== false,
		customized: row.customized === true,
		customized_from_version:
			typeof row.customized_from_version === 'number' ? row.customized_from_version : null,
		platform_updated: row.platform_updated === true
	};
}

/** The platform launcher's sharing, when the row is one (it carries a version). */
function sharingFromRow(row: Record<string, unknown>): LauncherSharing | null {
	if (typeof row.version !== 'number') return null;
	const mode = row.share_mode;
	return {
		share_mode: mode === 'all' || mode === 'selected' ? mode : 'none',
		tenant_ids: strings(row.tenant_ids),
		tenant_change_allowed: row.tenant_change_allowed !== false,
		version: row.version
	};
}

export function launcherFromRow(value: unknown): ConsoleLauncher {
	const row = object(value);
	const applicationType = row.application_type;
	const launchType = row.launch_type;
	const number = (key: string, fallback: number) =>
		typeof row[key] === 'number' ? (row[key] as number) : fallback;
	return {
		id: text(row.id),
		application_type:
			applicationType === 'oidc_client' || applicationType === 'saml_sp'
				? applicationType
				: 'standalone',
		application_id: textOrNull(row.application_id),
		name: text(row.name),
		description: textOrNull(row.description),
		category: textOrNull(row.category),
		launch_type:
			launchType === 'saml_sp_initiated' ||
			launchType === 'oidc_third_party_initiated' ||
			launchType === 'saml_idp_initiated'
				? launchType
				: 'bookmark',
		launch_url: textOrNull(row.launch_url),
		deep_link_url: textOrNull(row.deep_link_url),
		open_in_new_tab: row.open_in_new_tab === true,
		icon_type: row.icon_type === 'image' ? 'image' : 'phosphor',
		icon_value: text(row.icon_value),
		icon_color: text(row.icon_color) || '#ffffff',
		background_color: text(row.background_color) || '#2563eb',
		tile_background_color: textOrNull(row.tile_background_color),
		background_image_url: textOrNull(row.background_image_url),
		hide_icon: row.hide_icon === true,
		hide_name: row.hide_name === true,
		grid_width: number('grid_width', 2),
		sort_order: number('sort_order', 0),
		enabled: row.enabled !== false,
		allow_favorite: row.allow_favorite !== false,
		visibility: visibilityFromRow(row.visibility),
		created_at: number('created_at', 0),
		updated_at: number('updated_at', 0),
		shared: sharedFromRow(row.shared),
		sharing: sharingFromRow(row)
	};
}

export function launcherOptionsFromBody(value: unknown): LauncherOptions {
	const body = object(value);
	const rows = (key: string) => (Array.isArray(body[key]) ? (body[key] as unknown[]) : []);
	return {
		oidc_clients: rows('oidc_clients').flatMap((entry) => {
			const row = object(entry);
			const id = text(row.client_id);
			return id
				? [
						{
							client_id: id,
							client_name: text(row.client_name) || id,
							initiate_login_uri: textOrNull(row.initiate_login_uri),
							logo_uri: textOrNull(row.logo_uri)
						}
					]
				: [];
		}),
		groups: rows('groups').flatMap((entry) => {
			const row = object(entry);
			const id = text(row.id);
			return id
				? [
						{
							id,
							group_key: text(row.group_key),
							display_name: text(row.display_name) || text(row.group_key) || id
						}
					]
				: [];
		}),
		attribute_keys: strings(body.attribute_keys),
		phosphor_icons: strings(body.phosphor_icons)
	};
}

export function launcherUserFromRow(value: unknown): LauncherUser | null {
	const row = object(value);
	const id = text(row.id);
	if (!id) return null;
	return {
		id,
		name: text(row.name) || text(row.preferred_username),
		email: text(row.email)
	};
}

export async function responseBody(response: Response): Promise<Record<string, unknown>> {
	if (!response.ok) throw await errorFromResponse(response);
	if (response.status === 204) return {};
	return object(await response.json().catch(() => ({})));
}

const path = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
const send = (method: string, body: unknown) => ({
	method,
	includeJsonContentType: true,
	body: JSON.stringify(body)
});
export const launchersOf = (body: Record<string, unknown>) =>
	Array.isArray(body.launchers) ? body.launchers.map(launcherFromRow) : [];

export const httpLaunchers: LaunchersClient = {
	scope: 'tenant',
	async list(signal) {
		return launchersOf(await responseBody(await adminFetch(BASE, { signal })));
	},
	async get(id, signal) {
		const body = await responseBody(await adminFetch(path(id), { signal }));
		return launcherFromRow(body.launcher);
	},
	async options(signal) {
		return launcherOptionsFromBody(
			await responseBody(await adminFetch(`${BASE}/options`, { signal }))
		);
	},
	async create(input) {
		const body = await responseBody(await adminFetch(BASE, send('POST', input)));
		return launcherFromRow(body.launcher);
	},
	async update(id, input) {
		const body = await responseBody(await adminFetch(path(id), send('PUT', input)));
		return launcherFromRow(body.launcher);
	},
	async reorder(ids) {
		return launchersOf(
			await responseBody(await adminFetch(`${BASE}/order`, send('PUT', { launcher_ids: ids })))
		);
	},
	async remove(id) {
		await responseBody(await adminFetch(path(id), { method: 'DELETE' }));
	},
	async revert(id) {
		const body = await responseBody(
			await adminFetch(`${path(id)}/customization`, { method: 'DELETE' })
		);
		return launcherFromRow(body.launcher);
	},
	uploadBackground(file) {
		return uploadLoginUiAsset('launcher-background', file);
	},
	async searchUsers(query, signal) {
		const params = new URLSearchParams({ limit: '20', search: query });
		const body = await responseBody(
			await adminFetch(`${API_BASE_URL}/api/admin/users?${params}`, { signal })
		);
		return Array.isArray(body.users)
			? body.users.flatMap((row) => launcherUserFromRow(row) ?? [])
			: [];
	},
	async usersById(ids, signal) {
		const found = await Promise.all(
			ids.slice(0, USER_LOOKUP_LIMIT).map(async (id) => {
				try {
					const response = await adminFetch(
						`${API_BASE_URL}/api/admin/users/${encodeURIComponent(id)}`,
						{ signal }
					);
					return launcherUserFromRow((await responseBody(response)).user);
				} catch (error) {
					if (signal?.aborted) throw error;
					return null;
				}
			})
		);
		return found.filter((user): user is LauncherUser => user !== null);
	}
};
