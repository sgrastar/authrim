/**
 * FAKE DATA for the identity-mapping mock-ups (Storybook only). Made-up tenants, apps, sets and
 * test users: no real customer, person or value. The behaviour that reads it is in
 * `identity-mapping-fake.ts`.
 */
import type { ClientMappingChoice, HistoryEntry, MappingSetSummary } from '../identity-mapping';

export const PLATFORM = 'platform';
export const DEMO_TENANT = 'aster';

/** Authrim attributes a set reads (the sending side of the mapping editor). */
export const ATTRIBUTES = [
	{ key: 'affiliation', type: 'string[]' },
	{ key: 'org_name', type: 'string' },
	{ key: 'org_code', type: 'string' },
	{ key: 'department', type: 'string' },
	{ key: 'groups', type: 'string[]' },
	{ key: 'employee_type', type: 'string' }
] as const;

export type AttributeKey = (typeof ATTRIBUTES)[number]['key'];

/** Claims Authrim releases itself, by scope, whatever the set. */
export const STANDARD_CLAIMS: ReadonlyArray<{ claim: string; scope: string }> = [
	{ claim: 'sub', scope: 'openid' },
	{ claim: 'email', scope: 'email' },
	{ claim: 'email_verified', scope: 'email' },
	{ claim: 'name', scope: 'profile' },
	{ claim: 'given_name', scope: 'profile' },
	{ claim: 'family_name', scope: 'profile' }
];

/** Claims a set may release, with the scope that releases each (the destination profile). */
export const MAPPED_CLAIMS: ReadonlyArray<{ claim: string; scope: string; consent?: boolean }> = [
	{ claim: 'affiliation', scope: 'affiliation' },
	{ claim: 'organization', scope: 'affiliation' },
	{ claim: 'org', scope: 'affiliation' },
	{ claim: 'department', scope: 'affiliation', consent: true },
	{ claim: 'groups', scope: 'groups' },
	{ claim: 'employee_type', scope: 'affiliation' }
];

export interface FakeSet extends MappingSetSummary {
	mappings: Array<{ target: string; sources: string[]; steps?: unknown[] }>;
}

const set = (
	id: string,
	owner: 'tenant' | 'platform',
	name: string,
	mappings: FakeSet['mappings'],
	enabled = true
): FakeSet => ({
	id,
	owner,
	field_mapping_key: id.replace(/^fms_/, ''),
	display_name: name,
	description: null,
	enabled,
	active_version_id: enabled ? `${id}_v3` : null,
	version_label: 'v3',
	content_version: `${id}_v3`,
	created_at: Date.parse('2026-09-02T01:00:00Z'),
	updated_at: Date.parse('2026-10-21T03:20:00Z'),
	mappings
});

export function fakeSets(): FakeSet[] {
	return [
		set('fms_affil', 'platform', 'Affiliation claims', [
			{ target: 'affiliation', sources: ['affiliation'] },
			{ target: 'organization', sources: ['org_name'] }
		]),
		set('fms_groups', 'platform', 'Groups and department', [
			{ target: 'groups', sources: ['groups'] },
			{ target: 'department', sources: ['department'] }
		]),
		set('fms_aster', 'tenant', 'Aster campus claims', [
			{ target: 'affiliation', sources: ['affiliation'] },
			{ target: 'organization', sources: ['org_name'] },
			{ target: 'department', sources: ['department'] }
		]),
		set(
			'fms_legacy',
			'tenant',
			'Legacy claims (switched off)',
			[{ target: 'org', sources: ['org_code'] }],
			false
		)
	];
}

export interface FakeTenant {
	id: string;
	name: string;
	/** The tenant's own value of the default (undefined: not set, inherits). */
	ownDefault?: string | 'none';
	version: number;
	apps: { following: number; ownSet: number; optedOut: number; unusable: number };
}

const ROLLOUT = [
	// id, apps following the default, apps naming their own set, apps opted out
	['birch', 6, 0, 1],
	['cedar', 5, 1, 0],
	['dahlia', 4, 0, 0],
	['elm', 7, 0, 0],
	['fern', 5, 0, 0],
	['ginkgo', 6, 0, 0],
	['hazel', 3, 0, 0],
	['iris', 5, 0, 0],
	['juniper', 4, 0, 0],
	['kelp', 6, 0, 0],
	['laurel', 5, 0, 0],
	['maple', 7, 2, 0],
	['nettle', 4, 0, 0],
	['oak', 6, 0, 1],
	['pine', 5, 0, 0],
	['quince', 5, 0, 0],
	['rowan', 5, 2, 0],
	['sage', 8, 0, 0],
	['thyme', 3, 1, 0]
] as const;

