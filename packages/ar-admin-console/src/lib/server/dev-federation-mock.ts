/**
 * The tenant's SAML federation sources in the console dev mock (`AUTHRIM_ADMIN_UI_DEV_MOCK=true`):
 * the trust-source records and their entity and refresh-history views, the metadata refresh and
 * "make this entity an explicit connection". They are answered by the same in-memory fake as
 * Storybook (`federation-sources-fake.ts`) and written out in the wire shape the real Admin API
 * uses, so the console's own HTTP client is what the dev server exercises.
 */
import { ApiError } from '#lib/api/api-error.js';
import { createFakeFederationSources } from '#lib/api/fake/federation-sources-fake.js';
import type {
	FederationEntity,
	FederationMaterializeInput,
	FederationSource,
	FederationSourcesClient
} from '#lib/api/federation-sources.js';
import type { MockAnswer } from './dev-saml-settings-mock.js';

export type { MockAnswer };

const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

const wireType = (type: 'sp' | 'idp' | null) =>
	type === 'sp' ? 'saml_sp' : type === 'idp' ? 'saml_idp' : null;

function wireSource(source: FederationSource) {
	return {
		id: source.id,
		sourceType: 'saml_aggregate',
		sourceKey: source.sourceKey,
		displayName: source.name,
		lifecycleState: source.lifecycleState,
		protocolPayload: source.payload,
		status: source.status,
		createdAt: source.createdAt,
		updatedAt: source.updatedAt
	};
}

const wireEntity = (entity: FederationEntity) => ({
	...entity,
	explicitProviderType: wireType(entity.explicitProviderType)
});

/** What a materialized entity becomes in the rest of the mock: a connection the console can open. */
export interface MaterializedEntity {
	sourceId: string;
	input: FederationMaterializeInput;
	providerId: string;
	name: string;
}

/**
 * The answer for a federation request, or null when the path is not one. `body` is the request's
 * JSON, already read; `query` is its search string.
 */
export async function answerFederationMock(
	client: FederationSourcesClient,
	segments: readonly string[],
	method: string,
	body: unknown,
	query: URLSearchParams = new URLSearchParams(),
	onMaterialized?: (entity: MaterializedEntity) => void
): Promise<MockAnswer | null> {
	try {
		if (segments[0] === 'federation' && segments[1] === 'trust-sources') {
			const id = segments[2];
			const view = segments[3];
			if (!id) {
				if (method === 'GET')
					return {
						status: 200,
						body: { federationTrustSources: (await client.list()).map(wireSource) }
					};
				if (method === 'POST') {
					if (!isObject(body) || !isObject(body.protocolPayload))
						throw new ApiError(400, 'invalid_request', 'protocolPayload is required');
					const created = await client.create({
						sourceKey: String(body.sourceKey ?? ''),
						name: String(body.displayName ?? ''),
						lifecycleState:
							body.lifecycleState === 'active' || body.lifecycleState === 'retired'
								? body.lifecycleState
								: 'draft',
						payload: body.protocolPayload
					});
					// As the real mutation answers: the outcome is wrapped in `result`.
					return { status: 201, body: { result: { ...created, sourceType: 'saml_aggregate' } } };
				}
				return null;
			}
			if (!view) {
				if (method === 'GET') {
					const source = await client.get(id);
					return {
						status: 200,
						body: { federationTrustSource: wireSource(source), status: source.status }
					};
				}
				if (method === 'PUT') {
					if (!isObject(body) || !isObject(body.protocolPayload))
						throw new ApiError(400, 'invalid_request', 'protocolPayload is required');
					await client.update(id, {
						sourceKey: String(body.sourceKey ?? ''),
						name: String(body.displayName ?? ''),
						lifecycleState:
							body.lifecycleState === 'active' || body.lifecycleState === 'retired'
								? body.lifecycleState
								: 'draft',
						payload: body.protocolPayload,
						expectedUpdatedAt: Number(body.expectedUpdatedAt)
					});
					return { status: 200, body: { id, success: true } };
				}
				if (method === 'DELETE') {
					await client.remove(id);
					return { status: 200, body: { success: true } };
				}
				return null;
			}
			if (view === 'entities' && method === 'GET') {
				const role = query.get('role');
				const state = query.get('state');
				const limit = Number.parseInt(query.get('limit') ?? '', 10);
				const page = await client.entities(id, {
					q: query.get('q') ?? undefined,
					role:
						role === 'saml_idp' || role === 'saml_sp' || role === 'ambiguous' ? role : undefined,
					state:
						state === 'participating' || state === 'excluded' || state === 'explicit'
							? state
							: undefined,
					limit: Number.isFinite(limit) ? limit : undefined,
					cursor: query.get('cursor') ?? undefined
				});
				return { status: 200, body: { ...page, items: page.items.map(wireEntity) } };
			}
			if (view === 'requested-attributes' && method === 'GET') {
				return { status: 200, body: await client.requestedAttributes(id) };
			}
			if (view === 'refresh-history' && method === 'GET') {
				const limit = Number.parseInt(query.get('limit') ?? '', 10);
				return {
					status: 200,
					body: {
						refreshHistory: await client.refreshHistory(
							id,
							Number.isFinite(limit) ? limit : undefined
						)
					}
				};
			}
			return null;
		}
		if (segments[0] === 'saml-federation-sources' && segments[1] && method === 'POST') {
			const id = segments[1];
			if (segments[2] === 'refresh-metadata' && segments.length === 3)
				return { status: 200, body: { success: true, ...(await client.refresh(id)) } };
			if (segments[2] === 'entities' && segments[3] === 'materialize' && segments.length === 4) {
				if (!isObject(body) || typeof body.entityId !== 'string')
					throw new ApiError(400, 'invalid_request', 'entityId is required');
				const input: FederationMaterializeInput = {
					entityId: body.entityId,
					providerType: body.providerType === 'saml_sp' ? 'sp' : 'idp',
					...(typeof body.fieldMappingSetId === 'string'
						? { fieldMappingSetId: body.fieldMappingSetId }
						: {}),
					...(typeof body.name === 'string' ? { name: body.name } : {})
				};
				const result = await client.materialize(id, input);
				onMaterialized?.({
					sourceId: id,
					input,
					providerId: result.providerId,
					name: input.name ?? input.entityId
				});
				return {
					status: 201,
					body: {
						providerId: result.providerId,
						providerType: wireType(result.providerType),
						entityId: input.entityId,
						name: input.name ?? input.entityId,
						// Always a draft: the person enables it on the connection's own page.
						enabled: false,
						sourceId: id
					}
				};
			}
		}
		return null;
	} catch (error) {
		if (error instanceof ApiError) {
			return {
				status: error.status,
				body: { ...error.body, error: error.code, error_description: error.message }
			};
		}
		throw error;
	}
}

/** One fake per server process: an exclusion made in the console is there on the next request. */
export const devFederationSources = createFakeFederationSources();
