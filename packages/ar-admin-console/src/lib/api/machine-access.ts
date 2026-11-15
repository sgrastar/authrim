/**
 * Machine access (`/api/admin/machine-access`): machine principals (an automation, a CI job, an
 * integration…) that sign in to the Admin API with their own key (private_key_jwt), and the
 * public keys they sign in with. Authrim stores only the public key.
 *
 * The API answers in camelCase. Requests carry the tenant header as the other platform clients
 * do (the selected tenant). Handing out access (permissions, tenant reach, a new key, enabling a
 * principal) is protected by step-up (`machine.permission.grant`): the request is sent, the
 * refusal is met once, and the same request is repeated with the receipt (as `admin-groups`).
 *
 * The list reads the API's pages (100 each) until one comes back empty.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';
import { stepUpHeaders, withStepUp } from './admin-step-up';

export const MACHINE_PRINCIPAL_TYPES = [
	'automation',
	'ci',
	'integration',
	'mcp_server',
	'ai_agent',
	'internal_service',
	'setup_tool',
	'admin_ui_bff'
] as const;
export type MachinePrincipalType = (typeof MACHINE_PRINCIPAL_TYPES)[number];

export type MachinePrincipalStatus = 'active' | 'disabled' | 'deleted';
export type MachineKeyStatus = 'active' | 'rotating' | 'revoked' | 'expired';
export const MACHINE_KEY_ALGORITHMS = ['ES256', 'PS256', 'RS256'] as const;
export type MachineKeyAlgorithm = (typeof MACHINE_KEY_ALGORITHMS)[number];

/** Which tenants a machine reaches. */
export type MachineReach =
	| { mode: 'none' }
	| { mode: 'all' }
	| { mode: 'tenants'; tenantIds: string[] };

/** The API's longest token lifetime (seconds), and what it uses when none is given. */
const LIST_PAGE_SIZE = 100;
/** A cap so the list can never loop forever. */
export const LIST_MAX_PAGES = 50;

export const MACHINE_TOKEN_TTL_MAX = 900;
export const MACHINE_TOKEN_TTL_DEFAULT = 600;

export interface MachineKey {
	id: string;
	kid: string;
	alg: string;
	displayName: string;
	status: MachineKeyStatus;
	notBefore: number | null;
	expiresAt: number | null;
	lastUsedAt: number | null;
	createdAt: number;
}

export interface MachinePrincipal {
	id: string;
	clientId: string;
	displayName: string;
	description: string | null;
	principalType: string;
	status: MachinePrincipalStatus;
	tokenTtlSeconds: number;
	permissions: string[];
	reach: MachineReach;
	keys: MachineKey[];
	createdAt: number;
	updatedAt: number;
}

export interface MachinePrincipalInput {
	clientId: string;
	displayName: string;
	description?: string;
	principalType: MachinePrincipalType;
	tokenTtlSeconds: number;
	permissions: string[];
	reach: MachineReach;
}

export interface MachinePrincipalPatch {
	displayName?: string;
	description?: string | null;
	tokenTtlSeconds?: number;
	permissions?: string[];
	reach?: MachineReach;
}

export interface MachineKeyInput {
	kid: string;
	displayName: string;
	alg: MachineKeyAlgorithm;
	/** A public JWK; only its allowlisted members are sent (`pickPublicJwk`). */
	publicJwk: MachinePublicJwk;
	/** Epoch ms; omitted: no end. */
	expiresAt?: number;
}

/** The members of a public key that may be sent: its numbers and a few plain labels. */
export interface MachinePublicJwk {
	kty?: unknown;
	crv?: unknown;
	x?: unknown;
	y?: unknown;
	n?: unknown;
	e?: unknown;
	alg?: unknown;
	use?: unknown;
	kid?: unknown;
	key_ops?: unknown;
}

/**
 * A new object with only the allowlisted members, each a string (`key_ops`: strings). Whatever
 * else the input holds (unknown members, nested objects that could carry a private part) is
 * dropped, so it can never be sent.
 */
