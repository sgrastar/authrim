import type { MappingValueReference } from '@authrim/ar-lib-field-mapping/contract';
import type { MappingSetSummary } from './identity-mapping';

/** Public facade content, matching MappingSetContent / MappingGraphRule in Admin OpenAPI. */
export interface MappingSetContent {
	catalogVersionId: string;
	compatibilityRange?: string;
	sourceProfileIds?: string[];
	rules: MappingSetRule[];
}

export interface MappingSetRule {
	ruleKey: string;
	ruleKind: string;
	action: string;
	targetRef?: Record<string, unknown>;
	output?: MappingValueReference;
	priority?: number;
	scope?: Record<string, unknown>;
	condition?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	edges?: {
		sourceRef: Record<string, unknown>;
		targetRef: Record<string, unknown>;
		edgeKind?: string;
	}[];
	transforms?: {
		operation: string;
		inputs?: MappingValueReference[];
		parameters?: Record<string, unknown>;
		targetRef?: Record<string, unknown>;
	}[];
	validationRules?: {
		targetRef: Record<string, unknown>;
		validationKind: string;
		severity?: string;
		parameters?: Record<string, unknown>;
	}[];
	releaseRules?: {
		destinationType: string;
		destinationId?: string;
		sourceRef: Record<string, unknown>;
		releaseAction: string;
		legalBasis?: string;
		purpose?: string;
		condition?: Record<string, unknown>;
		priority?: number;
	}[];
	conflictRules?: {
		targetRef: Record<string, unknown>;
		conflictStrategy: string;
		sourcePriority?: unknown[];
		condition?: Record<string, unknown>;
	}[];
}

export interface MappingReferences {
	count: number;
	count_is_lower_bound?: boolean;
	scan_complete?: boolean;
}
/** Impact refusals carry the reference scanner's camelCase summary. */
export interface MappingImpactReferences {
	count: number;
	countIsLowerBound?: boolean;
	items?: { kind: string; tenantId?: string; clientId?: string; [key: string]: unknown }[];
	itemsTruncated?: boolean;
	scanComplete?: boolean;
	otherTenants?: { referenceCount: number; tenantCount: number; scanned: boolean };
	unscanned?: { count: number; items: { area: string; tenantId?: string; reason: string }[] };
}
export interface DestinationDescriptor {
	profileId: string;
	profileVersionId: string;
	destinationType: 'oidc' | 'saml' | 'resource_server';
	fields: {
		key: string;
		label: string;
		required: boolean;
		nullable: boolean;
		classification: string;
		surfaces: string[];
		requiredScopes: string[];
		valueType: string | null;
		valueMultiplicity: 'single' | 'multi' | null;
		allowedValues: string[];
	}[];
	nameId?: { format: string | null; classification: string };
}
export interface MappingSetDetail extends MappingSetSummary {
	content: MappingSetContent | null;
	references: MappingReferences | null;
	protocol: 'oidc' | 'saml' | null;
	destination_profile_id: string | null;
	destination_profile: DestinationDescriptor | null;
	/** Exact response header, kept separately from the body version token. */
	etag: string | null;
}
export interface MappingSetSaveRequest {
	display_name: string;
	description?: string | null;
	field_mapping_key?: string;
	owner_scope_type?: 'tenant' | 'platform';
	enabled?: boolean;
	confirm_impact?: number;
	content: MappingSetContent;
}
export interface MappingSetSaved extends MappingSetSummary {
	created: boolean;
	version_id: string;
	snapshot_id: string;
	previous_content_version: string;
	summary: ContentSummary;
	etag: string | null;
}
export interface ContentSummary {
	rules: number;
	edges: number;
	transforms: number;
	validation_rules: number;
	release_rules: number;
	conflict_rules: number;
	released_claims: string[];
}
export type SaveStage = 'validate' | 'create_version' | 'publish' | 'compile' | 'activate';
export interface MappingSavePreview {
	preview: true;
	id: string | null;
	owner: 'tenant' | 'platform';
	would_create: boolean;
	enabled: boolean;
	content_version: string;
	valid: boolean;
	stage_failed?: SaveStage;
	error?: string;
	error_description?: string;
	validation?: { ok: true };
	compile?: { ok: true; catalog_version_id: string };
	activation?: {
		scope: Record<string, unknown> | null;
		deactivation_refusal: Record<string, unknown> | null;
	};
	diff?: {
		before: ContentSummary | null;
		after: ContentSummary;
		claims_added: string[];
		claims_removed: string[];
	};
	references?: MappingReferences;
	confirm_impact_required?: boolean;
}
export type MappingMutationOutcome<T> =
	| { kind: 'success'; value: T }
	| {
			kind: 'impact_confirmation_required';
			references: MappingImpactReferences | null;
			body: Record<string, unknown>;
	  }
	| { kind: 'conflict'; status: number; body: Record<string, unknown> }
	| { kind: 'stage_failed'; stage: string; body: Record<string, unknown> }
	| { kind: 'outcome_unknown'; idempotencyKey: string; body: Record<string, unknown> };