export function fakeTenants(): FakeTenant[] {
	return [
		{
			id: DEMO_TENANT,
			name: 'Aster',
			ownDefault: 'fms_aster',
			version: 7,
			apps: { following: 10, ownSet: 3, optedOut: 1, unusable: 0 }
		},
		...ROLLOUT.map(([id, following, ownSet, optedOut]) => ({
			id,
			name: id.charAt(0).toUpperCase() + id.slice(1),
			version: 3,
			apps: { following, ownSet, optedOut, unusable: 0 }
		})),
		{
			id: 'willow',
			name: 'Willow',
			version: 2,
			apps: { following: 2, ownSet: 0, optedOut: 0, unusable: 1 }
		}
	];
}

export interface FakeApp {
	client_id: string;
	name: string;
	identity_mapping: ClientMappingChoice;
	scopes: string[];
}

const app = (
	client_id: string,
	name: string,
	scopes: string,
	identity_mapping: ClientMappingChoice = null
): FakeApp => ({
	client_id,
	name,
	identity_mapping,
	scopes: scopes.split(' ')
});

const FULL = 'openid email profile affiliation';

/** The apps of the demo tenant (the others are counted only). */
export function fakeApps(): FakeApp[] {
	return [
		app('app_library', 'Library portal', FULL),
		app('app_catalogue', 'Course catalogue', FULL),
		app('app_mail', 'Student mail', 'openid email profile'),
		app('app_timetable', 'Timetable', 'openid email'),
		app('app_repository', 'Research repository', FULL),
		app('app_events', 'Event booking', FULL),
		app('app_printing', 'Printing', 'openid profile'),
		app('app_guest', 'Guest Wi-Fi', 'openid'),
		app('app_alumni', 'Alumni site', FULL),
		app('app_helpdesk', 'Help desk', FULL),
		app('app_learning', 'Learning platform', `${FULL} groups`, { fieldMappingSetId: 'fms_aster' }),
		app('app_exams', 'Exam system', FULL, { fieldMappingSetId: 'fms_aster' }),
		app('app_intranet', 'Staff intranet', `${FULL} groups`, { fieldMappingSetId: 'fms_groups' }),
		app('app_conformance', 'Conformance test app', FULL, { mode: 'none' })
	];
}

/** Test users: made-up people with made-up attributes. `null`: no value; '': an empty one. */
export const TEST_USERS: ReadonlyArray<{
	user_id: string;
	label: string;
	attributes: Partial<Record<AttributeKey, string | string[] | null>>;
}> = [
	{
		user_id: 'test_full',
		label: 'Test user A (every attribute)',
		attributes: {
			affiliation: ['student', 'member'],
			org_name: 'Faculty of Science',
			org_code: 'SCI',
			department: 'Physics',
			groups: ['physics-lab', 'library-users'],
			employee_type: 'student'
		}
	},
	{
		user_id: 'test_no_affiliation',
		label: 'Test user B (no affiliation)',
		attributes: {
			affiliation: null,
			org_name: 'Faculty of Arts',
			org_code: 'ART',
			department: 'History',
			groups: ['library-users'],
			employee_type: 'staff'
		}
	},
	{
		user_id: 'test_empty_department',
		label: 'Test user C (empty department)',
		attributes: {
			affiliation: ['faculty'],
			org_name: 'Faculty of Law',
			org_code: 'LAW',
			department: '',
			groups: [],
			employee_type: 'faculty'
		}
	}
];

export function fakeHistory(): HistoryEntry[] {
	const operator = { id: 'adm_operator', label: 'Platform operator' };
	const adminA = { id: 'adm_a', label: 'Tenant admin A' };
	const adminB = { id: 'adm_b', label: 'Tenant admin B' };
	return [
		{
			id: 'h4',
			at: '2026-10-23T05:05:00Z',
			actor: adminB,
			tier: 'tenant_default',
			before: { state: 'set', setId: 'fms_affil', setName: 'Affiliation claims' },
			after: { state: 'set', setId: 'fms_aster', setName: 'Aster campus claims' },
			via: 'settings',
			restorable: true
		},
		{
			id: 'h3',
			at: '2026-10-22T01:30:00Z',
			actor: operator,
			tier: 'tenant_default',
			before: { state: 'set', setId: 'fms_legacy', setName: 'Legacy claims (switched off)' },
			after: { state: 'set', setId: 'fms_affil', setName: 'Affiliation claims' },
			via: 'bulk_apply',
			restorable: false,
			not_restorable_reason: 'set_inactive'
		},
		{
			id: 'h2',
			at: '2026-10-15T07:40:00Z',
			actor: adminA,
			tier: 'client',
			client_id: 'app_intranet',
			client_name: 'Staff intranet',
			before: { state: 'unset' },
			after: { state: 'set', setId: 'fms_groups', setName: 'Groups and department' },
			via: 'app',
			restorable: true
		},
		{
			id: 'h1',
			at: '2026-10-01T00:12:00Z',
			actor: adminA,
			tier: 'tenant_default',
			before: { state: 'unset' },
			after: { state: 'set', setId: 'fms_legacy', setName: 'Legacy claims (switched off)' },
			via: 'settings',
			restorable: true
		}
	];
}
