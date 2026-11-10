import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';

const BASE = `${API_BASE_URL}/api/admin/authentication-method-profiles`;
export type AuthenticationMethodValues = Record<string, unknown>;

export interface AuthenticationMethodProfile {
	id: string;
	name: string;
	is_system: boolean;
	values: AuthenticationMethodValues;
	version: number | string;
	created_at: number | null;
	updated_at: number | null;
}

export interface AuthenticationMethodProfileInput {
	name: string;
	values: AuthenticationMethodValues;
}

export interface AuthenticationMethodProfilesClient {
	list(signal?: AbortSignal): Promise<AuthenticationMethodProfile[]>;
	get(id: string, signal?: AbortSignal): Promise<AuthenticationMethodProfile>;
	create(input: AuthenticationMethodProfileInput): Promise<AuthenticationMethodProfile>;
	update(
		id: string,
		version: number | string,
		input: AuthenticationMethodProfileInput
	): Promise<AuthenticationMethodProfile>;
	remove(id: string): Promise<void>;
}

const object = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

export function profileFromRow(value: unknown): AuthenticationMethodProfile {
	const row = object(value);
	return {
		id: typeof row.id === 'string' ? row.id : '',
		name: typeof row.name === 'string' ? row.name : '',
		is_system: row.is_system === true,
		values: object(row.values),
		version: typeof row.version === 'number' || typeof row.version === 'string' ? row.version : 0,
		created_at: typeof row.created_at === 'number' ? row.created_at : null,
		updated_at: typeof row.updated_at === 'number' ? row.updated_at : null
	};
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
	if (!response.ok) throw await errorFromResponse(response);
	if (response.status === 204) return {};
	return object(await response.json().catch(() => ({})));
}

const path = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
const request = (method: string, body: unknown) => ({
	method,
	includeJsonContentType: true,
	body: JSON.stringify(body)
});

export const httpAuthenticationMethodProfiles: AuthenticationMethodProfilesClient = {
	async list(signal) {
		const body = await responseBody(await adminFetch(BASE, { signal }));
		return Array.isArray(body.profiles) ? body.profiles.map(profileFromRow) : [];
	},
	async get(id, signal) {
		const body = await responseBody(await adminFetch(path(id), { signal }));
		return profileFromRow(body.profile);
	},
	async create(input) {
		const body = await responseBody(await adminFetch(BASE, request('POST', input)));
		return profileFromRow(body.profile);
	},
	async update(id, version, input) {
		const body = await responseBody(
			await adminFetch(path(id), request('PUT', { ...input, version }))
		);
		return profileFromRow(body.profile);
	},
	async remove(id) {
		await responseBody(await adminFetch(path(id), { method: 'DELETE' }));
	}
};
