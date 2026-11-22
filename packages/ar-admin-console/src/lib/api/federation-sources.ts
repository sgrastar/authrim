/**
 * The tenant's SAML federation sources: an aggregate metadata document (a national federation's
 * list of hundreds of providers) trusted as a whole, with a few entities set aside.
 *
 * - `GET/POST /api/admin/federation/trust-sources`, `GET/PUT/DELETE …/:id`
 * - `GET …/:id/entities`, `GET …/:id/refresh-history` (read-only views over what was imported)
 * - `POST /api/admin/saml-federation-sources/:id/refresh-metadata` and `…/entities/materialize`
 * - `POST /api/admin/saml-metadata/certificate-preview`
 *
 * Every time is milliseconds since the epoch, as the server keeps them.
 *
 * Writes ask for a step-up (the Admin API refuses with `step_up_required`; the call is repeated with
 * a receipt) and are bound to the tenant selected when they started. A 409 stays an `ApiError`.
 * Pages take a `FederationSourcesClient` rather than calling fetch, so Storybook and tests hand
 * them an in-memory one (`fake/federation-sources-fake.ts`).
 */
import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
import { adminFetch, API_BASE_URL } from './admin-request';
import { StepUpCancelledError, stepUpHeaders, withStepUp } from './admin-step-up';
import { errorFromResponse } from './api-error';
import type { SamlCertificatePreview } from './saml-settings';

export type FederationRole = 'saml_idp' | 'saml_sp';
export type FederationLifecycle = 'draft' | 'active' | 'retired';
/** How the server describes a source's metadata: `stale` is not fetched since saved, `error` a failing fetch. */
export type FederationSourceState =
	| 'healthy'
	| 'stale'
	| 'error'
	| 'expired'
	| 'missing'
	| 'identity_change_pending'
	| 'unknown';
const SOURCE_STATES: readonly FederationSourceState[] = [
	'healthy',
	'stale',
	'error',
	'expired',
	'missing',
	'identity_change_pending'
];
export type FederationVerification = 'verified' | 'unverified' | 'skipped' | 'failed';
/** How a person who signs in through the federation picks their institution. */
export type FederationIdpSelectionMode = 'authrim_search' | 'external_ds';

export interface FederationCertificate {
	id: string;
	name?: string;
	/** PEM. */
	certificate: string;
	/** Lower-case hex, no separators. */
	fingerprintSha256: string;
	createdAt: number;
}

export interface FederationStatus {
	sourceState: FederationSourceState;
	lastAttemptAt: number | null;
	lastSuccessAt: number | null;
	nextRefreshAt: number | null;
	consecutiveFailures: number;
	lastErrorCode: string | null;
	/** The `validUntil` of the document in use (ISO date-time). */
	acceptedValidUntil: string | null;
	activeMetadataDocumentId: string | null;
	/** Null while the server has not said (a source read without its status). */
	entityCount: number | null;
	excludedCount: number;
	lastVerification: { status: FederationVerification; at: number | null } | null;
}

export interface FederationSource {
	id: string;
	sourceKey: string;
	name: string;
	lifecycleState: FederationLifecycle;
	description: string;
	metadataUrl: string;
	certificates: FederationCertificate[];
	/** Empty while the source only keeps an inventory (`inventory_only`). */
	roles: FederationRole[];
	automatic: boolean;
	idpMappingSetId: string;
	spMappingSetId: string;
	attributePresetId: string;
	priority: number | null;
	polling: { mode: 'automatic' | 'manual'; intervalSeconds: number };
	/** Only entities registered by one of these authorities take part; empty: any. */
	registrationAuthorities: string[];
	/** Entities set aside; everything else in the document takes part. */
	excludedEntityIds: string[];
	idpSelection: { mode: FederationIdpSelectionMode; discoveryServiceUrl: string };
	/** The payload as stored: what the console does not set is written back untouched. */
	payload: Record<string, unknown>;
	/** Absent on a list read by an older server. */
	status: FederationStatus | null;
	createdAt: number;
	updatedAt: number;
}

export interface FederationWrite {
	sourceKey: string;
	name: string;
	lifecycleState: FederationLifecycle;
	/** The whole `protocolPayload`: a write replaces it. */
	payload: Record<string, unknown>;
}
export interface FederationUpdate extends FederationWrite {
	expectedUpdatedAt: number;
}

