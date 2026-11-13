import { describe, expect, it } from 'vitest';
import type { ConsentStatement } from '#lib/api/consent-statements.js';
import {
	categoryKind,
	categoryOfKind,
	editorValue,
	isValidVersion,
	languageProblems,
	localizationInput,
	plainText,
	statementChange,
	statementName,
	statementStatus,
	todayVersion,
	versionLabel
} from './statement-model';

const statement: ConsentStatement = {
	id: 's1',
	slug: 'terms',
	category: 'saml_attribute_release',
	legal_basis: 'consent',
	processing_purpose: null,
	display_order: 0,
	is_active: true,
	record_retention_days: null,
	withdrawal_allowed: true,
	withdrawal_impact: null,
	required_consent_version: null,
	reconsent_interval_days: null,
	retired_at: null,
	created_at: 0,
	updated_at: 0
};

describe('categories', () => {
	it('shows only terms and privacy by name', () => {
		expect(categoryKind('terms_of_service')).toBe('terms');
		expect(categoryKind('privacy_policy')).toBe('privacy');
		expect(categoryKind('user_data_release')).toBe('other');
	});

	it('keeps an unknown category when "other" stays chosen', () => {
		expect(categoryOfKind('other', 'saml_attribute_release')).toBe('saml_attribute_release');
		expect(categoryOfKind('other', 'terms_of_service')).toBe('custom');
		expect(categoryOfKind('privacy')).toBe('privacy_policy');
	});
});

describe('names and status', () => {
	it('prefers the admin language, then others, then the key', () => {
		expect(statementName({ ja: '規約', en: 'Terms' }, 'en', 'k')).toBe('Terms');
		expect(statementName({ ja: '規約' }, 'de', 'k')).toBe('規約');
		expect(statementName({ fr: 'Conditions' }, 'de', 'k')).toBe('Conditions');
		expect(statementName({}, 'de', 'k')).toBe('k');
	});

	it('is draft only without a current version, and off when retired', () => {
		expect(statementStatus(statement, null)).toBe('draftOnly');
		expect(statementStatus({ ...statement, is_active: false }, null)).toBe('draftOnly');
		const current = { is_current: true } as never;
		expect(statementStatus(statement, current)).toBe('active');
		expect(statementStatus({ ...statement, is_active: false }, current)).toBe('inactive');
		expect(statementStatus({ ...statement, retired_at: 1 }, current)).toBe('inactive');
	});
});

describe('versions', () => {
	it('writes today as eight digits', () => {
		expect(todayVersion(new Date(2026, 10, 3))).toBe('20261103');
	});

	it('accepts only real dates', () => {
		expect(isValidVersion('20261101')).toBe(true);
		expect(isValidVersion('20261301')).toBe(false);
		expect(isValidVersion('20260230')).toBe(false);
		expect(isValidVersion('2026-11-01')).toBe(false);
	});

	it('reads a version as a date', () => {
		expect(versionLabel('20261101')).toBe('2026-11-01');
	});
});

describe('texts', () => {
	const value = { title: ' T ', description: 'D', content: 'body', url: 'https://x.test/p' };

	it('needs a title and a summary, and a link that is a link', () => {
		expect(languageProblems({ ...value, title: '', description: '' }, 'inline')).toEqual([
			'title',
			'description'
		]);
		expect(languageProblems({ ...value, url: 'ftp://x' }, 'url')).toEqual(['url']);
		expect(languageProblems({ ...value, url: '' }, 'url')).toEqual([]);
	});

	it('needs the text or link to publish', () => {
		expect(languageProblems({ ...value, content: '' }, 'inline', true)).toEqual(['content']);
		expect(languageProblems({ ...value, url: '' }, 'url', true)).toEqual(['url']);
	});

	it('sends only what the content type uses', () => {
		expect(localizationInput(value, 'inline')).toEqual({
			title: 'T',
			description: 'D',
			processing_purpose: null,
			withdrawal_impact: null,
			document_url: null,
			inline_content: 'body'
		});
		// Texts the page does not edit go back as they were (a PUT clears what it leaves out).
		expect(
			localizationInput(
				{ ...value, processingPurpose: 'Marketing', withdrawalImpact: 'No newsletter' },
				'inline'
			)
		).toMatchObject({ processing_purpose: 'Marketing', withdrawal_impact: 'No newsletter' });
		expect(localizationInput(value, 'url').inline_content).toBeNull();
		expect(localizationInput(value, 'url').document_url).toBe('https://x.test/p');
	});

	it('shows old HTML as text', () => {
		expect(plainText('<p>One &amp; two</p><p>Three</p>')).toBe('One & two\nThree');
	});
});

describe('statementChange', () => {
	it('lists only what changed', () => {
		const saved = editorValue(statement, null, []);
		expect(statementChange(saved, saved, statement)).toEqual({});
		const next = {
			...saved,
			category: 'privacy' as const,
			withdrawalImpact: ' x ',
			retentionDays: 30
		};
		expect(statementChange(next, saved, statement)).toEqual({
			category: 'privacy_policy',
			withdrawal_impact: 'x',
			record_retention_days: 30
		});
	});
});
