import { describe, expect, it } from 'vitest';
import {
	buildTotpDeleteProof,
	isTotpDeleteProofReady,
	normalizeTotpBackupCodeInput
} from '../totp-proof';

describe('TOTP account proof helpers', () => {
	it('sends 6 and 8 digit values as current TOTP codes', () => {
		expect(buildTotpDeleteProof(' 123456 ')).toEqual({ code: '123456' });
		expect(buildTotpDeleteProof('12345678')).toEqual({ code: '12345678' });
		expect(isTotpDeleteProofReady('123456')).toBe(true);
		expect(isTotpDeleteProofReady('12345678')).toBe(true);
	});

	it('accepts formatted backup codes for destructive TOTP operations', () => {
		expect(normalizeTotpBackupCodeInput('abcd-efgh-2345')).toBe('ABCDEFGH2345');
		expect(isTotpDeleteProofReady('abcd-efgh-2345')).toBe(true);
		expect(buildTotpDeleteProof(' abcd-efgh-2345 ')).toEqual({
			backup_code: 'abcd-efgh-2345'
		});
	});

	it('rejects incomplete delete proofs', () => {
		expect(isTotpDeleteProofReady('12345')).toBe(false);
		expect(isTotpDeleteProofReady('abcd-efgh')).toBe(false);
		expect(buildTotpDeleteProof('   ')).toEqual({});
	});
});
