import type {
	IdentityMappingClient,
	MappingSetSaved,
	MappingSetSaveRequest,
	MappingWriteOptions
} from '#lib/api/identity-mapping.js';
import type {
	DestinationDescriptor,
	MappingCatalog,
	MappingDestinationProfile,
	MappingSetDetail,
	MappingSetContent,
	MappingMutationOutcome
} from '#lib/api/mapping-set.js';
import { compileMapping } from '#lib/ui/patterns/mapping-codec.js';
import { copyValue } from '#lib/ui/save/draft.svelte.js';
import { codecContext } from './connection-mapping-fields.js';
import type { ConnectionMappingResources } from './connection-mapping.svelte.js';

export type MappingScenario =
	| 'shared'
	| 'impact'
	| 'conflict'
	| 'stage'
	| 'unknown'
	| 'binding'
	| 'readonly';

/** Injected HTTP-contract fixture for the existing connection screen; never installed in a live route. */
export function connectionMappingFixture(
	scenario: MappingScenario = 'shared',
	protocol: 'oidc' | 'saml' = 'oidc'
) {
	const events: string[] = [];
	const requests: {
		request: MappingSetSaveRequest;
		options: MappingWriteOptions | null;
		key: string;
	}[] = [];
	const catalog: MappingCatalog = {
		id: 'catalog',
		tenantId: 'demo',
		catalogKey: 'canonical',
		displayName: 'Authrim attributes',
		lifecycleState: 'active',
		versionId: 'catalog-v1',
		versionLabel: '1',
		bundleHash: null,
		entries: ['email', 'name'].map((key) => ({
			id: `entry-${key}`,
			stableFieldId: `field.profile.${key}`,
			namespace: 'authrim.profile',
			path: key,
			valueType: 'string',
			cardinality: 'single',
			targetTaxonomy: 'canonical'
		}))
	};
	const descriptor: DestinationDescriptor = {
		profileId: 'profile',
		profileVersionId: 'profile-v1',
		destinationType: protocol,
		fields: ['email', 'name'].map((key) => ({
			key,
			label: key,
			required: false,
			nullable: false,
			classification: 'pii',
			surfaces: protocol === 'oidc' ? ['id_token', 'userinfo'] : ['saml_assertion'],
			requiredScopes: [],
			valueType: 'string',
			valueMultiplicity: 'single',
			allowedValues: []
		}))
	};
	const profile: MappingDestinationProfile = {
		id: 'profile',
		tenantId: 'demo',
		destinationType: protocol,
		profileKey: 'recipient',
		displayName: protocol === 'oidc' ? 'Portal claims' : 'Portal attributes',
		ownerScopeType: 'tenant',
		ownerScopeId: 'demo',
		baseProfileId: null,
		lifecycleState: 'active',
		activeVersionId: 'profile-v1',
		version: {
			id: 'profile-v1',
			versionLabel: '1',
			lifecycleState: 'active',
			schemaHash: '',
			schema:
				protocol === 'oidc'
					? { claims: [{ claimName: 'email' }, { claimName: 'name' }] }
					: { attributes: [{ name: 'email' }, { name: 'name' }] },
			validationSummary: {},
			warningSummary: {},
			releaseImpact: {}
		}
	};
	const content: MappingSetContent = {
		catalogVersionId: 'catalog-v1',
		compatibilityRange: '^1',
		sourceProfileIds: ['canonical'],
		rules: []
	};
	const context = codecContext(protocol, descriptor, catalog, content);
	content.rules = ['email', 'name'].map((key) =>
		compileMapping({ id: `rule-${key}`, target: key, sources: [key], steps: [] }, context)
	);
	const initial: MappingSetDetail = {
		id: 'set-portal',
		owner: 'tenant',
		field_mapping_key: 'opaque-portal-key',
		display_name: 'Portal mapping',
		description: null,
		enabled: true,
		active_version_id: 'version-1',
		version_label: '1',
		content_version: 'version-1',
		created_at: 0,
		updated_at: 0,
		content,
		references: { count: 3, scan_complete: true },
		protocol,
		destination_profile_id: 'profile',
		destination_profile: descriptor,
		etag: '"version-1"'
	};
	if (scenario === 'readonly')
		initial.content = {
			...content,
			rules: content.rules.map((rule) => ({ ...rule, scope: { unsupported: true } }))
		};
	const sets = new Map([
		['set-portal', initial],
		[
			'set-shared',
			{
				...copyValue(initial),
				id: 'set-shared',
				field_mapping_key: 'opaque-shared-key',
				display_name: 'Shared staff mapping'
			}
		]
	]);
	let bound = 'set-portal';
	let failedOnce = false;
	const unused = async (): Promise<never> => {
		throw new Error('Not used by the connection screen');
	};
	async function save(
		setId: string,
		request: MappingSetSaveRequest,
		key: string,
		options: MappingWriteOptions | null
	): Promise<MappingMutationOutcome<MappingSetSaved>> {
		events.push('save');
		requests.push(copyValue({ request, key, options }));
		if (scenario === 'conflict') return { kind: 'conflict', status: 409, body: {} };
		if (scenario === 'stage') return { kind: 'stage_failed', stage: 'activate', body: {} };
		if (scenario === 'unknown' && !failedOnce) {
			failedOnce = true;
			return { kind: 'outcome_unknown', idempotencyKey: key, body: {} };
		}
		const previous = sets.get(setId) ?? initial;
		const saved: MappingSetDetail = {
			...copyValue(previous),
			id: setId,
			field_mapping_key: request.field_mapping_key ?? previous.field_mapping_key,
			display_name: request.display_name,
			description: request.description ?? null,
			content: copyValue(request.content),
			content_version: 'version-2',
			active_version_id: 'version-2',
			etag: '"version-2"'
		};
		sets.set(setId, saved);
		return {
			kind: 'success',
			value: {
				...saved,
				created: !options,
				version_id: 'version-2',
				snapshot_id: 'snapshot-2',
				previous_content_version: previous.content_version,
				summary: {
					rules: saved.content?.rules.length ?? 0,
					edges: 2,
					transforms: 0,
					validation_rules: 0,
					release_rules: 0,
					conflict_rules: 0,
					released_claims: ['email', 'name']
				}
			}
		};
	}
	const client: IdentityMappingClient = {
		sets: async () => ({ sets: copyValue([...sets.values()]) }),
		setContent: async (_tenant, id) => {
			const set = sets.get(id);
			if (!set) throw new Error('Missing set');
			return copyValue(set);
		},
		catalogs: async () => ({ catalogs: [copyValue(catalog)] }),
		destinationProfiles: async () => ({ destinationProfiles: [copyValue(profile)] }),
		createSet: async (_tenant, request, key) => save('set-created', request, key, null),
		saveSet: async (_tenant, id, request, options) =>
			save(id, request, options.idempotencyKey, options),
		previewSave: async () => ({
			preview: true,
			id: initial.id,
			owner: 'tenant',
			would_create: false,
			enabled: true,
			content_version: initial.content_version,
			valid: true,
			references: { count: 3, scan_complete: true },
			confirm_impact_required: scenario === 'impact'
		}),
		testUsers: async () => ({
			test_users: [
				{ user_id: 'test-user', label: 'Synthetic test user', attributes: {}, updated_at: 0 }
			],
			limits: { max_users: 10, max_attributes: 20 }
		}),
		explain: async (_tenant, request) => ({
			tenantId: 'demo',
			clientId: request.client_id,
			surface: request.surface,
			subject: { kind: 'test_user', user_id: request.subject.id },
			scopes: ['openid', 'profile', 'email'],
			consent: request.consent ?? 'all',
			selection: { kind: 'bound', tier: 'client', setId: bound },
			chain: [],
			warnings: [],
			outcome: { kind: 'issued' },
			claims: ['email', 'name'].map((claim) => ({
				claim,
				field: claim,
				sources: [claim],
				origin: 'mapping',
				value: 'present',
				scope: null,
				scope_granted: true,
				consent: request.consent === 'none' ? 'missing' : 'granted',
				released: request.consent !== 'none',
				...(request.consent === 'none' ? { reason: 'consent_missing' } : {})
			}))
		}),
		explainSaml: async (_tenant, request) => ({
			protocol: 'saml',
			tenantId: 'demo',
			sp_entity_id: request.sp_entity_id,
			subject: { kind: 'test_user', user_id: request.subject.id },
			consent: request.consent ?? 'all',
			fields: [{ field: 'email', policy: 'optional' }],
			before_consent: {
				items: [
					{
						key: 'email',
						kind: 'attribute',
						label: 'email',
						required: false,
						values: ['sample@example.test']
					},
					{ key: 'NameID', kind: 'nameid', label: 'NameID', required: true, deferred: true }
				]
			},
			after_consent: {
				status: 'failed',
				attributes: [{ name: 'email', values: ['sample@example.test'] }],
				nameid: { format: 'persistent', status: 'suppressed', reasons: ['test_user'] },
				identifier_evaluation: 'suppressed_for_test_user',
				error: { code: 'nameid_suppressed' }
			}
		}),
		deleteSet: unused,
		previewSetChange: async () => ({
			setId: initial.id,
			owner: 'tenant',
			changes: [],
			references: { count: 3, scan_complete: true },
			usage_complete: true,
			apps: [
				{
					tenant_id: 'demo',
					client_id: 'portal',
					name: 'Staff portal',
					tier: 'client',
					changes: [],
					held_back: []
				},
				{
					tenant_id: 'demo',
					client_id: 'other',
					name: 'Other staff app',
					tier: 'client',
					changes: [],
					held_back: []
				}
			],
			apps_truncated: false,
			sample: null
		}),
		replaceTestUsers: unused
	};
	const resources: ConnectionMappingResources = {
		client,
		tenantId: 'demo',
		protocol,
		connectionId: 'portal',
		connectionName: 'Staff portal',
		entityId: protocol === 'saml' ? 'https://portal.example.test/saml' : undefined,
		readBinding: async () => ({ setId: bound, pinned: false }),
		bind: async (set) => {
			events.push('bind');
			if (scenario === 'binding' && !failedOnce) {
				failedOnce = true;
				throw new Error('Binding unavailable');
			}
			bound = set.id;
		}
	};
	return { resources, events, requests, initial, catalog, profile };
}
