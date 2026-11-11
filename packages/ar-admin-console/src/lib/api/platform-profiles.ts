/**
 * The platform's own method and session profiles (`/api/admin/platform/{authentication-method,
 * session}-profiles`): named profiles every tenant can use, change into a copy of its own (while
 * the platform allows it), and that the platform can lock. Platform admins only.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';

export type PlatformProfileKind = 'method' | 'session';

export interface PlatformProfile {
	id: string;
	name: string;
	values: Record<string, unknown>;
	version: number;
	locked: boolean;
	/** `deleting`: a delete is checking for references (no change is taken meanwhile). */
	state: 'active' | 'deleting' | 'deleted';
	/** How many tenants keep a copy of it (with or without it applying). */
	overridingTenants: number | null;
	created_at: number | null;
	updated_at: number | null;
}

export interface PlatformProfileInput {
	name: string;
	values: Record<string, unknown>;
}

export interface PlatformProfilesClient {
	list(signal?: AbortSignal): Promise<PlatformProfile[]>;
	get(id: string, signal?: AbortSignal): Promise<PlatformProfile>;
	create(input: PlatformProfileInput): Promise<PlatformProfile>;
	update(id: string, version: number, input: PlatformProfileInput): Promise<PlatformProfile>;
	setLocked(id: string, version: number, locked: boolean): Promise<PlatformProfile>;
	remove(id: string): Promise<void>;
}

const PATHS: Readonly<Record<PlatformProfileKind, string>> = {
	method: 'authentication-method-profiles',
	session: 'session-profiles'
};

const object = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

export function platformProfileFromRow(value: unknown): PlatformProfile {
	const row = object(value);
	return {
		id: typeof row.id === 'string' ? row.id : '',
		name: typeof row.name === 'string' ? row.name : '',
		values: object(row.values),
		version: typeof row.version === 'number' ? row.version : 0,
		locked: row.locked === true,
		state: row.state === 'deleting' || row.state === 'deleted' ? row.state : 'active',
		overridingTenants: typeof row.overriding_tenants === 'number' ? row.overriding_tenants : null,
		created_at: typeof row.created_at === 'number' ? row.created_at : null,
		updated_at: typeof row.updated_at === 'number' ? row.updated_at : null
	};
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
	if (!response.ok) throw await errorFromResponse(response);
	if (response.status === 204) return {};
	return object(await response.json().catch(() => ({})));
}

const request = (method: string, body: unknown) => ({
	method,
	includeJsonContentType: true,
	body: JSON.stringify(body)
});

/** The client for one kind of platform profile. */
export function httpPlatformProfiles(kind: PlatformProfileKind): PlatformProfilesClient {
	const base = `${API_BASE_URL}/api/admin/platform/${PATHS[kind]}`;
	const path = (id: string) => `${base}/${encodeURIComponent(id)}`;
	return {
		async list(signal) {
			const body = await responseBody(await adminFetch(base, { signal }));
			return Array.isArray(body.profiles) ? body.profiles.map(platformProfileFromRow) : [];
		},
		async get(id, signal) {
			const body = await responseBody(await adminFetch(path(id), { signal }));
			return platformProfileFromRow(body.profile);
		},
		async create(input) {
			const body = await responseBody(await adminFetch(base, request('POST', input)));
			return platformProfileFromRow(body.profile);
		},
		async update(id, version, input) {
			const body = await responseBody(
				await adminFetch(path(id), request('PUT', { ...input, version }))
			);
			return platformProfileFromRow(body.profile);
		},
		async setLocked(id, version, locked) {
			const body = await responseBody(
				await adminFetch(`${path(id)}/lock`, request('PUT', { locked, version }))
			);
			return platformProfileFromRow(body.profile);
		},
		async remove(id) {
			await responseBody(await adminFetch(path(id), { method: 'DELETE' }));
		}
	};
}
