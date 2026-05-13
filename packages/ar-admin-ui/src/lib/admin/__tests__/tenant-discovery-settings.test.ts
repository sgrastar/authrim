import { describe, expect, it } from 'vitest';
import {
	buildDiscoveryMethodsValue,
	getMethodToggles,
	resolveEmailResolutionPolicy
} from '../tenant-discovery-settings';

describe('tenant discovery settings helpers', () => {
	it('treats email resolution as disabled when email discovery is not enabled', () => {
		expect(
			resolveEmailResolutionPolicy('["tenant_code","tenant_slug"]', 'exact_email_then_domain')
		).toBe('disabled');
	});

	it('keeps stored email policy when email discovery is enabled', () => {
		expect(resolveEmailResolutionPolicy('["email_domain","tenant_code"]', 'exact_email_only')).toBe(
			'exact_email_only'
		);
	});

	it('builds discovery methods in stable order', () => {
		expect(
			buildDiscoveryMethodsValue({
				emailEnabled: true,
				emailResolutionPolicy: 'exact_email_then_domain',
				tenantCodeEnabled: true,
				tenantSlugEnabled: true
			})
		).toBe('["email_domain","tenant_code","tenant_slug"]');
	});

	it('omits email discovery when policy is disabled', () => {
		expect(
			buildDiscoveryMethodsValue({
				emailEnabled: false,
				emailResolutionPolicy: 'disabled',
				tenantCodeEnabled: true,
				tenantSlugEnabled: false
			})
		).toBe('["tenant_code"]');
	});

	it('omits email discovery when email toggle is off even if a policy is selected', () => {
		expect(
			buildDiscoveryMethodsValue({
				emailEnabled: false,
				emailResolutionPolicy: 'exact_email_only',
				tenantCodeEnabled: false,
				tenantSlugEnabled: true
			})
		).toBe('["tenant_slug"]');
	});

	it('reads tenant code and slug toggles from stored methods', () => {
		expect(getMethodToggles('["email_domain","tenant_slug"]')).toEqual({
			emailEnabled: true,
			tenantCodeEnabled: false,
			tenantSlugEnabled: true
		});
	});
});
