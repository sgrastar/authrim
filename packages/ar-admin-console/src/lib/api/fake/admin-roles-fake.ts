/**
 * In-memory administrator roles for Storybook and tests. Follows the Admin API's rules that the
 * pages react to: built-in roles are read only (403), a name is used once and `ar_` names are
 * kept for the built-in roles (409 / 400), a role cannot rank at or above the caller's nor carry
 * a permission the caller lacks (403), and a role still held cannot be deleted (409).
 */
import { StepUpCancelledError } from '../admin-step-up';
import { hasAdminPermission } from '@authrim/ar-lib-core/types/admin-user';
import { ApiError, ConflictError } from '../api-error';
import type {
	AdminRoleDefinition,
	AdminRoleDetail,
	AdminRoleInput,
	AdminRolesClient,
	PermissionChoice,
	RoleAssignment
} from '../admin-roles';

export type FakeRolesCall = keyof AdminRolesClient;

export interface FakeAdminRolesOptions {
	roles?: AdminRoleDefinition[];
	/** Direct assignments per role. */
	assignments?: Record<string, RoleAssignment[]>;
	/** Holders per role (direct and through groups). */
	holders?: Record<string, number>;
	/** The caller's rank and permissions (default: a tenant administrator). */
	caller?: { rank: number; permissions: readonly string[] };
	delay?: number;
	failOn?: Partial<Record<FakeRolesCall, 403 | 404 | 500 | string>>;
	cancelStepUp?: boolean;
}

const NOW = Date.UTC(2026, 10, 7, 2, 0, 0);
const DAY = 86_400_000;

export function samplePermissions(): PermissionChoice[] {
	return [
		{ key: '*', description: 'Full access to all admin functions' },
		{ key: 'admin:admin_users:read', description: 'View admin users' },
		{ key: 'admin:admin_users:write', description: 'Create and update admin users' },
		{ key: 'admin:admin_roles:read', description: 'View admin roles' },
		{ key: 'admin:admin_roles:write', description: 'Create, update, and delete admin roles' },
		{ key: 'admin:users:read', description: 'View end users' },
		{ key: 'admin:users:write', description: 'Create and update end users' },
		{ key: 'admin:clients:read', description: 'View clients' },
		{ key: 'admin:settings:read', description: 'View settings' },
		{ key: 'admin:audit:read', description: 'View end user audit logs' }
	];
}

export function sampleRoleDefinitions(): AdminRoleDefinition[] {
	const builtIn = (name: string, display: string, level: number, permissions: string[]) => ({
		id: `role_${name}`,
		name,
		display_name: display,
		description: null,
		permissions,
		hierarchy_level: level,
		is_system: true,
		inherits_from: null,
		updated_at: NOW - 200 * DAY
	});
	return [
		builtIn('ar_super_admin', 'Super Administrator', 100, ['*']),
		builtIn('ar_tenant_admin', 'Tenant Administrator', 80, [
			'admin:admin_users:*',
			'admin:users:*'
		]),
		builtIn('ar_support', 'Support', 40, ['admin:users:read']),
		builtIn('ar_viewer', 'Viewer', 20, ['admin:users:read', 'admin:settings:read']),
		{
			id: 'role_custom_billing',
			name: 'billing_reader',
			display_name: 'Billing reader',
			description: 'Reads usage and invoices.',
			permissions: ['admin:audit:read', 'admin:settings:read'],
			hierarchy_level: 10,
			is_system: false,
			inherits_from: null,
			updated_at: NOW - 3 * DAY
		}
	];
}

function failure(spec: 403 | 404 | 500 | string): ApiError {
	if (typeof spec === 'number') return new ApiError(spec, '', `Fake failure ${spec}`);
	return new ConflictError(spec, { error: spec });
}

/** The generic refusals of the roles API (`createErrorResponse`): the OAuth code, by status. */
const refused = (status: 400 | 403 | 404 | 409): ApiError =>
	status === 409
		? new ConflictError('conflict', { error: 'invalid_request' })
		: new ApiError(status, status === 400 ? 'invalid_request' : 'access_denied', 'refused', {
				error: status === 400 ? 'invalid_request' : 'access_denied'
			});

