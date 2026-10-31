import { describe, expect, it } from 'vitest';
import { IDENTITY_MAPPING_CATEGORY, OIDC_DEFAULT_SET_KEY } from '../identity-mapping';
import type { BulkApplyRequest } from '../identity-mapping';
import { createFakeIdentityMapping, DEMO_TENANT } from './identity-mapping-fake';

const ALL_BUT_TWO = (ids: string[]) => ids.filter((id) => id !== 'thyme' && id !== 'willow');

function request(mode: 'preview' | 'apply', tenantIds: string[]): BulkApplyRequest {
	return {
		mode,
		tenant_ids: tenantIds,
		changes: [{ category: IDENTITY_MAPPING_CATEGORY, set: { [OIDC_DEFAULT_SET_KEY]: 'fms_affil' } }]
	};
}

describe('fake identity mapping', () => {
	it('keeps demo app records and history out of other tenant pages', async () => {
		const api = createFakeIdentityMapping();
		expect(await api.apps(DEMO_TENANT)).not.toHaveLength(0);
		expect(await api.history(DEMO_TENANT)).not.toHaveLength(0);
		for (const tenant of ['birch', 'platform']) {
			expect(await api.apps(tenant)).toEqual([]);
			expect(await api.history(tenant)).toEqual([]);
			expect((await api.sets(tenant)).sets.every((set) => set.owner === 'platform')).toBe(true);
		}
	});
	it('selects app → tenant default → platform default, and opt-outs stop there', async () => {
		const api = createFakeIdentityMapping({ platformDefault: 'fms_groups' });
		expect((await api.effective(DEMO_TENANT, 'app_library')).selection).toMatchObject({
			kind: 'bound',
			tier: 'tenant_default',
			setId: 'fms_aster'
		});
		expect((await api.effective(DEMO_TENANT, 'app_intranet')).selection).toMatchObject({
			kind: 'bound',
			tier: 'client'
		});
		expect((await api.effective(DEMO_TENANT, 'app_conformance')).selection).toEqual({
			kind: 'none',
			reason: 'client_opt_out'
		});
		expect((await api.effective('birch')).selection).toMatchObject({
			tier: 'platform_default',
			setId: 'fms_groups'
		});
		expect((await createFakeIdentityMapping().effective('birch')).selection).toEqual({
			kind: 'none',
			reason: 'no_default'
		});
	});

	it('previews the scenario: 18 tenants, 96 apps, 5 app-specific and 2 opted out unchanged', async () => {
		const api = createFakeIdentityMapping();
		const ids = ALL_BUT_TWO((await api.tenantsOverview()).tenants.map((row) => row.tenant_id));
		const preview = await api.bulkPreview(request('preview', ids));
		const ready = preview.results.filter((r) => r.status === 'ready');
		expect(ready).toHaveLength(18);
		const impact = ready.map((r) => r.impact[IDENTITY_MAPPING_CATEGORY]!);
		const total = (key: 'apps_following_default' | 'apps_with_own_set' | 'apps_opted_out') =>
			impact.reduce((sum, i) => sum + (i.available ? (i[key] ?? 0) : 0), 0);
		expect(total('apps_following_default')).toBe(96);
		expect(total('apps_with_own_set')).toBe(5);
		expect(total('apps_opted_out')).toBe(2);
		expect(preview.results.find((r) => r.tenant_id === DEMO_TENANT)?.changes[0].reason).toBe(
			'existing_override'
		);
	});

	it('keeps tenants applied when others fail, and refuses stale versions', async () => {
		const api = createFakeIdentityMapping({ failOnce: ['rowan'] });
		const preview = await api.bulkPreview(request('preview', ['rowan', 'sage']));
		const expected = Object.fromEntries(
			preview.results.map((r) => [
				r.tenant_id,
				{ [IDENTITY_MAPPING_CATEGORY]: r.changes[0].version! }
			])
		);
		const first = await api.bulkApply({ ...request('apply', ['rowan', 'sage']), expected }, 'k1');
		expect(first.results.map((r) => r.status)).toEqual(['failed', 'applied']);
		// The same key answers the same; a stale version is a conflict.
		expect(await api.bulkApply({ ...request('apply', ['rowan', 'sage']), expected }, 'k1')).toEqual(
			first
		);
		// As the API: a stale version is a conflict before any skip decision.
		const again = await api.bulkApply({ ...request('apply', ['sage']), expected }, 'k2');
		expect(again.results[0].status).toBe('conflict');
		expect((await api.effective('sage')).selection).toMatchObject({ tier: 'tenant_default' });
	});

	it('explains missing claims by reason, without values', async () => {
		const api = createFakeIdentityMapping();
		const missing = await api.explain(DEMO_TENANT, {
			client_id: 'app_library',
			subject: { kind: 'test_user', id: 'test_no_affiliation' },
			surface: 'id_token'
		});
		expect(missing.claims.find((c) => c.claim === 'affiliation')).toMatchObject({
			value: 'missing',
			released: false,
			reason: 'value_missing'
		});
		expect(JSON.stringify(missing)).not.toContain('Faculty');
		const scope = await api.explain(DEMO_TENANT, {
			client_id: 'app_timetable',
			subject: { kind: 'test_user', id: 'test_full' },
			surface: 'id_token'
		});
		expect(scope.claims.find((c) => c.claim === 'affiliation')?.reason).toBe('scope_not_granted');
		const stopped = await createFakeIdentityMapping({ inactiveTenantSet: true }).explain(
			DEMO_TENANT,
			{
				client_id: 'app_library',
				subject: { kind: 'test_user', id: 'test_full' },
				surface: 'id_token'
			}
		);
		expect(stopped.outcome).toEqual({
			kind: 'stopped',
			code: 'set_inactive',
			tier: 'tenant_default'
		});
	});

	it('diffs a draft per app, holding back what an app has no scope for', async () => {
		const api = createFakeIdentityMapping();
		const preview = await api.previewSetChange(DEMO_TENANT, 'fms_aster', {
			mappings: [
				{ target: 'affiliation', sources: ['affiliation'] },
				{ target: 'org', sources: ['org_name'] }
			]
		});
		const library = preview.apps.find((a) => a.client_id === 'app_library')!;
		expect(library.changes).toEqual([
			{ kind: 'renamed', claim: 'org', previous_claim: 'organization' },
			{ kind: 'removed', claim: 'department' }
		]);
		const timetable = preview.apps.find((a) => a.client_id === 'app_timetable')!;
		expect(timetable.changes).toEqual([]);
		expect(timetable.held_back.map((h) => h.claim)).toEqual(['org', 'department']);
		expect(preview.apps).toHaveLength(12);
	});

	it('restores the value before a change, and refuses after the level moved', async () => {
		const api = createFakeIdentityMapping();
		const plan = await api.previewRestore(DEMO_TENANT, 'h1');
		expect(plan.later_changes.map((h) => h.id)).toEqual(['h4', 'h3']);
		await api.setAppChoice(DEMO_TENANT, 'app_mail', { mode: 'none' });
		await expect(api.restore(DEMO_TENANT, 'h1', plan.expected_version)).rejects.toMatchObject({
			status: 409
		});
		const fresh = await api.previewRestore(DEMO_TENANT, 'h4');
		await api.restore(DEMO_TENANT, 'h4', fresh.expected_version);
		expect((await api.effective(DEMO_TENANT)).selection).toMatchObject({ setId: 'fms_affil' });
		await expect(api.previewRestore(DEMO_TENANT, 'h3')).rejects.toMatchObject({ status: 409 });
	});

	it('restores with what the levels below give, and checks the target again', async () => {
		const api = createFakeIdentityMapping();
		// The intranet goes back to following the tenant default: it keeps department.
		const plan = await api.previewRestore(DEMO_TENANT, 'h2');
		expect(plan.apps[0].changes.map((c) => `${c.kind}:${c.claim}`)).toEqual([
			'added:affiliation',
			'added:organization',
			'removed:groups'
		]);
		const inactive = createFakeIdentityMapping({ inactiveTenantSet: true });
		const fresh = await inactive.previewRestore(DEMO_TENANT, 'h4');
		await inactive.restore(DEMO_TENANT, 'h4', fresh.expected_version);
		const [latest] = await inactive.history(DEMO_TENANT);
		expect(latest).toMatchObject({ restorable: false, not_restorable_reason: 'set_inactive' });
		await expect(inactive.previewRestore(DEMO_TENANT, latest.id)).rejects.toMatchObject({
			status: 409
		});
	});

	it('refuses a save of a set in use unless the reference count is confirmed', async () => {
		const api = createFakeIdentityMapping();
		const content = await api.setContent(DEMO_TENANT, 'fms_aster');
		expect(content.references?.count).toBe(3);
		const draft = { mappings: [{ target: 'affiliation', sources: ['affiliation'] }] };
		await expect(api.saveSet(DEMO_TENANT, 'fms_aster', draft, null)).rejects.toMatchObject({
			status: 409
		});
		await api.saveSet(DEMO_TENANT, 'fms_aster', draft, 3);
		// A transform-only edit is a change too.
		const steps = await api.previewSetChange(DEMO_TENANT, 'fms_aster', {
			mappings: [{ target: 'affiliation', sources: ['affiliation'], steps: [{ id: 's1' }] }]
		});
		expect(steps.apps[0].changes).toEqual([{ kind: 'transform_changed', claim: 'affiliation' }]);
	});

	it('previews a restore to "not set" with what the platform default then gives', async () => {
		const api = createFakeIdentityMapping({ platformDefault: 'fms_groups' });
		const plan = await api.previewRestore(DEMO_TENANT, 'h1');
		const library = plan.apps.find((a) => a.client_id === 'app_library')!;
		expect(library.changes.map((c) => `${c.kind}:${c.claim}`)).toEqual([
			'removed:affiliation',
			'removed:organization'
		]);
		expect(library.held_back.map((h) => h.claim)).toEqual(['groups']);
		// The platform default is a reference too.
		expect((await api.usage(DEMO_TENANT, 'fms_groups')).usage.items[0]).toEqual({
			kind: 'platform_default'
		});
	});

	it('answers a platform set in the platform context by tenant', async () => {
		const api = createFakeIdentityMapping({ platformDefault: 'fms_affil' });
		const preview = await api.previewSetChange('platform', 'fms_affil', { mappings: [] });
		expect(preview.apps).toEqual([]);
		expect(preview.tenants?.length).toBe(20);
	});

	it('versions the tenant default on restore, and does not guess transformed values', async () => {
		const api = createFakeIdentityMapping();
		const overwrite = {
			...request('preview', [DEMO_TENANT]),
			on_existing_override: 'overwrite' as const
		};
		const preview = await api.bulkPreview(overwrite);
		const plan = await api.previewRestore(DEMO_TENANT, 'h4');
		await api.restore(DEMO_TENANT, 'h4', plan.expected_version);
		const expected = {
			[DEMO_TENANT]: { [IDENTITY_MAPPING_CATEGORY]: preview.results[0].changes[0].version! }
		};
		const stale = await api.bulkApply({ ...overwrite, mode: 'apply', expected }, 'k3');
		expect(stale.results[0].status).toBe('conflict');
		await api.saveSet(
			DEMO_TENANT,
			'fms_affil',
			{ mappings: [{ target: 'affiliation', sources: [], steps: [{ id: 'fixed' }] }] },
			(await api.setContent(DEMO_TENANT, 'fms_affil')).references?.count ?? null
		);
		const explained = await api.explain(DEMO_TENANT, {
			client_id: 'app_library',
			subject: { kind: 'test_user', id: 'test_no_affiliation' },
			surface: 'id_token'
		});
		expect(explained.claims.find((c) => c.claim === 'affiliation')).toMatchObject({
			value: 'not_evaluated',
			released: null
		});
		// A platform set some app names itself, in a tenant whose apps are only counted: incomplete.
		const platform = await api.previewSetChange('platform', 'fms_groups', { mappings: [] });
		expect(platform.tenants).toEqual([{ tenant_id: DEMO_TENANT, apps_using: 1 }]);
		expect(platform.usage_complete).toBe(false);
	});

	it('pages the tenant list and keeps tenants whose settings cannot be read', async () => {
		const api = createFakeIdentityMapping({ pageSize: 8, settingsUnreadable: ['nettle'] });
		const rows = [];
		let page = await api.tenantsOverview({ limit: 100 });
		rows.push(...page.tenants);
		while (page.next_cursor) {
			page = await api.tenantsOverview({ cursor: page.next_cursor, limit: 100 });
			rows.push(...page.tenants);
		}
		const ids = rows.map((row) => row.tenant_id);
		expect(page.tenants.length).toBeLessThanOrEqual(8);
		expect(ids).toHaveLength(21);
		expect(ids).toEqual([...ids].sort());
		const nettle = rows.find((row) => row.tenant_id === 'nettle');
		expect(nettle).toMatchObject({
			tenant_default: null,
			effective: { kind: 'failed', code: 'settings_unreadable' }
		});
	});

	it('refuses too many tenants, and neither previews nor writes unreadable settings', async () => {
		const api = createFakeIdentityMapping({ bulkLimit: 2, settingsUnreadable: ['nettle'] });
		await expect(
			api.bulkPreview(request('preview', ['birch', 'cedar', 'elm']))
		).rejects.toMatchObject({ status: 400, body: { code: 'too_many_tenants', limit: 2 } });
		const preview = await api.bulkPreview(request('preview', ['nettle']));
		expect(preview.results[0]).toMatchObject({
			status: 'nothing_to_do',
			changes: [{ action: 'would_reject', reason: 'settings_unavailable', version: null }]
		});
		const applied = await api.bulkApply({ ...request('apply', ['nettle']), expected: {} }, 'k9');
		expect(applied.results[0]).toMatchObject({
			status: 'failed',
			changes: [{ reason: 'settings_unavailable' }]
		});
	});

	it('explains with the consent asked for and lists every source attribute', async () => {
		const api = createFakeIdentityMapping();
		const none = await api.explain(DEMO_TENANT, {
			client_id: 'app_library',
			subject: { kind: 'test_user', id: 'test_full' },
			surface: 'userinfo',
			consent: 'none'
		});
		expect(none).toMatchObject({ surface: 'userinfo', consent: 'none', warnings: [] });
		expect(none.claims.find((c) => c.claim === 'department')).toMatchObject({
			consent: 'missing',
			released: false,
			reason: 'consent_missing',
			sources: ['department']
		});
		const users = await api.testUsers(DEMO_TENANT);
		expect(users.limits).toEqual({ max_users: 10, max_attributes: 50 });
		expect(users.test_users[0]).toHaveProperty('attributes');
	});

	it('sends only sub in an ID token without a set, and lists claims asked about', async () => {
		const api = createFakeIdentityMapping();
		const asked = {
			client_id: 'app_conformance',
			subject: { kind: 'test_user' as const, id: 'test_full' }
		};
		const idToken = await api.explain(DEMO_TENANT, {
			...asked,
			surface: 'id_token',
			claims: ['extra_claim']
		});
		expect(idToken.claims.find((c) => c.claim === 'email')).toMatchObject({
			released: false,
			reason: 'surface_not_listed'
		});
		expect(idToken.claims.find((c) => c.claim === 'sub')?.released).toBe(true);
		expect(idToken.claims.find((c) => c.claim === 'extra_claim')).toMatchObject({
			origin: 'requested',
			released: false,
			reason: 'mapping_not_applied'
		});
		const userinfo = await api.explain(DEMO_TENANT, { ...asked, surface: 'userinfo' });
		expect(userinfo.claims.find((c) => c.claim === 'email')?.released).toBe(true);
	});
});
