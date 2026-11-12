/**
 * In-memory administrators and invitations for Storybook and tests. Follows the Admin API's
 * rules that the pages react to: the list is paged and filtered like the API's, the last tenant
 * administrator cannot be suspended, deleted or lose the role (409 `last_tenant_admin`, as
 * `wouldLeaveNoTenantAdmin` decides), one pending invitation per address (409
 * `invitation_exists`), at most ten groups, and a failed email still creates the invitation (it
 * answers "not delivered").
 */
import { StepUpCancelledError } from '../admin-step-up';
import { ApiError, ConflictError } from '../api-error';
import type {
	AdminDetail,
	AdminListPage,
	AdminListQuery,
	AdminTeamClient,
	GroupChoice,
	HeldRole,
	InvitationCreated,
	InvitationInput,
	RoleChoice,
	TeamAdmin,
	TeamInvitation
} from '../admin-team';

export type FakeTeamCall =
	| 'listAdmins'
	| 'getAdmin'
	| 'updateAdmin'
	| 'deleteAdmin'
	| 'grantRole'
	| 'removeAssignment'
	| 'setAssignmentExpiry'
	| 'findEndedAssignment'
	| 'suspend'
	| 'activate'
	| 'unlock'
	| 'listInvitations'
	| 'createInvitation'
	| 'resendInvitation'
	| 'revokeInvitation'
	| 'listRoles'
	| 'listGroups'
	| 'defaultTenantId';

export interface FakeAdminTeamOptions {
	admins?: TeamAdmin[];
	invitations?: TeamInvitation[];
	roles?: RoleChoice[];
	groups?: GroupChoice[];
	/** Milliseconds each call takes. */
	delay?: number;
	/** Fail these calls with this status (403, 500) or API error code (a 409 or 502 code). */
	failOn?: Partial<Record<FakeTeamCall, 403 | 404 | 500 | string>>;
	/** Invitation emails cannot be sent: invitations are made, but not delivered. */
	emailDown?: boolean;
	/** Every request runs into a step-up the admin cancels. */
	cancelStepUp?: boolean;
	/** The deployment's default tenant (null: cannot be read). */
	defaultTenant?: string | null;
	/** The roles, groups and passkeys of each admin; defaults to `sampleHoldings()`. */
	holdings?: Record<string, Holdings>;
	/** The signed-in admin (cannot delete themself). */
	self?: string;
	/** Ended direct assignments (not shown, but counted when the role is given again). */
	ended?: { roleId: string; adminId: string; scope: 'tenant' | 'global'; assignmentId: string }[];
}

export type Holdings = Pick<AdminDetail, 'roles' | 'groups' | 'passkeys'>;

