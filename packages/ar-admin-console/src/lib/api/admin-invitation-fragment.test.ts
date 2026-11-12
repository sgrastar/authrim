import { describe, expect, it } from 'vitest';
import { readJoinFragment } from './admin-invitation-enrollment.js';

describe('the join link fragment', () => {
	it('reads the code and the e-mail address from the fragment', () => {
		expect(readJoinFragment('#code=ABCD-EFGH-JKLM-NPQR&email=new%40example.com')).toEqual({
			code: 'ABCD-EFGH-JKLM-NPQR',
			email: 'new@example.com'
		});
	});

	it('reads only what is there, and nothing from a link without either', () => {
		expect(readJoinFragment('#email=a%40example.com')).toEqual({ email: 'a@example.com' });
		expect(readJoinFragment('')).toBeNull();
		expect(readJoinFragment('#section')).toBeNull();
	});

	it('does not take a query string for a fragment', () => {
		// The page passes `location.hash`, so a `?code=` in the query is never offered here; and a
		// string without the leading `#` is not a fragment at all.
		expect(readJoinFragment('?code=ABCD&email=a%40example.com')).toBeNull();
	});

	it('ignores empty and oversized values', () => {
		expect(readJoinFragment('#code=&email=')).toBeNull();
		expect(readJoinFragment(`#email=${'a'.repeat(400)}`)).toBeNull();
	});
});
