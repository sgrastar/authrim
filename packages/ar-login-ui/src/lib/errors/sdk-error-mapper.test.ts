import { describe, expect, it } from 'vitest';
import { messageForApiError, messageForRateLimitError } from './sdk-error-mapper';

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
		// The authorization request is gone: said as that, with its own message when there is one.
		expect(
			messageForApiError(
				{ error: 'authorization_request_expired', error_description: 'raw' },
				{ ...messages, requestExpired: () => 'request expired' }
			)
		).toBe('request expired');
		expect(
			messageForApiError(
				{ error: 'authorization_request_expired', error_description: 'raw' },
				messages
			)
		).toBe('invalid request');
		// A Flow completion submitted before anyone has signed in.
		expect(
			messageForApiError(
				{ error: 'authentication_required', error_description: 'raw sign in' },
				messages
			)
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
			messageForApiError({ error: 'invalid_client', error_description: 'unknown client' }, messages)
		).toBe('unauthorized client');
		expect(
			messageForApiError(
				{ error: 'configuration_error', error_description: 'missing client setting' },
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

	describe('rate-limit errors', () => {
		const withRateLimited = {
			...messages,
			rateLimited: (minutes: number | null) =>
				minutes === null ? 'too many attempts' : `too many attempts, wait ${minutes} min`
		};

		it.each(['slow_down', 'rate_limit_exceeded', 'rate_limited', 'too_many_requests'])(
			'tells the user to wait for %s',
			(code) => {
				expect(messageForApiError({ error: code, error_description: 'raw' }, withRateLimited)).toBe(
					'too many attempts'
				);
			}
		);

		it.each([
			[42, 'too many attempts, wait 1 min'],
			[60, 'too many attempts, wait 1 min'],
			[61, 'too many attempts, wait 2 min'],
			[900, 'too many attempts, wait 15 min']
		])('says how long to wait for retry_after %j', (retryAfter, expected) => {
			expect(
				messageForApiError(
					{ error: 'slow_down', error_description: 'raw', retry_after: retryAfter },
					withRateLimited
				)
			).toBe(expected);
		});

		it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, 90_000, '60'])(
			'leaves the wait out for retry_after %j',
			(retryAfter) => {
				expect(
					messageForApiError(
						{
							error: 'slow_down',
							error_description: 'raw',
							retry_after: retryAfter as number
						},
						withRateLimited
					)
				).toBe('too many attempts');
			}
		);

		it('keeps the unknown message on screens without a rate-limit message', () => {
			expect(messageForApiError({ error: 'slow_down', error_description: 'raw' }, messages)).toBe(
				'unknown'
			);
		});

		it('gives nothing for other errors, for screens with their own message', () => {
			const rateLimited = () => 'too many attempts';
			expect(
				messageForRateLimitError(
					{ error: 'invalid_request', error_description: 'raw' },
					rateLimited
				)
			).toBeNull();
			expect(messageForRateLimitError(undefined, rateLimited)).toBeNull();
			expect(
				messageForRateLimitError({ error: 'slow_down', error_description: 'raw' }, rateLimited)
			).toBe('too many attempts');
		});
	});
});
