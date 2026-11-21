import { describe, expect, it } from 'vitest';
import {
	MOCK_FEDERATION_CERTIFICATE,
	MOCK_FEDERATION_FINGERPRINT,
	MOCK_FEDERATION_SOURCES,
	mockEntities
} from '#lib/api/fake/federation-sources-fake.js';
import type { FederationForm } from './federation-model';
import { fingerprintGroups, metadataUrlProblem, pemFromFileBytes } from './federation-model';
import {
	certificateFromPem,
	emptyFederationForm,
	entityState,
	federationCreateInput,
	federationFormOf,
	federationPayload,
	federationProblems,
	federationStatus,
	federationUpdateInput,
	fingerprintDisplay
} from './federation-model';
import { canProceed, emptyAnswers, stepsFor } from './connection-model';

const cert = {
	id: 'c1',
	certificate: MOCK_FEDERATION_CERTIFICATE,
	fingerprintSha256: MOCK_FEDERATION_FINGERPRINT,
	createdAt: 1
};
const valid = (patch: Partial<FederationForm> = {}): FederationForm => ({
	...emptyFederationForm('out'),
	name: 'Test federation',
	metadataUrl: 'https://metadata.example/aggregate.xml',
	certificates: [cert],
	spMappingSetId: 'set-sp',
	...patch
});
const fields = (form: FederationForm) => federationProblems(form).map((p) => p.field);
const [healthy, lapsed, draft] = MOCK_FEDERATION_SOURCES;

describe('a new federation', () => {
	it('starts with the role that goes with the direction chosen', () => {
		expect(emptyFederationForm('out')).toMatchObject({ spRole: true, idpRole: false });
		expect(emptyFederationForm('in')).toMatchObject({ spRole: false, idpRole: true });
		expect(emptyFederationForm()).toMatchObject({ spRole: false, idpRole: false });
	});

	it('asks for everything it cannot trust automatically without', () => {
		expect(fields(emptyFederationForm('out'))).toEqual([
			'name',
			'metadataUrl',
			'certificates',
			'spMappingSet'
		]);
		expect(fields(valid())).toEqual([]);
	});

	it('needs one exact https address, not a pattern or a plain-http one', () => {
		for (const url of [
			'http://m.example/a.xml',
			'https://m.example/*',
			'https://m.example/a b',
			''
		])
			expect(fields(valid({ metadataUrl: url }))).toContain('metadataUrl');
	});

	it('needs a role, and a mapping set for each role that is on', () => {
		expect(fields(valid({ spRole: false }))).toEqual(['roles']);
		expect(fields(valid({ idpRole: true }))).toEqual(['idpMappingSet']);
		expect(fields(valid({ idpRole: true, idpMappingSetId: 'set-idp' }))).toEqual([]);
	});

	it('needs an https discovery service only when an external one is chosen', () => {
		const idp = valid({ spRole: false, idpRole: true, idpMappingSetId: 'set-idp' });
		expect(fields({ ...idp, idpSelectionMode: 'external_ds' })).toEqual(['discoveryServiceUrl']);
		expect(
			fields({
				...idp,
				idpSelectionMode: 'external_ds',
				discoveryServiceUrl: 'https://ds.example/discovery'
			})
		).toEqual([]);
	});

	it('makes a request whose payload keeps exceptions and the picker beside the trust policy', () => {
		const input = federationCreateInput(valid());
		expect(input).toMatchObject({
			sourceKey: 'https://metadata.example/aggregate.xml',
			name: 'Test federation',
			lifecycleState: 'active'
		});
		expect(input.payload).toMatchObject({
			metadataUrl: 'https://metadata.example/aggregate.xml',
			metadataUrlPatterns: ['https://metadata.example/aggregate.xml'],
			certificates: [cert],
			polling: { mode: 'automatic', intervalSeconds: 21600 },
			runtimeResolution: {
				mode: 'automatic',
				roles: ['saml_sp'],
				spFieldMappingSetId: 'set-sp',
				defaultAttributePresetId: 'basic.v1'
			},
			exceptions: { excludedEntityIds: [] },
			idpSelection: { mode: 'authrim_search' }
		});
		// Exceptions and the picker are not part of the runtime policy that decides the trust hash.
		expect(input.payload.runtimeResolution).not.toHaveProperty('excludedEntityIds');
		expect(input.payload.runtimeResolution).not.toHaveProperty('idpFieldMappingSetId');
	});

	it('refuses an incomplete form', () => {
		expect(() => federationCreateInput(emptyFederationForm('in'))).toThrow();
	});

	it('writes the discovery service only with the IdP role and the external mode', () => {
		const external = valid({
			spRole: false,
			idpRole: true,
			idpMappingSetId: 'set-idp',
			idpSelectionMode: 'external_ds',
			discoveryServiceUrl: ' https://ds.example/discovery '
		});
		expect(federationPayload(external).idpSelection).toEqual({
			mode: 'external_ds',
			discoveryServiceUrl: 'https://ds.example/discovery'
		});
		expect(federationPayload({ ...external, idpRole: false, spRole: true }).idpSelection).toEqual({
			mode: 'authrim_search'
		});
	});
});

