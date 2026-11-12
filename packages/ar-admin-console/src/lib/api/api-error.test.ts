import { describe, expect, it } from 'vitest';
import { errorFromResponse } from './api-error';

const respond = (status: number, body: unknown) =>
	errorFromResponse(
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
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
});
