import type { IdentityMappingScimSourceProfileSchema } from '#lib/api/admin-identity-mapping.js';

export interface ScimSourceTemplate {
	id: string;
	sourceType: 'scim';
	category: string;
	profileKey: string;
	displayName: string;
	version: string;
	updatedAt: string;
	description: string;
	schema: IdentityMappingScimSourceProfileSchema;
}
