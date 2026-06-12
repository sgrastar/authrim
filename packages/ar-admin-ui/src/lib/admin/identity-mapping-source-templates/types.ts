import type { IdentityMappingSourceType } from '$lib/api/admin-identity-mapping';

export interface SourceTemplate {
	id: string;
	sourceType: IdentityMappingSourceType;
	category: string;
	profileKey: string;
	displayName: string;
	version: string;
	updatedAt: string;
	description: string;
	schema: Record<string, unknown>;
}
