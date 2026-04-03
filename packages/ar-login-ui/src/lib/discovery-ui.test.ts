import { describe, expect, it } from 'vitest';
import { getDefaultDiscoveryMode, getInteractiveDiscoveryMethods } from './discovery-ui';

describe('discovery UI helpers', () => {
	it('excludes app_hint from user-selectable methods', () => {
		expect(
			getInteractiveDiscoveryMethods(
				['email_domain', 'tenant_code', 'tenant_slug', 'app_hint'],
				'select_if_multiple'
			)
		).toEqual(['email_domain', 'tenant_code', 'tenant_slug']);
	});

	it('hides email discovery when selection_policy is manual_only', () => {
		expect(
			getInteractiveDiscoveryMethods(['email_domain', 'tenant_code', 'tenant_slug'], 'manual_only')
		).toEqual(['tenant_code', 'tenant_slug']);
	});

	it('derives the expected default mode', () => {
		expect(getDefaultDiscoveryMode(['email_domain', 'tenant_code'])).toBe('email');
		expect(getDefaultDiscoveryMode(['tenant_code', 'tenant_slug'])).toBe('tenant_code');
		expect(getDefaultDiscoveryMode(['tenant_slug'])).toBe('tenant_slug');
	});
});
