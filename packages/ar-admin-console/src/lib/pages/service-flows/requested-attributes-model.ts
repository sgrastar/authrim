import type { FederationRequestedAttributes } from '#lib/api/federation-sources.js';
import { t } from '#lib/i18n/i18n.svelte.js';

/**
 * What a federation's service providers ask for, by attribute name, as the mapping needs it:
 * how many of them require each and how many only ask, out of all `total` service providers.
 */
export interface RequestedCounts {
	/** The service providers of the federation (the denominator). */
	total: number;
	byName: ReadonlyMap<string, { required: number; optional: number }>;
}

export function requestedCountsFrom(data: FederationRequestedAttributes): RequestedCounts {
	return {
		total: data.spTotal,
		byName: new Map(
			data.attributes.map((attribute) => [
				attribute.name,
				{
					required: attribute.requiredBy,
					optional: Math.max(attribute.requestedBy - attribute.requiredBy, 0)
				}
			])
		)
	};
}

/** The line under an attribute of the mapping: "Req. 188 Opt. 2 / 515", or nothing if none ask. */
export function requestedNote(counts: RequestedCounts, name: string): string | undefined {
	const entry = counts.byName.get(name);
	if (!entry) return undefined;
	return t('sf.fed.req.counts', {
		required: entry.required,
		optional: entry.optional,
		total: counts.total
	});
}
