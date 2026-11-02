import type { IdentityMappingDestinationType } from '#lib/api/admin-identity-mapping.js';

export interface DestinationTemplate {
	id: string;
	destinationType: IdentityMappingDestinationType;
	category: string;
	profileKey: string;
	displayName: string;
	version: string;
	updatedAt: string;
	description: string;
	schema: Record<string, unknown>;
}
