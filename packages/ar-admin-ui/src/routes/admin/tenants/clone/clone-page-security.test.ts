import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('tenant clone page retry safety', () => {
	it('reuses an idempotency key for the same submitted clone request', () => {
		const page = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

		expect(page).toContain('const fingerprint = JSON.stringify({ sourceTenantId, request })');
		expect(page).toContain('if (fingerprint !== cloneAttemptFingerprint)');
		expect(page).toContain('cloneAttemptIdempotencyKey = crypto.randomUUID()');
		expect(page).toContain(
			'adminTenantsAPI.clone(sourceTenantId, request, cloneAttemptIdempotencyKey)'
		);
	});
});