export type FederationEntityState = 'participating' | 'excluded' | 'explicit';
export type FederationEntityRole = 'saml_idp' | 'saml_sp' | 'ambiguous';

export interface FederationEntityQuery {
	q?: string;
	role?: FederationEntityRole;
	state?: FederationEntityState;
	/** Keyword tokens (mdui:Keywords); an entity matches when it carries at least one. */
	keywords?: string[];
	/** What the page is ordered by (name when absent) and which way (ascending when absent). */
	sort?: 'name' | 'entityId';
	direction?: 'asc' | 'desc';
	limit?: number;
	cursor?: string;
}
/** The keywords of one kind (a location, an organization type) the entities carry. */
export interface FederationKeywordCategory {
	type: string;
	values: { value: string; label: string; count: number }[];
}
export interface FederationEntity {
	entityId: string;
	role: FederationEntityRole;
	displayName: string | null;
	logoUrl: string | null;
	registrationAuthority: string | null;
	entityCategories: string[];
	validUntil: string | null;
	excluded: boolean;
	policyAllowed: boolean;
	explicitProviderId: string | null;
	explicitProviderType: 'sp' | 'idp' | null;
}
export interface FederationEntityPage {
	items: FederationEntity[];
	/** Opaque: pass it back as `cursor` for the next page. */
	nextCursor: string | null;
	total: number;
	/** False when the server could not look up explicit connections (they are then not marked). */
	explicitLookupAvailable: boolean;
}

export interface FederationRefreshHistoryItem {
	jobId: string;
	trigger: 'automatic' | 'manual';
	status: 'completed' | 'failed' | 'running';
	startedAt: number;
	finishedAt: number | null;
	changed: boolean | null;
	entityCount: number | null;
	entityCountDelta: number | null;
	verificationStatus: FederationVerification | null;
	errorCode: string | null;
	documentId: string | null;
}

export interface FederationRefreshResult {
	changed: boolean;
	entityCount: number;
	verificationStatus: FederationVerification | null;
	status: FederationStatus | null;
}

export interface FederationMaterializeInput {
	entityId: string;
	providerType: 'sp' | 'idp';
	fieldMappingSetId?: string;
	attributePresetId?: string;
	name?: string;
}
export interface FederationMaterialized {
	providerId: string;
	providerType: 'sp' | 'idp';
}

export interface FederationSourcesClient {
	list(signal?: AbortSignal): Promise<FederationSource[]>;
	get(id: string, signal?: AbortSignal): Promise<FederationSource>;
	create(input: FederationWrite): Promise<{ id: string }>;
	/** A full replacement; refused with a 409 when `expectedUpdatedAt` is not the current one. */
	update(id: string, input: FederationUpdate): Promise<void>;
	remove(id: string): Promise<void>;
	/** Fetches the metadata now, verifies its signature and replaces the inventory. */
	refresh(id: string): Promise<FederationRefreshResult>;
	entities(
		id: string,
		query?: FederationEntityQuery,
		signal?: AbortSignal
	): Promise<FederationEntityPage>;
	/** The keywords the entities carry, by kind, with how many carry each (a role narrows it). */
	entityKeywords(
		id: string,
		query?: { role?: FederationEntityRole },
		signal?: AbortSignal
	): Promise<FederationKeywordCategory[]>;
	refreshHistory(
		id: string,
		limit?: number,
		signal?: AbortSignal
	): Promise<FederationRefreshHistoryItem[]>;
	/**
	 * Makes one entity of the federation an explicit connection of its own. It starts as a draft
	 * (still resolved through the federation until it is enabled on its own page, where it then
	 * wins).
	 */
	materialize(id: string, input: FederationMaterializeInput): Promise<FederationMaterialized>;
	previewCertificate(certificate: string): Promise<SamlCertificatePreview>;
	/**
	 * Reads a certificate from an https address (the server fetches it; PEM or DER) and says what
	 * it holds, with its SHA-1 and SHA-256 fingerprints. `certificate` is the PEM to keep.
	 */
	previewCertificateUrl(url: string): Promise<SamlCertificatePreview>;
}

// -- Reading ---------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | null =>
	typeof value === 'number' && Number.isFinite(value) ? value : null;