export function pickPublicJwk(
	jwk: MachinePublicJwk | Record<string, unknown>
): Record<string, unknown> {
	const source = jwk as Record<string, unknown>;
	const names =
		source.kty === 'EC' ? ['kty', 'crv', 'x', 'y'] : source.kty === 'RSA' ? ['kty', 'n', 'e'] : [];
	const picked: Record<string, unknown> = {};
	for (const name of [...names, 'alg', 'use', 'kid']) {
		if (typeof source[name] === 'string') picked[name] = source[name];
	}
	if (Array.isArray(source.key_ops) && source.key_ops.every((op) => typeof op === 'string')) {
		picked.key_ops = [...(source.key_ops as string[])];
	}
	return picked;
}

export interface MachineAccessClient {
	list(signal?: AbortSignal): Promise<MachinePrincipal[]>;
	get(principalId: string, signal?: AbortSignal): Promise<MachinePrincipal>;
	/** A client id already used answers 409; permissions the admin may not give answer 400. */
	create(input: MachinePrincipalInput): Promise<MachinePrincipal>;
	update(principalId: string, patch: MachinePrincipalPatch): Promise<MachinePrincipal>;
	/** Bringing a disabled principal back is handing out access again (step-up). */
	enable(principalId: string): Promise<void>;
	disable(principalId: string): Promise<void>;
	/** A kid already used by the principal answers 409. */
	addKey(principalId: string, input: MachineKeyInput): Promise<MachineKey>;
	/** The key stops working at once; it cannot be brought back. */
	revokeKey(principalId: string, keyId: string): Promise<void>;
}

type Row = Record<string, unknown>;

const record = (value: unknown): Row =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null =>
	typeof value === 'string' && value !== '' ? value : null;
const count = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : 0;
const countOrNull = (value: unknown): number | null =>
	typeof value === 'number' && Number.isFinite(value) ? value : null;
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function principalStatus(value: unknown): MachinePrincipalStatus {
	return value === 'disabled' || value === 'deleted' ? value : 'active';
}

function keyStatus(value: unknown): MachineKeyStatus {
	return value === 'rotating' || value === 'revoked' || value === 'expired' ? value : 'active';
}

/** `tenantScopes` as the API reads them: `all` wins, then the chosen tenants, else none. */
export function reachFromScopes(value: unknown): MachineReach {
	const scopes = rows(value).map(record);
	if (scopes.some((scope) => scope.scopeMode === 'all')) return { mode: 'all' };
	const tenantIds = scopes
		.filter((scope) => scope.scopeMode === 'allow' && typeof scope.tenantId === 'string')
		.map((scope) => scope.tenantId as string);
	return tenantIds.length > 0 ? { mode: 'tenants', tenantIds } : { mode: 'none' };
}

/** The request body's `tenant_scopes` for a reach. */
export function scopesFromReach(reach: MachineReach): Array<Record<string, string>> {
	if (reach.mode === 'all') return [{ scope_mode: 'all' }];
	if (reach.mode === 'tenants' && reach.tenantIds.length > 0) {
		return reach.tenantIds.map((tenantId) => ({ scope_mode: 'allow', tenant_id: tenantId }));
	}
	return [{ scope_mode: 'none' }];
}

export function machineKeyFromRow(value: unknown): MachineKey {
	const row = record(value);
	return {
		id: text(row.id),
		kid: text(row.kid),
		alg: text(row.alg),
		displayName: text(row.displayName),
		status: keyStatus(row.status),
		notBefore: countOrNull(row.notBefore),
		expiresAt: countOrNull(row.expiresAt),
		lastUsedAt: countOrNull(row.lastUsedAt),
		createdAt: count(row.createdAt)
	};
}

export function machinePrincipalFromRow(value: unknown): MachinePrincipal {
	const row = record(value);
	return {
		id: text(row.id),
		clientId: text(row.clientId),
		displayName: text(row.displayName),
		description: textOrNull(row.description),
		principalType: text(row.principalType),
		status: principalStatus(row.status),
		tokenTtlSeconds: count(row.tokenTtlSeconds) || MACHINE_TOKEN_TTL_DEFAULT,
		permissions: rows(row.permissions).filter((p): p is string => typeof p === 'string'),
		reach: reachFromScopes(row.tenantScopes),
		keys: rows(row.credentials).map(machineKeyFromRow),
		createdAt: count(row.createdAt),
		updatedAt: count(row.updatedAt)
	};
}

