import { API_BASE_URL, adminFetch } from './admin-request';
import { profileJson, profileRequest, readWritten, reviewAndActivate } from './profile-chain';
import type { MappingDestinationProfile } from './mapping-set';

/**
 * The output sources (destination profiles) a service flow makes and changes: what Authrim sends
 * to an app or service. A save is one action: the profile is written, reviewed and made active in
 * turn, so there are no versions or releases to manage. When the review stops (a warning the server
 * will not let through) the profile is kept as a draft and the result says so.
 *
 * - `GET /api/admin/identity-mapping/destination-profiles`
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
	/** Every profile of the tenant, of any kind (the profiles page). */
	listAll(tenantId: string, signal?: AbortSignal): Promise<MappingDestinationProfile[]>;
	save(tenantId: string, input: DestinationProfileInput): Promise<DestinationProfileSaved>;
	/**
	 * Switches on a version that was written but not activated (the review stopped it): reviews and
	 * activates it again, without writing anything new.
	 */
	activate(tenantId: string, written: MappingDestinationProfile): Promise<DestinationProfileSaved>;
	/** Deletes a profile; refused (409) while a mapping set sends into it. */
	remove(tenantId: string, id: string): Promise<void>;
}

const BASE = `${API_BASE_URL}/api/admin/identity-mapping/destination-profiles`;

export const httpDestinationProfiles: DestinationProfilesClient = {
	async list(tenantId, kind, signal) {
		return (await this.listAll(tenantId, signal)).filter((row) => row.destinationType === kind);
	},
	async listAll(tenantId, signal) {
		const result = await profileJson(await adminFetch(BASE, { tenantId, signal }));
		return (
			Array.isArray(result.destinationProfiles) ? result.destinationProfiles : []
		) as MappingDestinationProfile[];
	},
	async save(tenantId, input) {
		const body = {
			destinationType: input.destinationType,
			displayName: input.displayName,
			schema: input.schema,
			...(input.id ? {} : { profileKey: input.profileKey, ownerScopeType: 'tenant' })
		};
		const answer = await profileJson(
			await profileRequest(
				tenantId,
				input.id ? `${BASE}/${encodeURIComponent(input.id)}` : BASE,
				input.id ? 'PUT' : 'POST',
				body
			)
		);
		const { written, info } = readWritten(answer.result);
		const outcome = await reviewAndActivate(tenantId, BASE, info);
		if (!outcome.active) {
			return {
				profile: written as unknown as MappingDestinationProfile,
				active: false,
				reason: outcome.reason
			};
		}
		// A failed re-read after switching on is not a failed save: what was written stands.
		const profiles = await this.list(tenantId, input.destinationType).catch(() => []);
		return {
			profile:
				profiles.find((row) => row.id === info.id) ??
				(written as unknown as MappingDestinationProfile),
			active: true
		};
	},
	async activate(tenantId, written) {
		const kind = written.destinationType as DestinationKind;
		const versionId = written.version?.id;
		// Where the version stands now: an earlier try may have gone through with its answer lost.
		const before = (await this.list(tenantId, kind).catch(() => [])).find(
			(row) => row.id === written.id
		);
		const known = [before?.version, before?.activeVersion].find((v) => v?.id === versionId);
		const state = known?.lifecycleState ?? 'draft';
		const outcome =
			state === 'active'
				? { active: true as const }
				: await reviewAndActivate(tenantId, BASE, { id: written.id, versionId, state });
		if (!outcome.active) {
			return { profile: before ?? written, active: false, reason: outcome.reason };
		}
		// A failed re-read after switching on is not a failed activation: what was done stands.
		const profiles = await this.list(tenantId, kind).catch(() => []);
		return {
			profile: profiles.find((row) => row.id === written.id) ?? {
				...written,
				lifecycleState: 'active'
			},
			active: true
		};
	},
	async remove(tenantId, id) {
		await profileJson(
			await profileRequest(tenantId, `${BASE}/${encodeURIComponent(id)}`, 'DELETE')
		);
	}
};
