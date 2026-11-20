import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';
import type { MappingDestinationProfile } from './mapping-set';

/**
 * The output sources (destination profiles) a service flow makes and changes: what Authrim sends
 * to an app or service. A save is one action: the profile is written, reviewed and made active in
 * turn, so there are no versions or releases to manage. When the review stops (a warning the server
 * will not let through) the profile is kept as a draft and the result says so.
 *
 * - `GET /api/admin/field-mapping/destination-profiles`
 * - `POST …/destination-profiles`, `PUT …/destination-profiles/:id`
 * - `POST …/destination-profiles/:id/versions/:versionId/review` and `…/activate`
 */
export type DestinationKind = 'saml' | 'oidc';

export interface DestinationProfileInput {
	/** Set when an existing profile is changed. */
	id?: string;
	destinationType: DestinationKind;
	displayName: string;
	/** A new profile's key (not shown to anyone). */
	profileKey?: string;
	schema: Record<string, unknown>;
}

export interface DestinationProfileSaved {
	profile: MappingDestinationProfile;
	/** False: written, but the review stopped it from being switched on (see `reason`). */
	active: boolean;
	reason?: string;
}

export interface DestinationProfilesClient {
	/** The tenant's profiles of one kind (every lifecycle state). */
	list(
		tenantId: string,
		kind: DestinationKind,
		signal?: AbortSignal
	): Promise<MappingDestinationProfile[]>;
	save(tenantId: string, input: DestinationProfileInput): Promise<DestinationProfileSaved>;
}

const BASE = `${API_BASE_URL}/api/admin/field-mapping/destination-profiles`;

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

function post(tenantId: string, url: string, method: string, body: unknown): Promise<Response> {
	return adminFetch(url, {
		tenantId,
		method,
		headers: { 'Idempotency-Key': crypto.randomUUID() },
		includeJsonContentType: true,
		body: JSON.stringify(body)
	});
}

async function json(response: Response): Promise<Record<string, unknown>> {
	if (!response.ok) throw await errorFromResponse(response);
	return record(await response.json());
}

export const httpDestinationProfiles: DestinationProfilesClient = {
	async list(tenantId, kind, signal) {
		const result = await json(await adminFetch(BASE, { tenantId, signal }));
		const rows = Array.isArray(result.destinationProfiles) ? result.destinationProfiles : [];
		return (rows as MappingDestinationProfile[]).filter((row) => row.destinationType === kind);
	},
	async save(tenantId, input) {
		const body = {
			destinationType: input.destinationType,
			displayName: input.displayName,
			schema: input.schema,
			...(input.id ? {} : { profileKey: input.profileKey, ownerScopeType: 'tenant' })
		};
		const written = record(
			(
				await json(
					await post(
						tenantId,
						input.id ? `${BASE}/${encodeURIComponent(input.id)}` : BASE,
						input.id ? 'PUT' : 'POST',
						body
					)
				)
			).result
		) as unknown as MappingDestinationProfile;
		const id = written.id;
		const versionId = written.version?.id;
		let state = written.version?.lifecycleState ?? written.lifecycleState;
		try {
			if (state === 'draft' && versionId) {
				await json(
					await post(
						tenantId,
						`${BASE}/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/review`,
						'POST',
						{}
					)
				);
				state = 'reviewed';
			}
			if (state === 'reviewed' && versionId) {
				await json(
					await post(
						tenantId,
						`${BASE}/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/activate`,
						'POST',
						{}
					)
				);
				state = 'active';
			}
		} catch (error) {
			// Written but not switched on: the draft stays, and the caller says why.
			return {
				profile: written,
				active: false,
				reason: error instanceof Error ? error.message : ''
			};
		}
		// A failed re-read after switching on is not a failed save: what was written stands.
		const profiles = await this.list(tenantId, input.destinationType).catch(() => []);
		return {
			profile: profiles.find((row) => row.id === id) ?? written,
			active: state === 'active'
		};
	}
};
