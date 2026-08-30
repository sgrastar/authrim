import type {
	IdentityMappingDestinationProfileSummary,
	IdentityMappingFieldMappingVersionSummary
} from '$lib/api/admin-identity-mapping';
import type { SAMLDestinationFieldReleaseMode, SAMLRequestedAttribute } from '$lib/api/admin-saml';

export interface SAMLMappingSetReleaseField {
	key: string;
	label: string;
	friendlyName?: string;
	classification?: string;
}

export function resolveSAMLMappingSetReleaseFields(input: {
	versions: IdentityMappingFieldMappingVersionSummary[];
	destinationProfiles: IdentityMappingDestinationProfileSummary[];
}): SAMLMappingSetReleaseField[] {
	const fields = new Map<string, SAMLMappingSetReleaseField>();

	for (const profile of resolveSAMLMappingSetDestinationProfiles(input)) {
		const attributes = profile.version.schema.attributes;
		if (!Array.isArray(attributes)) continue;
		for (const value of attributes) {
			if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim()) continue;
			const key = value.name.trim();
			fields.set(key, {
				key,
				label: readString(value.label) ?? readString(value.friendlyName) ?? key,
				friendlyName: readString(value.friendlyName),
				classification: readString(value.classification)
			});
		}
	}

	return [...fields.values()];
}

export function resolveSAMLMappingSetDestinationProfileIds(input: {
	versions: IdentityMappingFieldMappingVersionSummary[];
	destinationProfiles: IdentityMappingDestinationProfileSummary[];
}): string[] {
	return resolveSAMLMappingSetDestinationProfiles(input).map((profile) => profile.id);
}

export function buildSAMLFieldReleasePolicies(input: {
	fields: SAMLMappingSetReleaseField[];
	existing?: Record<string, SAMLDestinationFieldReleaseMode>;
	metadataRequestedAttributes?: SAMLRequestedAttribute[];
}): Record<string, SAMLDestinationFieldReleaseMode> {
	const requested = new Map(
		(input.metadataRequestedAttributes ?? []).map((attribute) => [attribute.name, attribute])
	);
	return Object.fromEntries(
		input.fields.map((field) => {
			const existing = input.existing?.[field.key];
			if (existing) return [field.key, existing];
			return [field.key, requested.get(field.key)?.isRequired === true ? 'required' : 'optional'];
		})
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveSAMLMappingSetDestinationProfiles(input: {
	versions: IdentityMappingFieldMappingVersionSummary[];
	destinationProfiles: IdentityMappingDestinationProfileSummary[];
}): Array<
	IdentityMappingDestinationProfileSummary & { version: { schema: Record<string, unknown> } }
> {
	const activeVersion = input.versions.find((version) => version.lifecycleState === 'active');
	if (!activeVersion) return [];
	const destinationProfileIds = new Set(activeVersion.destinationProfileIds ?? []);
	return input.destinationProfiles.filter(
		(
			profile
		): profile is IdentityMappingDestinationProfileSummary & {
			version: { schema: Record<string, unknown> };
		} =>
			profile.destinationType === 'saml' &&
			(destinationProfileIds.has(profile.id) ||
				destinationProfileIds.has(`destination-profile-${profile.id}`)) &&
			Boolean(profile.version?.schema)
	);
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
