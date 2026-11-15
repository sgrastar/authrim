/**
 * In-memory machine access for Storybook and tests. Follows the Admin API's rules that the pages
 * react to: a client id is used once and a kid is used once per machine (409), a refused grant
 * answers 400 `invalid_request` (`refuseGrant`), a step-up the admin cancels stops a write
 * (`cancelStepUp`), and a revoked key cannot be brought back.
 */
import { StepUpCancelledError } from '../admin-step-up';
import { ApiError, ConflictError } from '../api-error';
import type {
	MachineAccessClient,
	MachineKey,
	MachinePrincipal,
	MachinePrincipalInput
} from '../machine-access';

export type FakeMachineCall = keyof MachineAccessClient;

export interface FakeMachineAccessOptions {
	principals?: MachinePrincipal[];
	delay?: number;
	failOn?: Partial<Record<FakeMachineCall, 403 | 404 | 500>>;
	/** Every write that hands out access runs into a step-up the admin cancels. */
	cancelStepUp?: boolean;
	/** Creating or changing permissions is refused as beyond the admin's authority. */
	refuseGrant?: boolean;
}

const NOW = Date.UTC(2026, 10, 14, 2, 0, 0);
const DAY = 86_400_000;

export function sampleMachinePrincipals(): MachinePrincipal[] {
	const key = (
		id: string,
		kid: string,
		alg: string,
		over: Partial<MachineKey> = {}
	): MachineKey => ({
		id,
		kid,
		alg,
		displayName: kid,
		status: 'active',
		notBefore: null,
		expiresAt: null,
		lastUsedAt: NOW - DAY,
		createdAt: NOW - 30 * DAY,
		...over
	});
	return [
		{
			id: 'amp_ci',
			clientId: 'ci-deployer',
			displayName: 'CI deployer',
			description: 'Applies settings from the release pipeline.',
			principalType: 'ci',
			status: 'active',
			tokenTtlSeconds: 600,
			permissions: ['admin:settings:read', 'admin:settings:write'],
			reach: { mode: 'tenants', tenantIds: ['default'] },
			keys: [
				key('mck_1', 'ci-2026-11', 'ES256'),
				key('mck_2', 'ci-2026-05', 'ES256', { status: 'revoked' }),
				key('mck_3', 'ci-2027-01', 'ES256', { notBefore: NOW + 60 * DAY })
			],
			createdAt: NOW - 60 * DAY,
			updatedAt: NOW - 3 * DAY
		},
		{
			id: 'amp_sync',
			clientId: 'directory-sync',
			displayName: 'Directory sync',
			description: null,
			principalType: 'integration',
			status: 'disabled',
			tokenTtlSeconds: 300,
			permissions: ['admin:users:read'],
			reach: { mode: 'none' },
			keys: [],
			createdAt: NOW - 90 * DAY,
			updatedAt: NOW - 20 * DAY
		},
		{
			id: 'amp_gone',
			clientId: 'old-exporter',
			displayName: 'Old exporter',
			description: null,
			principalType: 'automation',
			status: 'deleted',
			tokenTtlSeconds: 600,
			permissions: ['admin:users:read'],
			reach: { mode: 'none' },
			keys: [key('mck_9', 'old-key', 'ES256')],
			createdAt: NOW - 200 * DAY,
			updatedAt: NOW - 100 * DAY
		}
	];
}

/** A copy without the page's reactive wrappers (the real client sends JSON). */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const failure = (status: 403 | 404 | 500) =>
	new ApiError(status, status === 404 ? 'not_found' : 'error', `Failed (${status})`);

export function fakeMachineAccess(options: FakeMachineAccessOptions = {}): MachineAccessClient {
	const principals = structuredClone(options.principals ?? sampleMachinePrincipals());
	let next = 100;

	async function call<T>(name: FakeMachineCall, run: () => T, grant = false): Promise<T> {
		if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
		if (grant && options.cancelStepUp) throw new StepUpCancelledError();
		const spec = options.failOn?.[name];
		if (spec !== undefined) throw failure(spec);
		return run();
	}
	const find = (id: string) => {
		const principal = principals.find((item) => item.id === id);
		if (!principal) throw new ApiError(404, 'not_found', 'No such machine');
		return principal;
	};
	const refused = () => new ApiError(400, 'invalid_request', 'Invalid request');

	return {
		list: () => call('list', () => structuredClone(principals)),
		get: (id) => call('get', () => structuredClone(find(id))),
		create: (input: MachinePrincipalInput) =>
			call(
				'create',
				() => {
					if (options.refuseGrant && input.permissions.length > 0) throw refused();
					if (principals.some((item) => item.clientId === input.clientId.trim())) {
						throw new ConflictError('Client ID in use', {});
					}
					const principal: MachinePrincipal = {
						id: `amp_${next++}`,
						clientId: input.clientId.trim(),
						displayName: input.displayName.trim(),
						description: input.description?.trim() || null,
						principalType: input.principalType,
						status: 'active',
						tokenTtlSeconds: input.tokenTtlSeconds,
						permissions: plain(input.permissions),
						reach: plain(input.reach),
						keys: [],
						createdAt: Date.now(),
						updatedAt: Date.now()
					};
					principals.push(principal);
					return structuredClone(principal);
				},
				true
			),
		update: (id, patch) =>
			call(
				'update',
				() => {
					const principal = find(id);
					if (options.refuseGrant && patch.permissions) throw refused();
					if (patch.displayName !== undefined) principal.displayName = patch.displayName.trim();
					if (patch.description !== undefined) principal.description = patch.description || null;
					if (patch.tokenTtlSeconds !== undefined)
						principal.tokenTtlSeconds = patch.tokenTtlSeconds;
					if (patch.permissions) principal.permissions = plain(patch.permissions);
					if (patch.reach) principal.reach = plain(patch.reach);
					principal.updatedAt = Date.now();
					return structuredClone(principal);
				},
				true
			),
		enable: (id) =>
			call(
				'enable',
				() => {
					find(id).status = 'active';
				},
				true
			),
		disable: (id) =>
			call('disable', () => {
				find(id).status = 'disabled';
			}),
		addKey: (id, input) =>
			call(
				'addKey',
				() => {
					const principal = find(id);
					if (principal.keys.some((item) => item.kid === input.kid.trim())) {
						throw new ConflictError('kid in use', {});
					}
					const key: MachineKey = {
						id: `mck_${next++}`,
						kid: input.kid.trim(),
						alg: input.alg,
						displayName: input.displayName,
						status: 'active',
						notBefore: null,
						expiresAt: input.expiresAt ?? null,
						lastUsedAt: null,
						createdAt: Date.now()
					};
					principal.keys.unshift(key);
					return structuredClone(key);
				},
				true
			),
		revokeKey: (id, keyId) =>
			call('revokeKey', () => {
				const key = find(id).keys.find((item) => item.id === keyId);
				if (!key) throw new ApiError(404, 'not_found', 'No such key');
				key.status = 'revoked';
			})
	};
}
