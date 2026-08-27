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
