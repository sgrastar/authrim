import { describe, expect, it } from 'vitest';
import {
	buildDiscoveryMethodsValue,
	getMethodToggles,
	resolveEmailResolutionPolicy
} from '../tenant-discovery-settings';

describe('tenant discovery settings helpers', () => {
	it('treats email resolution as disabled when email discovery is not enabled', () => {
		expect(resolveEmailResolutionPolicy('["tenant_code","tenant_slug"]', 'exact_email_only')).toBe(
			'disabled'
		);
	});

	it('keeps stored email policy when email discovery is enabled', () => {
		expect(resolveEmailResolutionPolicy('["email_exact","tenant_code"]', 'exact_email_only')).toBe(
			'exact_email_only'
		);
	});

	it('builds discovery methods in stable order', () => {
		expect(
			buildDiscoveryMethodsValue({
				emailEnabled: true,
				emailResolutionPolicy: 'exact_email_only',
				tenantCodeEnabled: true,
				tenantSlugEnabled: true,
				wayfEnabled: true
			})
		).toBe('["email_exact","tenant_code","tenant_slug","wayf"]');
	});

	it('omits email discovery when policy is disabled', () => {
		expect(
			buildDiscoveryMethodsValue({
				emailEnabled: false,
				emailResolutionPolicy: 'disabled',
				tenantCodeEnabled: true,
				tenantSlugEnabled: false,
				wayfEnabled: false
			})
		).toBe('["tenant_code"]');
	});

	it('omits email discovery when email toggle is off even if a policy is selected', () => {
		expect(
			buildDiscoveryMethodsValue({
				emailEnabled: false,
				emailResolutionPolicy: 'exact_email_only',
				tenantCodeEnabled: false,
				tenantSlugEnabled: true,
				wayfEnabled: false
			})
		).toBe('["tenant_slug"]');
	});

	it('reads tenant code, slug, and WAYF toggles from stored methods', () => {
		expect(getMethodToggles('["email_exact","tenant_slug","wayf"]')).toEqual({
			emailEnabled: true,
			tenantCodeEnabled: false,
			tenantSlugEnabled: true,
			wayfEnabled: true
		});
	});
});