const strings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

function readStatus(value: unknown): FederationStatus | null {
	const row = object(value);
	if (typeof row.sourceState !== 'string') return null;
	const verification = object(row.lastVerification);
	return {
		sourceState: SOURCE_STATES.find((state) => state === row.sourceState) ?? 'unknown',
		lastAttemptAt: num(row.lastAttemptAt),
		lastSuccessAt: num(row.lastSuccessAt),
		nextRefreshAt: num(row.nextRefreshAt),
		consecutiveFailures: num(row.consecutiveFailures) ?? 0,
		lastErrorCode: str(row.lastErrorCode) || null,
		acceptedValidUntil: str(row.acceptedValidUntil) || null,
		activeMetadataDocumentId: str(row.activeMetadataDocumentId) || null,
		entityCount: num(row.entityCount) ?? 0,
		excludedCount: num(row.excludedCount) ?? 0,
		lastVerification:
			typeof verification.status === 'string'
				? {
						status: verification.status as FederationVerification,
						at: num(verification.at)
					}
				: null
	};
}

/**
 * Until the server sends a `status` with each source, what it keeps in the polling state of its
 * payload says the same (`healthy` / `stale` / `error`), without the entity counts.
 */
function statusFromPolling(polling: Json, payload: Json): FederationStatus | null {
	if (Object.keys(polling).length === 0) return null;
	const state = polling.sourceState;
	return {
		sourceState: SOURCE_STATES.find((known) => known === state) ?? 'unknown',
		lastAttemptAt: num(polling.lastAttemptAt),
		lastSuccessAt: num(polling.lastSuccessAt),
		nextRefreshAt: num(polling.nextRefreshAt),
		consecutiveFailures: num(polling.consecutiveFailures) ?? 0,
		lastErrorCode: str(polling.lastErrorCode) || null,
		acceptedValidUntil: str(polling.acceptedValidUntil) || null,
		activeMetadataDocumentId: null,
		entityCount: null,
		excludedCount: strings(object(payload.exceptions).excludedEntityIds).length,
		lastVerification: null
	};
}

function readSource(value: unknown, status?: unknown): FederationSource {
	const row = object(value);
	if (typeof row.id !== 'string' || typeof row.updatedAt !== 'number')
		throw new Error('Invalid federation source response');
	const payload = object(row.protocolPayload);
	const resolution = object(payload.runtimeResolution);
	const polling = object(payload.polling);
	const selection = object(payload.idpSelection);
	const patterns = strings(payload.metadataUrlPatterns);
	return {
		id: row.id,
		sourceKey: str(row.sourceKey),
		name: str(row.displayName),
		lifecycleState:
			(['active', 'retired'] as const).find((s) => s === row.lifecycleState) ?? 'draft',
		description: str(payload.description),
		metadataUrl: str(payload.metadataUrl) || patterns.find((p) => !p.includes('*')) || '',
		certificates: Array.isArray(payload.certificates)
			? payload.certificates.flatMap((entry, index) => {
					const cert = object(entry);
					// Every stored certificate is kept (a save writes the list back whole): one with
					// no `id` is keyed by its fingerprint.
					return typeof cert.certificate === 'string'
						? [
								{
									id: str(cert.id) || str(cert.fingerprintSha256) || `certificate-${index}`,
									...(typeof cert.name === 'string' ? { name: cert.name } : {}),
									certificate: cert.certificate,
									fingerprintSha256: str(cert.fingerprintSha256),
									createdAt: num(cert.createdAt) ?? 0
								}
							]
						: [];
				})
			: [],
		roles: strings(resolution.roles).filter(
			(role): role is FederationRole => role === 'saml_idp' || role === 'saml_sp'
		),
		automatic: resolution.mode === 'automatic',
		idpMappingSetId: str(resolution.idpFieldMappingSetId),
		spMappingSetId: str(resolution.spFieldMappingSetId),
		attributePresetId: str(resolution.defaultAttributePresetId),
		priority: num(resolution.priority),
		polling: {
			mode: polling.mode === 'manual' ? 'manual' : 'automatic',
			intervalSeconds: num(polling.intervalSeconds) ?? 21600
		},
		registrationAuthorities: strings(resolution.registrationAuthorities),
		excludedEntityIds: strings(object(payload.exceptions).excludedEntityIds),
		idpSelection: {
			mode: selection.mode === 'external_ds' ? 'external_ds' : 'authrim_search',
			discoveryServiceUrl: str(selection.discoveryServiceUrl)
		},
		payload,
		status: readStatus(status ?? row.status) ?? statusFromPolling(polling, payload),
		createdAt: num(row.createdAt) ?? 0,
		updatedAt: row.updatedAt
	};
}

