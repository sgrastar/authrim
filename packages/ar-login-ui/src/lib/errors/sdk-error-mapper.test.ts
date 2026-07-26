import { describe, expect, it } from 'vitest';
import { messageForApiError } from './sdk-error-mapper';

const messages = {
	unknown: () => 'unknown',
	invalidRequest: () => 'invalid request',
	accessDenied: () => 'access denied',
	unauthorizedClient: () => 'unauthorized client',
	unsupportedResponseType: () => 'unsupported response type',
	invalidScope: () => 'invalid scope',
	serverError: () => 'server error',
	temporarilyUnavailable: () => 'temporarily unavailable',
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
		).toBe('invalid request');
		expect(
			messageForApiError({ error: 'login_required', error_description: 'raw login' }, messages)
		).toBe('login required');
	});

	it('maps standard OAuth errors without exposing their descriptions', () => {
		expect(
			messageForApiError(
				{ error: 'unauthorized_client', error_description: 'raw client details' },
				messages
			)
		).toBe('unauthorized client');
		expect(
			messageForApiError(
				{ error: 'unsupported_response_type', error_description: 'raw response details' },
				messages
			)
		).toBe('unsupported response type');
		expect(
			messageForApiError(
				{ error: 'invalid_scope', error_description: 'raw scope details' },
				messages
			)
		).toBe('invalid scope');
		expect(
			messageForApiError(
				{ error: 'temporarily_unavailable', error_description: 'raw outage details' },
				messages
			)
		).toBe('temporarily unavailable');
	});

	it('does not expose untranslated invalid_request details', () => {
		expect(
			messageForApiError(
				{
					error: 'invalid_request',
					error_description: 'Missing required fields: direct_auth_artifact',
					error_details: { code: 'DIRECT_SESSION_REQUIRED_FIELDS_MISSING' }
				},
				messages
			)
		).toBe('invalid request');
		expect(
			messageForApiError(
				{
					error: 'invalid_request',
					error_description: 'Authorization challenge is invalid or expired'
				},
				messages
			)
		).toBe('invalid request');
	});

	it('uses the localized fallback for unknown errors', () => {
		expect(
			messageForApiError({ error: 'custom_error', error_description: 'Custom failure' }, messages)
		).toBe('unknown');
		expect(messageForApiError(undefined, messages)).toBe('unknown');
	});
});
