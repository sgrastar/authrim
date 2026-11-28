/**
 * Check API keys (`/api/admin/check-api-keys`): the `chk_` keys a service's backend uses to ask
 * the Check API about any of the tenant's users. Read with `admin:security:read`; made and revoked
 * with `admin:security:write` (the platform can turn machine credentials off for tenants, which
 * stops new keys only: revoking needs no capability). A key's
 * secret is returned once, when it is made; this list has its prefix only.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';
import { stepUpHeaders, withStepUp } from './admin-step-up';
import { MalformedResponseError, msOrNull } from './end-user-groups';

export interface CheckApiKey {
	id: string;
	name: string;
	client_id: string;
	key_prefix: string;
	allowed_operations: string[];
	rate_limit_tier: string;
	is_active: boolean;
	expires_at: number | null;
	created_at: number | null;
}

export interface CheckApiKeysPage {
	items: CheckApiKey[];
	page: number;
	limit: number;
	total: number;
}

/** What a new key is made from. The tenant is the one the client was made for. */
export interface CheckApiKeyInput {
	name: string;
	/** The client (the app's backend) the key belongs to. */
	client_id: string;
	/** Any of `check`, `batch`, `subscribe`. */
	allowed_operations: string[];
	/** When it stops working, in milliseconds; null for no end. */
	expires_at: number | null;
}

/** A made key, with the secret the API returns this once. */
export interface CreatedCheckApiKey {
	key: CheckApiKey;
	api_key: string;
}

export interface CheckApiKeysClient {
	create(input: CheckApiKeyInput): Promise<CreatedCheckApiKey>;
	/** One page (1-based) of the tenant's keys. */
	list(page?: number, limit?: number, signal?: AbortSignal): Promise<CheckApiKeysPage>;
	revoke(keyId: string): Promise<void>;
}

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function checkApiKeyFromRow(value: unknown): CheckApiKey {
	const row = record(value);
	return {
		id: text(row.id),
		name: text(row.name),
		client_id: text(row.client_id),
		key_prefix: text(row.key_prefix),
		allowed_operations: Array.isArray(row.allowed_operations)
			? row.allowed_operations.filter((item): item is string => typeof item === 'string')
			: [],
		rate_limit_tier: text(row.rate_limit_tier),
		is_active: row.is_active === true || row.is_active === 1,
		expires_at: msOrNull(row.expires_at),
		created_at: msOrNull(row.created_at)
	};
}

/** The create request: the API takes the end in epoch seconds. */
export function checkApiKeyBody(input: CheckApiKeyInput): Record<string, unknown> {
	return {
		name: input.name.trim(),
		client_id: input.client_id.trim(),
		allowed_operations: input.allowed_operations,
		...(input.expires_at === null ? {} : { expires_at: Math.floor(input.expires_at / 1000) })
	};
}

/** The create response: the key as a list row would show it, and the secret. */
export function createdCheckApiKeyFrom(value: unknown): CreatedCheckApiKey {
	const row = record(value);
	return {
		key: checkApiKeyFromRow({ ...row, is_active: true }),
		api_key: text(row.api_key)
	};
}

export function httpCheckApiKeys(tenantId: string): CheckApiKeysClient {
	const base = `${API_BASE_URL}/api/admin/check-api-keys`;
	return {
		async create(input) {
			return withStepUp(async (receipt) => {
				const response = await adminFetch(base, {
					method: 'POST',
					tenantId,
					headers: stepUpHeaders(receipt),
					includeJsonContentType: true,
					body: JSON.stringify(checkApiKeyBody(input))
				});
				if (!response.ok) throw await errorFromResponse(response);
				const created = createdCheckApiKeyFrom(await response.json().catch(() => ({})));
				if (!created.api_key) throw new MalformedResponseError('check-api-keys');
				return created;
			});
		},
		async list(page = 1, limit = 20, signal) {
			const response = await adminFetch(`${base}?page=${page}&limit=${limit}`, {
				signal,
				tenantId
			});
			if (!response.ok) throw await errorFromResponse(response);
			const body = record(await response.json().catch(() => ({})));
			const items = (Array.isArray(body.keys) ? body.keys : []).map(checkApiKeyFromRow);
			const number = (value: unknown, fallback: number) =>
				typeof value === 'number' && Number.isFinite(value) ? value : fallback;
			return {
				items,
				page: number(body.page, page),
				limit: number(body.limit, limit),
				total: number(body.total, items.length)
			};
		},
		async revoke(keyId) {
			await withStepUp(async (receipt) => {
				const response = await adminFetch(`${base}/${encodeURIComponent(keyId)}`, {
					method: 'DELETE',
					tenantId,
					headers: stepUpHeaders(receipt)
				});
				if (!response.ok) throw await errorFromResponse(response);
			});
		}
	};
}
