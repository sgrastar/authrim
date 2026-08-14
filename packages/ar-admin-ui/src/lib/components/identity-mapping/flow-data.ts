import type {
	IdentityMappingCatalogSummary,
	IdentityMappingDestinationProfileSummary,
	IdentityMappingExternalSchemaSummary,
	IdentityMappingFieldMappingSetSummary,
	IdentityMappingProtocolSchemaSummary,
	IdentityMappingSchemaReadinessRow,
	IdentityMappingSourceProfileSummary
} from '$lib/api/admin-identity-mapping';
import type { CustomClaimSchema } from '$lib/api/admin-custom-claims';
import type {
	MappingAdapter,
	MappingEdge,
	MappingNode,
	MappingRisk,
	MappingSample,
	RuleDetail
} from './types';

interface IdentityMappingFlowInput {
	policies: IdentityMappingFieldMappingSetSummary[];
	catalogs: IdentityMappingCatalogSummary[];
	identitySchemas?: CustomClaimSchema[];
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
	examples?: unknown[];
	note?: string | null;
	allowedValues?: string[];
	valueMultiplicity?: 'single' | 'multi' | null;
	nullable?: boolean | null;
}

const defaultAdapters: MappingAdapter[] = ['SAML', 'CSV', 'OIDC', 'SCIM', 'DIRECTORY'];

const systemIdentityFields = [
	{
		id: 'system.identity.account_uuid',
		path: 'account_id',
		label: 'UUID',
		valueType: 'identifier',
		examples: ['018f4d65-6a49-7d3a-9b83-b2c3f4d5e6a7'],
		note: 'Canonical identity account UUID.',
		uiFieldOrder: 20
	},
	{
		id: 'system.identity.lifecycle_state',
		path: 'lifecycle_state',
		label: 'Lifecycle State',
		valueType: 'string',
		allowedValues: ['active', 'suspended', 'deleted'],
		examples: ['active'],
		note: 'Current lifecycle state of the identity account.',
		uiFieldOrder: 40
	},
	{
		id: 'system.identity.created_at',
		path: 'created_at',
		label: 'Created At',
		valueType: 'datetime',
		examples: ['2026-01-15T09:30:00Z'],
		note: 'Account creation timestamp.',
		uiFieldOrder: 50
	},
	{
		id: 'system.identity.updated_at',
		path: 'updated_at',
		label: 'Updated At',
		valueType: 'datetime',
		examples: ['2026-03-20T14:45:00Z'],
		note: 'Account update timestamp.',
		uiFieldOrder: 60
	}
] as const;

