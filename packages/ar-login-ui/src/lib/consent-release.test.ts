import { describe, expect, it } from 'vitest';
import { i18nObject } from '$i18n/i18n-util';
import { loadAllLocales } from '$i18n/i18n-util.sync';
import {
	accountReleaseRows,
	formatReleaseValue,
	recordedReleaseItemLabel,
	releaseClaimLabel,
	releaseDefaultChecked,
	releaseItemLabel,
	releaseSelectedNames
} from './consent-release';

loadAllLocales();

describe('releaseClaimLabel', () => {
	it('labels the standard claims in the page language', () => {
		expect(releaseClaimLabel(i18nObject('en'), 'email')).toBe('Email address');
		expect(releaseClaimLabel(i18nObject('en'), 'family_name')).toBe('Last name');
		expect(releaseClaimLabel(i18nObject('ja'), 'email')).toBe('メールアドレス');
		expect(releaseClaimLabel(i18nObject('ja'), 'birthdate')).toBe('生年月日');
	});

	it('shows any other claim, even one named like an object property, by its name', () => {
		expect(releaseClaimLabel(i18nObject('en'), 'employee_number')).toBe('employee_number');
		expect(releaseClaimLabel(i18nObject('en'), 'constructor')).toBe('constructor');
		expect(releaseClaimLabel(i18nObject('en'), '__proto__')).toBe('__proto__');
	});
});

describe('formatReleaseValue', () => {
	it('writes values compactly as text', () => {
		expect(formatReleaseValue('Ada')).toBe('Ada');
		expect(formatReleaseValue(true)).toBe('true');
		expect(formatReleaseValue(42)).toBe('42');
		expect(formatReleaseValue(['a', 'b'])).toBe('a, b');
		expect(formatReleaseValue({ locality: 'Tokyo', country: 'JP' })).toBe(
			'locality: Tokyo; country: JP'
		);
	});

	it('returns null when there is nothing to show', () => {
		expect(formatReleaseValue(undefined)).toBeNull();
		expect(formatReleaseValue(null)).toBeNull();
		expect(formatReleaseValue('')).toBeNull();
		expect(formatReleaseValue([])).toBeNull();
	});

	it('keeps markup as plain text and cuts long values', () => {
		expect(formatReleaseValue('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
		const cut = formatReleaseValue('x'.repeat(1000))!;
		expect(cut.length).toBeLessThan(400);
		expect(cut.endsWith('…')).toBe(true);
	});
});

describe('optional items', () => {
	const release = {
		items: [
			{ name: 'sub', required: true },
			{ name: 'email', required: false, previously_approved: true },
			{ name: 'phone_number', required: false, previously_approved: false },
			{ name: 'birthdate', required: false }
		]
	};

	it('start checked only when approved last time', () => {
		expect(releaseDefaultChecked({ previously_approved: true })).toBe(true);
		expect(releaseDefaultChecked({ previously_approved: false })).toBe(false);
		expect(releaseDefaultChecked({})).toBe(false);
	});

	it('send the optional names still checked, never the required ones', () => {
		expect(releaseSelectedNames(release, {})).toEqual(['email']);
		expect(releaseSelectedNames(release, { email: false, birthdate: true })).toEqual(['birthdate']);
		expect(releaseSelectedNames(release, { sub: false })).toEqual(['email']);
	});
});

describe('accountReleaseRows', () => {
	const LL = i18nObject('en');

	it('lists what the user approved and declined, by label', () => {
		expect(
			accountReleaseRows(LL, {
				basis: 'user',
				approved: ['email', 'custom_claim'],
				declined: ['picture'],
				decidedAt: 1
			})
		).toEqual([
			{ label: 'Information provided', value: 'Email address, custom_claim' },
			{ label: 'Not provided', value: LL.consent_claim_picture() }
		]);
	});

	it('says "none" when the user approved nothing, and leaves out an empty declined row', () => {
		expect(
			accountReleaseRows(LL, { basis: 'user', approved: [], declined: [], decidedAt: 1 })
		).toEqual([{ label: 'Information provided', value: 'None' }]);
	});

	it('says how it was decided for the user, and when nothing was decided', () => {
		expect(accountReleaseRows(LL, { basis: 'trust' })[0].value).toBe(
			LL.account_consentInformationTrusted()
		);
		expect(accountReleaseRows(LL, { basis: 'not_asked' })[0].value).toBe(
			LL.account_consentInformationRequiredOnly()
		);
		// Made by a policy that no longer decides: still shown, with the next sign-in asking.
		expect(accountReleaseRows(LL, { basis: 'trust', superseded: true })[0].value).toBe(
			`${LL.account_consentInformationTrusted()} ${LL.account_consentInformationSuperseded()}`
		);
		for (const value of [undefined, null, 'user', { basis: 'other' }]) {
			expect(accountReleaseRows(LL, value)).toEqual([
				{ label: 'Information provided', value: LL.account_consentInformationNotRecorded() }
			]);
		}
	});

	it('ignores names that are not strings', () => {
		expect(
			accountReleaseRows(LL, { basis: 'user', approved: ['email', 3, null, ''], declined: 'x' })
		).toEqual([{ label: 'Information provided', value: 'Email address' }]);
	});
});

describe('releaseItemLabel', () => {
	it("uses a SAML attribute's own label and names the NameID by what it is", () => {
		const en = i18nObject('en');
		expect(releaseItemLabel(en, { name: 'k', kind: 'attribute', label: 'Affiliation' })).toBe(
			'Affiliation'
		);
		expect(
			releaseItemLabel(en, {
				name: 'k',
				kind: 'nameid',
				label: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'
			})
		).toBe(en.consent_release_saml_nameid_email());
		expect(
			releaseItemLabel(en, {
				name: 'k',
				kind: 'nameid',
				label: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'
			})
		).toBe(en.consent_release_saml_nameid());
		expect(releaseItemLabel(en, { name: 'email' })).toBe('Email address');
	});

	it('names a recorded SAML item key by its attribute name', () => {
		const en = i18nObject('en');
		expect(recordedReleaseItemLabel(en, '["attribute","mail",null]')).toBe('mail');
		expect(recordedReleaseItemLabel(en, 'email')).toBe('Email address');
		expect(recordedReleaseItemLabel(en, '[not json')).toBe('[not json');
	});

	it('shows a refused SAML SP as refused on the account page', () => {
		const en = i18nObject('en');
		expect(
			accountReleaseRows(en, {
				basis: 'user',
				approved: [],
				declined: [],
				decidedAt: 1,
				refused: true
			})
		).toEqual([
			{
				label: en.account_consentInformationRelease(),
				value: en.account_consentInformationRefused()
			}
		]);
	});
});
