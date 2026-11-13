import { describe, expect, it } from 'vitest';
import {
	createFakeConsentStatements,
	MOCK_CONSENT_STATEMENTS
} from '#lib/api/fake/consent-statements-fake.js';
import {
	consentEntries,
	consentLabel,
	consentSpecOf,
	consentValueOf,
	decodeConsent,
	encodeConsent,
	isChoosable,
	moveEntry
} from './consent-field-model';

describe('consent field value', () => {
	it('round-trips entries in order', () => {
		const spec = [
			{ statement_id: 'a', required: true },
			{ statement_id: 'b', required: false }
		];
		expect(consentValueOf(spec)).toEqual(['a:required', 'b:optional']);
		expect(consentSpecOf(consentValueOf(spec))).toEqual(spec);
	});

	it('keeps colons inside an id and drops unreadable entries', () => {
		expect(decodeConsent(encodeConsent({ statementId: 'x:y', required: true }))).toEqual({
			statementId: 'x:y',
			required: true
		});
		expect(consentEntries(['a:required', 'junk', ':required', 'b:maybe'])).toEqual([
			{ statementId: 'a', required: true }
		]);
		expect(consentEntries(undefined)).toEqual([]);
	});

	it('saves a statement once', () => {
		expect(consentSpecOf(['a:required', 'a:optional'])).toEqual([
			{ statement_id: 'a', required: true }
		]);
	});

	it('moves an entry and stays put at the ends', () => {
		expect(moveEntry([1, 2, 3], 1, -1)).toEqual([2, 1, 3]);
		expect(moveEntry([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
		expect(moveEntry([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
	});
});

describe('consent field choices', () => {
	it('chooses only active statements with a published version', async () => {
		const client = createFakeConsentStatements(MOCK_CONSENT_STATEMENTS);
		const items = await client.list();
		const choosable = items.filter(isChoosable).map((item) => item.statement.id);
		expect(choosable).toContain('stmt_terms');
		expect(choosable).toContain('stmt_privacy');
		expect(choosable).not.toContain('stmt_marketing');
		expect(choosable).not.toContain('stmt_survey');
	});

	it('names known statements and flags unknown ids', async () => {
		const items = await createFakeConsentStatements(MOCK_CONSENT_STATEMENTS).list();
		expect(consentLabel('stmt_terms', items, 'en')).toMatchObject({
			name: 'Terms of service',
			known: true,
			choosable: true
		});
		expect(consentLabel('gone', items, 'en')).toEqual({
			name: 'gone',
			known: false,
			choosable: false
		});
	});
});
