import type {
	IdentityMappingCatalogSummary,
	IdentityMappingDestinationProfileSummary,
	IdentityMappingExternalSchemaSummary,
	IdentityMappingPolicySummary,
	IdentityMappingProtocolSchemaSummary,
	IdentityMappingSchemaReadinessRow,
	IdentityMappingSourceProfileSummary
} from '$lib/api/admin-identity-mapping';
import type {
	MappingAdapter,
	MappingEdge,
	MappingNode,
	MappingRisk,
	MappingSample,
	RuleDetail
} from './types';

interface IdentityMappingFlowInput {
	policies: IdentityMappingPolicySummary[];
	catalogs: IdentityMappingCatalogSummary[];
	sourceProfiles: IdentityMappingSourceProfileSummary[];
	destinationProfiles: IdentityMappingDestinationProfileSummary[];
	protocolSchemas: IdentityMappingProtocolSchemaSummary[];
	externalSchemas: IdentityMappingExternalSchemaSummary[];
	schemaReadinessRows: IdentityMappingSchemaReadinessRow[];
}

interface ProfileSchema {
	id: string;
	title: string;
	source: string;
	adapter: MappingAdapter;
	direction: 'source' | 'destination';
	versionLabel: string;
	lifecycleState: string;
	schema: Record<string, unknown> | null;
}

interface ExtractedField {
	key: string;
	label: string;
	caption: string;
	type?: string;
	required?: boolean;
	privacy?: MappingNode['privacy'];
}

const defaultAdapters: MappingAdapter[] = ['SAML', 'CSV', 'OIDC', 'SCIM'];
const defaultCanonicalTargets: MappingNode[] = [
	{
		id: 'canonical-subject-identifier',
		ruleId: 'canonical-subject-identifier',
		role: 'target',
		label: 'Subject identifier',
		caption: 'identity_accounts.subject_id',
		type: 'stable identifier',
		privacy: 'non-PII',
		required: true
	},
	{
		id: 'canonical-email',
		ruleId: 'canonical-email',
		role: 'target',
		label: 'Email',
		caption: 'contact_points.value_storage_ref / contact_type=email',
		type: 'email',
		privacy: 'PII',
		required: true
	},
	{
		id: 'canonical-phone',
		ruleId: 'canonical-phone',
		role: 'target',
		label: 'Phone',
		caption: 'contact_points.value_storage_ref / contact_type=phone',
		type: 'phone',
		privacy: 'PII'
	},
	{
		id: 'canonical-mobile-phone',
		ruleId: 'canonical-mobile-phone',
		role: 'target',
		label: 'Mobile phone',
		caption: 'contact_points.value_storage_ref / contact_type=mobile',
		type: 'phone',
		privacy: 'PII'
	},
	{
		id: 'canonical-given-name',
		ruleId: 'canonical-given-name',
		role: 'target',
		label: 'Given name',
		caption: 'profile_attribute_values.value_storage_ref / catalog_entry_id=given_name',
		type: 'text',
		privacy: 'PII'
	},
	{
		id: 'canonical-family-name',
		ruleId: 'canonical-family-name',
		role: 'target',
		label: 'Family name',
		caption: 'profile_attribute_values.value_storage_ref / catalog_entry_id=family_name',
		type: 'text',
		privacy: 'PII'
	},
	{
		id: 'canonical-display-name',
		ruleId: 'canonical-display-name',
		role: 'target',
		label: 'Display name',
		caption: 'profile_attribute_values.value_storage_ref / catalog_entry_id=display_name',
		type: 'text',
		privacy: 'PII'
	},
	{
		id: 'canonical-address',
		ruleId: 'canonical-address',
		role: 'target',
		label: 'Address',
		caption: 'contact_points.value_storage_ref / contact_type=address',
		type: 'json',
		privacy: 'PII'
	},
	{
		id: 'canonical-locale',
		ruleId: 'canonical-locale',
		role: 'target',
		label: 'Locale',
		caption: 'profile_attribute_values.value_json / catalog_entry_id=locale',
		type: 'locale',
		privacy: 'non-PII'
	},
	{
		id: 'canonical-timezone',
		ruleId: 'canonical-timezone',
		role: 'target',
		label: 'Timezone',
		caption: 'profile_attribute_values.value_json / catalog_entry_id=timezone',
		type: 'text',
		privacy: 'non-PII'
	},
	{
		id: 'canonical-group-membership',
		ruleId: 'canonical-group-membership',
		role: 'target',
		label: 'Group membership',
		caption: 'group_memberships.group_id',
		type: 'multi-value',
		privacy: 'non-PII'
	},
	{
		id: 'canonical-entitlements',
		ruleId: 'canonical-entitlements',
		role: 'target',
		label: 'Entitlements',
		caption: 'entitlement_grants.entitlement_id',
		type: 'multi-value',
		privacy: 'non-PII'
	},
	{
		id: 'canonical-linked-identity',
		ruleId: 'canonical-linked-identity',
		role: 'target',
		label: 'Linked identity',
		caption: 'linked_identities.provider_subject',
		type: 'identifier',
		privacy: 'non-PII'
	},
	{
		id: 'canonical-lifecycle-state',
		ruleId: 'canonical-lifecycle-state',
		role: 'target',
		label: 'Lifecycle state',
		caption: 'identity_accounts.lifecycle_state',
		type: 'enum',
		privacy: 'non-PII'
	}
];

