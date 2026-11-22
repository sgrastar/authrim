import { API_BASE_URL, adminFetch } from './admin-request';
import { profileJson, profileRequest, readWritten, reviewAndActivate } from './profile-chain';

/**
 * The input sources (source profiles) of the tenant: what comes in for a mapping (the columns of
 * a CSV file, the attributes of a SCIM user). As for output sources, a save writes, reviews and
 * switches the profile on in one action.
 *
 * - `GET /api/admin/identity-mapping/source-profiles`
 * - `POST …/source-profiles`, `PUT …/source-profiles/:id`, `DELETE …/source-profiles/:id`
 * - `POST …/source-profiles/:id/versions/:versionId/review` and `…/activate`
 */
export type SourceKind = 'scim' | 'csv';

export interface SourceProfileVersion {
	id: string;
	versionLabel?: string | null;
	lifecycleState?: string | null;
	schema?: Record<string, unknown>;
}

export interface SourceProfile {
	id: string;
	sourceType: string;
	profileKey: string;
	displayName: string;
	lifecycleState: string;
	activeVersionId?: string | null;
	/** The version changed last (a draft while an edit is not switched on yet). */
	version?: SourceProfileVersion | null;
	activeVersion?: SourceProfileVersion | null;
}

export interface SourceProfileInput {
	id?: string;
	sourceType: SourceKind;
	displayName: string;
	profileKey?: string;
	schema: Record<string, unknown>;
}

export interface SourceProfileSaved {
	profile: SourceProfile;
	active: boolean;
	reason?: string;
}

export interface SourceProfilesClient {
	list(tenantId: string, signal?: AbortSignal): Promise<SourceProfile[]>;
	save(tenantId: string, input: SourceProfileInput): Promise<SourceProfileSaved>;
	remove(tenantId: string, id: string): Promise<void>;
}

const BASE = `${API_BASE_URL}/api/admin/identity-mapping/source-profiles`;

export const httpSourceProfiles: SourceProfilesClient = {
	async list(tenantId, signal) {
		const result = await profileJson(await adminFetch(BASE, { tenantId, signal }));
		return (Array.isArray(result.sourceProfiles) ? result.sourceProfiles : []) as SourceProfile[];
	},
	async save(tenantId, input) {
		const body = {
			sourceType: input.sourceType,
			displayName: input.displayName,
			schema: input.schema,
			...(input.id ? {} : { profileKey: input.profileKey })
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
		if (!outcome.active)
			return {
				profile: written as unknown as SourceProfile,
				active: false,
				reason: outcome.reason
			};
		const profiles = await this.list(tenantId).catch(() => []);
		return {
			profile: profiles.find((row) => row.id === info.id) ?? (written as unknown as SourceProfile),
			active: true
		};
	},
	async remove(tenantId, id) {
		await profileJson(
			await profileRequest(tenantId, `${BASE}/${encodeURIComponent(id)}`, 'DELETE')
		);
	}
};
