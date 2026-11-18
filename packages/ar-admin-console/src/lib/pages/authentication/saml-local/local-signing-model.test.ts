import { describe, expect, it } from 'vitest';
import { createFakeSamlSettings, mockSamlSettings } from '#lib/api/fake/saml-settings-fake.js';
import {
	certificateFingerprints,
	derOfPem,
	entityIdForStyle,
	fromDateTimeLocal,
	generatedDnsNames,
	nextReferences,
	normalizeDnsNames,
	parseDnsNamesInput,
	parseSubject,
	passphraseProblem,
	signingPolicy,
	signingSlotRows,
	slotPublication,
	toDateTimeLocal
} from './local-signing-model';

describe('signing slot rows', () => {
	it('lists the active slot, every next certificate and the backup, in that order', () => {
		const settings = mockSamlSettings();
		const rows = signingSlotRows(signingPolicy(settings, 'idp'));
		expect(rows.map((row) => row.slot)).toEqual(['active', 'next', 'backup']);
		expect(rows[0].stored).toBe(true);
		expect(rows[2].stored).toBe(false);
	});

	it('numbers next certificates only when there are several, and drops duplicates', () => {
		const next = { slot: 'next' as const, kid: 'k1', certificate: 'A' };
		const policy = {
			next,
			nextCandidates: [next, { slot: 'next' as const, kid: 'k2', certificate: 'B' }]
		};
		expect(nextReferences(policy).map((r) => r.kid)).toEqual(['k1', 'k2']);
		const rows = signingSlotRows(policy).filter((row) => row.slot === 'next');
		expect(rows.map((row) => row.index)).toEqual([1, 2]);
		expect(signingSlotRows({ next }).find((row) => row.slot === 'next')?.index).toBeUndefined();
	});

	it('says whether a slot is in the metadata as the server decides it', () => {
		const next = { slot: 'next' as const, kid: 'k', metadataPublishFrom: 2_000 };
		const activeNext = { metadataCertificatePublication: 'active_next' as const };
		const all = { metadataCertificatePublication: 'active_next_backup' as const };
		// The default mode publishes the active certificate only.
		expect(slotPublication({}, 'next', next, 3_000)).toBe('withheld');
		expect(slotPublication(activeNext, 'next', next, 1_000)).toBe('scheduled');
		expect(slotPublication(activeNext, 'next', next, 3_000)).toBe('published');
		expect(slotPublication(activeNext, 'backup', undefined)).toBe('withheld');
		expect(slotPublication(all, 'backup', undefined)).toBe('published');
		expect(slotPublication({}, 'active', undefined)).toBe('published');
	});

	it('treats an active slot without a key as signing with the default key', () => {
		const rows = signingSlotRows({});
		expect(rows[0]).toMatchObject({ slot: 'active', stored: false });
	});
});

describe('certificate subject and names', () => {
	it('reads a distinguished name into the form, ignoring parts it does not know', () => {
		expect(parseSubject('C=JP, ST=Tokyo, O=Acme, OU=IT, CN=Acme SAML, EMAIL=x@y')).toEqual({
			countryName: 'JP',
			stateOrProvinceName: 'Tokyo',
			localityName: '',
			organizationName: 'Acme',
			organizationalUnitName: 'IT',
			commonName: 'Acme SAML'
		});
		expect(parseSubject('O=Example, Inc., CN=Example SAML, L=New York, NY')).toMatchObject({
			organizationName: 'Example, Inc.',
			commonName: 'Example SAML',
			localityName: 'New York, NY'
		});
		expect(parseSubject('')).toBeNull();
		expect(parseSubject('nonsense')).toBeNull();
	});

	it('keeps host names only, lower-cased and without duplicates', () => {
		expect(
			normalizeDnsNames([
				' SSO.Example.ac.jp ',
				'https://idp.example.org/saml/metadata',
				'sso.example.ac.jp',
				''
			])
		).toEqual(['sso.example.ac.jp', 'idp.example.org']);
		expect(parseDnsNamesInput('a.example, b.example  c.example')).toEqual([
			'a.example',
			'b.example',
			'c.example'
		]);
	});

	it('derives the generated DNS names from the role addresses', () => {
		expect(generatedDnsNames(mockSamlSettings(), 'idp')).toEqual(['acme.authrim.example']);
	});
});

describe('entity IDs', () => {
	it('shows the current ID for the current style and the role URL for the other', () => {
		const settings = mockSamlSettings();
		expect(entityIdForStyle(settings, 'idp', 'metadata_url')).toBe(settings.generated.idpEntityId);
		expect(entityIdForStyle(settings, 'sp', 'role_url')).toBe(
			'https://acme.authrim.example/saml/sp'
		);
	});
});

