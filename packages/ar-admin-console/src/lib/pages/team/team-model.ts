/**
 * Small rules the team pages share, kept out of the components so they can be tested.
 */
import type { InvitationInput, RoleChoice, TeamAdmin } from '#lib/api/admin-team.js';
import { fromInputValue } from '#lib/ui/patterns/date-range.js';
import type { TimeZoneMode } from '#lib/ui/time/format-time.js';

/** The tabs of the team page (Settings → Administrators), as `?tab=` names them. */
export type TeamTab = 'admins' | 'invitations' | 'signin';

export function teamTabOf(value: string | null): TeamTab {
	return value === 'invitations' || value === 'signin' ? value : 'admins';
}

/** The name an admin goes by on screen: their name, else their address. */
export const adminLabel = (admin: Pick<TeamAdmin, 'name' | 'email'>): string =>
	admin.name?.trim() || admin.email;

/**
 * Locked after failed sign-ins, and so unlockable: the API unlocks only a `locked` admin. A
 * suspended one keeps the time of an earlier lock but is shown, and handled, as suspended.
 */
export function isLocked(admin: Pick<TeamAdmin, 'status'>): boolean {
	return admin.status === 'locked';
}

/** The role that is only ever held for every tenant (an invitation for it is always global). */
export const SUPER_ADMIN_ROLE = 'ar_super_admin';

export const MAX_INVITATION_GROUPS = 10;

/** Roles an invitation can offer: everything but the super admin, unless global roles may be given. */
export function invitableRoles(roles: readonly RoleChoice[], global: boolean): RoleChoice[] {
	return roles
		.filter((role) => global || role.name !== SUPER_ADMIN_ROLE)
		.sort((a, b) => b.hierarchy_level - a.hierarchy_level || a.name.localeCompare(b.name));
}

/** The scope an invitation for this role takes: the super admin's is always global. */
export function scopeFor(
	role: RoleChoice | undefined,
	chosen: InvitationInput['scope_type']
): InvitationInput['scope_type'] {
	return role?.name === SUPER_ADMIN_ROLE ? 'global' : chosen;
}

const EMAIL = /^\S+@\S+\.\S+$/;

export type InvitationProblem =
	| 'tm.new.emailRequired'
	| 'tm.new.emailInvalid'
	| 'tm.new.roleRequired'
	| 'tm.new.roleEndsPast'
	| 'tm.new.roleEndsInvalid'
	| 'tm.new.ipRequired'
	| 'tm.new.groupsTooMany';

/** What is wrong with an invitation before it is sent, field by field (the API checks again). */
export function invitationProblems(
	input: InvitationInput,
	now = Date.now(),
	/** What was typed as the role's end: something typed that is not a time is a problem. */
	roleEndsText = ''
): Partial<Record<'email' | 'role' | 'roleEnds' | 'ip' | 'groups', InvitationProblem>> {
	const problems: Partial<
		Record<'email' | 'role' | 'roleEnds' | 'ip' | 'groups', InvitationProblem>
	> = {};
	const email = input.email.trim();
	if (!email) problems.email = 'tm.new.emailRequired';
	else if (!EMAIL.test(email)) problems.email = 'tm.new.emailInvalid';
	if (!input.role_id) problems.role = 'tm.new.roleRequired';
	if (input.role_expires_at !== undefined && input.role_expires_at <= now) {
		problems.roleEnds = 'tm.new.roleEndsPast';
	} else if (input.role_expires_at === undefined && roleEndsText.trim() !== '') {
		problems.roleEnds = 'tm.new.roleEndsInvalid';
	}
	if (input.ip_restriction_enabled && !input.allowed_ip_ranges.some((range) => range.trim())) {
		problems.ip = 'tm.new.ipRequired';
	}
	if (input.group_ids.length > MAX_INVITATION_GROUPS) problems.groups = 'tm.new.groupsTooMany';
	return problems;
}

/**
 * A `datetime-local` value, read in the zone the admin chose for timestamps, as milliseconds;
 * undefined when empty or not a time.
 */
export function inputTimeToMs(value: string, zone: TimeZoneMode): number | undefined {
	// The input's own shape only: Date reads odd text ("x:00Z") as some time in 2000.
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return undefined;
	// To the minute, as the field offers it: a value with seconds is read the same way.
	const iso = fromInputValue(value.slice(0, 16), zone);
	return iso === undefined ? undefined : Date.parse(iso);
}