describe('saving over a source that was read', () => {
	it('keeps what the console does not set and writes the version it read', () => {
		const stored = {
			...healthy,
			updatedAt: 42,
			registrationAuthorities: ['https://ra.example/'],
			payload: {
				policy: 'warn',
				polling: { mode: 'manual', intervalSeconds: 86400 },
				runtimeResolution: {
					mode: 'automatic',
					roles: ['saml_sp'],
					priority: 5,
					registrationAuthorities: ['https://ra.example/']
				}
			}
		};
		const form = {
			...federationFormOf(stored),
			name: 'Renamed',
			excludedEntityIds: ['a', 'a', 'b']
		};
		const update = federationUpdateInput({ ...form, spMappingSetId: 'set-sp' }, stored);
		expect(update.expectedUpdatedAt).toBe(42);
		expect(update.sourceKey).toBe(stored.sourceKey);
		expect(update.payload).toMatchObject({
			policy: 'warn',
			polling: { mode: 'manual', intervalSeconds: 86400 },
			runtimeResolution: {
				priority: 5,
				registrationAuthorities: ['https://ra.example/'],
				spFieldMappingSetId: 'set-sp'
			},
			exceptions: { excludedEntityIds: ['a', 'b'] }
		});
	});

	it('reads the roles, the sets and the exceptions of a source into a form', () => {
		const form = federationFormOf(healthy);
		expect(form).toMatchObject({
			spRole: true,
			idpRole: true,
			spMappingSetId: 'map-tenant-default'
		});
		expect(form.excludedEntityIds).toHaveLength(3);
	});
});

describe('where a federation stands', () => {
	const now = Date.UTC(2026, 10, 20, 9);
	it('is in use when healthy, expired when its metadata has run out, not started as a draft', () => {
		expect(federationStatus(healthy, now)).toBe('active');
		expect(federationStatus(lapsed, now)).toBe('expired');
		expect(federationStatus(draft, now)).toBe('draft');
		expect(federationStatus({ ...healthy, lifecycleState: 'retired' }, now)).toBe('retired');
	});

	it('is failing when the last fetch failed but the metadata is still good', () => {
		const failing = {
			...healthy,
			status: { ...healthy.status!, consecutiveFailures: 2, sourceState: 'error' as const }
		};
		expect(federationStatus(failing, now)).toBe('refreshFailed');
		const unverified = {
			...healthy,
			status: { ...healthy.status!, lastVerification: { status: 'failed' as const, at: 1 } }
		};
		expect(federationStatus(unverified, now)).toBe('refreshFailed');
	});

	it('treats a valid-until in the past as expired even if the server did not say so', () => {
		const old = {
			...healthy,
			status: { ...healthy.status!, acceptedValidUntil: new Date(now - 1000).toISOString() }
		};
		expect(federationStatus(old, now)).toBe('expired');
	});

	it('is in use when the server has not said anything yet', () => {
		expect(federationStatus({ ...healthy, status: null }, now)).toBe('active');
	});
});

