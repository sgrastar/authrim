/**
 * Identity mapping (which Mapping Set an OIDC app releases claims through, and where that was
 * decided): the shapes of the Admin API's answers, and the client the mapping pages take.
 *
 * Two kinds of call are typed here:
 * - **existing** — the shape the Admin API returns today, read from its handlers
 *   (`identity-mapping-effective.ts`, `identity-mapping-usage.ts`, the set facade,
 *   `routes/settings-v2/bulk-apply.ts`, `admin-clients.ts`);
 * - **proposed** — what the pages need and the API does not provide yet. Each is marked
 *   `PROPOSED` with the route it is planned as; until it lands, only the in-memory client
 *   (`fake/identity-mapping-fake.ts`) answers it. The page stories carry the `api-pending` tag.
 *
 * Pages never work out which set applies or which claims are released: they show what these
 * calls return (the runtime's own selection and release), with where it was decided.
 */

/** The levels of the order, the app's first. */
export type MappingTier = 'client' | 'tenant_default' | 'platform_default';

/**
 * What one level says. `unset` falls to the next level; `none` is an explicit opt-out (an app's
 * `{mode:'none'}`, a tenant's `none`); `invalid` is a value that is not a choice (the selection
 * fails rather than fall through); `not_consulted`: decided above, not read.
 */
export type ChainState = 'unset' | 'set' | 'none' | 'invalid' | 'not_consulted';

/**
 * What the Admin database says of a set a level names (absent when it could not be read). It is
 * the set's record only: `active` does not prove the set can be used at runtime (it may have no
 * activation or compiled snapshot); that is what the explanation's `outcome` says.
 */
export interface SetFacts {
	setFound?: boolean;
	setName?: string;
	setOwner?: 'tenant' | 'platform';
	setLifecycleState?: string;
}

export interface ChainEntry extends SetFacts {
	tier: MappingTier;
	state: ChainState;
	setId?: string;
	/** For the two defaults: `kv` saved at the tenant itself, `platform` inherited. */
	source?: string;
}

export type NoneReason = 'client_opt_out' | 'tenant_opt_out' | 'no_default';

export type EffectiveSelection =
	| ({ kind: 'bound'; tier: MappingTier; setId: string; pinnedVersionId?: string } & SetFacts)
	| { kind: 'none'; reason: NoneReason }
	| { kind: 'failed'; code: string; tier?: MappingTier; reason?: string };

export interface ImplicitActivationWarning {
	code: 'implicit_activation_no_longer_applies';
	activations: Array<{ activationId: string; setId: string; setName?: string }>;
}

/** existing: GET /api/admin/identity-mapping/effective[?client_id=] */
export interface EffectiveMapping {
	tenantId: string;
	clientId: string | null;
	selection: EffectiveSelection;
	chain: ChainEntry[];
	warnings: ImplicitActivationWarning[];
	warnings_unavailable?: true;
}

/** existing: one row of GET /api/admin/identity-mapping/sets */
export interface MappingSetSummary {
	id: string;
	owner: 'tenant' | 'platform';
	field_mapping_key: string;
	display_name: string | null;
	description: string | null;
	enabled: boolean;
	active_version_id: string | null;
	version_label: string | null;
	content_version: string;
	/** Milliseconds since the epoch, as the repository keeps them. */
	created_at: number;
	updated_at: number;
}

export type ReferenceKind =
	| 'platform_default'
	| 'tenant_default'
	| 'client'
	| 'saml_provider'
	| 'credential_profile'
	| 'federation_trust_source'
	| 'scim';

/** existing: GET /api/admin/identity-mapping/usage?set_id= */
export interface MappingSetUsage {
	setId: string;
	owner: 'tenant' | 'platform';
	usage: {
		count: number;
		countIsLowerBound: boolean;
		items: Array<{ kind: ReferenceKind; tenantId?: string; clientId?: string }>;
		itemsTruncated: boolean;
		otherTenants?: { referenceCount: number; tenantCount: number; scanned: boolean };
		scanComplete: boolean;
		unscanned: { count: number; items: Array<{ area: string; tenantId?: string; reason: string }> };
	};
	blocksChange: boolean | null;
}

// ---------------------------------------------------------------------------------------------
// Bulk apply (existing: POST /api/admin/settings/bulk-apply, category `identity-mapping`)
// ---------------------------------------------------------------------------------------------

export const OIDC_DEFAULT_SET_KEY = 'identity_mapping.oidc_default_set_id';
export const IDENTITY_MAPPING_CATEGORY = 'identity-mapping';