export function fakeAdminRoles(options: FakeAdminRolesOptions = {}): AdminRolesClient {
	const roles = structuredClone(options.roles ?? sampleRoleDefinitions());
	const assignments = structuredClone(
		options.assignments ?? {
			role_ar_tenant_admin: [
				{
					id: 'asg_1',
					admin_user_id: 'adm_1',
					email: 'aiko.sato@example.com',
					name: 'Aiko Sato',
					scope_type: 'tenant' as const,
					expires_at: null,
					created_at: NOW - 60 * DAY
				}
			]
		}
	);
	const holders = { role_ar_tenant_admin: 2, role_ar_security_admin: 1, ...options.holders };
	const caller = options.caller ?? {
		rank: 80,
		permissions: [
			'admin:admin_users:*',
			'admin:admin_roles:*',
			'admin:users:*',
			'admin:clients:read',
			'admin:settings:read',
			'admin:audit:read'
		]
	};
	// The API's own permission rule (wildcards, compatible actions, exact-only permissions).
	const holds = (permission: string) => hasAdminPermission([...caller.permissions], permission);
	let next = 100;

	/** `stepUp`: the API asks for a step-up for this change (it widens a role). */
	async function call<T>(name: FakeRolesCall, run: () => T, stepUp = false): Promise<T> {
		if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
		if (stepUp && options.cancelStepUp) throw new StepUpCancelledError();
		const spec = options.failOn?.[name];
		if (spec !== undefined) throw failure(spec);
		return run();
	}

	const find = (roleId: string) => {
		const role = roles.find((item) => item.id === roleId);
		if (!role) throw refused(404);
		return role;
	};
	/** `creating`: a new role skips the permission check for a caller holding `*`, as the API does. */
	const check = (input: Partial<AdminRoleInput>, creating = false) => {
		if (input.hierarchy_level !== undefined && input.hierarchy_level >= caller.rank)
			throw refused(403);
		if (creating && holds('*')) return;
		if (input.permissions?.some((permission) => !holds(permission))) throw refused(403);
	};

	return {
		list: () => call('list', () => structuredClone(roles)),
		get: (roleId) =>
			call(
				'get',
				(): AdminRoleDetail => ({
					...structuredClone(find(roleId)),
					holder_count: holders[roleId as keyof typeof holders] ?? 0
				})
			),
		assignments: (roleId) => call('assignments', () => structuredClone(assignments[roleId] ?? [])),
		permissions: () => call('permissions', () => samplePermissions()),
		create: (input) =>
			call('create', () => {
				const name = input.name.trim();
				if (name.toLowerCase().startsWith('ar_')) throw refused(400);
				if (roles.some((role) => role.name === name)) throw refused(409);
				check(input, true);
				const role: AdminRoleDefinition = {
					id: `role_${next++}`,
					name,
					display_name: input.display_name.trim() || null,
					description: input.description.trim() || null,
					permissions: [...input.permissions],
					hierarchy_level: input.hierarchy_level,
					is_system: false,
					inherits_from: null,
					updated_at: NOW
				};
				roles.push(role);
				return structuredClone(role);
			}),
		update: (roleId, changes) => {
			// A step-up only for a change that widens the role: a permission it lacks, a higher rank.
			const before = roles.find((item) => item.id === roleId);
			const widens =
				!!before &&
				((changes.permissions?.some((permission) => !before.permissions.includes(permission)) ??
					false) ||
					(changes.hierarchy_level !== undefined &&
						changes.hierarchy_level > before.hierarchy_level));
			return call(
				'update',
				() => {
					const role = find(roleId);
					if (role.is_system) throw refused(403);
					// The role itself must rank below the caller, whatever the change.
					if (role.hierarchy_level >= caller.rank) throw refused(403);
					check(changes);
					if (changes.display_name !== undefined)
						role.display_name = changes.display_name.trim() || null;
					if (changes.description !== undefined)
						role.description = changes.description.trim() || null;
					if (changes.permissions !== undefined) role.permissions = [...changes.permissions];
					if (changes.hierarchy_level !== undefined) role.hierarchy_level = changes.hierarchy_level;
					role.updated_at = NOW;
				},
				widens
			);
		},
		remove: (roleId) =>
			call('remove', () => {
				const role = find(roleId);
				if (role.is_system) throw refused(403);
				if ((holders[roleId as keyof typeof holders] ?? 0) > 0) throw refused(409);
				roles.splice(roles.indexOf(role), 1);
			})
	};
}
