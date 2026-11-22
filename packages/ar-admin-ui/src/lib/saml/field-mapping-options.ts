export type SAMLFieldMappingProviderType = 'saml_idp' | 'saml_sp';

export interface SAMLFieldMappingSetOption {
	id: string;
	lifecycleState: string;
}

export interface SAMLFieldMappingVersionOption {
	lifecycleState: string;
	directions?: {
		source: boolean;
		destination: boolean;
	};
	sourceProfileIds?: string[];
	destinationProfileIds?: string[];
	latestSnapshot?: {
		lifecycleState?: string | null;
	} | null;
}

export function filterCompatibleActiveFieldMappingSets<T extends SAMLFieldMappingSetOption>(
	fieldMappingSets: readonly T[],
	versionsByFieldMappingSetId: Readonly<Record<string, readonly SAMLFieldMappingVersionOption[]>>,
	providerType: SAMLFieldMappingProviderType
): T[] {
	return fieldMappingSets.filter((fieldMappingSet) => {
		if (fieldMappingSet.lifecycleState !== 'active') return false;
		return (versionsByFieldMappingSetId[fieldMappingSet.id] ?? []).some((version) =>
			isCompatibleActiveVersion(version, providerType)
		);
	});
}

export function buildSelectableFieldMappingSets<T extends SAMLFieldMappingSetOption>(input: {
	fieldMappingSets: readonly T[];
	versionsByFieldMappingSetId: Readonly<Record<string, readonly SAMLFieldMappingVersionOption[]>>;
	providerType: SAMLFieldMappingProviderType;
	currentFieldMappingSetId?: string;
}): T[] {
	const compatible = filterCompatibleActiveFieldMappingSets(
		input.fieldMappingSets,
		input.versionsByFieldMappingSetId,
		input.providerType
	);
	const current = input.fieldMappingSets.find(
		(fieldMappingSet) => fieldMappingSet.id === input.currentFieldMappingSetId
	);
	if (current && !compatible.some((fieldMappingSet) => fieldMappingSet.id === current.id)) {
		return [current, ...compatible];
	}
	return compatible;
}

function isCompatibleActiveVersion(
	version: SAMLFieldMappingVersionOption,
	providerType: SAMLFieldMappingProviderType
): boolean {
	if (version.lifecycleState !== 'active') return false;

	const requiredSide = providerType === 'saml_idp' ? 'source' : 'destination';
	if (version.directions) return version.directions[requiredSide];

	const hasSourceProfiles = (version.sourceProfileIds?.length ?? 0) > 0;
	const hasDestinationProfiles = (version.destinationProfileIds?.length ?? 0) > 0;
	if (hasSourceProfiles || hasDestinationProfiles) {
		return requiredSide === 'source' ? hasSourceProfiles : hasDestinationProfiles;
	}

	return true;
}

/**
 * What the pickers know of a set from the list alone: a set that is switched on serves a version,
 * and the one-step Mapping Set API lists no more than that. Reading each set for its direction
 * would be one request per set against a rate limit; which Destination Profile a set releases
 * into is read once, for the set that is chosen, and the server's save-time checks refuse a set
 * that does not fit the provider.
 */
export function activeVersionsFromListedSets(
	fieldMappingSets: readonly SAMLFieldMappingSetOption[]
): Record<string, SAMLFieldMappingVersionOption[]> {
	return Object.fromEntries(
		fieldMappingSets
			.filter((fieldMappingSet) => fieldMappingSet.lifecycleState === 'active')
			.map((fieldMappingSet) => [fieldMappingSet.id, [{ lifecycleState: 'active' }]])
	);
}