export function buildIdentityMappingFlowSamples(input: IdentityMappingFlowInput): MappingSample[] {
	const sourceProfiles = [
		...input.sourceProfiles.map(sourceProfileToProfile),
		...input.externalSchemas.map(externalSchemaToProfile),
		...input.protocolSchemas
			.filter((schema) => isInboundProtocol(schema.protocol))
			.map(protocolSchemaToSourceProfile)
	];
	const destinationProfiles = [
		...input.destinationProfiles.map(destinationProfileToProfile),
		...input.protocolSchemas.map(protocolSchemaToDestinationProfile)
	];
	const canonicalTargets = buildCanonicalTargets(input.catalogs);

	if (
		sourceProfiles.length === 0 &&
		canonicalTargets.length === 0 &&
		destinationProfiles.length === 0
	) {
		return [];
	}

	const profiles =
		sourceProfiles.length > 0
			? sourceProfiles
			: [
					{
						id: 'schema-readiness-inventory',
						title: 'Schema readiness inventory',
						source: 'schema-readiness',
						adapter: 'CSV' as const,
						direction: 'source' as const,
						versionLabel: 'current',
						lifecycleState: 'readiness',
						schema: null
					}
				];

	return profiles.map((sourceProfile) =>
		buildSample(sourceProfile, destinationProfiles, canonicalTargets, input.policies.length)
	);
}

function buildSample(
	sourceProfile: ProfileSchema,
	destinationProfiles: ProfileSchema[],
	canonicalTargets: MappingNode[],
	policyCount: number
): MappingSample {
	const sourceNodes = buildSchemaNodes(sourceProfile, 'source');
	const destinationNodes = destinationProfiles.flatMap((profile) =>
		buildSchemaNodes(profile, 'destination')
	);
	const nodes = [...sourceNodes, ...canonicalTargets, ...destinationNodes];
	const rules = Object.fromEntries(nodes.map((node) => [node.ruleId, ruleForNode(node)]));
	const activeRuleId = nodes[0]?.ruleId ?? 'empty-flow';
	const destinationAdapter =
		destinationProfiles.find((profile) => profile.adapter === 'OIDC')?.adapter ??
		destinationProfiles[0]?.adapter ??
		'OIDC';

	return {
		id: sourceProfile.id,
		title: sourceProfile.title,
		snapshot: sourceProfile.versionLabel,
		status: sourceProfile.lifecycleState,
		reviewGates: `${sourceNodes.length} source fields`,
		inboundAdapter: sourceProfile.adapter,
		outboundAdapter: destinationAdapter,
		activeRuleId,
		metrics: [
			`0 / ${sourceNodes.length}`,
			`${Math.max(1, sourceNodes.length > 0 ? 2 : 1)} schemas`,
			String(policyCount),
			canonicalTargets.length > 0 ? `${canonicalTargets.length} targets` : 'no catalog'
		],
		nodes,
		edges: [] satisfies MappingEdge[],
		rules
	};
}

function sourceProfileToProfile(profile: IdentityMappingSourceProfileSummary): ProfileSchema {
	return {
		id: `source-profile-${profile.id}`,
		title: profile.displayName,
		source: `${profile.sourceType.toUpperCase()} / ${profile.profileKey}`,
		adapter: adapterFrom(profile.sourceType),
		direction: 'source',
		versionLabel: profile.version?.versionLabel ?? 'draft',
		lifecycleState: profile.version?.lifecycleState ?? profile.lifecycleState,
		schema: (profile.version?.schema as unknown as Record<string, unknown> | undefined) ?? null
	};
}

