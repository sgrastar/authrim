import { describe, expect, it } from 'vitest';
import { i18nObject } from '$i18n/i18n-util';
import { loadAllLocales } from '$i18n/i18n-util.sync';
import {
	formatReleaseValue,
	releaseClaimLabel,
	releaseDefaultChecked,
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