export interface BulkApplyRequest {
	mode: 'preview' | 'apply';
	tenant_ids: string[];
	changes: Array<{ category: string; set?: Record<string, unknown>; clear?: string[] }>;
	/** A tenant that already has its own value: leave it (`skip`, the default) or replace it. */
	on_existing_override?: 'skip' | 'overwrite';
	/** tenant ID → category → the version the preview returned. Required for `apply`. */
	expected?: Record<string, Record<string, string>>;
}

export type PreviewAction = 'would_apply' | 'would_clear' | 'would_skip' | 'would_reject';

export interface CurrentValue {
	overridden: boolean;
	own: unknown;
	effective: unknown;
	source: string;
}

export interface PreviewChange {
	category: string;
	key: string;
	current: CurrentValue | null;
	proposed: unknown;
	action: PreviewAction;
	/** `existing_override`, `already_set`, `not_overridden`, `validation_failed`… */
	reason?: string;
	validation: { ok: boolean | null; errors?: Array<{ code: string; detail_code?: string }> };
	version: string | null;
}

/** What the `identity-mapping` impact provider says of one tenant (plain counts and codes). */
export type IdentityMappingImpact =
	| {
			available: true;
			applies: boolean;
			apps_total?: number;
			apps_following_default?: number;
			apps_with_unusable_choice?: number;
			/** PROPOSED: apps that name a set of their own (クライアント指定), not changed. */
			apps_with_own_set?: number;
			/** PROPOSED: apps that opted out (`{mode:'none'}`), not changed. */
			apps_opted_out?: number;
			warnings?: ImplicitActivationWarning[];
			warnings_unavailable?: true;
	  }
	| { available: false; reason: string };

export interface BulkPreviewResult {
	tenant_id: string;
	status: 'ready' | 'nothing_to_do' | 'rejected' | 'failed';
	reason?: string;
	changes: PreviewChange[];
	impact: { 'identity-mapping'?: IdentityMappingImpact };
}

export type ChangeStatus = 'applied' | 'cleared' | 'skipped' | 'rejected' | 'conflict' | 'failed';

export interface AppliedChange {
	category: string;
	key: string;
	status: ChangeStatus;
	reason?: string;
	detail_code?: string;
	previous: unknown;
	new: unknown;
	version_before: string | null;
	version_after: string | null;
}

export interface BulkApplyResult {
	tenant_id: string;
	status: ChangeStatus;
	reason?: string;
	error?: { code: string };
	changes: AppliedChange[];
}

export interface BulkApplyResponse<R> {
	bulk_id?: string;
	mode: 'preview' | 'apply';
	on_existing_override: 'skip' | 'overwrite';
	limits: { max_tenants_per_request: number; max_keys_per_request: number };
	summary: { tenants: number; by_status: Record<string, number> };
	results: R[];
}

// ---------------------------------------------------------------------------------------------
// PROPOSED: GET /api/admin/platform/identity-mapping/tenants (MAP-01, MAP-07)
// ---------------------------------------------------------------------------------------------

/** How the apps of one tenant choose. Counts only, with the same reading as the selection. */
export interface AppCounts {
	total: number;
	following_default: number;
	own_set: number;
	opted_out: number;
	unusable: number;
}

export interface PlatformTenantRow {
	tenant_id: string;
	display_name: string;
	/** The tenant level of the chain, for the tenant itself (no app). */
	tenant_default: ChainEntry;
	/** What an app of this tenant that names no set gets, from the selection. */
	effective: EffectiveSelection;
	/** Null when the tenant's apps could not be counted (`apps_unavailable` says why). */
	apps: AppCounts | null;
	apps_unavailable?: string;
}

export interface PlatformTenantsOverview {
	platform_default: ChainEntry;
	tenants: PlatformTenantRow[];
	generated_at: string;
}

// ---------------------------------------------------------------------------------------------
// PROPOSED: POST /api/admin/identity-mapping/explain (MAP-04)
// ---------------------------------------------------------------------------------------------

export type ExplainSurface = 'id_token' | 'userinfo';

/** Why a claim is not released. Fixed codes; never a value. */
export type ClaimDropReason =
	| 'value_missing'
	| 'value_empty'
	| 'scope_not_granted'
	| 'consent_missing'
	| 'not_in_set'
	| 'mapping_not_applied'
	| 'issuance_stopped';

