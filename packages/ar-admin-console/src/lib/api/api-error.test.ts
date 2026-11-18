import { describe, expect, it } from 'vitest';
import { ConflictError, ReleasePausedError, errorFromResponse } from './api-error';

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	errorFromResponse(
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json', ...headers }
		})
	);

describe('errorFromResponse', () => {
	it('treats a disabled capability as forbidden, with the API message', async () => {
		const error = await respond(403, {
			error: 'capability_disabled',
			error_description: 'This capability has been turned off for tenants by the platform.',
			capability: 'webhooks'
		});
		expect(error.forbidden).toBe(true);
		expect(error.capabilityDisabled).toBe(true);
		expect(error.code).toBe('capability_disabled');
		expect(error.message).toContain('turned off');
		expect(error.body.capability).toBe('webhooks');
	});

	it('does not read an ordinary refusal as a disabled capability', async () => {
		const error = await respond(403, { error: 'insufficient_permissions' });
		expect(error.forbidden).toBe(true);
		expect(error.capabilityDisabled).toBe(false);
	});

	it('does not read a 503 as forbidden', async () => {
		const error = await respond(503, { error: 'temporarily_unavailable' });
		expect(error.forbidden).toBe(false);
		expect(error.capabilityDisabled).toBe(false);
	});

	it('reads a change refused while a release is verified as paused, not as a conflict', async () => {
		const error = await respond(
			409,
			{
				error: 'ADMIN_MUTATION_PAUSED_FOR_RELEASE',
				operationId: 'op-1',
				targetVersion: '0.6.0',
				phase: 'verifying'
			},
			{ 'retry-after': '5' }
		);
		expect(error).toBeInstanceOf(ReleasePausedError);
		expect(error).not.toBeInstanceOf(ConflictError);
		expect(error.code).toBe('ADMIN_MUTATION_PAUSED_FOR_RELEASE');
		// Never 409: pages read that status as "changed elsewhere".
		expect(error.status).toBe(503);
		expect((error as ReleasePausedError).httpStatus).toBe(409);
		expect((error as ReleasePausedError).retryAfterSeconds).toBe(5);
		expect(error.body.targetVersion).toBe('0.6.0');
	});

	it('reads an unreadable release state as paused too', async () => {
		const error = await respond(503, { error: 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE' });
		expect(error).toBeInstanceOf(ReleasePausedError);
		expect(error.status).toBe(503);
		expect((error as ReleasePausedError).httpStatus).toBe(503);
		expect((error as ReleasePausedError).retryAfterSeconds).toBe(0);
	});

	it('keeps every other 409 a conflict and every other 503 a plain error', async () => {
		expect(await respond(409, { error: 'ADMIN_CONFLICT' })).toBeInstanceOf(ConflictError);
		// The codes count only with the status the API sends them with.
		expect(
			await respond(409, { error: 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE' })
		).toBeInstanceOf(ConflictError);
		expect(await respond(503, { error: 'temporarily_unavailable' })).not.toBeInstanceOf(
			ReleasePausedError
		);
		expect(await respond(503, { error: 'ADMIN_MUTATION_PAUSED_FOR_RELEASE' })).not.toBeInstanceOf(
			ReleasePausedError
		);
	});
});
