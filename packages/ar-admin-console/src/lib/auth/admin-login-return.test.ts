import { describe, expect, it } from 'vitest';
import { resolveAdminAgentLoginHandoffId, resolveAdminLoginReturnTo } from './admin-login-return';

const ORIGIN = 'https://tenant.authrim.example';
const ADMIN_ORIGIN = 'https://admin.authrim.example';

describe('resolveAdminLoginReturnTo', () => {
	it('allows the fixed Agent OAuth and elevation journeys', () => {
		expect(
			resolveAdminLoginReturnTo(
				'?return_to=%2Foauth%2Fadmin-agent%2Fauthorize%3Frequest_uri%3Durn%253Atest',
				ORIGIN
			)
		).toBe('/oauth/admin-agent/authorize?request_uri=urn%3Atest');
		expect(
			resolveAdminLoginReturnTo(
				'?return_to=%2Fadmin%2Fagent-access%2Felevations%2Fael_1234-abcd',
				ORIGIN
			)
		).toBe('/admin/agent-access/elevations/ael_1234-abcd');
		expect(
			resolveAdminLoginReturnTo(
				'?return_to=%2Fadmin%2Fagent-access%2Fbulk-plans%2Fabp_1234-abcd%2F2',
				ORIGIN
			)
		).toBe('/admin/agent-access/bulk-plans/abp_1234-abcd/2');
	});

	it('rejects the legacy cross-origin Agent OAuth continuation', () => {
		const target = `${ORIGIN}/oauth/admin-agent/authorize?request_uri=urn%3Atest&client_id=codex`;
		expect(
			resolveAdminLoginReturnTo(`?return_to=${encodeURIComponent(target)}`, ADMIN_ORIGIN)
		).toBe('/admin');
	});

	it('parses a bounded login handoff without converting it into a cross-origin return URL', () => {
		const handoffId = `alh_${'a'.repeat(32)}`;
		expect(resolveAdminAgentLoginHandoffId(`?agent_handoff=${handoffId}`)).toBe(handoffId);
		expect(resolveAdminLoginReturnTo(`?agent_handoff=${handoffId}`, ADMIN_ORIGIN)).toBe('/admin');
	});

	it('rejects open redirects and unrelated Admin paths', () => {
		expect(
			resolveAdminLoginReturnTo('?return_to=https%3A%2F%2Fevil.example%2Fcallback', ORIGIN)
		).toBe('/admin');
		expect(resolveAdminLoginReturnTo('?return_to=%2Fadmin%2Fadmins', ORIGIN)).toBe('/admin');
		expect(
			resolveAdminLoginReturnTo(
				`?return_to=${encodeURIComponent(
					'https://evil.example/oauth/admin-agent/authorize?request_uri=stolen'
				)}`,
				ADMIN_ORIGIN
			)
		).toBe('/admin');
		expect(resolveAdminAgentLoginHandoffId('?agent_handoff=alh_too-short')).toBeNull();
		expect(
			resolveAdminLoginReturnTo(
				'?return_to=%2Fadmin%2Fagent-access%2Felevations%2Fael_ok%3Fnext%3Devil',
				ORIGIN
			)
		).toBe('/admin');
		expect(
			resolveAdminLoginReturnTo(
				'?return_to=%2Fadmin%2Fagent-access%2Fbulk-plans%2Fabp_ok%2F0',
				ORIGIN
			)
		).toBe('/admin');
	});
});