export interface ExplainedClaim {
	claim: string;
	/** The Authrim attribute the set fills it from; null for claims Authrim gives itself. */
	field: string | null;
	/** `standard`: released by Authrim whatever the set; `mapping`: from the set. */
	origin: 'standard' | 'mapping' | 'requested';
	/**
	 * Whether the user has a value (never the value itself). `not_evaluated`: the value is worked
	 * out at sign-in (transforms, several attributes) and the explanation did not run that.
	 */
	value: 'present' | 'missing' | 'empty' | 'not_read' | 'not_evaluated';
	/** The scope that releases it, and whether the app was granted it. */
	scope: string | null;
	scope_granted: boolean;
	consent: 'not_required' | 'granted' | 'missing';
	/** Null when it depends on a value worked out at sign-in (`not_evaluated`) and nothing else stops it. */
	released: boolean | null;
	reason?: ClaimDropReason;
}

export interface ClaimExplanation {
	tenantId: string;
	clientId: string;
	surface: ExplainSurface;
	subject: { kind: 'test_user'; user_id: string };
	/** The scopes the app's last authorization asked for and was granted. */
	scopes: string[];
	selection: EffectiveSelection;
	chain: ChainEntry[];
	/** `stopped`: the set the selection names cannot be used, so no token is issued (MAP-06). */
	outcome: { kind: 'issued' } | { kind: 'stopped'; code: string; tier?: MappingTier };
	claims: ExplainedClaim[];
}

export interface TestUser {
	user_id: string;
	/** A label for test users (made up, never a real person). */
	label: string;
}

// ---------------------------------------------------------------------------------------------
// PROPOSED: POST /api/admin/identity-mapping/sets/{id}/preview-change (MAP-05)
// ---------------------------------------------------------------------------------------------

export type ClaimChangeKind =
	| 'added'
	| 'removed'
	| 'renamed'
	| 'source_changed'
	| 'transform_changed'
	| 'type_changed';

export interface ClaimChange {
	kind: ClaimChangeKind;
	claim: string;
	/** `renamed`: the claim name before. */
	previous_claim?: string;
	type_before?: string;
	type_after?: string;
}

export interface AppClaimChanges {
	tenant_id: string;
	client_id: string;
	name: string;
	/** Why this app uses the set (クライアント指定 / テナント既定 / プラットフォーム既定). */
	tier: MappingTier;
	/** Changes this app would see in its tokens, given the scopes it is granted. */
	changes: ClaimChange[];
	/** Changes to the set this app would not see, by the scope that holds them back. */
	held_back: Array<{ claim: string; scope: string }>;
}

export interface SampleClaimValue {
	claim: string;
	/** The side whose value the preview could not work out (it is decided at sign-in). */
	not_evaluated?: Array<'before' | 'after'>;
	/** A test user's value: made-up data, shown as is. Null when the claim is not sent. */
	before: string | null;
	after: string | null;
}

export interface SetChangePreview {
	setId: string;
	/** True when every place that uses the set was looked at (see usage). */
	usage_complete: boolean;
	apps: AppClaimChanges[];
	/**
	 * For a platform set, asked in the platform's context: how many apps of each tenant use it.
	 * The apps themselves are listed one tenant at a time.
	 */
	tenants?: Array<{ tenant_id: string; apps_using: number | null }>;
	sample: { user_id: string; claims: SampleClaimValue[] } | null;
}

/** The draft content sent for a preview: the same mappings a save would send. */
export interface SetContentDraft {
	/**
	 * Each claim, the attributes it reads and the transforms on the way (opaque here: the editor's
	 * own steps, kept as they are so an edit of a transform is a change too).
	 */
	mappings: Array<{ target: string; sources: string[]; steps?: unknown[] }>;
}

export interface SetContent {
	set: MappingSetSummary;
	mappings: SetContentDraft['mappings'];
	/** What a mapping may read (Authrim attributes) and fill (the claims the profile allows). */
	attributes: Array<{ key: string; type: string }>;
	claims: Array<{ key: string; type: string }>;
	/**
	 * How many places name the set, as the facade's GET returns it. A save of a set in use must
	 * send the count back (`confirm_impact`) and is refused (409, with the count it found) when it
	 * is not the count now. The GET does not look in other tenants, so for a platform set the
	 * count of the refusal is the one to confirm.
	 */
	references: { count: number; count_is_lower_bound: boolean; scan_complete: boolean } | null;
}

// ---------------------------------------------------------------------------------------------
// MAP-03: an app's choice (existing: PUT /api/admin/clients/{id} `identity_mapping`)
// ---------------------------------------------------------------------------------------------

export type ClientMappingChoice = { fieldMappingSetId: string } | { mode: 'none' } | null;

export interface AppSummary {
	client_id: string;
	name: string;
	identity_mapping: ClientMappingChoice;
}

// ---------------------------------------------------------------------------------------------
// PROPOSED: GET /api/admin/identity-mapping/history, POST …/history/{id}/restore (MAP-08)
// ---------------------------------------------------------------------------------------------

