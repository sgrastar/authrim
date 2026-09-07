export type PasskeyRegistrationErrorKind =
	| 'cancelled-or-timed-out'
	| 'already-registered'
	| 'interrupted'
	| 'authenticator-unsupported'
	| 'authenticator-unavailable'
	| 'configuration'
	| 'failed';

const UNSUPPORTED_CODES = new Set([
	'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT',
	'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT',
	'ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG',
	'ERROR_AUTO_REGISTER_USER_VERIFICATION_FAILURE'
]);

const CONFIGURATION_CODES = new Set([
	'ERROR_INVALID_DOMAIN',
	'ERROR_INVALID_RP_ID',
	'ERROR_INVALID_USER_ID_LENGTH',
	'ERROR_MALFORMED_PUBKEYCREDPARAMS'
]);

function stringProperty(value: unknown, property: 'name' | 'code'): string {
	if (!value || typeof value !== 'object') return '';
	const candidate = Reflect.get(value, property);
	return typeof candidate === 'string' ? candidate : '';
}

function errorName(error: unknown): string {
	const directName = stringProperty(error, 'name');
	if (directName) return directName;
	if (!error || typeof error !== 'object') return '';
	return stringProperty(Reflect.get(error, 'cause'), 'name');
}

/**
 * Classify browser and SimpleWebAuthn registration failures without displaying their
 * browser-generated messages. Browsers intentionally group cancellation and timeout under
 * NotAllowedError, so those two outcomes cannot be separated reliably.
 */
export function classifyPasskeyRegistrationError(error: unknown): PasskeyRegistrationErrorKind {
	const code = stringProperty(error, 'code');
	const name = errorName(error);

	if (code === 'ERROR_CEREMONY_ABORTED' || name === 'AbortError') return 'interrupted';
	if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || name === 'InvalidStateError') {
		return 'already-registered';
	}
	if (name === 'NotAllowedError') return 'cancelled-or-timed-out';
	if (UNSUPPORTED_CODES.has(code) || name === 'ConstraintError' || name === 'NotSupportedError') {
		return 'authenticator-unsupported';
	}
	if (CONFIGURATION_CODES.has(code) || name === 'SecurityError' || name === 'TypeError') {
		return 'configuration';
	}
	if (code === 'ERROR_AUTHENTICATOR_GENERAL_ERROR' || name === 'NotReadableError') {
		return 'authenticator-unavailable';
	}
	return 'failed';
}
