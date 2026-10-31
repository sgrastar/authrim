/**
 * FAKE identity-mapping API for Storybook and tests: an in-memory stand-in that answers as the
 * Admin API does (or, for the PROPOSED calls in `../identity-mapping.ts`, as it is planned to).
 * It plays the runtime too: the selection (app → tenant default → platform default → none, an
 * unusable set failing rather than falling through) and the release (scopes, consent, presence of
 * a value). Pages never compute either; they show what this returns, so wiring the real client
 * changes nothing in them. Data: `identity-mapping-fake-data.ts` (all made up).
 */
import { ApiError } from '../api-error';
import type {
	AppClaimChanges,
	BulkApplyRequest,
	BulkApplyResult,
	BulkPreviewResult,
	ChainEntry,
	ClaimChange,
	ClaimExplanation,
	ClientMappingChoice,
	EffectiveMapping,
	EffectiveSelection,
	ExplainConsent,
	ExplainedClaim,
	ExplainRequest,
	HistoryEntry,
	IdentityMappingClient,
	LevelValue,
	PlatformTenantRow,
	SetContentDraft
} from '../identity-mapping';
import { IDENTITY_MAPPING_CATEGORY, OIDC_DEFAULT_SET_KEY } from '../identity-mapping';
import {
	ATTRIBUTES,
	DEMO_TENANT,
	fakeApps,
	fakeHistory,
	fakeSets,
	fakeTenants,
	MAPPED_CLAIMS,
	PLATFORM,
	STANDARD_CLAIMS,
	TEST_USERS,
	type FakeApp,
	type FakeSet,
	type FakeTenant
} from './identity-mapping-fake-data';

export { DEMO_TENANT } from './identity-mapping-fake-data';