export function buildIdentityMappingFlowSamples(input: IdentityMappingFlowInput): MappingSample[] {
	const sourceProfiles = [
		...input.sourceProfiles.map(sourceProfileToProfile),
		...input.externalSchemas.map(externalSchemaToProfile),
		...input.protocolSchemas
			.filter((schema) => isSourceProtocol(schema.protocol))
			.map(protocolSchemaToSourceProfile)
	];
	const destinationProfiles = [
		...input.destinationProfiles.map(destinationProfileToProfile),
		...input.protocolSchemas.map(protocolSchemaToDestinationProfile)
	];
	const canonicalTargets = buildIdentityTargets(input.identitySchemas ?? []);

	if (
		sourceProfiles.length === 0 &&
		canonicalTargets.length === 0 &&
		destinationProfiles.length === 0
	) {
		return [];
	}

	if (sourceProfiles.length === 0) {
		const destinationOnlySample = buildDestinationOnlySample(
			destinationProfiles,
			canonicalTargets,
			input.policies.length
		);
		return destinationOnlySample ? [destinationOnlySample] : [];
	}

	return sourceProfiles.map((sourceProfile) =>
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
		sourceAdapter: sourceProfile.adapter,
		destinationAdapter: destinationAdapter,
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

function buildDestinationOnlySample(
	destinationProfiles: ProfileSchema[],
	canonicalTargets: MappingNode[],
	policyCount: number
): MappingSample | null {
	const destinationNodes = destinationProfiles.flatMap((profile) =>
		buildSchemaNodes(profile, 'destination')
	);
	if (destinationNodes.length === 0) return null;

	const nodes = [...canonicalTargets, ...destinationNodes];
	const rules = Object.fromEntries(nodes.map((node) => [node.ruleId, ruleForNode(node)]));
	const activeDestinationProfile = destinationProfiles.find(
		(profile) => profile.lifecycleState === 'active'
	);
	const displayProfile = activeDestinationProfile ?? destinationProfiles[0];
	const destinationAdapter =
		destinationProfiles.find((profile) => profile.adapter === 'OIDC')?.adapter ??
		displayProfile?.adapter ??
		'OIDC';

	return {
		id: 'destination-release-control-plane',
		title: 'Destination release',
		snapshot: displayProfile?.versionLabel ?? 'current',
		status: displayProfile?.lifecycleState ?? 'active',
		reviewGates: `${destinationNodes.length} destination fields`,
		sourceAdapter: 'CSV',
		destinationAdapter,
		activeRuleId: nodes[0]?.ruleId ?? 'empty-flow',
		metrics: [
			`0 / ${destinationNodes.length}`,
			`${Math.max(1, destinationProfiles.length)} schemas`,
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

function buildIdentityTargets(identitySchemas: CustomClaimSchema[]): MappingNode[] {
	const schemaTargets = buildCustomClaimTargets(identitySchemas);
	if (schemaTargets.length === 0) return [];
	return [...buildSystemIdentityTargets(), ...schemaTargets];
}

function buildSystemIdentityTargets(): MappingNode[] {
	return systemIdentityFields.map((field) =>
		canonicalTargetNode({
			id: field.id,
			stableFieldId: field.id,
			path: field.path,
			label: field.label,
			valueType: field.valueType,
			cardinality: 'single',
			classification: 'internal',
			storageTarget: 'System identity',
			uiGroupKey: 'system',
			uiGroupLabel: 'System',
			uiGroupOrder: -100,
			uiFieldOrder: field.uiFieldOrder,
			examples: Array.from(field.examples),
			note: field.note,
			allowedValues: 'allowedValues' in field ? Array.from(field.allowedValues) : undefined,
			valueMultiplicity: 'single',
			nullable: false,
			required: false
		})
	);
}

function buildCustomClaimTargets(schemas: CustomClaimSchema[]): MappingNode[] {
	return schemas
		.filter((schema) => schema.is_active !== 0 && schema.operation_status === 'active')
		.sort(
			(a, b) =>
				(a.ui_group_order ?? 0) - (b.ui_group_order ?? 0) ||
				(a.ui_field_order ?? a.display_order ?? 0) - (b.ui_field_order ?? b.display_order ?? 0) ||
				a.field_key.localeCompare(b.field_key)
		)
		.map((schema) =>
			canonicalTargetNode({
				id: schema.id,
				stableFieldId: `field.canonical.${schema.field_key}`,
				path: schema.field_key,
				label: schema.display_label || schema.field_key,
				valueType: schema.field_type,
				cardinality: schema.cardinality ?? 'single',
				classification: schema.is_pii ? 'pii' : 'internal',
				storageTarget: schema.is_pii ? 'PII attribute' : 'Profile attribute',
				uiGroupKey: schema.ui_group_key ?? 'custom',
				uiGroupLabel: schema.ui_group_label ?? 'Custom',
				uiGroupOrder: schema.ui_group_order,
				uiFieldOrder: schema.ui_field_order ?? schema.display_order,
				examples: examplesFromCustomClaim(schema),
				note: schema.description,
				allowedValues: allowedValuesFromCustomClaim(schema),
				valueMultiplicity: schema.cardinality === 'multi' ? 'multi' : 'single',
				nullable: schema.is_required ? false : null,
				required: Boolean(schema.is_required)
			})
		);
}

function examplesFromCustomClaim(schema: CustomClaimSchema): unknown[] | undefined {
	const parsed = parseJsonValue(schema.examples_json);
	const explicit = examplesFromParsedValue(parsed);
	if (explicit) return explicit;
	return inferredExamplesForField({
		key: schema.field_key,
		label: schema.display_label,
		type: schema.field_type,
		allowedValues: allowedValuesFromCustomClaim(schema)
	});
}

function allowedValuesFromCustomClaim(schema: CustomClaimSchema): string[] | undefined {
	if (schema.field_type !== 'enum') return undefined;
	const validationRules = parseJsonValue(schema.validation_rules);
	const values = isRecord(validationRules) ? validationRules.enum_values : undefined;
	if (!Array.isArray(values)) return undefined;
	const allowedValues = values.map(String).filter(Boolean);
	return allowedValues.length > 0 ? allowedValues : undefined;
}

function parseJsonValue(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	if (!value.trim()) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function canonicalTargetNode(input: {
	id: string;
	stableFieldId: string;
	path: string;
	label: string;
	valueType: string;
	cardinality: string;
	classification: string;
	storageTarget: string;
	uiGroupKey?: string | null;
	uiGroupLabel?: string | null;
	uiGroupOrder?: number;
	uiFieldOrder?: number;
	examples?: unknown[];
	note?: string | null;
	allowedValues?: string[];
	valueMultiplicity?: 'single' | 'multi' | null;
	nullable?: boolean | null;
	required?: boolean | null;
}): MappingNode {
	return {
		id: `canonical-${slug(input.id)}`,
		ruleId: `canonical-${slug(input.id)}`,
		role: 'target',
		fieldRef: {
			namespace: 'authrim.profile',
			path: input.path,
			catalogEntryId: input.stableFieldId
		},
		label: input.label,
		caption: '',
		type: displayValueType(input.valueType),
		storageTarget: input.storageTarget,
		uiGroupKey: input.uiGroupKey,
		uiGroupLabel: input.uiGroupLabel,
		uiGroupOrder: input.uiGroupOrder,
		uiFieldOrder: input.uiFieldOrder,
		examples: input.examples,
		note: input.note,
		allowedValues: input.allowedValues,
		valueMultiplicity: input.valueMultiplicity,
		nullable: input.nullable,
		inputCardinality: input.cardinality === 'multi' ? 'many' : 'one',
		locked: input.stableFieldId === 'field.canonical.subject_id',
		privacy: privacyFrom(input.classification),
		required: input.required ?? isRequiredCanonicalTarget(input.stableFieldId)
	};
}

function buildSchemaNodes(profile: ProfileSchema, role: 'source' | 'destination'): MappingNode[] {
	const fields = extractSchemaFields(profile.schema, profile.source);
	if (fields.length === 0 && !profile.schema) return [];
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

	return extractedFields.slice(0, 64).map((field, index) => {
		const nodeKey = `${role}-${slug(profile.id)}-${slug(field.key, `field-${index + 1}`)}-${index}`;
		return {
			id: nodeKey,
			ruleId: nodeKey,
			role,
			fieldRef: {
				namespace: namespaceForProfile(profile.adapter),
				path: field.key
			},
			adapter: profile.adapter,
			profileId: profile.id,
			profileTitle: profile.title,
			label: field.label,
			caption: field.caption,
			type: displayValueType(field.type),
			privacy: field.privacy,
			required: field.required,
			examples: field.examples,
			note: field.note,
			allowedValues: field.allowedValues,
			valueMultiplicity: field.valueMultiplicity,
			nullable: field.nullable
		};
	});
}

function extractSchemaFields(
	schema: Record<string, unknown> | null,
	fallbackKey: string
): ExtractedField[] {
	if (!schema) return [];

	const allowInlineRequired = schema.destinationType !== 'saml';
	const required = new Set(
		allowInlineRequired && Array.isArray(schema.required) ? schema.required.map(String) : []
	);
	const candidates = [
		fieldsFromArray(schema.attributes, required, allowInlineRequired),
		fieldsFromArray(schema.fields, required, allowInlineRequired),
		fieldsFromArray(schema.columns, required, allowInlineRequired),
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

function fieldsFromArray(
	value: unknown,
	required: Set<string>,
	allowInlineRequired = true
): ExtractedField[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (typeof item === 'string') {
			return [
				{
					key: item,
					label: item,
					caption: 'schema field',
					required: required.has(item),
					examples: inferredExamplesForField({ key: item, label: item })
				}
			];
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
		const allowedValues = allowedValuesFromRecord(item);
		return [
			{
				key,
				label: stringValue(item.label) ?? key,
				caption: stringValue(item.description) ?? type ?? 'schema field',
				type,
				required: required.has(key) || (allowInlineRequired && item.required === true),
				privacy: privacyFrom(`${key} ${stringValue(item.classification) ?? ''}`),
				examples:
					examplesFromRecord(item) ??
					inferredExamplesForField({
						key,
						label: stringValue(item.label),
						type,
						allowedValues
					}),
				note: noteFromRecord(item),
				allowedValues,
				valueMultiplicity: valueMultiplicityFromRecord(item),
				nullable: nullableFromRecord(item)
			}
		];
	});
}

function fieldsFromClaims(value: unknown, required: Set<string>): ExtractedField[] {
	if (Array.isArray(value)) return fieldsFromArray(value, required);
	if (!isRecord(value)) return [];
	return Object.entries(value).map(([key, claim]) => {
		const record = isRecord(claim) ? claim : null;
		const type = record ? stringValue(record.type) : undefined;
		const allowedValues = record ? allowedValuesFromRecord(record) : undefined;
		return {
			key,
			label: key,
			caption: record ? (stringValue(record.description) ?? 'claim') : 'claim',
			type,
			required: required.has(key),
			privacy: privacyFrom(key),
			examples:
				(record ? examplesFromRecord(record) : undefined) ??
				inferredExamplesForField({ key, type, allowedValues }),
			note: record ? noteFromRecord(record) : null,
			allowedValues,
			valueMultiplicity: record ? valueMultiplicityFromRecord(record) : null,
			nullable: record ? nullableFromRecord(record) : null
		};
	});
}

function fieldsFromProperties(value: unknown, required: Set<string>): ExtractedField[] {
	if (!isRecord(value)) return [];
	return Object.entries(value).map(([key, property]) => {
		const record = isRecord(property) ? property : null;
		const type = record ? stringValue(record.type) : undefined;
		const allowedValues = record ? allowedValuesFromRecord(record) : undefined;
		return {
			key,
			label: key,
			caption: record ? (stringValue(record.description) ?? 'property') : 'property',
			type,
			required: required.has(key),
			privacy: privacyFrom(key),
			examples:
				(record ? examplesFromRecord(record) : undefined) ??
				inferredExamplesForField({ key, type, allowedValues }),
			note: record ? noteFromRecord(record) : null,
			allowedValues,
			valueMultiplicity: record ? valueMultiplicityFromRecord(record) : null,
			nullable: record ? nullableFromRecord(record) : null
		};
	});
}

function allowedValuesFromRecord(record: Record<string, unknown>): string[] | undefined {
	const value = record.allowedValues ?? record.allowed_values ?? record.enum ?? record.enums;
	if (!Array.isArray(value)) return undefined;
	const values = Array.from(
		new Set(
			value
				.map(String)
				.map((item) => item.trim())
				.filter(Boolean)
		)
	);
	return values.length > 0 ? values : undefined;
}

function valueMultiplicityFromRecord(record: Record<string, unknown>): 'single' | 'multi' | null {
	const value =
		record.valueMultiplicity ??
		record.value_multiplicity ??
		record.multiplicity ??
		record.cardinality;
	if (value === 'single' || value === 'multi') return value;
	if (value === 'one') return 'single';
	if (value === 'many' || value === 'multiple') return 'multi';
	return null;
}

function nullableFromRecord(record: Record<string, unknown>): boolean | null {
	if (typeof record.nullable === 'boolean') return record.nullable;
	if (typeof record.notNullable === 'boolean') return !record.notNullable;
	if (typeof record.not_null === 'boolean') return !record.not_null;
	return null;
}

function examplesFromRecord(record: Record<string, unknown>): unknown[] | undefined {
	for (const key of [
		'examples',
		'exampleValues',
		'example_values',
		'sampleValues',
		'sample_values',
		'samples',
		'values'
	]) {
		const value = record[key];
		if (Array.isArray(value)) return value;
	}
	const sampleValue =
		record.sampleValue ??
		record.sample_value ??
		record.example ??
		record.defaultExample ??
		record.default_example;
	return sampleValue === undefined ? undefined : [sampleValue];
}

function examplesFromParsedValue(value: unknown): unknown[] | undefined {
	if (Array.isArray(value)) return compactExamples(value);
	if (isRecord(value)) return compactExamples(examplesFromRecord(value) ?? []);
	if (value !== undefined && value !== null) return [value];
	return undefined;
}

function compactExamples(values: unknown[]): unknown[] | undefined {
	const compacted = values
		.flatMap((value) => (Array.isArray(value) ? value : [value]))
		.filter((value) => value !== undefined && value !== null && String(value).trim() !== '');
	return compacted.length > 0 ? compacted : undefined;
}

function inferredExamplesForField(input: {
	key: string;
	label?: string | null;
	type?: string | null;
	allowedValues?: string[];
}): unknown[] | undefined {
	if (input.allowedValues && input.allowedValues.length > 0) {
		return input.allowedValues.slice(0, 3);
	}

	const key = input.key.toLowerCase();
	const label = (input.label ?? '').toLowerCase();
	const haystack = `${key} ${label}`;
	const type = displayValueType(input.type ?? undefined);

	if (haystack.includes('email_verified')) return [true];
	if (haystack.includes('phone_number_verified')) return [false];
	if (haystack.includes('email') || haystack === 'mail') return ['taro.yamada@example.edu'];
	if (haystack.includes('phone')) return ['+81-3-1234-5678'];
	if (haystack.includes('given_name') || haystack.includes('first_name')) return ['Taro'];
	if (haystack.includes('family_name') || haystack.includes('last_name') || key === 'sn') {
		return ['Yamada'];
	}
	if (haystack.includes('middle_name')) return ['Quincy'];
	if (haystack.includes('display_name') || haystack.includes('full_name') || key === 'name') {
		return ['Taro Yamada'];
	}
	if (haystack.includes('nickname')) return ['taro', 'yamada_t'];
	if (haystack.includes('preferred_username') || haystack.includes('username')) {
		return ['taro.yamada'];
	}
	if (haystack.includes('picture') || haystack.includes('avatar')) {
		return ['https://example.edu/users/taro.yamada/photo.jpg'];
	}
	if (haystack.includes('profile')) return ['https://example.edu/users/taro.yamada'];
	if (haystack.includes('website')) return ['https://example.edu'];
	if (haystack.includes('gender')) return ['female'];
	if (haystack.includes('birthdate')) return ['1970-01-01'];
	if (haystack.includes('zoneinfo') || haystack.includes('time_zone')) return ['Asia/Tokyo'];
	if (haystack.includes('locale')) return ['ja-JP'];
	if (haystack.includes('country')) return ['JP'];
	if (haystack.includes('postal')) return ['100-0001'];
	if (haystack.includes('locality') || haystack.includes('city')) return ['Tokyo'];
	if (haystack.includes('region') || haystack.includes('prefecture')) return ['Tokyo'];
	if (haystack.includes('street')) return ['1-1 Chiyoda'];
	if (haystack.includes('address')) return ['1-1 Chiyoda, Tokyo, Japan'];
	if (haystack.includes('organization') || key === 'o') return ['Example University'];
	if (haystack.includes('department') || haystack.includes('organizational_unit') || key === 'ou') {
		return ['Library Services'];
	}
	if (haystack.includes('group')) return [['students', 'library-users']];
	if (haystack.includes('entitlement')) return [['urn:example:entitlement:library']];
	if (haystack.includes('updated_at') || haystack.includes('created_at')) {
		return ['2026-01-15T09:30:00Z'];
	}
	if (haystack.includes('uuid')) return ['018f4d65-6a49-7d3a-9b83-b2c3f4d5e6a7'];
	if (haystack.includes('subject')) return ['sub_9f8e7d6c5b4a3210'];
	if (haystack.endsWith(' id') || key === 'id' || key.endsWith('_id')) {
		return ['usr_01J7Z4W2M8Q8Y9N6T3V2K1A0BC'];
	}

	if (type === 'Boolean') return [true];
	if (type === 'Number') return [12345];
	if (type === 'Date') return ['2026-01-15T09:30:00Z'];
	if (type === 'Array') return [['value-1', 'value-2']];
	if (type === 'JSON') return [{ value: 'example' }];
	if (type === 'String') return ['example'];
	return undefined;
}

function noteFromRecord(record: Record<string, unknown>): string | null {
	return (
		stringValue(record.note) ??
		stringValue(record.notes) ??
		stringValue(record.helpText) ??
		stringValue(record.help_text) ??
		stringValue(record.description) ??
		null
	);
}

function ruleForNode(node: MappingNode): RuleDetail {
	const isPii = node.privacy === 'PII';
	const isLocked = node.locked === true;
	const risk: MappingRisk = isPii ? 'medium' : node.required ? 'medium' : 'low';
	return {
		title: node.label,
		risk,
		source:
			node.role === 'source' ? `${node.adapter ?? 'source'} / ${node.label}` : 'Not connected',
		target: node.role === 'target' ? node.label : 'No schema field selected',
		destination:
			node.role === 'destination'
				? `${node.adapter ?? 'destination'} / ${node.label}`
				: 'Not connected',
		transform: isLocked ? 'managed by subject identifier strategy' : 'not configured',
		validation: isLocked
			? 'locked subject identifier; configure strategy instead'
			: node.required
				? 'required by loaded schema'
				: 'loaded from control-plane schema',
		release: 'not configured',
		storageTarget: node.storageTarget,
		consentStatus: isPii ? 'required' : 'not_required',
		legalBasis: isPii ? 'consent' : 'legitimate_interest',
		purpose: node.role === 'destination' ? 'attribute_release' : 'identity_mapping',
		attributeSetHash: 'not configured',
		consentMode: isPii ? 'until_attributes_change' : 'not_applicable',
		releaseFieldMappingVersion: 'not configured',
		termsVersion: isPii ? 'tenant default required' : 'not_required',
		privacyFieldMappingVersion: isPii ? 'tenant default required' : 'not_required',
		denyReason: 'none',
		runtime: 'loaded control-plane schema',
		conflict: 'not evaluated',
		disclosure: 'redacted summary',
		dryrunStatus: 'unmapped',
		dryrunTone: node.required ? 'warn' : 'ok',
		input: node.role === 'source' ? `[schema field: ${node.label}]` : 'No runtime input selected.',
		output:
			node.role === 'destination' ? `[projection field: ${node.label}]` : 'No mapping edge yet.',
		trace: `${node.label} is loaded from the field mapping control-plane API.`,
		review: isLocked ? 'strategy review' : node.required ? 'required mapping review' : '0 tasks',
		replay: 'no',
		diffSeverity: risk,
		diffTitle: 'Control-plane schema node',
		diff: isLocked
			? [
					'This node is generated from the current field mapping API response.',
					'Subject identifiers are generated by subject identifier strategy, not by direct field mapping.'
				]
			: [
					'This node is generated from the current field mapping API response.',
					'No mapping rule is inferred until an operator connects source, identity schema field, and destination.'
				]
	};
}

function displayName(value: string | undefined, fallback: string): string {
	return value?.trim() || fallback;
}

function displayValueType(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = value.toLowerCase();
	if (
		['string', 'text', 'email', 'phone', 'url', 'uri', 'identifier', 'locale'].includes(normalized)
	) {
		return 'String';
	}
	if (['date', 'datetime', 'timestamp'].includes(normalized)) return 'Date';
	if (['boolean', 'bool'].includes(normalized)) return 'Boolean';
	if (['number', 'integer', 'int', 'float', 'double'].includes(normalized)) return 'Number';
	if (['json', 'object'].includes(normalized)) return 'JSON';
	if (['array', 'list', 'multi-value', 'multivalue'].includes(normalized)) return 'Array';
	if (normalized === 'enum') return 'String';
	return titleCase(value);
}

function isRequiredCanonicalTarget(stableFieldId: string): boolean {
	return ['field.canonical.subject_id', 'field.canonical.email'].includes(stableFieldId);
}

function titleCase(value: string): string {
	return value
		.replace(/[_./-]+/g, ' ')
		.trim()
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function adapterFrom(value: string): MappingAdapter {
	const normalized = value.toLowerCase();
	return defaultAdapters.find((adapter) => normalized.includes(adapter.toLowerCase())) ?? 'CSV';
}

function namespaceForProfile(adapter: MappingAdapter): string {
	switch (adapter) {
		case 'OIDC':
			return 'oidc.claim';
		case 'SAML':
			return 'saml.attribute';
		case 'SCIM':
			return 'scim.attribute';
		case 'DIRECTORY':
			return 'directory';
		case 'CSV':
			return 'csv.column';
	}
}

function isSourceProtocol(protocol: string): boolean {
	return ['csv', 'scim', 'saml', 'oidc', 'directory'].includes(protocol.toLowerCase());
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
		normalized.includes('internal') ||
		normalized.includes('non-pii') ||
		normalized.includes('group') ||
		normalized.includes('policy') ||
		normalized.includes('lifecycle') ||
		normalized.includes('account')
	) {
		return 'non-PII';
	}
	return 'Other';
}

function slug(input: string, fallback = 'item'): string {
	const normalized = input
		.toLowerCase()
		.normalize('NFKC')
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 80);
	if (normalized) return normalized;
	return `${fallback}-${shortHash(input)}`;
}

function shortHash(input: string): string {
	let hash = 0;
	for (const char of input) {
		hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
	}
	return hash.toString(36);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