describe('an entity', () => {
	const [first, second] = mockEntities(10);
	it('is explicit before it is excluded, and takes part otherwise', () => {
		expect(entityState({ ...first, excluded: true })).toBe('excluded');
		expect(entityState(second)).toBe('participating');
		expect(entityState({ ...first, excluded: true, explicitProviderId: 'p1' })).toBe('explicit');
	});
});

describe('a certificate', () => {
	it('is read from pasted text with its fingerprint worked out here', async () => {
		const certificate = await certificateFromPem(`junk\n${MOCK_FEDERATION_CERTIFICATE}\n`);
		expect(certificate?.fingerprintSha256).toBe(MOCK_FEDERATION_FINGERPRINT);
		expect(certificate?.certificate).toBe(MOCK_FEDERATION_CERTIFICATE);
	});

	it('is refused when the text is not a certificate', async () => {
		expect(await certificateFromPem('hello')).toBeNull();
		expect(
			await certificateFromPem('-----BEGIN CERTIFICATE-----\nVEVTVA==\n-----END CERTIFICATE-----')
		).toBeNull();
	});

	it('is shown as colon-separated pairs, as federations publish it', () => {
		expect(fingerprintDisplay('aa7bc7')).toBe('AA:7B:C7');
	});

	it('breaks into runs of bytes, never inside a byte pair, and joins back unchanged', () => {
		const sha256 = fingerprintDisplay(MOCK_FEDERATION_FINGERPRINT);
		const groups = fingerprintGroups(sha256);
		// 32 bytes: four runs of eight, each but the last ending in its colon.
		expect(groups).toHaveLength(4);
		expect(groups.slice(0, 3).every((group) => group.endsWith(':'))).toBe(true);
		expect(groups[3]?.endsWith(':')).toBe(false);
		expect(groups.every((group) => /^([0-9A-F]{2}:?)+$/.test(group))).toBe(true);
		expect(groups.join('')).toBe(sha256);
		// SHA-1 (20 bytes): eight, eight, four.
		expect(
			fingerprintGroups('AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD')
		).toEqual(['AA:BB:CC:DD:EE:FF:00:11:', '22:33:44:55:66:77:88:99:', 'AA:BB:CC:DD']);
		expect(fingerprintGroups('')).toEqual([]);
	});

	it('is read from a file as PEM text or as DER bytes', async () => {
		const asText = new TextEncoder().encode(`${MOCK_FEDERATION_CERTIFICATE}\n`);
		expect((await certificateFromPem(pemFromFileBytes(asText)))?.fingerprintSha256).toBe(
			MOCK_FEDERATION_FINGERPRINT
		);
		// The same certificate as binary DER (what a .cer file often is).
		const base64 = MOCK_FEDERATION_CERTIFICATE.replace(/-----[A-Z ]+-----|\s/g, '');
		const der = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
		expect(der[0]).toBe(0x30);
		const wrapped = pemFromFileBytes(der);
		expect(wrapped).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
		expect((await certificateFromPem(wrapped))?.fingerprintSha256).toBe(
			MOCK_FEDERATION_FINGERPRINT
		);
		// Neither: not a certificate once read.
		expect(await certificateFromPem(pemFromFileBytes(new Uint8Array([1, 2, 3])))).toBeNull();
	});
});

describe('the metadata address', () => {
	it('says nothing for an empty or a good one', () => {
		expect(metadataUrlProblem('')).toBeUndefined();
		expect(metadataUrlProblem('https://metadata.example.org/aggregate.xml')).toBeUndefined();
	});

	it('refuses a link with a # part (a link copied from a page), with its own message', () => {
		const copied =
			'https://www.example.org/join/rule#:~:text=https%3A//metadata.example.org/aggregate.xml';
		expect(metadataUrlProblem(copied)).toBeTruthy();
		expect(metadataUrlProblem(copied)).not.toBe(metadataUrlProblem('http://plain.example/a.xml'));
	});

	it('refuses http, patterns and spaces', () => {
		for (const bad of [
			'http://a.example/x.xml',
			'https://a.example/*.xml',
			'https://a.example/a b'
		])
			expect(metadataUrlProblem(bad), bad).toBeTruthy();
	});
});

