import { describe, expect, it } from 'vitest';
import { oidcDestinationTemplates } from '../identity-mapping-destination-templates/oidc';
import { samlDestinationTemplates } from '../identity-mapping-destination-templates/saml';
import { resourceServerDestinationTemplates } from '../identity-mapping-destination-templates/resource-server';

describe('identity mapping destination templates', () => {
	it('includes a practical set of standard OIDC claims', () => {
		const standardOidc = oidcDestinationTemplates.find(
			(template) => template.id === 'template_destination_oidc_standard'
		);

		expect(standardOidc).toBeDefined();
		expect(standardOidc?.schema.claims).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ claimName: 'sub', required: true, requiredScopes: [] }),
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

	it('lists every standard OIDC claim for both the ID token and UserInfo', () => {
		// OIDC Core 5.4: with response_type=id_token there is no UserInfo, so the scope claims travel
		// in the ID token; a profile that lists them for UserInfo only would drop them there.
		const standardOidc = oidcDestinationTemplates.find(
			(template) => template.id === 'template_destination_oidc_standard'
		);
		const claims = standardOidc?.schema.claims as Array<{ claimName: string; surfaces: string[] }>;
		for (const claim of claims) {
			expect(claim.surfaces, claim.claimName).toEqual(['id_token', 'userinfo']);
		}
	});

	it('provides a client-scoped Resource Server introspection template', () => {
		const standard = resourceServerDestinationTemplates.find(
			(template) => template.id === 'template_destination_resource_server_standard'
		);
		expect(standard).toMatchObject({ destinationType: 'resource_server' });
		expect(standard?.schema.claims).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ claimName: 'active', required: true, requiredScopes: [] }),
				expect.objectContaining({
					claimName: 'roles',
					valueMultiplicity: 'multi',
					requiredScopes: ['roles']
				})
			])
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