export interface MappingWriteOptions {
	idempotencyKey: string;
	/** Exact ETag or content_version from the current GET/save. Never a low-level version workflow. */
	version: string;
}
export interface MappingCatalog {
	id: string;
	tenantId: string;
	catalogKey: string;
	displayName: string;
	lifecycleState: string;
	versionId: string | null;
	versionLabel: string | null;
	bundleHash: string | null;
	entries: Array<{
		id: string;
		stableFieldId: string;
		namespace: string;
		path: string;
		valueType: string;
		cardinality: string;
		targetTaxonomy: string;
		[key: string]: unknown;
	}>;
}
export interface MappingDestinationProfile {
	id: string;
	tenantId: string;
	destinationType: string;
	profileKey: string;
	displayName: string;
	ownerScopeType: string;
	ownerScopeId: string | null;
	baseProfileId: string | null;
	lifecycleState: string;
	activeVersionId: string | null;
	version: {
		id: string;
		versionLabel: string;
		lifecycleState: string;
		schemaHash: string;
		schema: Record<string, unknown>;
		validationSummary: Record<string, unknown>;
		warningSummary: Record<string, unknown>;
		releaseImpact: Record<string, unknown>;
	} | null;
}

export interface MappingChange {
	kind:
		| 'added'
		| 'removed'
		| 'renamed'
		| 'source_changed'
		| 'transform_changed'
		| 'type_changed'
		| 'validation_changed'
		| 'profile_field_added'
		| 'profile_field_removed'
		| 'profile_field_changed';
	claim: string;
	profile_id: string | null;
	namespace: string;
	previous_claim?: string;
	previous_profile_id?: string | null;
	previous_namespace?: string;
	type_before?: string;
	type_after?: string;
	validation_effect?: 'may_reject' | 'validation_only';
	[key: string]: unknown;
}
/** Preview-change describes persisted drafts; it does not compile samples for release. */
export interface MappingSetChangePreview {
	setId: string;
	owner: 'tenant' | 'platform';
	protocol?: 'saml';
	changes: MappingChange[];
	references: MappingReferences;
	usage_complete: boolean;
	apps: {
		tenant_id: string;
		client_id: string;
		name: string;
		tier: 'client' | 'tenant_default' | 'platform_default';
		changes: MappingChange[];
		held_back: { claim: string; scope: string }[];
	}[];
	apps_truncated: boolean;
	tenants?: {
		tenant_id: string;
		apps_using?: number | null;
		apps_changed?: number | null;
		apps_count_is_lower_bound?: boolean;
		unavailable?: string;
		sps_using?: number;
		sps_changed?: number;
	}[];
	tenants_truncated?: boolean;
	defaults_unavailable?: string;
	sps?: {
		tenant_id: string;
		provider_id: string;
		sp_entity_id: string | null;
		name: string;
		changes: MappingChange[];
		held_back: { attribute: string; reason: string }[];
		pinned_version_id: string | null;
	}[];
	sps_truncated?: boolean;
	unresolved_sp_references?: unknown[];
	sample: null;
	sample_unavailable?: 'draft_not_compiled';
}
export interface SAMLExplainRequest {
	sp_entity_id: string;
	subject: { kind: 'test_user'; id: string };
	consent?: 'all' | 'none' | 'required';
}
/** Synthetic release data from the SAML facade; no account data or identifier material. */
export interface SAMLExplanation {
	protocol: 'saml';
	tenantId: string;
	sp_entity_id: string;
	subject: { kind: 'test_user'; user_id: string };
	consent: 'all' | 'none' | 'required';
	fields: { field: string; policy: string }[];
	before_consent: {
		status?: 'failed';
		items: {
			key: string;
			kind: 'nameid' | 'attribute';
			label: string;
			required: boolean;
			values?: string[];
			deferred?: boolean;
		}[];
		attributes?: SAMLReleasedAttribute[];
		deferred_attributes?: string[];
		nameid?: SAMLExplainedNameID;
		optional_missing_attributes?: string[];
		withheld_scoped_values?: unknown[];
		error?: { code: string; fields?: string[]; reasons?: string[] };
	};
	after_consent: {
		status: 'released' | 'failed' | 'awaiting_consent';
		attributes: SAMLReleasedAttribute[];
		nameid: SAMLExplainedNameID;
		optional_missing_attributes?: string[];
		identifier_evaluation?: 'suppressed_for_test_user';
		error?: { code: string; fields?: string[]; reasons?: string[] };
	};
}
export interface SAMLReleasedAttribute {
	name: string;
	nameFormat?: string;
	friendlyName?: string;
	values: string[];
}
export interface SAMLExplainedNameID {
	format: string;
	status: 'released' | 'deferred' | 'suppressed' | 'failed';
	value?: string;
	reasons?: string[];
}