function protocolSchemaToSourceProfile(
	schema: IdentityMappingProtocolSchemaSummary
): ProfileSchema {
	return {
		id: `protocol-source-${schema.id}`,
		title: displayName(schema.displayName, schema.schemaKey),
		source: `${schema.protocol} / ${schema.schemaKey}`,
		adapter: adapterFrom(schema.protocol),
		direction: 'source',
		versionLabel: schema.schemaVersion ?? schema.versionLabel ?? 'current',
		lifecycleState: schema.lifecycleState,
		schema: schema.schema ?? null
	};
}

function protocolSchemaToDestinationProfile(
	schema: IdentityMappingProtocolSchemaSummary
): ProfileSchema {
	return {
		id: `protocol-destination-${schema.id}`,
		title: displayName(schema.displayName, schema.schemaKey),
		source: `${schema.protocol} / ${schema.schemaKey}`,
		adapter: adapterFrom(schema.protocol),
		direction: 'destination',
		versionLabel: schema.schemaVersion ?? schema.versionLabel ?? 'current',
		lifecycleState: schema.lifecycleState,
		schema: schema.schema ?? null
	};
}

function destinationProfileToProfile(
	profile: IdentityMappingDestinationProfileSummary
): ProfileSchema {
	return {
		id: `destination-profile-${profile.id}`,
		title: profile.displayName,
		source: `${profile.destinationType.toUpperCase()} / ${profile.profileKey}`,
		adapter: adapterFrom(profile.destinationType),
		direction: 'destination',
		versionLabel: profile.version?.versionLabel ?? 'draft',
		lifecycleState: profile.version?.lifecycleState ?? profile.lifecycleState,
		schema: (profile.version?.schema as unknown as Record<string, unknown> | undefined) ?? null
	};
}

function externalSchemaToProfile(schema: IdentityMappingExternalSchemaSummary): ProfileSchema {
	return {
		id: `external-source-${schema.id}`,
		title: displayName(schema.displayName, schema.schemaKey),
		source: `${schema.sourceType} / ${schema.sourceKey ?? schema.sourceId ?? schema.schemaKey}`,
		adapter: adapterFrom(schema.sourceType),
		direction: 'source',
		versionLabel: schema.versionLabel ?? `imported:${schema.importedAt ?? 'current'}`,
		lifecycleState: schema.lifecycleState,
		schema: schema.schema ?? null
	};
}

function buildCanonicalTargets(catalogs: IdentityMappingCatalogSummary[]): MappingNode[] {
	const activeCatalog =
		catalogs.find((catalog) => catalog.lifecycleState === 'active') ?? catalogs[0];
	const catalogCaption = activeCatalog
		? `${activeCatalog.catalogKey} / ${activeCatalog.versionLabel ?? 'built-in canonical defaults'}`
		: 'Authrim built-in canonical defaults';

	return defaultCanonicalTargets.map((target) => ({
		...target,
		caption: `${target.caption} / ${catalogCaption}`
	}));
}

function buildSchemaNodes(profile: ProfileSchema, role: 'source' | 'destination'): MappingNode[] {
	const fields = extractSchemaFields(profile.schema, profile.source);
	const extractedFields =
		fields.length > 0
			? fields
			: [
					{
						key: profile.source,
						label: profile.title,
						caption: profile.source
					}
				];

	return extractedFields.slice(0, 24).map((field) => ({
		id: `${role}-${slug(profile.id)}-${slug(field.key)}`,
		ruleId: `${role}-${slug(profile.id)}-${slug(field.key)}`,
		role,
		adapter: profile.adapter,
		label: field.label,
		caption: field.caption,
		type: field.type,
		privacy: field.privacy,
		required: field.required
	}));
}

function extractSchemaFields(
	schema: Record<string, unknown> | null,
	fallbackKey: string
): ExtractedField[] {
	if (!schema) return [];

	const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
	const candidates = [
		fieldsFromArray(schema.attributes, required),
		fieldsFromArray(schema.fields, required),
		fieldsFromArray(schema.columns, required),
		fieldsFromClaims(schema.claims, required),
		fieldsFromProperties(schema.properties, required)
	].find((fields) => fields.length > 0);

	if (candidates) return candidates;

	return Object.entries(schema)
		.filter(([, value]) => typeof value !== 'object' || value === null)
		.map(([key, value]) => ({
			key,
			label: key,
			caption: `${fallbackKey} / ${typeof value}`,
			type: typeof value
		}));
}

