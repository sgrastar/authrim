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

	it('exposes actionable invalid_request details for direct session and authorization challenge failures', () => {
		expect(
			messageForApiError(
				{
					error: 'invalid_request',
					error_description: 'Missing required fields: direct_auth_artifact',
					error_details: { code: 'DIRECT_SESSION_REQUIRED_FIELDS_MISSING' }
				},
				messages
			)
		).toBe('Missing required fields: direct_auth_artifact');
		expect(
			messageForApiError(
				{
					error: 'invalid_request',
					error_description: 'Authorization challenge is invalid or expired'
				},
				messages
			)
		).toBe('Authorization challenge is invalid or expired');
	});

	it('falls back to server description only for unknown errors', () => {
		expect(
			messageForApiError({ error: 'custom_error', error_description: 'Custom failure' }, messages)
		).toBe('Custom failure');
		expect(messageForApiError(undefined, messages)).toBe('unknown');
	});
});