export interface FakeIdentityMappingOptions {
	/** The platform default (a platform set ID, or unset). */
	platformDefault?: string;
	/** Tenants whose first apply fails (the API answers `failed` for them once). */
	failOnce?: string[];
	/** The demo tenant's default set is switched off: its apps' tokens are not issued (MAP-06). */
	inactiveTenantSet?: boolean;
	/** Tenants whose impact cannot be counted (the provider answers `available: false`). */
	impactUnavailable?: string[];
	/** Tenants whose settings cannot be read (no tenant default; the selection fails). */
	settingsUnreadable?: string[];
	/** This apply request (1 = the first) fails as a whole once, as a lost request would. */
	failApplyRequest?: number;
	/** The most tenants one bulk-apply request may name (the API's default is 25). */
	bulkLimit?: number;
	/** The most tenants one page of the list holds (the API's is 100), to show paging. */
	pageSize?: number;
	/** Milliseconds every call waits (to show loading states). */
	delay?: number;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const copy = <T>(value: T): T => structuredClone(value);

export function createFakeIdentityMapping(
	options: FakeIdentityMappingOptions = {}
): IdentityMappingClient {
	const sets = fakeSets();
	if (options.inactiveTenantSet) {
		const target = sets.find((s) => s.id === 'fms_aster')!;
		target.enabled = false;
		target.active_version_id = null;
	}
	const tenants = fakeTenants();
	const apps = fakeApps();
	let history = fakeHistory();
	const platformDefault = options.platformDefault;
	const failOnce = new Set(options.failOnce ?? []);
	const applied = new Map<string, unknown>();

	const pause = () => wait(options.delay ?? 120);
	const bulkLimit = options.bulkLimit ?? 25;
	let applyRequests = 0;
	/** As the API: a request naming more tenants than the limit is refused whole. */
	const refuseTooMany = (request: BulkApplyRequest) => {
		if (request.tenant_ids.length > bulkLimit) {
			throw new ApiError(400, 'invalid_request', 'Too many tenants', {
				error: 'invalid_request',
				code: 'too_many_tenants',
				limit: bulkLimit
			});
		}
	};
	const findSet = (id: string | undefined) => sets.find((s) => s.id === id);
	const tenant = (id: string): FakeTenant => {
		const found = tenants.find((t) => t.id === id);
		if (!found) throw new ApiError(404, 'not_found', 'tenant not found');
		return found;
	};
	const facts = (setId: string | undefined) => {
		const found = findSet(setId);
		return found
			? {
					setFound: true,
					...(found.display_name ? { setName: found.display_name } : {}),
					setOwner: found.owner,
					// The record stays active when the set is switched off (no activation): the
					// Admin API's facts cannot tell; the explanation's outcome does.
					setLifecycleState: 'active'
				}
			: setId
				? { setFound: false }
				: {};
	};
	const usable = (setId: string) => findSet(setId)?.enabled === true;

	// --- the selection, as the runtime makes it -------------------------------------------------
	function select(
		tenantId: string,
		choice: ClientMappingChoice,
		/** Selects as if the tenant default were this (`undefined` inside: not set). */
		override?: { tenantDefault: string | undefined }
	): EffectiveMapping {
		const own = override ? override.tenantDefault : tenant(tenantId).ownDefault;
		const clientEntry: ChainEntry =
			choice === null
				? { tier: 'client', state: 'unset' }
				: 'mode' in choice
					? { tier: 'client', state: 'none' }
					: {
							tier: 'client',
							state: 'set',
							setId: choice.fieldMappingSetId,
							...facts(choice.fieldMappingSetId)
						};
		const tenantEntry: ChainEntry =
			own === undefined
				? { tier: 'tenant_default', state: 'unset' }
				: own === 'none'
					? { tier: 'tenant_default', state: 'none', source: 'kv' }
					: { tier: 'tenant_default', state: 'set', setId: own, source: 'kv', ...facts(own) };
		const platformEntry: ChainEntry = platformDefault
			? {
					tier: 'platform_default',
					state: 'set',
					setId: platformDefault,
					source: 'platform',
					...facts(platformDefault)
				}
			: { tier: 'platform_default', state: 'unset' };
		const chain = [clientEntry, tenantEntry, platformEntry];
		let selection: EffectiveSelection = { kind: 'none', reason: 'no_default' };
		for (const entry of chain) {
			if (entry.state === 'unset') continue;
			if (entry.state === 'none') {
				selection = {
					kind: 'none',
					reason: entry.tier === 'client' ? 'client_opt_out' : 'tenant_opt_out'
				};
			} else {
				selection = { kind: 'bound', tier: entry.tier, setId: entry.setId!, ...facts(entry.setId) };
			}
			break;
		}
		return {
			tenantId,
			clientId: null,
			selection,
			chain,
			warnings: []
		};
	}

	const appOf = (clientId: string): FakeApp => {
		const found = apps.find((a) => a.client_id === clientId);
		if (!found) throw new ApiError(404, 'not_found', 'client not found');
		return found;
	};
	const appSelection = (tenantId: string, clientId: string) => ({
		...select(tenantId, appOf(clientId).identity_mapping),
		clientId
	});

	// --- the release -----------------------------------------------------------------------------
	const claimScope = (claim: string) => MAPPED_CLAIMS.find((c) => c.claim === claim)?.scope ?? '';
	const attributeType = (key: string | undefined) =>
		ATTRIBUTES.find((a) => a.key === key)?.type ?? 'string';
	const presence = (value: unknown): ExplainedClaim['value'] =>
		value === null || value === undefined
			? 'missing'
			: value === '' || (Array.isArray(value) && value.length === 0)
				? 'empty'
				: 'present';

	function explain(tenantId: string, request: ExplainRequest): ClaimExplanation {
		const clientId = request.client_id;
		const userId = request.subject.id;
		const consentAsked: ExplainConsent = request.consent ?? 'all';
		const target = appOf(clientId);
		const user = TEST_USERS.find((u) => u.user_id === userId);
		if (!user) throw new ApiError(404, 'not_found', 'test user not found');
		const effective = appSelection(tenantId, clientId);
		const { selection } = effective;
		const set = selection.kind === 'bound' ? findSet(selection.setId) : undefined;
		const stopped = selection.kind === 'bound' && (!set || !set.enabled);
		const scopes = request.scopes ?? target.scopes;
		const granted = (scope: string) => scopes.includes(scope);
		const idTokenWithoutSet = request.surface === 'id_token' && selection.kind !== 'bound';
		const claims: ExplainedClaim[] = STANDARD_CLAIMS.map(({ claim, scope }) => ({
			claim,
			field: null,
			sources: claim === 'sub' ? [] : [claim],
			origin: 'standard',
			value: 'present',
			scope,
			scope_granted: granted(scope),
			consent: 'not_required',
			// Without a set, the token endpoint's ID token carries the protocol's claims only.
			released: !stopped && granted(scope) && !(idTokenWithoutSet && claim !== 'sub'),
			...(stopped
				? { reason: 'issuance_stopped' as const }
				: idTokenWithoutSet && claim !== 'sub'
					? { reason: 'surface_not_listed' as const }
					: granted(scope)
						? {}
						: { reason: 'scope_not_granted' as const })
		}));
		for (const mapped of MAPPED_CLAIMS) {
			const mapping = set?.mappings.find((m) => m.target === mapped.claim);
			// A test user's consent is the one asked for: every optional item, or none.
			const consent = mapped.consent
				? consentAsked === 'none'
					? 'missing'
					: 'granted'
				: 'not_required';
			const base = {
				claim: mapped.claim,
				field: mapping?.sources[0] ?? null,
				sources: mapping ? [...mapping.sources] : [],
				origin: 'mapping' as const,
				scope: mapped.scope,
				scope_granted: granted(mapped.scope),
				consent: consent as ExplainedClaim['consent']
			};
			if (selection.kind !== 'bound') {
				claims.push({ ...base, value: 'not_read', released: false, reason: 'mapping_not_applied' });
				continue;
			}
			if (!mapping) {
				// Only claims the app could receive are worth listing as "not in the set".
				if (granted(mapped.scope)) {
					claims.push({ ...base, value: 'not_read', released: false, reason: 'not_in_set' });
				}
				continue;
			}
			// Only a plain copy of one attribute is worked out here; anything else (transforms,
			// several attributes, a fixed value) is left to sign-in rather than guessed.
			const value: ExplainedClaim['value'] =
				(mapping.steps?.length ?? 0) > 0 || mapping.sources.length !== 1
					? 'not_evaluated'
					: presence(user.attributes[mapping.sources[0] as keyof typeof user.attributes]);
			const reason = stopped
				? 'issuance_stopped'
				: value === 'missing'
					? 'value_missing'
					: value === 'empty'
						? 'value_empty'
						: !base.scope_granted
							? 'scope_not_granted'
							: consent === 'missing'
								? 'consent_missing'
								: undefined;
			// A value left to sign-in may still be empty: unknown, unless something else stops it.
			const released = reason ? false : value === 'not_evaluated' ? null : true;
			claims.push({ ...base, value, released, ...(reason ? { reason } : {}) });
		}
		// Claims asked about by name that nothing builds: listed, with why they are not sent.
		for (const name of request.claims ?? []) {
			if (claims.some((c) => c.claim === name)) continue;
			claims.push({
				claim: name,
				field: null,
				sources: [],
				origin: 'requested',
				value: 'not_read',
				scope: null,
				scope_granted: false,
				consent: 'not_required',
				released: false,
				reason: stopped
					? 'issuance_stopped'
					: selection.kind === 'bound'
						? 'not_in_set'
						: 'mapping_not_applied'
			});
		}
		return {
			tenantId,
			clientId,
			surface: request.surface,
			subject: { kind: 'test_user', user_id: userId },
			scopes,
			consent: consentAsked,
			selection,
			chain: effective.chain,
			warnings: [],
			outcome: stopped
				? {
						kind: 'stopped',
						code: set ? 'set_inactive' : 'set_missing',
						...(selection.kind === 'bound' ? { tier: selection.tier } : {})
					}
				: { kind: 'issued' },
			claims
		};
	}

	// --- the difference a change makes ---------------------------------------------------------
	function diff(before: FakeSet['mappings'], after: FakeSet['mappings']): ClaimChange[] {
		const changes: ClaimChange[] = [];
		const added = after.filter((m) => !before.some((b) => b.target === m.target));
		const removed = before.filter((m) => !after.some((a) => a.target === m.target));
		for (const m of added) {
			const renamedFrom =
				m.sources.length > 0
					? removed.find((r) => r.sources.join() === m.sources.join())
					: undefined;
			if (renamedFrom) {
				removed.splice(removed.indexOf(renamedFrom), 1);
				changes.push({ kind: 'renamed', claim: m.target, previous_claim: renamedFrom.target });
			} else changes.push({ kind: 'added', claim: m.target });
		}
		for (const m of removed) changes.push({ kind: 'removed', claim: m.target });
		for (const m of after) {
			const was = before.find((b) => b.target === m.target);
			if (!was) continue;
			if (was.sources.join() === m.sources.join()) {
				// Same attributes, other transforms: the value may change.
				if (JSON.stringify(was.steps ?? []) !== JSON.stringify(m.steps ?? [])) {
					changes.push({ kind: 'transform_changed', claim: m.target });
				}
				continue;
			}
			const typeBefore = attributeType(was.sources[0]);
			const typeAfter = attributeType(m.sources[0]);
			changes.push(
				typeBefore === typeAfter
					? { kind: 'source_changed', claim: m.target }
					: {
							kind: 'type_changed',
							claim: m.target,
							type_before: typeBefore,
							type_after: typeAfter
						}
			);
		}
		return changes;
	}

	/** What each app using `setId` (through any level) would see if the set became `after`. */
	function appChanges(tenantId: string, setId: string, changes: ClaimChange[]): AppClaimChanges[] {
		const rows: AppClaimChanges[] = [];
		for (const a of apps) {
			const { selection } = appSelection(tenantId, a.client_id);
			if (selection.kind !== 'bound' || selection.setId !== setId) continue;
			const seen = (claim: string) => a.scopes.includes(claimScope(claim));
			rows.push({
				tenant_id: tenantId,
				client_id: a.client_id,
				name: a.name,
				tier: selection.tier,
				changes: changes.filter(
					(c) => seen(c.claim) || (!!c.previous_claim && seen(c.previous_claim))
				),
				held_back: changes
					.filter((c) => !seen(c.claim) && !(c.previous_claim && seen(c.previous_claim)))
					.map((c) => ({ claim: c.claim, scope: claimScope(c.claim) }))
			});
		}
		return rows;
	}

	/** Apps that would see a change if one level went from `from` to `to`. */
	/** One level's value as the runtime reads it: a set ID, `none`, or not set. */
	const rawLevel = (value: LevelValue): string | undefined =>
		value.state === 'unset' ? undefined : value.state === 'none' ? 'none' : value.setId;
	const choiceOf = (value: LevelValue): ClientMappingChoice =>
		value.state === 'unset'
			? null
			: value.state === 'none'
				? { mode: 'none' }
				: { fieldMappingSetId: value.setId! };
	/** The mappings an app releases through, once selected (none: no mapping). */
	const resolvedMappings = (selection: EffectiveSelection) =>
		selection.kind === 'bound' ? (findSet(selection.setId)?.mappings ?? []) : [];

	/**
	 * What each app would see if one level went to `to`: every app is selected before and after
	 * (so an app that falls back to a default keeps what the default gives), then compared.
	 */
	function levelChanges(tenantId: string, entry: HistoryEntry, to: LevelValue): AppClaimChanges[] {
		const affected = apps.filter((a) =>
			entry.tier === 'client' ? a.client_id === entry.client_id : a.identity_mapping === null
		);
		return affected.map((a) => {
			const before = select(tenantId, a.identity_mapping).selection;
			const after =
				entry.tier === 'client'
					? select(tenantId, choiceOf(to)).selection
					: select(tenantId, a.identity_mapping, { tenantDefault: rawLevel(to) }).selection;
			const changes = diff(resolvedMappings(before), resolvedMappings(after));
			const seen = (claim: string) => a.scopes.includes(claimScope(claim));
			return {
				tenant_id: tenantId,
				client_id: a.client_id,
				name: a.name,
				tier: entry.tier,
				changes: changes.filter((c) => seen(c.claim)),
				held_back: changes
					.filter((c) => !seen(c.claim))
					.map((c) => ({ claim: c.claim, scope: claimScope(c.claim) }))
			};
		});
	}

	/** Whether the value before a change can be written back now, worked out at every read. */
	function restorability(
		tenantId: string,
		entry: HistoryEntry
	): Pick<HistoryEntry, 'restorable' | 'not_restorable_reason'> {
		const target = entry.before;
		if (target.state === 'set') {
			const found = findSet(target.setId);
			if (!found) return { restorable: false, not_restorable_reason: 'set_deleted' };
			if (!found.enabled) return { restorable: false, not_restorable_reason: 'set_inactive' };
		}
		const now = currentLevel(tenantId, entry);
		if (now.state === target.state && now.setId === target.setId) {
			return { restorable: false, not_restorable_reason: 'is_current' };
		}
		return { restorable: true };
	}

	const withRestorability = (tenantId: string, entry: HistoryEntry): HistoryEntry => {
		const { restorable: _r, not_restorable_reason: _n, ...rest } = entry;
		return { ...rest, ...restorability(tenantId, entry) };
	};

	function currentLevel(tenantId: string, entry: HistoryEntry): LevelValue {
		const value =
			entry.tier === 'client'
				? (() => {
						const choice = appOf(entry.client_id!).identity_mapping;
						return choice === null
							? undefined
							: 'mode' in choice
								? 'none'
								: choice.fieldMappingSetId;
					})()
				: tenant(tenantId).ownDefault;
		return levelValue(value);
	}

	function levelValue(value: string | undefined): LevelValue {
		if (value === undefined) return { state: 'unset' };
		if (value === 'none') return { state: 'none' };
		const name = findSet(value)?.display_name;
		return { state: 'set', setId: value, ...(name ? { setName: name } : {}) };
	}

	const sameLevel = (a: HistoryEntry, b: HistoryEntry) =>
		a.tier === b.tier && a.client_id === b.client_id;

	// --- bulk apply ------------------------------------------------------------------------------
	function plannedSet(request: BulkApplyRequest): string | undefined {
		const change = request.changes.find((c) => c.category === IDENTITY_MAPPING_CATEGORY);
		const value = change?.set?.[OIDC_DEFAULT_SET_KEY];
		return typeof value === 'string' ? value : undefined;
	}

	function previewTenant(request: BulkApplyRequest, id: string): BulkPreviewResult {
		const found = tenants.find((t) => t.id === id);
		if (!found) {
			return {
				tenant_id: id,
				status: 'rejected',
				reason: 'tenant_not_found',
				changes: [],
				impact: {}
			};
		}
		const proposed = plannedSet(request);
		if (options.settingsUnreadable?.includes(id)) {
			// As the API: its values in effect are unknown, so it is neither previewed nor written.
			return {
				tenant_id: id,
				status: 'nothing_to_do',
				changes: [
					{
						category: IDENTITY_MAPPING_CATEGORY,
						key: OIDC_DEFAULT_SET_KEY,
						current: null,
						proposed: proposed ?? null,
						action: 'would_reject',
						reason: 'settings_unavailable',
						validation: { ok: null },
						version: null
					}
				],
				impact: {}
			};
		}
		const own = found.ownDefault;
		const skip =
			own === proposed
				? 'already_set'
				: own !== undefined && request.on_existing_override !== 'overwrite'
					? 'existing_override'
					: undefined;
		const valid =
			proposed !== undefined && findSet(proposed)?.owner === 'platform' && usable(proposed);
		const action = skip ? 'would_skip' : valid ? 'would_apply' : 'would_reject';
		const effective = select(id, null).selection;
		return {
			tenant_id: id,
			// The API's preview says only whether anything would be written; the why is per key.
			status: action === 'would_apply' ? 'ready' : 'nothing_to_do',
			changes: [
				{
					category: IDENTITY_MAPPING_CATEGORY,
					key: OIDC_DEFAULT_SET_KEY,
					current: {
						overridden: own !== undefined,
						own: own ?? null,
						effective: effective.kind === 'bound' ? effective.setId : null,
						source: own !== undefined ? 'kv' : platformDefault ? 'platform' : 'default'
					},
					proposed: proposed ?? null,
					action,
					...(skip ? { reason: skip } : valid ? {} : { reason: 'validation_failed' }),
					validation: skip
						? { ok: null }
						: valid
							? { ok: true }
							: {
									ok: false,
									errors: [{ code: 'validation_failed', detail_code: 'set_not_usable' }]
								},
					version: `v${found.version}`
				}
			],
			impact:
				action === 'would_apply' && options.impactUnavailable?.includes(id)
					? {
							[IDENTITY_MAPPING_CATEGORY]: { available: false, reason: 'core_database_unavailable' }
						}
					: action === 'would_apply'
						? {
								[IDENTITY_MAPPING_CATEGORY]: {
									available: true,
									applies: true,
									apps_total:
										found.apps.following +
										found.apps.ownSet +
										found.apps.optedOut +
										found.apps.unusable,
									apps_following_default: found.apps.following,
									apps_with_unusable_choice: found.apps.unusable,
									apps_with_own_set: found.apps.ownSet,
									apps_opted_out: found.apps.optedOut,
									warnings: []
								}
							}
						: {}
		};
	}

	function applyTenant(request: BulkApplyRequest, id: string): BulkApplyResult {
		const preview = previewTenant(request, id);
		const entry = preview.changes[0];
		const base = {
			category: IDENTITY_MAPPING_CATEGORY,
			key: OIDC_DEFAULT_SET_KEY,
			previous: entry?.current?.own ?? null,
			new: plannedSet(request) ?? null,
			version_before: entry?.version ?? null
		};
		if (preview.status === 'rejected' && !entry) {
			return { tenant_id: id, status: 'rejected', reason: preview.reason, changes: [] };
		}
		if (entry.reason === 'settings_unavailable') {
			// Not read, not written: a failure the API reports as such (it can be retried).
			return {
				tenant_id: id,
				status: 'failed',
				changes: [
					{ ...base, status: 'failed', reason: 'settings_unavailable', version_after: null }
				]
			};
		}
		// As the API does: a tenant changed since the preview is a conflict, before anything else.
		if (request.expected?.[id]?.[IDENTITY_MAPPING_CATEGORY] !== entry.version) {
			return {
				tenant_id: id,
				status: 'conflict',
				changes: [{ ...base, status: 'conflict', reason: 'version_changed', version_after: null }]
			};
		}
		if (entry.action === 'would_skip') {
			return {
				tenant_id: id,
				status: 'skipped',
				changes: [{ ...base, status: 'skipped', reason: entry.reason, version_after: null }]
			};
		}
		if (entry.action === 'would_reject') {
			return {
				tenant_id: id,
				status: 'rejected',
				changes: [{ ...base, status: 'rejected', reason: 'validation_failed', version_after: null }]
			};
		}
		if (failOnce.delete(id)) {
			return {
				tenant_id: id,
				status: 'failed',
				changes: [{ ...base, status: 'failed', reason: 'internal_error', version_after: null }]
			};
		}
		const found = tenant(id);
		const was = levelValue(found.ownDefault);
		found.ownDefault = plannedSet(request);
		found.version += 1;
		if (id === DEMO_TENANT) {
			history = [
				{
					id: `h${history.length + 1}`,
					at: new Date().toISOString(),
					actor: { id: 'adm_operator', label: 'Platform operator' },
					tier: 'tenant_default',
					before: was,
					after: levelValue(found.ownDefault),
					via: 'bulk_apply',
					restorable: true
				},
				...history
			];
		}
		return {
			tenant_id: id,
			status: 'applied',
			changes: [{ ...base, status: 'applied', version_after: `v${found.version}` }]
		};
	}

	const bulkResponse = <R extends { status: string }>(request: BulkApplyRequest, results: R[]) => {
		const byStatus: Record<string, number> = {};
		for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
		return {
			mode: request.mode,
			on_existing_override: request.on_existing_override ?? 'skip',
			limits: { max_tenants_per_request: bulkLimit, max_keys_per_request: 20 },
			summary: { tenants: results.length, by_status: byStatus },
			results
		};
	};

	/** A mapping is kept when it fills a claim from something: attributes, or a step alone. */
	const kept = (mappings: SetContentDraft['mappings']) =>
		mappings.filter((m) => m.target && (m.sources.length > 0 || (m.steps?.length ?? 0) > 0));

	/** The places that name a set (the facade's count): defaults and apps, not the apps behind them. */
	const referenceCount = (setId: string) =>
		(platformDefault === setId ? 1 : 0) +
		tenants.filter((t) => t.ownDefault === setId).length +
		apps.filter(
			(a) =>
				a.identity_mapping !== null &&
				'fieldMappingSetId' in a.identity_mapping &&
				a.identity_mapping.fieldMappingSetId === setId
		).length;

	const tenantRow = (t: FakeTenant): PlatformTenantRow => {
		const unreadable = options.settingsUnreadable?.includes(t.id);
		const { chain, selection } = select(t.id, null);
		const base = {
			tenant_id: t.id,
			display_name: t.name,
			lifecycle_state: 'active',
			// As the API: unreadable settings leave no tenant level, and a failed selection.
			tenant_default: unreadable ? null : chain[1],
			effective: unreadable ? ({ kind: 'failed', code: 'settings_unreadable' } as const) : selection
		};
		if (options.impactUnavailable?.includes(t.id)) {
			return { ...base, apps: null, apps_unavailable: 'core_database_unavailable' };
		}
		return {
			...base,
			apps: {
				total: t.apps.following + t.apps.ownSet + t.apps.optedOut + t.apps.unusable,
				following_default: t.apps.following,
				own_set: t.apps.ownSet,
				opted_out: t.apps.optedOut,
				unusable: t.apps.unusable
			}
		};
	};

	return {
		async sets(tenantId) {
			await pause();
			const owner = tenantId === PLATFORM ? 'platform' : 'tenant';
			// The tenant sees its own sets and the platform's it may name.
			return {
				sets: copy(
					sets
						.filter(
							(s) => s.owner === 'platform' || (owner === 'tenant' && tenantId === DEMO_TENANT)
						)
						.map(({ mappings: _m, ...s }) => s)
				)
			};
		},
		async effective(tenantId, clientId) {
			await pause();
			return copy(clientId ? appSelection(tenantId, clientId) : select(tenantId, null));
		},
		async usage(_tenantId, setId) {
			await pause();
			const found = findSet(setId);
			if (!found) throw new ApiError(404, 'not_found', 'field mapping set not found');
			const items = apps
				.filter(
					(a) =>
						a.identity_mapping &&
						'fieldMappingSetId' in a.identity_mapping &&
						a.identity_mapping.fieldMappingSetId === setId
				)
				.map((a) => ({ kind: 'client' as const, tenantId: DEMO_TENANT, clientId: a.client_id }));
			const defaults = tenants
				.filter((t) => t.ownDefault === setId)
				.map((t) => ({ kind: 'tenant_default' as const, tenantId: t.id }));
			const platform = platformDefault === setId ? [{ kind: 'platform_default' as const }] : [];
			const all = [...platform, ...defaults, ...items];
			return {
				setId,
				owner: found.owner,
				usage: {
					count: all.length,
					countIsLowerBound: false,
					items: all,
					itemsTruncated: false,
					scanComplete: true,
					unscanned: { count: 0, items: [] }
				},
				blocksChange: all.length > 0
			};
		},
		async bulkPreview(request) {
			await pause();
			refuseTooMany(request);
			return copy(
				bulkResponse(
					request,
					request.tenant_ids.map((id) => previewTenant(request, id))
				)
			);
		},
		async bulkApply(request, key) {
			await pause();
			// Same key, same answer (the API keeps the result of a request it has run).
			if (applied.has(key)) return copy(applied.get(key)) as never;
			refuseTooMany(request);
			applyRequests += 1;
			if (applyRequests === options.failApplyRequest) {
				throw new ApiError(503, 'temporarily_unavailable', 'The request could not be completed');
			}
			const answer = {
				bulk_id: `bulk_${applied.size + 1}`,
				...bulkResponse(
					request,
					request.tenant_ids.map((id) => applyTenant(request, id))
				)
			};
			applied.set(key, copy(answer));
			return copy(answer);
		},
		async apps(tenantId) {
			await pause();
			if (tenantId !== DEMO_TENANT) return [];
			return copy(
				apps.map(({ client_id, name, identity_mapping }) => ({ client_id, name, identity_mapping }))
			);
		},
		async setAppChoice(tenantId, clientId, choice) {
			await pause();
			if (choice && 'fieldMappingSetId' in choice && !usable(choice.fieldMappingSetId)) {
				throw new ApiError(
					400,
					'invalid_request',
					'identity_mapping.fieldMappingSetId must reference an active compiled Mapping Set'
				);
			}
			const target = appOf(clientId);
			const before = currentLevel(tenantId, {
				tier: 'client',
				client_id: clientId
			} as HistoryEntry);
			target.identity_mapping = choice;
			history = [
				{
					id: `h${history.length + 1}`,
					at: new Date().toISOString(),
					actor: { id: 'adm_a', label: 'Tenant admin A' },
					tier: 'client',
					client_id: clientId,
					client_name: target.name,
					before,
					after: currentLevel(tenantId, { tier: 'client', client_id: clientId } as HistoryEntry),
					via: 'app',
					restorable: true
				},
				...history
			];
		},
		async tenantsOverview(page = {}) {
			await pause();
			const limit = Math.min(page.limit ?? 50, options.pageSize ?? 100);
			// Tenant ID order, from after the cursor (the last ID of the page before).
			const ordered = [...tenants].sort((a, b) => a.id.localeCompare(b.id));
			const start = page.cursor ? ordered.findIndex((t) => t.id > page.cursor!) : 0;
			const rest = start < 0 ? [] : ordered.slice(start);
			const shown = rest.slice(0, limit);
			const platform: ChainEntry = platformDefault
				? {
						tier: 'platform_default',
						state: 'set',
						setId: platformDefault,
						...facts(platformDefault)
					}
				: { tier: 'platform_default', state: 'unset' };
			return copy({
				platform_default: platform,
				tenants: shown.map(tenantRow),
				next_cursor: rest.length > limit ? shown[shown.length - 1].id : null,
				generated_at: new Date().toISOString()
			});
		},
		async testUsers() {
			await pause();
			return copy({
				test_users: TEST_USERS.map(({ user_id, label, attributes }) => ({
					user_id,
					label,
					attributes,
					updated_at: Date.parse('2026-10-20T00:00:00Z')
				})),
				limits: { max_users: 10, max_attributes: 50 }
			});
		},
		async explain(tenantId, request) {
			await pause();
			return copy(explain(tenantId, request));
		},
		async previewChoice(tenantId, clientId, choice) {
			await pause();
			appOf(clientId);
			return copy({ ...select(tenantId, choice), clientId });
		},
		async previewSetChange(tenantId, setId, draft: SetContentDraft, sampleUserId) {
			await pause();
			const found = findSet(setId);
			if (!found) throw new ApiError(404, 'not_found', 'field mapping set not found');
			const after = kept(draft.mappings);
			const changes = diff(found.mappings, after);
			if (tenantId === PLATFORM) {
				// In the platform's context: how many apps of each tenant use the set, no app list.
				// Apps follow it through a default, or name it themselves. Only the demo tenant's apps
				// are known one by one; elsewhere an app's own set is not known, so it is incomplete.
				const follows = (t: FakeTenant) =>
					t.ownDefault === setId || (t.ownDefault === undefined && platformDefault === setId);
				const rows = tenants
					.map((t) => {
						if (options.impactUnavailable?.includes(t.id))
							return { tenant_id: t.id, apps_using: null };
						if (t.id === DEMO_TENANT) {
							const using = apps.filter((a) => {
								const selection = select(t.id, a.identity_mapping).selection;
								return selection.kind === 'bound' && selection.setId === setId;
							}).length;
							return { tenant_id: t.id, apps_using: using };
						}
						return { tenant_id: t.id, apps_using: follows(t) ? t.apps.following : 0 };
					})
					.filter((row) => row.apps_using === null || row.apps_using > 0);
				const unknown = tenants.some((t) => t.id !== DEMO_TENANT && t.apps.ownSet > 0);
				return copy({
					setId,
					usage_complete: !unknown,
					apps: [],
					tenants: rows,
					sample: null
				});
			}
			const user = TEST_USERS.find((u) => u.user_id === sampleUserId);
			/** A test user's value: only a plain copy of one attribute is worked out here. */
			const valueOf = (mappings: FakeSet['mappings'], claim: string) => {
				const mapping = mappings.find((m) => m.target === claim);
				if (!mapping) return { value: null };
				if ((mapping.steps?.length ?? 0) > 0 || mapping.sources.length !== 1) {
					return { value: null, not_evaluated: true as const };
				}
				const value = user?.attributes[mapping.sources[0] as keyof typeof user.attributes];
				return { value: value === undefined || value === null ? null : JSON.stringify(value) };
			};
			const claims = [...new Set([...found.mappings, ...after].map((m) => m.target))];
			// Only this tenant's apps are listed; another tenant using the set (a platform set) is
			// not looked at here, so the answer says it is not complete.
			const elsewhere = tenants.some(
				(t) =>
					t.id !== tenantId &&
					(t.ownDefault === setId || (t.ownDefault === undefined && platformDefault === setId))
			);
			return copy({
				setId,
				usage_complete: !elsewhere,
				apps: appChanges(tenantId, setId, changes),
				sample: user
					? {
							user_id: user.user_id,
							claims: claims.map((claim) => {
								const before = valueOf(found.mappings, claim);
								const next = valueOf(after, claim);
								return {
									claim,
									before: before.value,
									after: next.value,
									...(before.not_evaluated || next.not_evaluated
										? {
												not_evaluated: [
													...(before.not_evaluated ? ['before' as const] : []),
													...(next.not_evaluated ? ['after' as const] : [])
												]
											}
										: {})
								};
							})
						}
					: null
			});
		},
		async setContent(_tenantId, setId) {
			await pause();
			const found = findSet(setId);
			if (!found) throw new ApiError(404, 'not_found', 'field mapping set not found');
			const { mappings, ...summary } = found;
			// The claim types follow the attribute each is usually filled from.
			const claimType = (claim: string) =>
				claim === 'affiliation' || claim === 'groups' ? 'string[]' : 'string';
			return copy({
				set: summary,
				mappings,
				references: {
					count: referenceCount(setId),
					count_is_lower_bound: false,
					scan_complete: true
				},
				attributes: ATTRIBUTES.map(({ key, type }) => ({ key, type })),
				claims: MAPPED_CLAIMS.map(({ claim }) => ({ key: claim, type: claimType(claim) }))
			});
		},
		async saveSet(_tenantId, setId, draft, confirmImpact) {
			await pause();
			const found = findSet(setId);
			if (!found) throw new ApiError(404, 'not_found', 'field mapping set not found');
			const count = referenceCount(setId);
			if (count > 0 && confirmImpact !== count) {
				throw new ApiError(
					409,
					'impact_confirmation_required',
					`The Mapping Set is in use (${count} references); send confirm_impact with that number to change it`,
					{ error: 'impact_confirmation_required', references: { count } }
				);
			}
			found.mappings = kept(draft.mappings);
			found.updated_at = Date.now();
		},
		async history(tenantId) {
			await pause();
			if (tenantId !== DEMO_TENANT) return [];
			return copy(history.map((entry) => withRestorability(tenantId, entry)));
		},
		async previewRestore(tenantId, entryId) {
			await pause();
			const found = history.find((h) => h.id === entryId);
			if (!found) throw new ApiError(404, 'not_found', 'history entry not found');
			const entry = withRestorability(tenantId, found);
			if (!entry.restorable)
				throw new ApiError(409, 'not_restorable', 'This change cannot be restored', {
					reason: entry.not_restorable_reason
				});
			const index = history.indexOf(found);
			const current = currentLevel(tenantId, entry);
			return copy({
				entry,
				current,
				restores: entry.before,
				later_changes: history.slice(0, index).filter((h) => sameLevel(h, entry)),
				apps: levelChanges(tenantId, entry, entry.before),
				expected_version: `hv${history.length}`
			});
		},
		async restore(tenantId, entryId, expectedVersion) {
			await pause();
			if (expectedVersion !== `hv${history.length}`)
				throw new ApiError(409, 'conflict', 'The level changed since the preview');
			const found = history.find((h) => h.id === entryId);
			if (!found) throw new ApiError(404, 'not_found', 'history entry not found');
			// Checked again now: the set to go back to may have gone since the preview.
			const entry = withRestorability(tenantId, found);
			if (!entry.restorable)
				throw new ApiError(409, 'not_restorable', 'This change cannot be restored', {
					reason: entry.not_restorable_reason
				});
			const before = currentLevel(tenantId, entry);
			const value = entry.before;
			if (entry.tier === 'client') {
				appOf(entry.client_id!).identity_mapping =
					value.state === 'unset'
						? null
						: value.state === 'none'
							? { mode: 'none' }
							: { fieldMappingSetId: value.setId! };
			} else {
				const target = tenant(tenantId);
				target.ownDefault =
					value.state === 'unset' ? undefined : value.state === 'none' ? 'none' : value.setId;
				// The same settings document the bulk apply versions: a preview read before is stale.
				target.version += 1;
			}
			const restored: HistoryEntry = {
				id: `h${history.length + 1}`,
				at: new Date().toISOString(),
				actor: { id: 'adm_b', label: 'Tenant admin B' },
				tier: entry.tier,
				...(entry.client_id ? { client_id: entry.client_id, client_name: entry.client_name } : {}),
				before,
				after: currentLevel(tenantId, entry),
				via: 'restore',
				restorable: true
			};
			history = [restored, ...history];
			return copy(restored);
		}
	};
}