const NOW = Date.UTC(2026, 10, 7, 2, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function sampleAdmins(): TeamAdmin[] {
	const admin = (partial: Partial<TeamAdmin> & Pick<TeamAdmin, 'id' | 'email'>): TeamAdmin => ({
		name: null,
		status: 'active',
		mfa_enabled: true,
		last_login_at: NOW - 2 * HOUR,
		locked_until: null,
		created_at: NOW - 90 * DAY,
		...partial
	});
	return [
		admin({ id: 'adm_1', email: 'aiko.sato@example.com', name: 'Aiko Sato' }),
		admin({
			id: 'adm_2',
			email: 'ken.ito@example.com',
			name: 'Ken Ito',
			last_login_at: NOW - 3 * DAY
		}),
		admin({
			id: 'adm_3',
			email: 'mina.kato@example.com',
			name: 'Mina Kato',
			status: 'locked',
			locked_until: NOW + HOUR
		}),
		admin({
			id: 'adm_4',
			email: 'ops@example.com',
			status: 'suspended',
			mfa_enabled: false,
			last_login_at: NOW - 40 * DAY
		}),
		admin({ id: 'adm_5', email: 'yuki.mori@example.com', name: 'Yuki Mori', last_login_at: null })
	];
}

export function sampleHoldings(): Record<string, Holdings> {
	const direct = (
		assignment: string,
		role: string,
		name: string,
		display: string,
		partial: Partial<HeldRole> = {}
	): HeldRole => ({
		role_id: role,
		name,
		display_name: display,
		scope_type: 'tenant',
		assignment_id: assignment,
		source: 'direct',
		group: null,
		assigned_at: NOW - 60 * DAY,
		expires_at: null,
		...partial
	});
	const viaGroup = (
		role: string,
		name: string,
		display: string,
		group: string,
		groupName: string
	): HeldRole => ({
		role_id: role,
		name,
		display_name: display,
		scope_type: 'tenant',
		assignment_id: null,
		source: 'group',
		group: { id: group, name: groupName },
		assigned_at: NOW - 20 * DAY,
		expires_at: null
	});
	const ops = { id: 'grp_ops', group_key: 'ops', display_name: 'Operations' };
	return {
		adm_1: {
			roles: [
				direct('asg_1', 'role_ar_tenant_admin', 'ar_tenant_admin', 'Tenant Administrator'),
				viaGroup(
					'role_ar_security_admin',
					'ar_security_admin',
					'Security Administrator',
					'grp_ops',
					'Operations'
				)
			],
			groups: [ops],
			passkeys: [
				{
					id: 'pk_1',
					device_name: 'Work MacBook',
					provider: 'iCloud Keychain',
					created_at: NOW - 80 * DAY,
					last_used_at: NOW - 2 * HOUR
				},
				{
					id: 'pk_2',
					device_name: null,
					provider: 'YubiKey 5',
					created_at: NOW - 30 * DAY,
					last_used_at: null
				}
			]
		},
		adm_2: {
			roles: [
				direct('asg_2', 'role_ar_support', 'ar_support', 'Support', { expires_at: NOW + 14 * DAY })
			],
			groups: [],
			passkeys: [
				{
					id: 'pk_3',
					device_name: 'Phone',
					provider: 'Google Password Manager',
					created_at: NOW - 40 * DAY,
					last_used_at: NOW - 3 * DAY
				}
			]
		}
	};
}

export function sampleRoles(): RoleChoice[] {
	const role = (id: string, name: string, display: string, level: number): RoleChoice => ({
		id,
		name,
		display_name: display,
		description: null,
		hierarchy_level: level,
		is_system: true
	});
	return [
		role('role_ar_super_admin', 'ar_super_admin', 'Super Administrator', 100),
		role('role_ar_tenant_admin', 'ar_tenant_admin', 'Tenant Administrator', 80),
		role('role_ar_security_admin', 'ar_security_admin', 'Security Administrator', 60),
		role('role_ar_support', 'ar_support', 'Support', 40),
		role('role_ar_viewer', 'ar_viewer', 'Viewer', 20),
		{
			id: 'role_custom_billing',
			name: 'billing_reader',
			display_name: 'Billing reader',
			description: 'Reads usage and invoices.',
			hierarchy_level: 10,
			is_system: false
		}
	];
}

export function sampleGroups(): GroupChoice[] {
	return [
		{
			id: 'grp_ops',
			group_key: 'ops',
			display_name: 'Operations',
			member_count: 3,
			grant_count: 2
		},
		{
			id: 'grp_support',
			group_key: 'support-desk',
			display_name: 'Support desk',
			member_count: 6,
			grant_count: 1
		}
	];
}

export function sampleInvitations(): TeamInvitation[] {
	const invitation = (
		partial: Partial<TeamInvitation> & Pick<TeamInvitation, 'id' | 'email'>
	): TeamInvitation => ({
		name: null,
		status: 'pending',
		role: { id: 'role_ar_support', name: 'ar_support', display_name: 'Support' },
		scope_type: 'tenant',
		role_expires_at: null,
		ip_restriction_enabled: false,
		allowed_ip_ranges: [],
		expires_at: NOW + 20 * HOUR,
		last_sent_at: NOW - 4 * HOUR,
		last_delivery_status: 'sent',
		code_delivery: 'email',
		accepted_at: null,
		created_at: NOW - 4 * HOUR,
		...partial
	});
	return [
		invitation({ id: 'inv_1', email: 'new.member@example.com', name: 'Riku Abe' }),
		invitation({
			id: 'inv_2',
			email: 'platform.ops@example.com',
			role: {
				id: 'role_ar_super_admin',
				name: 'ar_super_admin',
				display_name: 'Super Administrator'
			},
			scope_type: 'global',
			last_delivery_status: 'failed'
		}),
		invitation({
			id: 'inv_3',
			email: 'old.invite@example.com',
			status: 'expired',
			expires_at: NOW - 2 * DAY,
			created_at: NOW - 3 * DAY
		}),
		invitation({
			id: 'inv_4',
			email: 'joined@example.com',
			status: 'accepted',
			accepted_at: NOW - 5 * DAY,
			created_at: NOW - 6 * DAY
		})
	];
}

function failure(spec: 403 | 404 | 500 | string): ApiError {
	if (typeof spec === 'number') return new ApiError(spec, '', `Fake failure ${spec}`);
	const status = spec === 'email_delivery_failed' ? 502 : spec.startsWith('invalid_') ? 400 : 409;
	const body = { error: spec };
	return status === 409 ? new ConflictError(spec, body) : new ApiError(status, spec, spec, body);
}

export function fakeAdminTeam(options: FakeAdminTeamOptions = {}): AdminTeamClient {
	const admins = structuredClone(options.admins ?? sampleAdmins());
	const invitations = structuredClone(options.invitations ?? sampleInvitations());
	const roles = options.roles ?? sampleRoles();
	const holdings = structuredClone(options.holdings ?? sampleHoldings());
	const holdingsOf = (id: string): Holdings =>
		(holdings[id] ??= { roles: [], groups: [], passkeys: [] });
	/** Active admins holding a tenant admin role (directly or through a group), but this one. */
	/** Active tenant administrators (current, or open-ended only), leaving out `except`. */
	const countTenantAdmins = (
		permanentOnly: boolean,
		except: { adminId?: string; assignmentId?: string } = {}
	) => {
		const now = Date.now();
		return admins.filter(
			(admin) =>
				admin.id !== except.adminId &&
				admin.status === 'active' &&
				holdingsOf(admin.id).roles.some(
					(role) =>
						role.name === 'ar_tenant_admin' &&
						(role.assignment_id === null || role.assignment_id !== except.assignmentId) &&
						(role.expires_at === null || (!permanentOnly && role.expires_at > now))
				)
		).length;
	};
	/**
	 * The API's last-admin rule (`wouldLeaveNoTenantAdmin`): a change may not take away the last
	 * current administrator, nor the last open-ended one while there is one. A new end still to
	 * come keeps what it covers current until then.
	 */
	const wouldLeaveNoTenantAdmin = (
		except: { adminId?: string; assignmentId?: string },
		newExpiresAt?: number
	) => {
		const stillCurrent = newExpiresAt !== undefined && newExpiresAt > Date.now();
		if (!stillCurrent && countTenantAdmins(false, except) === 0 && countTenantAdmins(false) > 0) {
			return true;
		}
		return countTenantAdmins(true, except) === 0 && countTenantAdmins(true) > 0;
	};
	const groups = options.groups ?? sampleGroups();
	const ended = structuredClone(options.ended ?? []);
	let next = 100;

	async function call<T>(name: FakeTeamCall, run: () => T, write = false): Promise<T> {
		if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
		if (write && options.cancelStepUp) throw new StepUpCancelledError();
		const spec = options.failOn?.[name];
		if (spec !== undefined) throw failure(spec);
		return run();
	}

	const findAdmin = (id: string) => {
		const admin = admins.find((item) => item.id === id);
		if (!admin) throw new ApiError(404, 'not_found', 'No such admin');
		return admin;
	};
	const findPending = (id: string) => {
		const invitation = invitations.find((item) => item.id === id);
		// An expired one is still pending in the API's table: it can be sent again or revoked.
		if (!invitation || (invitation.status !== 'pending' && invitation.status !== 'expired')) {
			throw new ApiError(404, 'invitation_not_found', 'No pending invitation', {
				error: 'invitation_not_found'
			});
		}
		return invitation;
	};
	const delivered = (invitation: TeamInvitation): InvitationCreated => {
		invitation.last_sent_at = NOW;
		invitation.last_delivery_status = options.emailDown ? 'failed' : 'sent';
		return { id: invitation.id, delivered: !options.emailDown };
	};

	return {
		listAdmins: (query: AdminListQuery) =>
			call('listAdmins', (): AdminListPage => {
				const email = query.email?.trim().toLowerCase();
				const matching = admins.filter(
					(admin) =>
						(!email || admin.email.includes(email)) &&
						(!query.status || admin.status === query.status) &&
						(query.mfa === undefined || admin.mfa_enabled === query.mfa)
				);
				const start = (query.page - 1) * query.limit;
				return {
					admins: structuredClone(matching.slice(start, start + query.limit)),
					total: matching.length,
					page: query.page,
					totalPages: Math.ceil(matching.length / query.limit)
				};
			}),
		getAdmin: (adminId) =>
			call('getAdmin', (): AdminDetail => {
				const admin = findAdmin(adminId);
				return structuredClone({
					...admin,
					email_verified: true,
					updated_at: admin.created_at,
					...holdingsOf(adminId)
				});
			}),
		updateAdmin: (adminId, input) =>
			call(
				'updateAdmin',
				() => {
					const admin = findAdmin(adminId);
					const email = input.email.trim().toLowerCase();
					if (admins.some((item) => item.id !== adminId && item.email === email)) {
						throw failure('email_in_use');
					}
					admin.email = email;
					admin.name = input.name.trim() || null;
				},
				true
			),
		deleteAdmin: (adminId) =>
			call(
				'deleteAdmin',
				() => {
					findAdmin(adminId);
					if (adminId === options.self) throw new ApiError(403, 'access_denied', 'Not yourself');
					if (wouldLeaveNoTenantAdmin({ adminId })) throw failure('last_tenant_admin');
					admins.splice(
						admins.findIndex((item) => item.id === adminId),
						1
					);
				},
				true
			),
		grantRole: (adminId, input) =>
			call(
				'grantRole',
				() => {
					findAdmin(adminId);
					const role = roles.find((item) => item.id === input.role_id);
					if (!role) throw new ApiError(404, 'not_found', 'No such role');
					const held = holdingsOf(adminId).roles;
					const endedOne = ended.some(
						(item) =>
							item.roleId === role.id && item.adminId === adminId && item.scope === input.scope_type
					);
					if (
						endedOne ||
						held.some(
							(item) =>
								item.source === 'direct' &&
								item.role_id === role.id &&
								item.scope_type === input.scope_type
						)
					) {
						throw new ConflictError('conflict', { error: 'invalid_request' });
					}
					held.push({
						role_id: role.id,
						name: role.name,
						display_name: role.display_name,
						scope_type: input.scope_type,
						assignment_id: `asg_${next++}`,
						source: 'direct',
						group: null,
						assigned_at: NOW,
						expires_at: input.expires_at ?? null
					});
				},
				true
			),
		removeAssignment: (adminId, assignmentId) =>
			call(
				'removeAssignment',
				() => {
					const held = holdingsOf(adminId).roles;
					const index = held.findIndex((item) => item.assignment_id === assignmentId);
					if (index < 0) throw new ApiError(404, 'not_found', 'No such assignment');
					if (held[index].name === 'ar_tenant_admin' && wouldLeaveNoTenantAdmin({ assignmentId })) {
						throw failure('last_tenant_admin');
					}
					held.splice(index, 1);
				},
				true
			),
		setAssignmentExpiry: (roleId, assignmentId, expiresAt) =>
			call(
				'setAssignmentExpiry',
				() => {
					// An ended assignment (not shown) comes back as a held role.
					const endedAt = ended.findIndex(
						(item) => item.assignmentId === assignmentId && item.roleId === roleId
					);
					if (endedAt >= 0) {
						const [back] = ended.splice(endedAt, 1);
						const role = roles.find((item) => item.id === roleId);
						if (!role) throw new ApiError(404, 'not_found', 'No such role');
						holdingsOf(back.adminId).roles.push({
							role_id: role.id,
							name: role.name,
							display_name: role.display_name,
							scope_type: back.scope,
							assignment_id: back.assignmentId,
							source: 'direct',
							group: null,
							assigned_at: NOW - 90 * DAY,
							expires_at: expiresAt
						});
						return;
					}
					const role = Object.values(holdings)
						.flatMap((item) => item.roles)
						.find((item) => item.assignment_id === assignmentId && item.role_id === roleId);
					if (!role) throw new ApiError(404, 'not_found', 'No such assignment');
					// An end on the last open-ended tenant admin role would leave the tenant without one.
					if (
						expiresAt !== null &&
						role.name === 'ar_tenant_admin' &&
						wouldLeaveNoTenantAdmin({ assignmentId }, expiresAt)
					) {
						throw failure('last_tenant_admin');
					}
					role.expires_at = expiresAt;
				},
				true
			),
		findEndedAssignment: (roleId, adminId, scope) =>
			call('findEndedAssignment', () => {
				const found = ended.find(
					(item) => item.roleId === roleId && item.adminId === adminId && item.scope === scope
				);
				return found?.assignmentId ?? null;
			}),
		suspend: (adminId) =>
			call(
				'suspend',
				() => {
					const admin = findAdmin(adminId);
					if (wouldLeaveNoTenantAdmin({ adminId })) throw failure('last_tenant_admin');
					admin.status = 'suspended';
				},
				true
			),
		activate: (adminId) =>
			call(
				'activate',
				() => {
					findAdmin(adminId).status = 'active';
				},
				true
			),
		unlock: (adminId) =>
			call(
				'unlock',
				() => {
					const admin = findAdmin(adminId);
					admin.status = 'active';
					admin.locked_until = null;
				},
				true
			),
		listInvitations: (includeCompleted) =>
			call('listInvitations', () =>
				structuredClone(
					invitations
						.filter((item) => includeCompleted || item.status === 'pending')
						.sort((a, b) => b.created_at - a.created_at)
						.slice(0, 100)
				)
			),
		createInvitation: (input: InvitationInput) =>
			call(
				'createInvitation',
				() => {
					const email = input.email.trim().toLowerCase();
					if (admins.some((admin) => admin.email === email)) throw failure('admin_exists');
					if (invitations.some((item) => item.email === email && item.status === 'pending')) {
						throw failure('invitation_exists');
					}
					if (input.group_ids.length > 10) throw failure('invalid_request');
					const role = roles.find((item) => item.id === input.role_id);
					if (!role)
						throw new ApiError(404, 'role_not_found', 'No such role', { error: 'role_not_found' });
					const invitation: TeamInvitation = {
						id: `inv_${next++}`,
						email,
						name: input.name?.trim() || null,
						status: 'pending',
						role: { id: role.id, name: role.name, display_name: role.display_name },
						scope_type: input.scope_type,
						role_expires_at: input.role_expires_at ?? null,
						ip_restriction_enabled: input.ip_restriction_enabled,
						allowed_ip_ranges: input.ip_restriction_enabled ? input.allowed_ip_ranges : [],
						expires_at: NOW + (input.expires_in_hours ?? 24) * HOUR,
						last_sent_at: null,
						last_delivery_status: 'pending',
						code_delivery: 'email',
						accepted_at: null,
						created_at: NOW
					};
					invitations.unshift(invitation);
					return delivered(invitation);
				},
				true
			),
		resendInvitation: (invitationId) =>
			call(
				'resendInvitation',
				() => {
					// A new code and a new 24 hours, which brings an expired invitation back.
					const invitation = findPending(invitationId);
					invitation.status = 'pending';
					invitation.expires_at = NOW + 24 * HOUR;
					return delivered(invitation);
				},
				true
			),
		revokeInvitation: (invitationId) =>
			call(
				'revokeInvitation',
				() => {
					findPending(invitationId).status = 'revoked';
				},
				true
			),
		listRoles: () => call('listRoles', () => structuredClone(roles)),
		listGroups: () => call('listGroups', () => structuredClone(groups)),
		defaultTenantId: () =>
			call('defaultTenantId', () =>
				options.defaultTenant === undefined ? 'acme' : options.defaultTenant
			)
	};
}