/** The value of one level before or after a change (a set, `none`, or not set). */
export interface LevelValue {
	state: 'unset' | 'set' | 'none';
	setId?: string;
	setName?: string;
}

export type NotRestorableReason = 'set_deleted' | 'set_inactive' | 'is_current';

export interface HistoryEntry {
	id: string;
	at: string;
	actor: { id: string; label: string };
	/** The level that changed: the tenant default, or one app's choice. */
	tier: 'tenant_default' | 'client';
	client_id?: string;
	client_name?: string;
	before: LevelValue;
	after: LevelValue;
	via: 'settings' | 'bulk_apply' | 'app' | 'restore';
	restorable: boolean;
	not_restorable_reason?: NotRestorableReason;
}

export interface RestorePreview {
	entry: HistoryEntry;
	/** The level now, and what restoring writes (the entry's `before`). */
	current: LevelValue;
	restores: LevelValue;
	/** Later changes to the same level that restoring also undoes. */
	later_changes: HistoryEntry[];
	/** What apps would see, as in MAP-05. */
	apps: AppClaimChanges[];
	/** Sent back with the restore: refused if the level changed since. */
	expected_version: string;
}

// ---------------------------------------------------------------------------------------------
// The client the pages take
// ---------------------------------------------------------------------------------------------

export interface IdentityMappingClient {
	/** existing: GET /api/admin/identity-mapping/sets (in the tenant's context, or the platform's). */
	sets(tenantId: string): Promise<{ sets: MappingSetSummary[] }>;
	/** existing: GET /api/admin/identity-mapping/effective */
	effective(tenantId: string, clientId?: string): Promise<EffectiveMapping>;
	/** existing: GET /api/admin/identity-mapping/usage */
	usage(tenantId: string, setId: string): Promise<MappingSetUsage>;
	/** existing: POST /api/admin/settings/bulk-apply, preview */
	bulkPreview(request: BulkApplyRequest): Promise<BulkApplyResponse<BulkPreviewResult>>;
	/** existing: POST /api/admin/settings/bulk-apply, apply (with an Idempotency-Key) */
	bulkApply(
		request: BulkApplyRequest,
		idempotencyKey: string
	): Promise<BulkApplyResponse<BulkApplyResult>>;
	/** existing: GET /api/admin/clients (the fields the mapping pages read). */
	apps(tenantId: string): Promise<AppSummary[]>;
	/** existing: PUT /api/admin/clients/{id} with `identity_mapping`. */
	setAppChoice(tenantId: string, clientId: string, choice: ClientMappingChoice): Promise<void>;

	/** PROPOSED: GET /api/admin/platform/identity-mapping/tenants */
	tenantsOverview(): Promise<PlatformTenantsOverview>;
	/** PROPOSED: GET /api/admin/identity-mapping/test-users */
	testUsers(tenantId: string): Promise<TestUser[]>;
	/** PROPOSED: POST /api/admin/identity-mapping/explain */
	explain(
		tenantId: string,
		request: { client_id: string; user_id: string; surface: ExplainSurface }
	): Promise<ClaimExplanation>;
	/** PROPOSED: POST /api/admin/identity-mapping/preview-effective (an app's choice, not saved). */
	previewChoice(
		tenantId: string,
		clientId: string,
		choice: ClientMappingChoice
	): Promise<EffectiveMapping>;
	/** PROPOSED: POST /api/admin/identity-mapping/sets/{id}/preview-change */
	previewSetChange(
		tenantId: string,
		setId: string,
		draft: SetContentDraft,
		sampleUserId?: string
	): Promise<SetChangePreview>;
	/**
	 * existing: GET /api/admin/identity-mapping/sets/{id}, with what its editor offers (the Authrim
	 * attributes and the claims of its destination profile). Simplified: the facade returns the
	 * whole content; the mock-up reads the mappings only.
	 */
	setContent(tenantId: string, setId: string): Promise<SetContent>;
	/**
	 * existing: PUT /api/admin/identity-mapping/sets/{id} (the facade's whole content; the mock-up
	 * sends the mappings only).
	 */
	saveSet(
		tenantId: string,
		setId: string,
		draft: SetContentDraft,
		confirmImpact: number | null
	): Promise<void>;
	/** PROPOSED: GET /api/admin/identity-mapping/history */
	history(tenantId: string): Promise<HistoryEntry[]>;
	/** PROPOSED: POST /api/admin/identity-mapping/history/{id}/restore with `preview: true` */
	previewRestore(tenantId: string, entryId: string): Promise<RestorePreview>;
	/** PROPOSED: POST /api/admin/identity-mapping/history/{id}/restore */
	restore(tenantId: string, entryId: string, expectedVersion: string): Promise<HistoryEntry>;
}