describe('the wizard steps', () => {
	it('asks only for the federation: its mapping sets are chosen on its own page', () => {
		const answers = emptyAnswers();
		answers.direction = 'in';
		answers.kind = 'federation';
		expect(stepsFor(answers).map((step) => step.id)).toEqual([
			'where',
			'kind',
			'federation-source'
		]);
	});

	it('goes on once the federation can exist, with no mapping set yet', () => {
		const answers = emptyAnswers();
		answers.direction = 'out';
		answers.kind = 'federation';
		answers.federation = valid({ spMappingSetId: '' });
		expect(canProceed('federation-source', answers)).toBe(true);
		answers.federation.certificates = [];
		expect(canProceed('federation-source', answers)).toBe(false);
	});
});

describe('what is kept and refused when saving', () => {
	it('keeps unknown keys beside the exceptions and the picker', () => {
		const payload = federationPayload(valid(), {
			exceptions: { excludedEntityIds: ['old'], note: 'kept' },
			idpSelection: { mode: 'external_ds', discoveryServiceUrl: 'https://ds.example/', extra: 1 }
		});
		expect(payload.exceptions).toEqual({ excludedEntityIds: [], note: 'kept' });
		expect(payload.idpSelection).toEqual({ mode: 'authrim_search', extra: 1 });
	});

	it('refuses an address with credentials or no host as a discovery service', () => {
		const idp = valid({
			spRole: false,
			idpRole: true,
			idpMappingSetId: 's',
			idpSelectionMode: 'external_ds'
		});
		for (const url of [
			'https://user:pw@ds.example/',
			'https://',
			'https:ds.example/',
			'http://ds.example'
		])
			expect(fields({ ...idp, discoveryServiceUrl: url })).toContain('discoveryServiceUrl');
	});

	it('takes registration authorities as identifiers, not addresses', () => {
		const form = valid({
			registrationAuthorities: 'urn:mace:example\nhttp://ra.example/\n\nurn:mace:example'
		});
		expect(fields(form)).toEqual([]);
		expect(federationPayload(form).runtimeResolution).toMatchObject({
			registrationAuthorities: ['urn:mace:example', 'http://ra.example/']
		});
	});

	it('keeps an inventory-only source an administrator set on purpose', () => {
		// Not waiting for its sets (no marker): choosing them does not switch it on.
		const payload = federationPayload(valid(), { runtimeResolution: { mode: 'inventory_only' } });
		expect(payload.runtimeResolution).toMatchObject({ mode: 'inventory_only' });
		expect(payload).not.toHaveProperty('setupPending');
	});

	it('waits for the last mapping set across saves, then switches on', () => {
		const both = { spRole: true, idpRole: true };
		// Made with no sets: waiting.
		const made = federationPayload(valid({ ...both, spMappingSetId: '', idpMappingSetId: '' }));
		expect(made).toMatchObject({
			setupPending: true,
			runtimeResolution: { mode: 'inventory_only' }
		});
		// One set chosen and saved: still waiting, though an id is stored.
		const half = federationPayload(valid({ ...both, idpMappingSetId: '' }), made);
		expect(half).toMatchObject({
			setupPending: true,
			runtimeResolution: { mode: 'inventory_only' }
		});
		// The last one: on, and no longer waiting.
		const done = federationPayload(valid({ ...both, idpMappingSetId: 'set-idp' }), half);
		expect(done.runtimeResolution).toMatchObject({ mode: 'automatic' });
		expect(done).not.toHaveProperty('setupPending');
	});

	it('still refuses an external discovery service without an https address', () => {
		const form = valid({
			spRole: false,
			idpRole: true,
			idpMappingSetId: '',
			idpSelectionMode: 'external_ds',
			discoveryServiceUrl: 'http://ds.example'
		});
		expect(() => federationCreateInput(form)).toThrow();
	});

	it('creates a federation with no mapping set', () => {
		expect(() => federationCreateInput(valid({ spMappingSetId: '' }))).not.toThrow();
		expect(() => federationCreateInput(valid({ spRole: false, idpRole: false }))).toThrow();
	});
});