function readEntity(value: unknown): FederationEntity {
	const row = object(value);
	const type = row.explicitProviderType;
	return {
		entityId: str(row.entityId),
		role: row.role === 'saml_sp' || row.role === 'ambiguous' ? row.role : 'saml_idp',
		displayName: str(row.displayName) || null,
		logoUrl: str(row.logoUrl) || null,
		registrationAuthority: str(row.registrationAuthority) || null,
		entityCategories: strings(row.entityCategories),
		validUntil: str(row.validUntil) || null,
		excluded: row.excluded === true,
		policyAllowed: row.policyAllowed !== false,
		explicitProviderId: str(row.explicitProviderId) || null,
		// The server says `saml_sp`/`saml_idp`; the console's kinds are `sp`/`idp`.
		explicitProviderType: type === 'saml_sp' ? 'sp' : type === 'saml_idp' ? 'idp' : null
	};
}

function readHistory(value: unknown): FederationRefreshHistoryItem {
	const row = object(value);
	return {
		jobId: str(row.jobId),
		trigger: row.trigger === 'manual' ? 'manual' : 'automatic',
		status: row.status === 'failed' || row.status === 'running' ? row.status : 'completed',
		startedAt: num(row.startedAt) ?? 0,
		finishedAt: num(row.finishedAt),
		changed: typeof row.changed === 'boolean' ? row.changed : null,
		entityCount: num(row.entityCount),
		entityCountDelta: num(row.entityCountDelta),
		verificationStatus: (str(row.verificationStatus) || null) as FederationVerification | null,
		errorCode: str(row.errorCode) || null,
		documentId: str(row.documentId) || null
	};
}

// -- Transport -------------------------------------------------------------------------------

const TRUST = `${API_BASE_URL}/api/admin/federation/trust-sources`;
const SOURCES = `${API_BASE_URL}/api/admin/saml-federation-sources`;

async function send<T>(
	url: string,
	init: {
		method?: string;
		json?: unknown;
		receipt?: string;
		tenantId?: string;
		idempotencyKey?: string;
		signal?: AbortSignal;
	} = {}
): Promise<T> {
	const response = await adminFetch(url, {
		method: init.method ?? 'GET',
		tenantId: init.tenantId,
		signal: init.signal,
		includeJsonContentType: init.json !== undefined,
		headers: {
			...stepUpHeaders(init.receipt),
			...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {})
		},
		body: init.json === undefined ? undefined : JSON.stringify(init.json)
	});
	if (!response.ok) throw await errorFromResponse(response);
	return (await response.json().catch(() => ({}))) as T;
}

/**
 * A step-up protected write, bound to the tenant selected when it started: should a platform
 * admin switch tenants while the step-up is pending, the retry is cancelled rather than sent to
 * the newly selected tenant. One `Idempotency-Key` serves every attempt of the same write.
 */
function protectedWrite<T>(
	url: string,
	method: 'POST' | 'PUT' | 'DELETE',
	json?: unknown
): Promise<T> {
	const tenantId = tenantScope.tenantId ?? undefined;
	const idempotencyKey = crypto.randomUUID();
	return withStepUp((receipt) => {
		if ((tenantScope.tenantId ?? undefined) !== tenantId) throw new StepUpCancelledError();
		return send<T>(url, { method, json, receipt, tenantId, idempotencyKey });
	});
}

function body(input: FederationWrite | FederationUpdate) {
	return {
		sourceType: 'saml_aggregate',
		sourceKey: input.sourceKey,
		displayName: input.name,
		lifecycleState: input.lifecycleState,
		protocolPayload: input.payload,
		...('expectedUpdatedAt' in input ? { expectedUpdatedAt: input.expectedUpdatedAt } : {})
	};
}

