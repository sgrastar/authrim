import { describe, expect, it } from 'vitest';
import { buildAuthSwitchHref } from './auth-switch-url';

describe('buildAuthSwitchHref', () => {
	it('preserves the authorization and tenant context between login and signup', () => {
		const params = new URLSearchParams({
			challenge_id: 'challenge-1',
			tenant_host: 'tenant.test.authrim.com',
			login_hint: 'user@example.com',
			runtime_interaction_id: 'login-only-interaction',
			error: 'ignored'
		});

		expect(buildAuthSwitchHref('/signup', params)).toBe(
			'/signup?challenge_id=challenge-1&tenant_host=tenant.test.authrim.com&login_hint=user%40example.com'
		);
	});

	it('returns a clean path when no transferable context is present', () => {
		expect(buildAuthSwitchHref('/login', new URLSearchParams('error=ignored'))).toBe('/login');
	});
});
