import { describe, expect, it } from 'vitest';
import type { InvitationInput } from '#lib/api/admin-team.js';
import { sampleRoles } from '#lib/api/fake/admin-team-fake.js';
import { ApiError, ConflictError } from '#lib/api/api-error.js';
import { StepUpCancelledError } from '#lib/api/admin-step-up.js';
import {
	adminLabel,
	inputTimeToMs,
	invitableRoles,
	invitationProblems,
	isLocked,
	scopeFor,
	teamTabOf
} from './team-model';
import { teamErrorKey } from './team-errors';

const NOW = Date.UTC(2026, 10, 7);

const invitation = (partial: Partial<InvitationInput> = {}): InvitationInput => ({
	email: 'new@example.com',
	role_id: 'role_ar_support',
	scope_type: 'tenant',
	ip_restriction_enabled: false,
	allowed_ip_ranges: [],
	group_ids: [],
	...partial
});

describe('administrators on screen', () => {
	it('goes by name, else by address', () => {
		expect(adminLabel({ name: ' Ken ', email: 'k@example.com' })).toBe('Ken');
		expect(adminLabel({ name: null, email: 'k@example.com' })).toBe('k@example.com');
	});

	it('is locked (and unlockable) only as the API says, not while suspended', () => {
		expect(isLocked({ status: 'locked' })).toBe(true);
		// The API unlocks only a `locked` admin; a suspended one keeps an old lock time.
		expect(isLocked({ status: 'suspended' })).toBe(false);
		expect(isLocked({ status: 'active' })).toBe(false);
	});

	it('opens the tab a link names, else the administrators', () => {
		expect(teamTabOf('invitations')).toBe('invitations');
		expect(teamTabOf('signin')).toBe('signin');
		expect(teamTabOf('nope')).toBe('admins');
		expect(teamTabOf(null)).toBe('admins');
	});
});

describe('what an invitation offers', () => {
	it('leaves out the super admin unless global roles can be given, highest first', () => {
		const tenantOnly = invitableRoles(sampleRoles(), false).map((role) => role.name);
		expect(tenantOnly).not.toContain('ar_super_admin');
		expect(tenantOnly[0]).toBe('ar_tenant_admin');
		expect(invitableRoles(sampleRoles(), true)[0].name).toBe('ar_super_admin');
	});

	it('always makes a super admin invitation global', () => {
		const [superAdmin, tenantAdmin] = sampleRoles();
		expect(scopeFor(superAdmin, 'tenant')).toBe('global');
		expect(scopeFor(tenantAdmin, 'tenant')).toBe('tenant');
		expect(scopeFor(tenantAdmin, 'global')).toBe('global');
		expect(scopeFor(undefined, 'tenant')).toBe('tenant');
	});
});

describe('checking an invitation before it is sent', () => {
	it('passes a complete invitation', () => {
		expect(invitationProblems(invitation(), NOW)).toEqual({});
	});

	it('names each missing or wrong field', () => {
		expect(
			invitationProblems(
				invitation({
					email: 'not-an-address',
					role_id: '',
					role_expires_at: NOW,
					ip_restriction_enabled: true,
					allowed_ip_ranges: ['  '],
					group_ids: Array.from({ length: 11 }, (_, i) => `g${i}`)
				}),
				NOW
			)
		).toEqual({
			email: 'tm.new.emailInvalid',
			role: 'tm.new.roleRequired',
			roleEnds: 'tm.new.roleEndsPast',
			ip: 'tm.new.ipRequired',
			groups: 'tm.new.groupsTooMany'
		});
		expect(invitationProblems(invitation({ email: ' ' }), NOW).email).toBe('tm.new.emailRequired');
	});

	it('says when something typed as the role end is not a time, instead of sending no end', () => {
		expect(invitationProblems(invitation(), NOW, 'garbage').roleEnds).toBe(
			'tm.new.roleEndsInvalid'
		);
		expect(invitationProblems(invitation(), NOW, '').roleEnds).toBeUndefined();
	});

	it('reads the role end in the zone the admin chose', () => {
		expect(inputTimeToMs('2026-12-01T09:30', 'utc')).toBe(Date.UTC(2026, 11, 1, 9, 30));
		expect(inputTimeToMs('2026-12-01T09:30:30', 'utc')).toBe(Date.UTC(2026, 11, 1, 9, 30));
		expect(inputTimeToMs('', 'utc')).toBeUndefined();
		expect(inputTimeToMs('nonsense', 'utc')).toBeUndefined();
	});
});

describe('what a refusal tells the admin', () => {
	it('tells the last administrators apart, though both answer 409', () => {
		expect(teamErrorKey(new ConflictError('x', { error: 'last_tenant_admin' }))).toBe(
			'tm.error.lastTenantAdmin'
		);
		expect(teamErrorKey(new ConflictError('x', { error: 'last_platform_admin' }))).toBe(
			'tm.error.lastPlatformAdmin'
		);
		expect(teamErrorKey(new ConflictError('x', { error: 'invitation_exists' }))).toBe(
			'tm.error.invitationExists'
		);
	});

	it('explains the global placement rule', () => {
		expect(
			teamErrorKey(new ConflictError('x', { error: 'cross_tenant_admin_requires_default_home' }))
		).toBe('tm.error.crossTenant');
	});

	it('asks to reload on a group changed meanwhile and on any other 409', () => {
		expect(teamErrorKey(new ConflictError('x', { error: 'admin_group_changed' }))).toBe(
			'tm.error.changed'
		);
		expect(teamErrorKey(new ConflictError('x', { error: 'something_new' }))).toBe(
			'tm.error.changed'
		);
	});

	it('falls back on the status, and says a cancelled step-up sent nothing', () => {
		expect(teamErrorKey(new ApiError(403, 'access_denied', 'x'))).toBe('tm.error.forbidden');
		expect(teamErrorKey(new ApiError(404, '', 'x'))).toBe('tm.error.notFound');
		expect(teamErrorKey(new ApiError(500, '', 'x'))).toBe('tm.error.generic');
		expect(teamErrorKey(new StepUpCancelledError())).toBe('tm.error.cancelled');
	});
});
