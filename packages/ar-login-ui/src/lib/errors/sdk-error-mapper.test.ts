import { describe, expect, it } from 'vitest';
import { messageForApiError } from './sdk-error-mapper';

const messages = {
	unknown: () => 'unknown',
	invalidRequest: () => 'invalid request',
	accessDenied: () => 'access denied',
	serverError: () => 'server error',
	loginRequired: () => 'login required',
	emailCodeInvalid: () => 'invalid code'
};

describe('messageForApiError', () => {
	it('maps OAuth and SDK errors to LoginUI messages', () => {
		expect(
			messageForApiError(
				{ error: 'invalid_request', error_description: 'raw invalid request' },
				messages
			)
		).toBe('invalid request');
		expect(
			messageForApiError(
				{ error: 'token_binding_failed', error_description: 'raw token binding detail' },
				messages
			)
		).toBe('invalid code');
		expect(
			messageForApiError({ error: 'login_required', error_description: 'raw login' }, messages)
		).toBe('login required');
	});

	it('falls back to server description only for unknown errors', () => {
		expect(
			messageForApiError({ error: 'custom_error', error_description: 'Custom failure' }, messages)
		).toBe('Custom failure');
		expect(messageForApiError(undefined, messages)).toBe('unknown');
	});
});
