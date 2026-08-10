import { describe, expect, it } from 'vitest';
import { classifyPasskeyRegistrationError } from './passkey-registration-error';

function namedError(name: string): Error {
	const error = new Error('Browser-generated detail must not be displayed');
	error.name = name;
	return error;
}

describe('classifyPasskeyRegistrationError', () => {
	it.each([
		['NotAllowedError', 'cancelled-or-timed-out'],
		['InvalidStateError', 'already-registered'],
		['AbortError', 'interrupted'],
		['ConstraintError', 'authenticator-unsupported'],
		['NotSupportedError', 'authenticator-unsupported'],
		['NotReadableError', 'authenticator-unavailable'],
		['SecurityError', 'configuration'],
		['TypeError', 'configuration'],
		['UnknownError', 'failed']
	] as const)('maps %s to %s', (name, expected) => {
		expect(classifyPasskeyRegistrationError(namedError(name))).toBe(expected);
	});

	it.each([
		['ERROR_CEREMONY_ABORTED', 'interrupted'],
		['ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED', 'already-registered'],
		['ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT', 'authenticator-unsupported'],
		['ERROR_AUTHENTICATOR_GENERAL_ERROR', 'authenticator-unavailable'],
		['ERROR_INVALID_RP_ID', 'configuration']
	] as const)('uses the SimpleWebAuthn code %s', (code, expected) => {
		expect(classifyPasskeyRegistrationError({ code, name: 'Error' })).toBe(expected);
	});

	it('falls back without exposing arbitrary exception details', () => {
		expect(classifyPasskeyRegistrationError(new Error('private implementation detail'))).toBe(
			'failed'
		);
	});
});
