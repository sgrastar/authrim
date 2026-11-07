/**
 * In-memory admin groups for Storybook and tests. Follows the Admin API's rules that the pages
 * react to: a group key is used once (409), a role is given by a group once (409), a change can
 * meet another admin's change first (`failOn: { …: 'admin_group_changed' }`), and taking away
 * the last tenant administrator a group makes (its member, the grant, its end, the group) is
 * refused with 409 `last_tenant_admin`, as the API's `wouldLeaveNoTenantAdmin` decides, unless
 * someone outside the groups holds that role (`otherTenantAdmin`).
 */
import { StepUpCancelledError } from '../admin-step-up';
import { ApiError, ConflictError } from '../api-error';
import type {
	AdminGroupDetail,
	AdminGroupGrant,
	AdminGroupInput,
	AdminGroupMember,
	AdminGroupsClient,
	AdminGroupSummary
} from '../admin-groups';
import { sampleAdmins, sampleRoles } from './admin-team-fake';

export type FakeGroupsCall = keyof AdminGroupsClient;

export interface FakeAdminGroupsOptions {
	groups?: AdminGroupDetail[];
	delay?: number;
	/** Fail these calls with this status, or with this API error code (a 409). */
	failOn?: Partial<Record<FakeGroupsCall, 403 | 404 | 500 | string>>;
	/** Every change runs into a step-up the admin cancels. */
	cancelStepUp?: boolean;
	/** Someone outside the groups also holds the tenant admin role, open-ended. */
	otherTenantAdmin?: boolean;
}

const NOW = Date.UTC(2026, 10, 7, 2, 0, 0);
const DAY = 86_400_000;

export function sampleGroupDetails(): AdminGroupDetail[] {
	const member = (
		id: string,
		adminId: string,
		email: string,
		name: string | null
	): AdminGroupMember => ({
		id,
		admin_user_id: adminId,
		email,
		name,
		status: 'active',
		created_at: NOW - 20 * DAY
	});
	const grant = (id: string, roleId: string, name: string, display: string): AdminGroupGrant => ({
		id,
		role_id: roleId,
		role_name: name,
		role_display_name: display,
		expires_at: null,
		created_at: NOW - 20 * DAY
	});
	return [
		{
			id: 'grp_ops',
			group_key: 'ops',
			display_name: 'Operations',
			description: 'On-call administrators.',
			member_count: 2,
			grant_count: 2,
			created_at: NOW - 30 * DAY,
			updated_at: NOW - 2 * DAY,
			members: [
				member('mem_1', 'adm_1', 'aiko.sato@example.com', 'Aiko Sato'),
				member('mem_2', 'adm_2', 'ken.ito@example.com', 'Ken Ito')
			],
			grants: [
				grant('grt_1', 'role_ar_security_admin', 'ar_security_admin', 'Security Administrator'),
				{
					...grant('grt_2', 'role_ar_support', 'ar_support', 'Support'),
					expires_at: NOW + 30 * DAY
				}
			]
		},
		{
			id: 'grp_support',
			group_key: 'support-desk',
			display_name: 'Support desk',
			description: null,
			member_count: 0,
			grant_count: 1,
			created_at: NOW - 10 * DAY,
			updated_at: NOW - 10 * DAY,
			members: [],
			grants: [grant('grt_3', 'role_ar_support', 'ar_support', 'Support')]
		}
	];
}

function failure(spec: 403 | 404 | 500 | string): ApiError {
	if (typeof spec === 'number') return new ApiError(spec, '', `Fake failure ${spec}`);
	return new ConflictError(spec, { error: spec });
}

