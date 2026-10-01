/**
 * Settings API v2: one category of settings at one scope (the platform, a tenant, an app).
 *
 * Reading gives each value with where it comes from (`sources`: set here in KV, from the
 * deployment's environment, or the built-in default) and a `version`. A change sends that
 * version back (`ifMatch`); if someone else saved in between, it fails with ConflictError
 * instead of silently overwriting them.
 *
 * Pages take a `SettingsClient` rather than calling fetch, so Storybook and tests hand them an
 * in-memory one (`fake/settings-fake.ts`).
 */
import type { CategoryName } from '@authrim/ar-lib-core/types/settings/catalog';
import type {
	SettingSource,
	SettingsGetResult as CoreSettingsGetResult,
	SettingsPatchRequest,
	SettingsPatchResult
} from '@authrim/ar-lib-core/utils/settings-manager';
import { adminFetch, API_BASE_URL } from './admin-request';
import { errorFromResponse } from './api-error';

export type { CategoryName, SettingSource, SettingsPatchRequest, SettingsPatchResult };

/**
 * A category as read. `locked`: settings the scope above has fixed, which this scope may not
 * override (shown, but not offered for change).
 * TODO(api): the Settings API has no locks yet; only the in-memory API sends them.
 */
export type SettingsGetResult = CoreSettingsGetResult & { locked?: string[] };

/** Where settings are read and written. */
export type SettingsTarget =
	| { level: 'platform' }
	| { level: 'tenant'; tenantId: string }
	| { level: 'client'; clientId: string; tenantId: string };

export interface SettingsClient {
	get(
		target: SettingsTarget,
		category: CategoryName,
		signal?: AbortSignal
	): Promise<SettingsGetResult>;
	/**
	 * Applies what it can: keys it refuses come back in `rejected` (200). Throws RejectedError
	 * when nothing was applied, ConflictError when `ifMatch` is not the current version.
	 */
	patch(
		target: SettingsTarget,
		category: CategoryName,
		request: SettingsPatchRequest
	): Promise<SettingsPatchResult>;
}

/** A stable name for a target (`tenant:acme`, `platform`), to compare and to key stores. */
export function targetKey(target: SettingsTarget): string {
	switch (target.level) {
		case 'platform':
			return 'platform';
		case 'tenant':
			return `tenant:${target.tenantId}`;
		case 'client':
			return `client:${target.clientId}`;
	}
}

function settingsPath(target: SettingsTarget, category: CategoryName): string {
	const name = encodeURIComponent(category);
	switch (target.level) {
		case 'platform':
			return `/api/admin/platform/settings/${name}`;
		case 'tenant':
			return `/api/admin/tenants/${encodeURIComponent(target.tenantId)}/settings/${name}`;
		case 'client':
			return `/api/admin/clients/${encodeURIComponent(target.clientId)}/settings/${name}`;
	}
}

function tenantOf(target: SettingsTarget): string | undefined {
	return target.level === 'platform' ? undefined : target.tenantId;
}

/** The Admin API, through the console's same-origin proxy. */
export const httpSettings: SettingsClient = {
	async get(target, category, signal) {
		const response = await adminFetch(`${API_BASE_URL}${settingsPath(target, category)}`, {
			signal,
			tenantId: tenantOf(target)
		});
		if (!response.ok) throw await errorFromResponse(response);
		return (await response.json()) as SettingsGetResult;
	},
	async patch(target, category, request) {
		const response = await adminFetch(`${API_BASE_URL}${settingsPath(target, category)}`, {
			method: 'PATCH',
			body: JSON.stringify(request),
			includeJsonContentType: true,
			tenantId: tenantOf(target)
		});
		if (!response.ok) throw await errorFromResponse(response);
		return (await response.json()) as SettingsPatchResult;
	}
};