function query(params: Record<string, string | number | string[] | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (Array.isArray(value)) for (const item of value) search.append(key, item);
		else if (value !== undefined && value !== '') search.set(key, String(value));
	}
	const text = search.toString();
	return text ? `?${text}` : '';
}

export const httpFederationSources: FederationSourcesClient = {
	async list(signal) {
		const result = object(await send(TRUST, { signal }));
		return Array.isArray(result.federationTrustSources)
			? result.federationTrustSources.map((row) => readSource(row))
			: [];
	},
	async get(id, signal) {
		const result = object(await send(`${TRUST}/${encodeURIComponent(id)}`, { signal }));
		return readSource(result.federationTrustSource, result.status);
	},
	async create(input) {
		const result = object(await protectedWrite(TRUST, 'POST', body(input)));
		// The mutation answers `{ result: { id, … } }`.
		const id = object(result.result).id ?? result.id;
		if (typeof id !== 'string') throw new Error('Invalid federation source response');
		return { id };
	},
	async update(id, input) {
		await protectedWrite(`${TRUST}/${encodeURIComponent(id)}`, 'PUT', body(input));
	},
	async remove(id) {
		await protectedWrite(`${TRUST}/${encodeURIComponent(id)}`, 'DELETE');
	},
	async refresh(id) {
		const result = object(
			await protectedWrite(`${SOURCES}/${encodeURIComponent(id)}/refresh-metadata`, 'POST', {})
		);
		return {
			changed: result.changed === true,
			entityCount: num(result.entityCount) ?? 0,
			verificationStatus: (str(result.verificationStatus) || null) as FederationVerification | null,
			status: readStatus(result.status)
		};
	},
	async entities(id, params = {}, signal) {
		const result = object(
			await send(
				`${TRUST}/${encodeURIComponent(id)}/entities${query({
					q: params.q,
					role: params.role,
					state: params.state,
					keyword: params.keywords,
					sort: params.sort,
					direction: params.direction,
					limit: params.limit,
					cursor: params.cursor
				})}`,
				{ signal }
			)
		);
		return {
			items: Array.isArray(result.items) ? result.items.map(readEntity) : [],
			nextCursor: str(result.nextCursor) || null,
			total: num(result.total) ?? 0,
			explicitLookupAvailable: result.explicitLookupAvailable !== false
		};
	},
	async entityKeywords(id, params = {}, signal) {
		const result = object(
			await send(
				`${TRUST}/${encodeURIComponent(id)}/entity-keywords${query({ role: params.role })}`,
				{ signal }
			)
		);
		return (Array.isArray(result.categories) ? result.categories : []).map((category) => {
			const row = object(category);
			return {
				type: str(row.type),
				values: (Array.isArray(row.values) ? row.values : []).map((value) => {
					const item = object(value);
					return { value: str(item.value), label: str(item.label), count: num(item.count) ?? 0 };
				})
			};
		});
	},
	async refreshHistory(id, limit, signal) {
		const result = object(
			await send(`${TRUST}/${encodeURIComponent(id)}/refresh-history${query({ limit })}`, {
				signal
			})
		);
		return Array.isArray(result.refreshHistory) ? result.refreshHistory.map(readHistory) : [];
	},
	async materialize(id, input) {
		const result = object(
			await protectedWrite(`${SOURCES}/${encodeURIComponent(id)}/entities/materialize`, 'POST', {
				entityId: input.entityId,
				providerType: input.providerType === 'sp' ? 'saml_sp' : 'saml_idp',
				...(input.fieldMappingSetId ? { fieldMappingSetId: input.fieldMappingSetId } : {}),
				...(input.attributePresetId ? { attributePresetId: input.attributePresetId } : {}),
				...(input.name ? { name: input.name } : {})
			})
		);
		if (typeof result.providerId !== 'string') throw new Error('Invalid materialize response');
		return {
			providerId: result.providerId,
			providerType: result.providerType === 'saml_sp' ? 'sp' : 'idp'
		};
	},
	previewCertificate: (certificate) =>
		send(`${API_BASE_URL}/api/admin/saml-metadata/certificate-preview`, {
			method: 'POST',
			json: { certificate }
		}),
	previewCertificateUrl: (url) =>
		send(`${API_BASE_URL}/api/admin/saml-metadata/certificate-preview`, {
			method: 'POST',
			json: { certificateUrl: url }
		})
};