export function fakeAdminGroups(options: FakeAdminGroupsOptions = {}): AdminGroupsClient {
	const groups = structuredClone(options.groups ?? sampleGroupDetails());
	const admins = sampleAdmins();
	const roles = sampleRoles();
	let next = 100;

	async function call<T>(name: FakeGroupsCall, run: () => T, write = false): Promise<T> {
		if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
		if (write && options.cancelStepUp) throw new StepUpCancelledError();
		const spec = options.failOn?.[name];
		if (spec !== undefined) throw failure(spec);
		return run();
	}

	const find = (groupId: string) => {
		const group = groups.find((item) => item.id === groupId);
		if (!group) throw new ApiError(404, 'not_found', 'No such group');
		return group;
	};
	const summary = (group: AdminGroupDetail): AdminGroupSummary => ({
		id: group.id,
		group_key: group.group_key,
		display_name: group.display_name,
		description: group.description,
		member_count: group.members.length,
		grant_count: group.grants.length,
		updated_at: group.updated_at
	});
	/** Members holding the open-ended tenant admin role through some group, leaving out `except`. */
	/**
	 * Active members holding the tenant admin role through some group (current, or open-ended
	 * only), leaving out `except` (a group, a membership, a grant, or a grant's new end).
	 */
	const tenantAdmins = (
		permanentOnly: boolean,
		except: { group?: string; member?: string; grant?: string; grantEnds?: number } = {}
	) => {
		const now = Date.now();
		return new Set(
			groups
				.filter((group) => group.id !== except.group)
				.filter((group) =>
					group.grants.some((item) => {
						if (item.role_name !== 'ar_tenant_admin') return false;
						const ends =
							item.id === except.grant
								? except.grantEnds === undefined
									? 'gone'
									: except.grantEnds
								: item.expires_at;
						if (ends === 'gone') return false;
						return ends === null || (!permanentOnly && ends > now);
					})
				)
				.flatMap((group) =>
					group.members.filter((item) => item.id !== except.member && item.status === 'active')
				)
				.map((item) => item.admin_user_id)
		).size;
	};
	/**
	 * The API's last-admin rule (`wouldLeaveNoTenantAdmin`): no change may take away the last
	 * current tenant administrator, nor the last open-ended one while there is one.
	 */
	const guard = (except: {
		group?: string;
		member?: string;
		grant?: string;
		grantEnds?: number;
	}) => {
		if (options.otherTenantAdmin) return;
		const lastCurrent = tenantAdmins(false) > 0 && tenantAdmins(false, except) === 0;
		const lastOpenEnded = tenantAdmins(true) > 0 && tenantAdmins(true, except) === 0;
		if (lastCurrent || lastOpenEnded) throw failure('last_tenant_admin');
	};
	const touch = (group: AdminGroupDetail) => (group.updated_at = NOW);

	return {
		list: () => call('list', () => groups.map(summary)),
		get: (groupId) =>
			call('get', () => structuredClone({ ...find(groupId), ...summary(find(groupId)) })),
		create: (input: AdminGroupInput) =>
			call(
				'create',
				() => {
					if (groups.some((item) => item.group_key === input.group_key.trim())) {
						throw new ConflictError('conflict', { error: 'invalid_request' });
					}
					const group: AdminGroupDetail = {
						id: `grp_${next++}`,
						group_key: input.group_key.trim(),
						display_name: input.display_name.trim(),
						description: input.description?.trim() || null,
						member_count: 0,
						grant_count: 0,
						created_at: NOW,
						updated_at: NOW,
						members: [],
						grants: []
					};
					groups.push(group);
					return summary(group);
				},
				true
			),
		update: (groupId, input) =>
			call(
				'update',
				() => {
					const group = find(groupId);
					group.display_name = input.display_name.trim();
					group.description = input.description?.trim() || null;
					touch(group);
				},
				true
			),
		remove: (groupId) =>
			call(
				'remove',
				() => {
					find(groupId);
					guard({ group: groupId });
					groups.splice(
						groups.findIndex((item) => item.id === groupId),
						1
					);
				},
				true
			),
		addMember: (groupId, adminUserId) =>
			call(
				'addMember',
				() => {
					const group = find(groupId);
					if (group.members.some((item) => item.admin_user_id === adminUserId)) return;
					const admin = admins.find((item) => item.id === adminUserId);
					if (!admin) throw new ApiError(404, 'not_found', 'No such admin');
					group.members.push({
						id: `mem_${next++}`,
						admin_user_id: admin.id,
						email: admin.email,
						name: admin.name,
						status: admin.status,
						created_at: NOW
					});
					touch(group);
				},
				true
			),
		removeMember: (groupId, adminUserId) =>
			call(
				'removeMember',
				() => {
					const group = find(groupId);
					const member = group.members.find((item) => item.admin_user_id === adminUserId);
					if (!member) throw new ApiError(404, 'not_found', 'No such member');
					guard({ member: member.id });
					group.members.splice(group.members.indexOf(member), 1);
					touch(group);
				},
				true
			),
		addGrant: (groupId, input) =>
			call(
				'addGrant',
				() => {
					const group = find(groupId);
					const role = roles.find((item) => item.id === input.role_id);
					if (!role) throw new ApiError(404, 'not_found', 'No such role');
					if (group.grants.some((item) => item.role_id === role.id)) {
						throw new ConflictError('conflict', { error: 'invalid_request' });
					}
					group.grants.push({
						id: `grt_${next++}`,
						role_id: role.id,
						role_name: role.name,
						role_display_name: role.display_name,
						expires_at: input.expires_at ?? null,
						created_at: NOW
					});
					touch(group);
				},
				true
			),
		setGrantExpiry: (groupId, grantId, expiresAt) =>
			call(
				'setGrantExpiry',
				() => {
					const grant = find(groupId).grants.find((item) => item.id === grantId);
					if (!grant) throw new ApiError(404, 'not_found', 'No such grant');
					if (expiresAt !== null) guard({ grant: grantId, grantEnds: expiresAt });
					grant.expires_at = expiresAt;
				},
				true
			),
		removeGrant: (groupId, grantId) =>
			call(
				'removeGrant',
				() => {
					const group = find(groupId);
					const grant = group.grants.find((item) => item.id === grantId);
					if (!grant) throw new ApiError(404, 'not_found', 'No such grant');
					guard({ grant: grantId });
					group.grants.splice(group.grants.indexOf(grant), 1);
					touch(group);
				},
				true
			)
	};
}
