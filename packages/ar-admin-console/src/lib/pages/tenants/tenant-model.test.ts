import { describe, expect, it } from 'vitest';
import {
	canCopy,
	canDelete,
	COPY_GROUPS,
	copyProblem,
	defaultCopyOptions,
	setCopyPart,
	suggestTenantId,
	takenIdentifiers,
	newTenantProblems,
	tenantIdProblem
} from './tenant-model';
import { TENANT_COPY_PARTS } from '#lib/api/tenants.js';

describe('tenant ids', () => {
	it('checks them as the API does', () => {
		expect(tenantIdProblem('')).toBe('required');
		expect(tenantIdProblem('Acme')).toBe('format');
		expect(tenantIdProblem('-acme')).toBe('format');
		expect(tenantIdProblem('a'.repeat(64))).toBe('format');
		expect(tenantIdProblem('platform')).toBe('reserved');
		expect(tenantIdProblem('acme', { sourceId: 'acme' })).toBe('same');
		expect(tenantIdProblem('acme', { taken: new Set(['acme']) })).toBe('taken');
		expect(tenantIdProblem(' acme-2 ')).toBeNull();
	});

	it('suggests one from a name', () => {
		expect(suggestTenantId('Umbrella Labs!')).toBe('umbrella-labs');
		expect(suggestTenantId('  Café ')).toBe('cafe');
		expect(suggestTenantId('日本')).toBe('');
		expect(suggestTenantId(`${'a'.repeat(62)} b`)).toBe('a'.repeat(62));
	});
});

describe('what a copy takes', () => {
	it('offers every part the API knows, once', () => {
		const parts = COPY_GROUPS.flatMap((group) => group.items).flatMap((item) =>
			item.part ? [item.part] : []
		);
		expect([...parts].sort()).toEqual([...TENANT_COPY_PARTS].sort());
	});

	it('starts with settings and roles, as the API defaults', () => {
		const options = defaultCopyOptions();
		expect(
			Object.entries(options)
				.filter(([, on]) => on)
				.map(([part]) => part)
		).toEqual(['settings', 'roles']);
	});

	it('keeps a secret with what holds it', () => {
		let options = setCopyPart(defaultCopyOptions(), 'client_credentials', true);
		expect(options).toMatchObject({ clients: true, client_credentials: true });
		options = setCopyPart(options, 'clients', false);
		expect(options).toMatchObject({ clients: false, client_credentials: false });
		options = setCopyPart(options, 'settings', false);
		expect(options.secret_settings).toBe(false);
	});

	it('refuses admin access with webhooks', () => {
		const options = { ...defaultCopyOptions(), admin_access: true, webhooks: true };
		expect(copyProblem(options)).toBe('separateStepUps');
		expect(copyProblem(defaultCopyOptions())).toBeNull();
	});
});

describe('actions by state', () => {
	it('deletes only an operator-mutable, non-default tenant; copies only an active one', () => {
		expect(canDelete({ lifecycleState: 'active', isDefault: false })).toBe(true);
		expect(canDelete({ lifecycleState: 'suspended', isDefault: false })).toBe(true);
		expect(canDelete({ lifecycleState: 'active', isDefault: true })).toBe(false);
		expect(canDelete({ lifecycleState: 'deleting', isDefault: false })).toBe(false);
		expect(canDelete({ lifecycleState: 'provisioning', isDefault: false })).toBe(false);
		expect(canCopy({ lifecycleState: 'active' })).toBe(true);
		expect(canCopy({ lifecycleState: 'suspended' })).toBe(false);
	});
});

describe('a new tenant’s id and code', () => {
	const taken = takenIdentifiers([{ id: 'acme', code: 'login' }]);

	it('checks ids against ids and codes against codes, as the API does', () => {
		expect(newTenantProblems({ id: 'login', code: 'new-login' }, taken)).toEqual({
			id: null,
			code: null
		});
		expect(newTenantProblems({ id: 'acme', code: '' }, taken).id).toBe('taken');
		expect(newTenantProblems({ id: 'other', code: 'login' }, taken).code).toBe('taken');
	});

	it('checks an empty code as the id it becomes', () => {
		expect(newTenantProblems({ id: 'login', code: '' }, taken)).toEqual({
			id: null,
			code: 'taken'
		});
	});

	it('refuses the source id for a copy', () => {
		expect(newTenantProblems({ id: 'acme', code: '' }, taken, 'acme').id).toBe('same');
	});
});
