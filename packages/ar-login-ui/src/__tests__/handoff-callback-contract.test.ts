import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const callbackSource = readFileSync(resolve(__dirname, '../routes/callback/+page.svelte'), 'utf8');

describe('hosted handoff callback contract', () => {
	it('uses cookie-only finalize instead of the JSON token verification path', () => {
		expect(callbackSource).toContain('/handoff/finalize');
		expect(callbackSource).not.toContain('/handoff/verify');
		expect(callbackSource).not.toContain('verifyToken(');
		expect(callbackSource).not.toContain('/api/v1/auth/direct/token');
	});

	it('sends cookies, rejects token material, and restores auth from the cookie session', () => {
		expect(callbackSource).toContain('authrimFetch');
		expect(callbackSource).toContain('assertNoBrowserTokenMaterial');
		expect(callbackSource).toContain('auth.refreshFromSession()');
		expect(callbackSource).toContain('handoff_cookie_session_success');
	});

	it('restores pending Flow runtime state after external IdP handoff', () => {
		expect(callbackSource).toContain('externalFlowRuntimeInteractionId');
		expect(callbackSource).toContain('externalFlowRuntimeKind');
		expect(callbackSource).toContain('updateFlowRuntimePostAuthRedirect');
		expect(callbackSource).toContain('runtime_interaction_id=');
	});

	it('does not fall back to browser-side authorization code token exchange', () => {
		expect(callbackSource).toContain('external_handoff_required');
		expect(callbackSource).toContain('external_handoff_required: () => $LL.error_server_error()');
		expect(callbackSource).not.toContain('token-capable SDK client');
	});

	it('polls durable external IdP provisioning while keeping the existing processing spinner', () => {
		expect(callbackSource).toContain("params.get('provisioning_token')");
		expect(callbackSource).toContain('/api/external/provisioning/status');
		expect(callbackSource).toContain('retry_after_ms');
		expect(callbackSource).toContain("status === 'processing'");
		expect(callbackSource).toContain("history.replaceState(null, '', window.location.pathname)");
	});

	it('allows only the fixed same-origin provisioning resume endpoint', () => {
		expect(callbackSource).toContain('resumeUrl.origin !== apiOrigin');
		expect(callbackSource).toContain("resumeUrl.pathname !== '/auth/external/provisioning/resume'");
		expect(callbackSource).toContain('window.location.assign(resumeUrl.toString())');
	});
});
