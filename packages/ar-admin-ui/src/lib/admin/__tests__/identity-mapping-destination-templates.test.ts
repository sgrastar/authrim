import { describe, expect, it } from 'vitest';
import { oidcDestinationTemplates } from '../identity-mapping-destination-templates/oidc';
import { samlDestinationTemplates } from '../identity-mapping-destination-templates/saml';

describe('identity mapping destination templates', () => {
	it('includes a practical set of standard OIDC claims', () => {
		const standardOidc = oidcDestinationTemplates.find(
			(template) => template.id === 'template_destination_oidc_standard'
		);

		expect(standardOidc).toBeDefined();
		expect(standardOidc?.schema.claims).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ claimName: 'sub', required: true, requiredScopes: ['openid'] }),
				expect.objectContaining({ claimName: 'name', requiredScopes: ['profile'] }),
				expect.objectContaining({ claimName: 'given_name', requiredScopes: ['profile'] }),
				expect.objectContaining({ claimName: 'family_name', requiredScopes: ['profile'] }),
				expect.objectContaining({ claimName: 'preferred_username', requiredScopes: ['profile'] }),
				expect.objectContaining({ claimName: 'locale', requiredScopes: ['profile'] }),
				expect.objectContaining({ claimName: 'updated_at', valueType: 'number' }),
				expect.objectContaining({ claimName: 'email', requiredScopes: ['email'] }),
				expect.objectContaining({ claimName: 'email_verified', valueType: 'boolean' }),
				expect.objectContaining({ claimName: 'phone_number', requiredScopes: ['phone'] }),
				expect.objectContaining({ claimName: 'address', valueType: 'json' })
			])
		);
		expect(Array.isArray(standardOidc?.schema.claims) && standardOidc.schema.claims.length).toBe(
			20
		);
	});

	it('keeps SAML destination templates free of SP-specific required fields', () => {
		for (const template of samlDestinationTemplates) {
			const attributes = template.schema.attributes;
			expect(Array.isArray(attributes)).toBe(true);
			for (const attribute of attributes as Array<Record<string, unknown>>) {
				expect(attribute).not.toHaveProperty('required');
				expect(attribute.nullable).toBe(true);
			}
		}
	});
});
