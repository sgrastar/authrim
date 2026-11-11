import { describe, expect, it } from 'vitest';
import { BUILT_IN_METHODS, methodKey } from './authentication-method-fields';

describe('authentication method profile matrix', () => {
	it('maps the login-only methods to their supported settings keys', () => {
		expect(methodKey('did', 'login')).toBe('authentication-methods.did.login_enabled');
		expect(methodKey('directory_password', 'login')).toBe(
			'authentication-methods.directory_password.enabled'
		);
		for (const id of ['did', 'directory_password']) {
			expect(BUILT_IN_METHODS.find((method) => method.id === id)?.supports).toEqual(['login']);
		}
	});
});
