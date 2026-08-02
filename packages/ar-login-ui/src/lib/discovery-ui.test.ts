import { describe, expect, it } from 'vitest';
import { getDefaultDiscoveryMode, getInteractiveDiscoveryMethods } from './discovery-ui';

describe('discovery UI helpers', () => {
	it('excludes app_hint from user-selectable methods', () => {
		expect(
			getInteractiveDiscoveryMethods(
				['email_exact', 'tenant_code', 'tenant_slug', 'app_hint'],
				'select_if_multiple'
			)
		).toEqual(['email_exact', 'tenant_code', 'tenant_slug']);
	});

	it('includes WAYF as a user-selectable method', () => {
		expect(getInteractiveDiscoveryMethods(['wayf'], 'select_if_multiple')).toEqual(['wayf']);
	});

	it('hides email discovery when selection_policy is manual_only', () => {
		expect(
			getInteractiveDiscoveryMethods(
				['email_exact', 'tenant_code', 'tenant_slug', 'wayf'],
				'manual_only'
			)
		).toEqual(['tenant_code', 'tenant_slug', 'wayf']);
	});

	it('derives the expected default mode', () => {
		expect(getDefaultDiscoveryMode(['email_exact', 'tenant_code'])).toBe('email');
		expect(getDefaultDiscoveryMode(['tenant_code', 'tenant_slug'])).toBe('tenant_code');
		expect(getDefaultDiscoveryMode(['wayf'])).toBe('wayf');
		expect(getDefaultDiscoveryMode(['tenant_slug'])).toBe('tenant_slug');
	});
});
