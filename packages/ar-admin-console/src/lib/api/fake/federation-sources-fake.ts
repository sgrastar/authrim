import { ApiError } from '../api-error';
import type {
	FederationCertificate,
	FederationEntity,
	FederationEntityPage,
	FederationEntityQuery,
	FederationRefreshHistoryItem,
	FederationRefreshResult,
	FederationSource,
	FederationSourcesClient,
	FederationStatus
} from '../federation-sources';
import type { SamlCertificatePreview } from '../saml-settings';

/** A synthetic self-signed certificate (never a real federation's), so stories show a real fingerprint. */
export const MOCK_FEDERATION_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBljCCAT2gAwIBAgIUUTx2a+ghj20/oSueJPse5mFodK0wCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWTW9jayBGZWRlcmF0aW9uIFNpZ25lcjAeFw0yNjExMTkyMzQ0
NTRaFw0zNjExMTYyMzQ0NTRaMCExHzAdBgNVBAMMFk1vY2sgRmVkZXJhdGlvbiBT
aWduZXIwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASxdskryKLcx56DZQOdYNUv
bKcAlX35JA9axWk8hvpjg42YRVavr99dFfhorkhkNhOXvdfJI6ZCoeKzeSO7krb4
o1MwUTAdBgNVHQ4EFgQU+RNNf91Ku2zinEHKz3afSKZl39IwHwYDVR0jBBgwFoAU
+RNNf91Ku2zinEHKz3afSKZl39IwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQD
AgNHADBEAiArTdLFGgOm3VgeAX9qf+FtHFeTTlZwMXTPunyGHh5LoAIgJwy2RjBM
7Tk3NclfGMycnNXW+DvOE5M3XJp2lH26R0s=
-----END CERTIFICATE-----`;
export const MOCK_FEDERATION_FINGERPRINT =
	'aa7bc75eef9d0af29978e6cf5a77b4649769dd985d1a92e7de73e8d6c8a28dab';
export const MOCK_FEDERATION_FINGERPRINT_SHA1 = 'fd21eeb543b37342821d7573f4fc07c5195dd56d';

/** What the server reads from the mock certificate. */
function mockCertificatePreview(): SamlCertificatePreview {
	return {
		certificate: MOCK_FEDERATION_CERTIFICATE,
		subject: 'CN=Mock Federation Signer',
		issuer: 'CN=Mock Federation Signer',
		serialNumber: '513C766BE8218F6D3FA12B9E24FB1EE6616874AD',
		validFrom: '2026-11-19T23:44:54.000Z',
		validTo: '2036-11-16T23:44:54.000Z',
		signatureAlgorithm: 'ecdsa-with-SHA256',
		publicKeyAlgorithm: 'EC',
		fingerprintSha1: MOCK_FEDERATION_FINGERPRINT_SHA1,
		fingerprintSha256: MOCK_FEDERATION_FINGERPRINT,
		warnings: []
	};
}

/** A copy that also takes what a Svelte form hands over (state proxies cannot be structured-cloned). */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const DAY = 24 * 60 * 60 * 1000;
// Relative to the real clock: the status card counts days left against it.
const NOW = Date.now();

const certificate: FederationCertificate = {
	id: 'cert-1',
	name: 'Federation signer',
	certificate: MOCK_FEDERATION_CERTIFICATE,
	fingerprintSha256: MOCK_FEDERATION_FINGERPRINT,
	createdAt: NOW - 30 * DAY
};

function source(
	id: string,
	name: string,
	extra: Partial<FederationSource> & { status: FederationStatus | null }
): FederationSource {
	const url = `https://metadata.${id}.example/federation/aggregate.xml`;
	const excluded = extra.excludedEntityIds ?? [];
	const base: FederationSource = {
		id,
		sourceKey: url,
		name,
		lifecycleState: 'active',
		description: '',
		metadataUrl: url,
		certificates: [certificate],
		roles: ['saml_sp'],
		automatic: true,
		idpMappingSetId: '',
		spMappingSetId: 'map-tenant-default',
		attributePresetId: 'standard',
		priority: null,
		polling: { mode: 'automatic', intervalSeconds: 6 * 60 * 60 },
		excludedEntityIds: excluded,
		registrationAuthorities: [],
		idpSelection: { mode: 'authrim_search', discoveryServiceUrl: '' },
		payload: {},
		createdAt: NOW - 60 * DAY,
		updatedAt: NOW - DAY,
		...extra
	};
	return base;
}

