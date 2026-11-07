import { describe, expect, it } from 'vitest';
import { samplePermissions } from '#lib/api/fake/admin-roles-fake.js';
import { groupPermissions, roleChanges, roleNameProblem, type RoleDraft } from './role-model';

const draft = (partial: Partial<RoleDraft> = {}): RoleDraft => ({
	display_name: 'Billing reader',
	description: '',
	permissions: ['admin:audit:read', 'admin:settings:read'],
	hierarchy_level: 10,
	...partial
});

describe('a role name', () => {
	it('is required and not one kept for the built-in roles', () => {
		expect(roleNameProblem(' ')).toBe('tr.new.nameRequired');
		expect(roleNameProblem('ar_custom')).toBe('tr.new.nameReserved');
		expect(roleNameProblem('AR_custom')).toBe('tr.new.nameReserved');
		expect(roleNameProblem('billing_reader')).toBeUndefined();
	});
});

describe('permissions', () => {
	it('group by the resource they are about, the wildcard alone', () => {
		const groups = groupPermissions(samplePermissions());
		expect(groups[0]).toMatchObject({ resource: '*' });
		expect(groups.find((group) => group.resource === 'admin_users')?.items).toHaveLength(2);
	});
});

describe('saving a role', () => {
	it('sends nothing when nothing changed, whatever the order of the permissions', () => {
		expect(
			roleChanges(draft(), draft({ permissions: ['admin:settings:read', 'admin:audit:read'] }))
		).toEqual({});
	});

	it('sends only what changed', () => {
		expect(roleChanges(draft(), draft({ description: 'Reads invoices' }))).toEqual({
			description: 'Reads invoices'
		});
		expect(
			roleChanges(draft(), draft({ hierarchy_level: 5, permissions: ['admin:audit:read'] }))
		).toEqual({
			hierarchy_level: 5,
			permissions: ['admin:audit:read']
		});
	});
});