async function readJson(response: Response): Promise<Row> {
	if (!response.ok) throw await errorFromResponse(response);
	if (response.status === 204) return {};
	return record(await response.json().catch(() => ({})));
}

export function httpMachineAccess(tenantId?: string): MachineAccessClient {
	const base = `${API_BASE_URL}/api/admin/machine-access/principals`;
	const principalUrl = (id: string) => `${base}/${encodeURIComponent(id)}`;
	const get = (url: string, signal?: AbortSignal) => adminFetch(url, { signal, tenantId });
	const send = (url: string, method: string, body: unknown, receipt?: string) =>
		adminFetch(url, {
			method,
			tenantId,
			headers: stepUpHeaders(receipt),
			includeJsonContentType: true,
			body: JSON.stringify(body ?? {})
		});
	/** A write that hands out access: its step-up refusal is met once, then it is repeated. */
	const grant = (url: string, method: string, body: unknown) =>
		withStepUp(async (receipt) => readJson(await send(url, method, body, receipt)));
	/** A write that takes access away: never asks for step-up. */
	const plain = async (url: string, method: string, body?: unknown) =>
		readJson(await send(url, method, body));

	return {
		async list(signal) {
			// Newest first, and the API hides what the admin may not see after paging, so a short
			// page is not the last one: read pages until one is empty (at most LIST_MAX_PAGES).
			const all: MachinePrincipal[] = [];
			for (let page = 1; page <= LIST_MAX_PAGES; page++) {
				signal?.throwIfAborted();
				const body = await readJson(
					await get(`${base}?limit=${LIST_PAGE_SIZE}&page=${page}`, signal)
				);
				const items = rows(body.items);
				if (items.length === 0) break;
				all.push(...items.map(machinePrincipalFromRow));
			}
			return all;
		},
		async get(principalId, signal) {
			const body = await readJson(await get(principalUrl(principalId), signal));
			return machinePrincipalFromRow(body.principal);
		},
		async create(input) {
			const description = input.description?.trim();
			const body = await grant(base, 'POST', {
				client_id: input.clientId.trim(),
				display_name: input.displayName.trim(),
				...(description ? { description } : {}),
				principal_type: input.principalType,
				token_ttl_seconds: input.tokenTtlSeconds,
				permissions: input.permissions,
				tenant_scopes: scopesFromReach(input.reach)
			});
			return machinePrincipalFromRow(body.principal);
		},
		async update(principalId, patch) {
			const body = await grant(principalUrl(principalId), 'PATCH', {
				...(patch.displayName !== undefined ? { display_name: patch.displayName.trim() } : {}),
				...(patch.description !== undefined
					? { description: patch.description?.trim() ?? '' }
					: {}),
				...(patch.tokenTtlSeconds !== undefined
					? { token_ttl_seconds: patch.tokenTtlSeconds }
					: {}),
				...(patch.permissions !== undefined ? { permissions: patch.permissions } : {}),
				...(patch.reach !== undefined ? { tenant_scopes: scopesFromReach(patch.reach) } : {})
			});
			return machinePrincipalFromRow(body.principal);
		},
		async enable(principalId) {
			await grant(`${principalUrl(principalId)}/enable`, 'POST', {});
		},
		async disable(principalId) {
			await plain(`${principalUrl(principalId)}/disable`, 'POST', {});
		},
		async addKey(principalId, input) {
			const body = await grant(`${principalUrl(principalId)}/credentials`, 'POST', {
				kid: input.kid.trim(),
				display_name: input.displayName.trim(),
				alg: input.alg,
				public_jwk: pickPublicJwk(input.publicJwk),
				// No list of its own: the key acts with its principal's permissions.
				permissions: [],
				// The key's own reach is "all": what it reaches is the principal's tenants narrowed by
				// the key's, so "all" leaves exactly the principal's, now and after later changes.
				// (Omitted, the API stores "none", and the key would reach nothing.)
				tenant_scopes: [{ scope_mode: 'all' }],
				...(input.expiresAt !== undefined ? { expires_at: input.expiresAt } : {})
			});
			return machineKeyFromRow(body.credential);
		},
		async revokeKey(principalId, keyId) {
			await plain(
				`${principalUrl(principalId)}/credentials/${encodeURIComponent(keyId)}`,
				'DELETE'
			);
		}
	};
}