describe('dates and passphrases', () => {
	it('round-trips a datetime-local value', () => {
		const local = toDateTimeLocal(new Date(2026, 10, 19, 9, 30));
		expect(local).toBe('2026-11-19T09:30');
		expect(fromDateTimeLocal(local)).toBe(new Date(2026, 10, 19, 9, 30).toISOString());
		expect(fromDateTimeLocal('')).toBeUndefined();
		expect(toDateTimeLocal('nope')).toBe('');
	});

	it('refuses a short passphrase before a mismatch', () => {
		expect(passphraseProblem('short', 'other')).toBe('short');
		expect(passphraseProblem('long enough passphrase', 'different')).toBe('mismatch');
		expect(passphraseProblem('long enough passphrase', 'long enough passphrase')).toBeNull();
	});
});

describe('fake SAML settings', () => {
	it('moves the slots as the server does across a rollover', async () => {
		const client = createFakeSamlSettings();
		let settings = await client.localSigning({ role: 'sp', action: 'publish_next' });
		expect(signingPolicy(settings, 'sp').next).toBeDefined();
		expect(signingPolicy(settings, 'sp').metadataCertificatePublication).toBe('active_next');
		settings = await client.localSigning({ role: 'sp', action: 'promote_next' });
		const policy = signingPolicy(settings, 'sp');
		expect(policy.next).toBeUndefined();
		expect(policy.backup?.kid).toBe('key-202602010000-sp');
		expect(policy.metadataCertificatePublication).toBe('active_next_backup');
		settings = await client.localSigning({ role: 'sp', action: 'retire_backup' });
		expect(signingPolicy(settings, 'sp').backup).toBeUndefined();
		expect(signingPolicy(settings, 'sp').metadataCertificatePublication).toBe('active_only');
	});

	it('exports a bundle that only its own tenant and passphrase can import', async () => {
		const client = createFakeSamlSettings();
		await expect(client.exportDrBundle('short')).rejects.toMatchObject({ status: 400 });
		const bundle = await client.exportDrBundle('correct horse battery');
		// Characters outside Latin-1 survive the fake's encoding.
		await expect(client.exportDrBundle('正しい馬のバッテリー ステープル')).resolves.toMatchObject({
			tenantId: 'acme'
		});
		expect(bundle.tenantId).toBe('acme');
		await expect(client.importDrBundle(bundle, 'wrong passphrase!!')).rejects.toMatchObject({
			code: 'dr_bundle_decrypt_failed'
		});
		await expect(
			client.importDrBundle({ ...bundle, tenantId: 'other' }, 'correct horse battery')
		).rejects.toMatchObject({ code: 'dr_bundle_tenant_mismatch' });
		// The bundle also carries the publication settings of its time, as the real one does.
		await client.update({ entityIdStyle: 'role_url', interactiveLoginUrlPolicy: 'ui_base_url' });
		const restored = await client.importDrBundle(bundle, 'correct horse battery');
		expect(restored.localSigning?.idpSigningKeyPolicy.active?.kid).toBe('key-202511010000-idp');
		expect(restored.entityIdStyle).toBe('metadata_url');
		expect(restored.interactiveLoginUrlPolicy).toBe('tenant_host');
		expect(restored.generated.idpEntityId).toBe('https://acme.authrim.example/saml/idp/metadata');
	});

	it('changes the entity IDs with the style', async () => {
		const client = createFakeSamlSettings();
		const settings = await client.update({ entityIdStyle: 'role_url' });
		expect(settings.generated.idpEntityId).toBe('https://acme.authrim.example/saml/idp');
	});
});

describe('certificate fingerprints', () => {
	it('hashes the DER bytes of a PEM certificate', async () => {
		const pem = '-----BEGIN CERTIFICATE-----\nMAEC\nAw==\n-----END CERTIFICATE-----';
		expect([...derOfPem(pem)!]).toEqual([0x30, 1, 2, 3]);
		const prints = await certificateFingerprints(pem);
		// SHA-256 of 30 01 02 03.
		expect(prints?.sha256).toBe(
			'6A:35:4D:83:27:00:C1:AB:B0:63:13:2F:E1:C0:64:98:6E:15:FB:94:7C:A1:33:02:5E:99:49:15:34:35:0D:A6'
		);
		expect(prints?.sha1.split(':')).toHaveLength(20);
		expect(derOfPem('not a certificate')).toBeNull();
		expect(await certificateFingerprints('')).toBeNull();
	});
});
