import { describe, expect, it } from 'vitest';
import { readReauthEmail } from './reauth-email';

describe('the address typed for a re-authentication by email code', () => {
	it('takes a trimmed address', () => {
		expect(readReauthEmail('  ada@example.com ')).toEqual({ ok: true, email: 'ada@example.com' });
	});

	it('asks for an address when none is typed', () => {
		expect(readReauthEmail('   ')).toEqual({ ok: false, reason: 'required' });
	});

	it('refuses what is not an address', () => {
		expect(readReauthEmail('ada')).toEqual({ ok: false, reason: 'invalid' });
		expect(readReauthEmail('ada@example')).toEqual({ ok: false, reason: 'invalid' });
	});
});
