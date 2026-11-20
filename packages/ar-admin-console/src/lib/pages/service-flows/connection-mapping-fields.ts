import type { FieldRef } from '@authrim/ar-lib-field-mapping/contract';
import type {
	DestinationDescriptor,
	MappingCatalog,
	MappingDestinationProfile,
	MappingSetContent
} from '#lib/api/mapping-set.js';
import type { MappingCodecContext, MappingCodecField } from '#lib/ui/patterns/mapping-codec.js';
import type { MappingType } from '#lib/ui/patterns/mapping-model.js';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

function valueType(value: unknown, multi: boolean): MappingType {
	if (multi) {
		if (value && value !== 'string') throw new Error('Unsupported multi-valued field type');
		return 'string[]';
	}
	if (!value || ['email', 'url', 'uri', 'uuid', 'text', 'phone'].includes(String(value)))
		return 'string';
	if (value === 'integer') return 'number';
	if (value === 'datetime') return 'date';
	if (
		value === 'string' ||
		value === 'number' ||
		value === 'boolean' ||
		value === 'date' ||
		value === 'object'
	)
		return value;
	if (value === 'json') return 'object';
	// A SAML-specific value kind (a persistent NameID) carries text.
	if (typeof value === 'string' && value.startsWith('saml:')) return 'string';
	throw new Error('Unsupported field type');
}

/** Existing profile schemas supply candidates only; this screen never edits their definition. */
export function profileDescriptor(profile: MappingDestinationProfile): DestinationDescriptor {
	if (
		!profile.version ||
		(profile.destinationType !== 'oidc' && profile.destinationType !== 'saml')
	)
		throw new Error('An active release profile is required');
	const schema = profile.version.schema;
	const rows = profile.destinationType === 'oidc' ? schema.claims : schema.attributes;
	if (!Array.isArray(rows)) throw new Error('Unsupported Destination Profile');
	const fields = rows.map((row): DestinationDescriptor['fields'][number] => {
		if (!isRecord(row)) throw new Error('Invalid profile field');
		const key = profile.destinationType === 'oidc' ? row.claimName : row.name;
		if (typeof key !== 'string' || !key) throw new Error('Invalid profile field');
		return {
			key,
			label: typeof row.label === 'string' ? row.label : key,
			required: profile.destinationType === 'oidc' && (row.required === true || key === 'sub'),
			nullable: row.nullable === true,
			classification: typeof row.classification === 'string' ? row.classification : 'internal',
			surfaces: [],
			requiredScopes: [],
			allowedValues: [],
			valueType:
				typeof row.valueType === 'string'
					? row.valueType
					: typeof row.type === 'string'
						? row.type
						: null,
			valueMultiplicity: row.valueMultiplicity === 'multi' ? 'multi' : 'single'
		};
	});
	return {
		profileId: profile.id,
		profileVersionId: profile.version.id,
		destinationType: profile.destinationType,
		fields,
		...(isRecord(schema.nameId)
			? {
					nameId: {
						format: typeof schema.nameId.format === 'string' ? schema.nameId.format : null,
						classification:
							typeof schema.nameId.classification === 'string'
								? schema.nameId.classification
								: 'internal'
					}
				}
			: {})
	};
}

function ref(value: Record<string, unknown>): FieldRef & { profileId?: string } {
	if (
		(value.side !== 'source' && value.side !== 'destination') ||
		typeof value.namespace !== 'string' ||
		typeof value.path !== 'string'
	)
		throw new Error('Unsupported field reference');
	return { ...value, side: value.side, namespace: value.namespace, path: value.path };
}

export function codecContext(
	protocol: 'oidc' | 'saml',
	descriptor: DestinationDescriptor,
	catalog: MappingCatalog,
	content: MappingSetContent
): MappingCodecContext {
	if (descriptor.destinationType !== protocol)
		throw new Error('The Mapping Set uses another protocol');
	const sources: MappingCodecField[] = catalog.entries
		.filter((entry) => entry.namespace.startsWith('authrim.'))
		.map((entry) => {
			const stored = content.rules
				.flatMap((rule) => rule.edges ?? [])
				.find(
					(edge) =>
						edge.sourceRef.namespace === entry.namespace && edge.sourceRef.path === entry.path
				)?.sourceRef;
			return {
				key:
					catalog.entries.filter((other) => other.path === entry.path).length > 1
						? `${entry.namespace}:${entry.path}`
						: entry.path,
				label: entry.path,
				type: valueType(entry.valueType, entry.cardinality === 'multi'),
				ref: stored ? ref(stored) : { side: 'source', namespace: entry.namespace, path: entry.path }
			};
		});
	const targets: MappingCodecField[] = descriptor.fields.map((field) => ({
		key: field.key,
		label: field.label,
		required: field.required,
		type: valueType(field.valueType, field.valueMultiplicity === 'multi'),
		ref: {
			side: 'destination',
			namespace: protocol === 'oidc' ? 'oidc.claim' : 'saml.attribute',
			path: field.key,
			profileId: descriptor.profileId
		}
	}));
	if (protocol === 'saml' && descriptor.nameId)
		targets.push({
			key: 'NameID',
			label: 'NameID',
			type: 'string',
			required: true,
			ref: {
				side: 'destination',
				namespace: 'saml.nameid',
				path: 'NameID',
				profileId: descriptor.profileId
			}
		});
	for (const target of targets) {
		const stored = content.rules.find(
			(rule) =>
				rule.targetRef?.namespace === target.ref.namespace &&
				(target.ref.namespace === 'saml.nameid' || rule.targetRef?.path === target.ref.path)
		)?.targetRef;
		if (stored) target.ref = ref(stored);
	}
	return { protocol, profileId: descriptor.profileId, sources, targets };
}
