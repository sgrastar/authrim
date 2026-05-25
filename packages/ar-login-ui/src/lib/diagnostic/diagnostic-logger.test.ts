import { describe, expect, it } from 'vitest';
import { DiagnosticLogger } from './diagnostic-logger';

describe('DiagnosticLogger', () => {
	it('records SDK-compatible auth decision events with sensitive values redacted', () => {
		const logger = new DiagnosticLogger({
			enabled: true,
			sessionId: 'diag-session'
		});

		logger.logAuthDecision({
			decision: 'deny',
			reason: 'token_binding_failed',
			flow: 'direct',
			context: {
				status: 401,
				access_token: 'secret-access-token',
				nested: {
					refresh_token: 'secret-refresh-token',
					Authorization: 'DPoP secret'
				}
			}
		});

		expect(logger.getLogs()).toEqual([
			expect.objectContaining({
				category: 'auth-decision',
				decision: 'deny',
				reason: 'token_binding_failed',
				flow: 'direct',
				context: {
					status: 401,
					access_token: '[REDACTED]',
					nested: {
						refresh_token: '[REDACTED]',
						Authorization: '[REDACTED]'
					}
				}
			})
		]);
	});
});
