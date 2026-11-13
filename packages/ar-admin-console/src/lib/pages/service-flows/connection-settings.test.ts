import { describe, expect, it } from 'vitest';
import { canActivate, sampleAnswers, stillToDo } from './connection-model';
import {
	applyProfile,
	emptySettings,
	grantAllowed,
	settingsFromImport,
	SETTINGS_FIELDS,
	SETTINGS_PARTS,
	settingsChanged,
	settingsState,
	testBasis
} from './connection-settings';

describe('connection settings', () => {
	it('start done: nothing is required with the defaults', () => {
		const s = emptySettings();
		for (const part of ['rp-grants', 'rp-security', 'sp-encryption', 'idp-assertion'])
			expect(settingsState(part, s, 'web')).toBe('done');
	});

	it('a pairwise subject needs an https sector address', () => {
		const s = emptySettings();
		s.rp.subjectType = 'pairwise';
		expect(settingsState('rp-security', s, 'web')).toBe('required');
		s.rp.sectorUri = 'http://insecure.example';
		expect(settingsState('rp-security', s, 'web')).toBe('required');
		s.rp.sectorUri = 'https://app.example/sector.json';
		expect(settingsState('rp-security', s, 'web')).toBe('done');
	});

	it('client credentials only for an app that can keep a secret', () => {
		expect(grantAllowed('client_credentials', 'web')).toBe(true);
		expect(grantAllowed('client_credentials', 'spa')).toBe(false);
		const s = emptySettings();
		s.rp.grantTypes = ['authorization_code', 'client_credentials'];
		expect(settingsState('rp-grants', s, 'native')).toBe('required');
		s.rp.grantTypes = [];
		expect(settingsState('rp-grants', s, 'web')).toBe('required');
		// Allowed while it was a web app, then the app type changed: it has to be put right.
		s.rp.clientCredentials = true;
		expect(settingsState('rp-exchange', s, 'web')).toBe('done');
		expect(settingsState('rp-exchange', s, 'spa')).toBe('required');
	});

	it('encryption needs the service certificate', () => {
		const s = emptySettings();
		s.sp.encryptNameId = true;
		expect(settingsState('sp-encryption', s, 'web')).toBe('required');
		s.sp.encryptionCert = '-----BEGIN CERTIFICATE-----';
		expect(settingsState('sp-encryption', s, 'web')).toBe('done');
	});

	it('a profile sets signing and checking', () => {
		const s = emptySettings();
		applyProfile(s.sp, 'strict');
		expect(s.sp).toMatchObject({
			profile: 'strict',
			signAssertions: true,
			authnRequestSignature: 'required'
		});
		applyProfile(s.sp, 'legacy');
		expect(s.sp.logoutRequestSignature).toBe('optional');
	});

	it('an IdP needs a certificate in use that has not expired', () => {
		const s = emptySettings();
		expect(settingsState('idp-certs', s, 'web')).toBe('required');
		settingsFromImport(s, 'manual');
		expect(s.idp.certificates).toHaveLength(0);
		settingsFromImport(s, 'url');
		expect(settingsState('idp-certs', s, 'web')).toBe('done');
		s.idp.certificates = s.idp.certificates.map((c) => ({ ...c, daysLeft: -1 }));
		expect(settingsState('idp-certs', s, 'web')).toBe('required');
	});

	it('a blank authentication context does not count', () => {
		const s = emptySettings();
		s.idp.authnContextMode = 'require_any';
		s.idp.authnContexts = ['  '];
		expect(settingsState('idp-assertion', s, 'web')).toBe('required');
		s.idp.authnContexts = ['urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport'];
		expect(settingsState('idp-assertion', s, 'web')).toBe('done');
	});

	it('a SAML partner needs at least one binding', () => {
		const s = emptySettings();
		s.sp.bindings = [];
		s.idp.bindings = [];
		expect(settingsState('sp-endpoints', s, 'web')).toBe('required');
		expect(settingsState('idp-endpoints', s, 'web')).toBe('required');
		const lists = emptySettings();
		lists.rp.postLogoutUris = ['https://app.example/*'];
		lists.rp.webOrigins = ['http://app.example'];
		lists.sp.acsUrls = [''];
		expect(settingsState('rp-logout', lists, 'web')).toBe('required');
		expect(settingsState('rp-security', lists, 'web')).toBe('required');
		expect(settingsState('sp-endpoints', lists, 'web')).toBe('required');
	});

	it('an OAuth 2.0 provider is ready with its own endpoints, without discovery', () => {
		const a = sampleAnswers('op', 'wizard');
		a.op.clientId = 'authrim';
		a.op.clientSecret = 'secret';
		a.settings.op.protocol = 'oauth2';
		// The missing addresses are asked where they are entered, not in the provider's details.
		// (The mapping is still required too; this is about where the addresses are asked.)
		const ids = () => stillToDo(a).map((p) => p.id);
		expect(ids()).toContain('op-endpoints');
		expect(ids()).not.toContain('op-details');
		a.settings.op.authorizationEndpoint = 'https://github.example/login/oauth/authorize';
		a.settings.op.tokenEndpoint = 'https://github.example/login/oauth/access_token';
		expect(ids()).not.toContain('op-endpoints');
		expect(ids()).toContain('op-test');
	});

	it('an address that is not https makes its setting required', () => {
		const s = emptySettings();
		s.rp.backchannelUri = 'http://app.example/logout';
		s.op.tokenEndpoint = 'http://insecure.example/token';
		s.idp.ssoUrl = 'http://idp.example/sso';
		expect(settingsState('rp-logout', s, 'web')).toBe('required');
		expect(settingsState('op-endpoints', s, 'web')).toBe('required');
		expect(settingsState('idp-endpoints', s, 'web')).toBe('required');
	});

	it('a FAPI 2.0 provider needs no client secret', () => {
		const a = sampleAnswers('op');
		a.op.clientSecret = '';
		expect(stillToDo(a).map((p) => p.id)).toContain('op-details');
		a.settings.op.fapi2 = true;
		expect(stillToDo(a).map((p) => p.id)).not.toContain('op-details');
	});

	it('a required setting is on the to-do list and holds back activation', () => {
		const a = sampleAnswers('idp');
		expect(canActivate(a)).toBe(true);
		a.settings.idp.authnContextMode = 'require_any';
		expect(stillToDo(a).map((p) => p.id)).toContain('idp-assertion');
		expect(canActivate(a)).toBe(false);
	});
});

