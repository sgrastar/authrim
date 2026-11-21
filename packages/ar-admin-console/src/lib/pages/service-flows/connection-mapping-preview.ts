import type { AppClaimChanges, ClaimChange, SetChangePreview } from '#lib/api/identity-mapping.js';
import type { MappingChange, MappingSetChangePreview } from '#lib/api/mapping-set.js';

const toChange = (change: MappingChange): ClaimChange => ({
	kind: change.kind,
	claim: change.claim,
	previous_claim: change.previous_claim,
	type_before: change.type_before,
	type_after: change.type_after
});

/** The places of a tenant that use a platform set: apps and service providers together. */
function countOf(row: NonNullable<MappingSetChangePreview['tenants']>[number]): number | null {
	if (row.unavailable || row.apps_count_is_lower_bound) return null;
	if (row.apps_using == null && row.sps_using == null) return null;
	return (row.apps_using ?? 0) + (row.sps_using ?? 0);
}

/** One entry per claim and reason: the facade names a claim once for each change it holds back. */
function once<T extends { claim: string; scope: string; reason?: string }>(list: T[]): T[] {
	const seen = new Set<string>();
	return list.filter((item) => {
		const key = `${item.claim}\u0000${item.scope}\u0000${item.reason ?? ''}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * What the mapping set screen reads (`SetChangePreview`) from what the facade answers for a
 * change: the apps and, for a SAML tenant, the service providers that use the set, side by side,
 * and the count of apps per tenant for a platform set. The facade does not work out a test
 * user's values for a draft, so there is no sample.
 */
export function setChangePreviewOf(preview: MappingSetChangePreview): SetChangePreview {
	const apps: AppClaimChanges[] = [
		...preview.apps.map((app) => ({
			tenant_id: app.tenant_id,
			client_id: app.client_id,
			name: app.name,
			tier: app.tier,
			changes: app.changes.map(toChange),
			held_back: once(app.held_back.map((held) => ({ ...held, scope: held.scope ?? '' })))
		})),
		...(preview.sps ?? []).map((sp) => ({
			tenant_id: sp.tenant_id,
			client_id: sp.provider_id,
			name: sp.name,
			tier: 'client' as const,
			changes: sp.changes.map(toChange),
			held_back: once(
				sp.held_back.map((held) => ({ claim: held.attribute, scope: '', reason: held.reason }))
			)
		}))
	];
	const tenants = preview.tenants?.length ? preview.tenants : undefined;
	// Whatever the facade could not look at fully makes the whole answer incomplete.
	const complete =
		preview.usage_complete &&
		!preview.apps_truncated &&
		!preview.sps_truncated &&
		!preview.tenants_truncated &&
		!preview.defaults_unavailable &&
		!preview.unresolved_sp_references?.length &&
		!(preview.tenants ?? []).some((row) => row.unavailable || row.apps_count_is_lower_bound);
	return {
		setId: preview.setId,
		usage_complete: complete,
		apps,
		tenants: tenants?.map((row) => ({
			tenant_id: row.tenant_id,
			apps_using: countOf(row)
		})),
		sample: null
	};
}