function status(partial: Partial<FederationStatus>): FederationStatus {
	return {
		sourceState: 'healthy',
		lastAttemptAt: NOW - 3_600_000,
		lastSuccessAt: NOW - 3_600_000,
		nextRefreshAt: NOW + 5 * 3_600_000,
		consecutiveFailures: 0,
		lastErrorCode: null,
		acceptedValidUntil: new Date(NOW + 14.5 * DAY).toISOString(),
		activeMetadataDocumentId: 'doc-1',
		entityCount: 1200,
		excludedCount: 3,
		lastVerification: { status: 'verified', at: NOW - 3_600_000 },
		...partial
	};
}

/** Three federations: one in good health, one whose metadata has run out, one not started yet. */
export const MOCK_FEDERATION_SOURCES: readonly FederationSource[] = [
	source('test-federation', 'Test federation', {
		roles: ['saml_idp', 'saml_sp'],
		idpMappingSetId: 'map-tenant-default',
		excludedEntityIds: [
			'https://sp.excluded-1.example/shibboleth',
			'https://sp.excluded-2.example/shibboleth',
			'https://sp.excluded-3.example/shibboleth'
		],
		status: status({})
	}),
	source('lapsed-federation', 'Lapsed federation', {
		status: status({
			sourceState: 'expired',
			acceptedValidUntil: new Date(NOW - 1.5 * DAY).toISOString(),
			lastSuccessAt: NOW - 16 * DAY,
			consecutiveFailures: 4,
			lastErrorCode: 'metadata_fetch_failed',
			entityCount: 480,
			excludedCount: 0
		})
	}),
	source('draft-federation', 'Draft federation', {
		lifecycleState: 'draft',
		certificates: [],
		status: null
	})
];

const SCOPES = ['University', 'Institute', 'College', 'Library', 'Hospital', 'Archive'];
const CATEGORIES = ['https://refeds.org/category/research-and-scholarship'];

/**
 * A federation's worth of entities: `count` of them (1,200 by default), the first three SPs the
 * test federation sets aside by default and one with an explicit connection of its own.
 */
export function mockEntities(count = 1200): FederationEntity[] {
	return Array.from({ length: count }, (_, index) => {
		const n = index + 1;
		const role =
			n <= 3 ? 'saml_sp' : n % 5 === 0 ? 'ambiguous' : n % 2 === 0 ? 'saml_idp' : 'saml_sp';
		const host = `${role === 'saml_idp' ? 'idp' : 'sp'}.${n === 1 ? 'excluded-1' : n === 2 ? 'excluded-2' : n === 3 ? 'excluded-3' : `inst-${n}`}.example`;
		return {
			entityId:
				role === 'saml_idp' ? `https://${host}/idp/shibboleth` : `https://${host}/shibboleth`,
			role,
			displayName: `${SCOPES[n % SCOPES.length]} of Example ${n}`,
			logoUrl: null,
			registrationAuthority: n % 3 === 0 ? 'https://registrar.example/' : null,
			entityCategories: n % 4 === 0 ? CATEGORIES : [],
			validUntil: null,
			excluded: false,
			policyAllowed: true,
			explicitProviderId: n === 7 ? 'saml-explicit-7' : null,
			explicitProviderType: n === 7 ? 'sp' : null
		};
	});
}

export interface FakeFederationSourcesOptions {
	sources?: readonly FederationSource[];
	/** The entities of every source (the exclusions of the source are applied on top). */
	entities?: readonly FederationEntity[];
	/** What a refresh answers, or the error it fails with. */
	refresh?: Partial<FederationRefreshResult> | Error;
	/** Every save finds the source changed by someone else. */
	conflictOnSave?: boolean;
	/** Milliseconds each call takes (0 by default; stories that show a loading state set it). */
	delay?: number;
}

export interface FakeFederationSources extends FederationSourcesClient {
	/** The calls that changed something, for a story to assert on. */
	readonly calls: {
		created: unknown[];
		updated: { id: string; input: unknown }[];
		removed: string[];
		refreshed: string[];
		materialized: { id: string; input: unknown }[];
	};
}

