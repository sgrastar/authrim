import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const callbackSource = readFileSync(
	resolve(__dirname, '../routes/callback/+page.svelte'),
	'utf8'
);

describe('hosted handoff callback contract', () => {
	it('uses cookie-only finalize instead of the JSON token verification path', () => {
		expect(callbackSource).toContain('/auth/external/handoff/finalize');
		expect(callbackSource).not.toContain('/auth/external/handoff/verify');
		expect(callbackSource).not.toContain('verifyToken(');
	});

	it('sends cookies, rejects token material, and restores auth from the cookie session', () => {
		expect(callbackSource).toContain("credentials: 'include'");
		expect(callbackSource).toContain("'access_token' in finalizeData");
		expect(callbackSource).toContain("'refresh_token' in finalizeData");
		expect(callbackSource).toContain('auth.refreshFromSession()');
		expect(callbackSource).toContain('handoff_cookie_session_success');
	});
});
