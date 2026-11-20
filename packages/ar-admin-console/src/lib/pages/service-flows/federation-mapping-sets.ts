import { httpIdentityMapping } from '#lib/api/identity-mapping.js';
import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
import type { FederationMappingOption } from './federation-model';

/** The mapping sets of the tenant a federation's roles can be given, as the selects offer them. */
export async function loadFederationMappingSets(): Promise<FederationMappingOption[]> {
	const tenantId = tenantScope.tenantId;
	if (!tenantId) throw new Error('tenant_unknown');
	const { sets } = await httpIdentityMapping().sets(tenantId);
	return sets
		.filter((set) => set.enabled)
		.map((set) => ({ value: set.id, label: set.display_name ?? set.field_mapping_key }));
}