function history(sourceId: string): FederationRefreshHistoryItem[] {
	return [
		{
			jobId: `${sourceId}-job-3`,
			trigger: 'automatic',
			status: 'completed',
			startedAt: NOW - 3_600_000,
			finishedAt: NOW - 3_590_000,
			changed: true,
			entityCount: 1200,
			entityCountDelta: 4,
			verificationStatus: 'verified',
			errorCode: null,
			documentId: 'doc-3'
		},
		{
			jobId: `${sourceId}-job-2`,
			trigger: 'manual',
			status: 'failed',
			startedAt: NOW - 9 * DAY,
			finishedAt: NOW - 9 * DAY + 5000,
			changed: null,
			entityCount: null,
			entityCountDelta: null,
			verificationStatus: null,
			errorCode: 'metadata_fetch_failed',
			documentId: null
		},
		{
			jobId: `${sourceId}-job-1`,
			trigger: 'automatic',
			status: 'completed',
			startedAt: NOW - 15 * DAY,
			finishedAt: NOW - 15 * DAY + 12_000,
			changed: true,
			entityCount: 1196,
			entityCountDelta: null,
			verificationStatus: 'verified',
			errorCode: null,
			documentId: 'doc-1'
		}
	];
}

export function createFakeFederationSources(
	options: FakeFederationSourcesOptions = {}
): FakeFederationSources {
	const sources = new Map<string, FederationSource>(
		(options.sources ?? MOCK_FEDERATION_SOURCES).map((row) => [row.id, clone(row)])
	);
	const entities = clone([...(options.entities ?? mockEntities())]);
	const wait = () =>
		options.delay ? new Promise<void>((resolve) => setTimeout(resolve, options.delay)) : undefined;
	let clock = 0;
	let counter = 0;
	const calls: FakeFederationSources['calls'] = {
		created: [],
		updated: [],
		removed: [],
		refreshed: [],
		materialized: []
	};
	const find = (id: string) => {
		const row = sources.get(id);
		if (!row) throw new ApiError(404, 'not_found', 'Federation source not found');
		return row;
	};
	const view = (row: FederationSource): FederationSource => ({
		...clone(row),
		status: row.status ? { ...row.status, excludedCount: row.excludedEntityIds.length } : row.status
	});
	const viewOf = (row: FederationSource, entity: FederationEntity): FederationEntity => ({
		...entity,
		excluded: row.excludedEntityIds.includes(entity.entityId)
	});

	return {
		calls,
		async list() {
			await wait();
			return [...sources.values()].map(view);
		},
		async get(id) {
			await wait();
			return view(find(id));
		},
		async create(input) {
			await wait();
			calls.created.push(clone(input));
			if ([...sources.values()].some((row) => row.sourceKey === input.sourceKey))
				throw new ApiError(409, 'conflict', 'A federation with this address exists');
			const id = `federation-${++counter}`;
			const payload = input.payload;
			const resolution = (payload.runtimeResolution ?? {}) as Record<string, unknown>;
			const roles = (
				Array.isArray(resolution.roles) ? resolution.roles : []
			) as FederationSource['roles'];
			sources.set(id, {
				id,
				sourceKey: input.sourceKey,
				name: input.name,
				lifecycleState: input.lifecycleState,
				description: String(payload.description ?? ''),
				metadataUrl: String(payload.metadataUrl ?? ''),
				certificates: (payload.certificates ?? []) as FederationCertificate[],
				roles,
				automatic: true,
				idpMappingSetId: String(resolution.idpFieldMappingSetId ?? ''),
				spMappingSetId: String(resolution.spFieldMappingSetId ?? ''),
				attributePresetId: String(resolution.defaultAttributePresetId ?? ''),
				priority: null,
				polling: { mode: 'automatic', intervalSeconds: 6 * 60 * 60 },
				registrationAuthorities: [],
				excludedEntityIds: [],
				idpSelection: { mode: 'authrim_search', discoveryServiceUrl: '' },
				payload: clone(payload),
				status: null,
				createdAt: NOW + ++clock * 1000,
				updatedAt: NOW + clock * 1000
			});
			return { id };
		},
		async update(id, input) {
			await wait();
			const row = find(id);
			if (options.conflictOnSave || input.expectedUpdatedAt !== row.updatedAt)
				throw new ApiError(409, 'conflict', 'The federation changed since it was read');
			calls.updated.push({ id, input: clone(input) });
			const payload = input.payload;
			const resolution = (payload.runtimeResolution ?? {}) as Record<string, unknown>;
			const exceptions = (payload.exceptions ?? {}) as { excludedEntityIds?: string[] };
			const selection = (payload.idpSelection ?? {}) as {
				mode?: 'authrim_search' | 'external_ds';
				discoveryServiceUrl?: string;
			};
			sources.set(id, {
				...row,
				name: input.name,
				lifecycleState: input.lifecycleState,
				description: String(payload.description ?? ''),
				metadataUrl: String(payload.metadataUrl ?? row.metadataUrl),
				certificates: (payload.certificates ?? row.certificates) as FederationCertificate[],
				roles: (Array.isArray(resolution.roles)
					? resolution.roles
					: row.roles) as FederationSource['roles'],
				idpMappingSetId: String(resolution.idpFieldMappingSetId ?? ''),
				spMappingSetId: String(resolution.spFieldMappingSetId ?? ''),
				attributePresetId: String(resolution.defaultAttributePresetId ?? ''),
				registrationAuthorities: Array.isArray(resolution.registrationAuthorities)
					? (resolution.registrationAuthorities as string[])
					: [],
				excludedEntityIds: exceptions.excludedEntityIds ?? [],
				idpSelection: {
					mode: selection.mode ?? 'authrim_search',
					discoveryServiceUrl: selection.discoveryServiceUrl ?? ''
				},
				payload: clone(payload),
				updatedAt: row.updatedAt + 1
			});
		},
		async remove(id) {
			await wait();
			find(id);
			calls.removed.push(id);
			sources.delete(id);
		},
		async refresh(id) {
			await wait();
			const row = find(id);
			calls.refreshed.push(id);
			if (options.refresh instanceof Error) throw options.refresh;
			const result: FederationRefreshResult = {
				changed: true,
				entityCount: entities.length,
				verificationStatus: 'verified',
				status: status({
					entityCount: entities.length,
					excludedCount: row.excludedEntityIds.length
				}),
				...options.refresh
			};
			// A fetch moves the source's version, as on the server.
			if (result.status)
				sources.set(id, { ...row, status: result.status, updatedAt: row.updatedAt + 1 });
			return clone(result);
		},
		async entities(id, query: FederationEntityQuery = {}): Promise<FederationEntityPage> {
			await wait();
			const row = find(id);
			const needle = (query.q ?? '').trim().toLowerCase();
			const matches = entities
				.map((entity) => viewOf(row, entity))
				.filter(
					(entity) =>
						(!needle ||
							entity.entityId.toLowerCase().includes(needle) ||
							(entity.displayName ?? '').toLowerCase().includes(needle)) &&
						(!query.role || entity.role === query.role) &&
						(!query.state ||
							(query.state === 'explicit'
								? entity.explicitProviderId !== null
								: query.state === 'excluded'
									? entity.excluded && entity.explicitProviderId === null
									: !entity.excluded && entity.explicitProviderId === null))
				)
				.sort(
					(a, b) =>
						(a.displayName ?? '').localeCompare(b.displayName ?? '') ||
						a.entityId.localeCompare(b.entityId)
				);
			const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
			const start = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
			const items = matches.slice(start, start + limit);
			return {
				items,
				nextCursor: start + limit < matches.length ? String(start + limit) : null,
				total: matches.length,
				explicitLookupAvailable: true
			};
		},
		async refreshHistory(id, limit = 20) {
			await wait();
			find(id);
			return history(id).slice(0, limit);
		},
		async materialize(id, input) {
			await wait();
			find(id);
			const entity = entities.find((candidate) => candidate.entityId === input.entityId);
			if (!entity) throw new ApiError(404, 'not_found', 'Entity not found in this federation');
			if (entity.explicitProviderId)
				throw new ApiError(409, 'saml_explicit_provider_exists', 'An explicit connection exists');
			calls.materialized.push({ id, input: clone(input) });
			const providerId = `saml-materialized-${++counter}`;
			entity.explicitProviderId = providerId;
			entity.explicitProviderType = input.providerType;
			return { providerId, providerType: input.providerType };
		},
		async previewCertificate(pem): Promise<SamlCertificatePreview> {
			await wait();
			if (pem.trim() !== MOCK_FEDERATION_CERTIFICATE)
				throw new ApiError(400, 'invalid_certificate', 'Not a certificate');
			return mockCertificatePreview();
		},
		async previewCertificateUrl(url): Promise<SamlCertificatePreview> {
			await wait();
			// The server accepts only an external https address, and answers 400 for anything that
			// does not serve a certificate.
			if (!/^https:\/\//i.test(url.trim()) || /unreachable|notacert/i.test(url))
				throw new ApiError(400, 'invalid_request', 'Not a certificate');
			return mockCertificatePreview();
		}
	};
}