function fieldsFromArray(value: unknown, required: Set<string>): ExtractedField[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (typeof item === 'string') {
			return [{ key: item, label: item, caption: 'schema field', required: required.has(item) }];
		}
		if (!isRecord(item)) return [];
		const key =
			stringValue(item.name) ??
			stringValue(item.key) ??
			stringValue(item.claimName) ??
			stringValue(item.columnName) ??
			stringValue(item.headerName) ??
			stringValue(item.id) ??
			stringValue(item.stableColumnId);
		if (!key) return [];
		const type = stringValue(item.type) ?? stringValue(item.valueType);
		return [
			{
				key,
				label: stringValue(item.label) ?? key,
				caption: stringValue(item.description) ?? type ?? 'schema field',
				type,
				required: required.has(key) || item.required === true,
				privacy: privacyFrom(`${key} ${stringValue(item.classification) ?? ''}`)
			}
		];
	});
}

function fieldsFromClaims(value: unknown, required: Set<string>): ExtractedField[] {
	if (Array.isArray(value)) return fieldsFromArray(value, required);
	if (!isRecord(value)) return [];
	return Object.entries(value).map(([key, claim]) => ({
		key,
		label: key,
		caption: isRecord(claim) ? (stringValue(claim.description) ?? 'claim') : 'claim',
		type: isRecord(claim) ? stringValue(claim.type) : undefined,
		required: required.has(key),
		privacy: privacyFrom(key)
	}));
}

function fieldsFromProperties(value: unknown, required: Set<string>): ExtractedField[] {
	if (!isRecord(value)) return [];
	return Object.entries(value).map(([key, property]) => ({
		key,
		label: key,
		caption: isRecord(property) ? (stringValue(property.description) ?? 'property') : 'property',
		type: isRecord(property) ? stringValue(property.type) : undefined,
		required: required.has(key),
		privacy: privacyFrom(key)
	}));
}

function ruleForNode(node: MappingNode): RuleDetail {
	const isPii = node.privacy === 'PII';
	const risk: MappingRisk = isPii ? 'medium' : node.required ? 'medium' : 'low';
	return {
		title: node.label,
		risk,
		source:
			node.role === 'source' ? `${node.adapter ?? 'source'} / ${node.label}` : 'Not connected',
		target: node.role === 'target' ? node.label : 'No canonical target selected',
		destination:
			node.role === 'destination'
				? `${node.adapter ?? 'destination'} / ${node.label}`
				: 'Not connected',
		transform: 'not configured',
		validation: node.required ? 'required by loaded schema' : 'loaded from control-plane schema',
		release: 'not configured',
		consentStatus: isPii ? 'required' : 'not_required',
		legalBasis: isPii ? 'consent' : 'legitimate_interest',
		purpose: node.role === 'destination' ? 'attribute_release' : 'identity_mapping',
		attributeSetHash: 'not configured',
		consentMode: isPii ? 'until_attributes_change' : 'not_applicable',
		releasePolicyVersion: 'not configured',
		termsVersion: isPii ? 'tenant default required' : 'not_required',
		privacyPolicyVersion: isPii ? 'tenant default required' : 'not_required',
		denyReason: 'none',
		runtime: 'loaded control-plane schema',
		conflict: 'not evaluated',
		disclosure: 'redacted summary',
		dryrunStatus: 'unmapped',
		dryrunTone: node.required ? 'warn' : 'ok',
		input: node.role === 'source' ? `[schema field: ${node.label}]` : 'No runtime input selected.',
		output:
			node.role === 'destination' ? `[projection field: ${node.label}]` : 'No mapping edge yet.',
		trace: `${node.label} is loaded from the identity mapping control-plane API.`,
		review: node.required ? 'required mapping review' : '0 tasks',
		replay: 'no',
		diffSeverity: risk,
		diffTitle: 'Control-plane schema node',
		diff: [
			'This node is generated from the current identity mapping API response.',
			'No mapping rule is inferred until an operator connects source, canonical target, and destination.'
		]
	};
}

function displayName(value: string | undefined, fallback: string): string {
	return value?.trim() || fallback;
}

function adapterFrom(value: string): MappingAdapter {
	const normalized = value.toLowerCase();
	return defaultAdapters.find((adapter) => normalized.includes(adapter.toLowerCase())) ?? 'CSV';
}

function isInboundProtocol(protocol: string): boolean {
	return ['csv', 'scim', 'saml', 'oidc'].includes(protocol.toLowerCase());
}

function privacyFrom(value: string): MappingNode['privacy'] {
	const normalized = value.toLowerCase();
	if (
		normalized.includes('pii') ||
		normalized.includes('email') ||
		normalized.includes('mail') ||
		normalized.includes('phone') ||
		normalized.includes('name') ||
		normalized.includes('address')
	) {
		return 'PII';
	}
	if (
		normalized.includes('group') ||
		normalized.includes('policy') ||
		normalized.includes('lifecycle') ||
		normalized.includes('account')
	) {
		return 'non-PII';
	}
	return 'Other';
}

function slug(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 80);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