describe('what a test runs against', () => {
	it('changes with the settings and with who the service is, not with display-only ones', () => {
		const a = sampleAnswers('sp', 'complete');
		const before = testBasis(a);
		a.settings.op.buttonText = 'Sign in with Acme';
		expect(testBasis(a)).toBe(before);
		a.sp.acsUrl = 'https://hr.example/saml/acs/other';
		expect(testBasis(a)).not.toBe(before);
		const b = sampleAnswers('sp', 'complete');
		b.settings.sp.signAssertions = !b.settings.sp.signAssertions;
		expect(testBasis(b)).not.toBe(before);
		const c = sampleAnswers('sp', 'complete');
		c.sp.minAuth = c.sp.minAuth === 'aal2' ? 'none' : 'aal2';
		expect(testBasis(c)).not.toBe(before);
		const op = sampleAnswers('op', 'complete');
		const opBefore = testBasis(op);
		op.op.clientSecret = 'another-secret';
		expect(testBasis(op)).not.toBe(opBefore);
	});
});

describe('the change mark of a closed section', () => {
	it('names only values the settings have, for every section', () => {
		const s = emptySettings();
		for (const [kind, parts] of Object.entries(SETTINGS_PARTS))
			for (const part of parts) {
				const fields = SETTINGS_FIELDS[part];
				expect(fields, part).toBeDefined();
				for (const field of fields)
					expect(Object.keys(s[kind as keyof typeof s]), `${part} ${field}`).toContain(field);
			}
	});

	it('follows a change of a value in that section only', () => {
		const saved = emptySettings();
		const now = emptySettings();
		now.sp.signAssertions = !now.sp.signAssertions;
		expect(settingsChanged('sp-signing', now, saved)).toBe(true);
		expect(settingsChanged('sp-assertion', now, saved)).toBe(false);
	});

	it('follows overriding a default, though the value shown stays the same', () => {
		const saved = emptySettings();
		const now = emptySettings();
		now.sp.overridden = ['minimumAal'];
		expect(settingsChanged('sp-assertion', now, saved)).toBe(true);
		expect(settingsChanged('sp-encryption', now, saved)).toBe(false);
	});
});
