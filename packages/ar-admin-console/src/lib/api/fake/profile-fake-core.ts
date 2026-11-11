/**
 * The in-memory profiles behind the method and session profile fakes: a tenant's own profiles,
 * Default, and the platform's profiles with the tenant's copies of them, as the Admin API answers
 * them (profile-layer.ts).
 */
import { ApiError } from '../api-error';
import type { ProfileLayer } from '../profile-layer';

export interface FakeProfile {
	id: string;
	name: string;
	is_system: boolean;
	values: Record<string, unknown>;
	version: number | string;
	created_at: number | null;
	updated_at: number | null;
	layer: ProfileLayer | null;
}

export interface FakeProfilesOptions {
	/** Default's layer (its values are the tenant's own unless this says otherwise). */
	defaultLayer?: ProfileLayer;
	/** The platform does not let the tenant add profiles of its own. */
	creationNotAllowed?: boolean;
}

/** A layer for a fake: a profile the tenant may change, nothing kept over the platform's. */
export function fakeLayer(overrides: Partial<ProfileLayer> = {}): ProfileLayer {
	return {
		scope: 'platform',
		platformValues: {},
		overridden: false,
		overrideInactive: false,
		overrideInactiveReason: null,
		locked: false,
		editable: true,
		platformUpdated: false,
		copyVersion: null,
		...overrides
	};
}

const notEditable = (layer: ProfileLayer) =>
	new ApiError(
		403,
		'profile_not_editable',
		layer.locked
			? 'The platform has locked this profile'
			: 'The platform does not let tenants change its profiles',
		{ reason: layer.overrideInactiveReason ?? (layer.locked ? 'locked' : 'changes_not_allowed') }
	);

export function createFakeProfileStore(
	idPrefix: string,
	defaults: Record<string, unknown>,
	initial: FakeProfile[],
	options: FakeProfilesOptions
) {
	const profiles = new Map<string, FakeProfile>();
	profiles.set('default', {
		id: 'default',
		name: 'Default',
		is_system: true,
		values: { ...defaults },
		version: 'rev-1',
		created_at: null,
		updated_at: null,
		// The Admin API reports Default's layer too (the platform's Default under the tenant's).
		layer: structuredClone(options.defaultLayer ?? fakeLayer({ scope: 'tenant' }))
	});
	for (const profile of initial) profiles.set(profile.id, structuredClone(profile));
	let next = 1;
	// Versions are never reused: one read before a change (a save, a revert) stays stale after.
	let revision = 1;
	const nextVersion = (version: number | string): number | string =>
		typeof version === 'number' ? version + 1 : `rev-${++revision}`;
	const found = (id: string) => {
		const profile = profiles.get(id);
		if (!profile) throw new Error('Profile not found');
		return profile;
	};
	const copy = <T>(value: T): T => structuredClone(value);
	return {
		async list() {
			return [...profiles.values()].map(copy);
		},
		async get(id: string) {
			return copy(found(id));
		},
		async create(input: { name: string; values: Record<string, unknown> }) {
			if (options.creationNotAllowed) {
				throw new ApiError(
					403,
					'profile_creation_not_allowed',
					'The platform does not let tenants add profiles of their own'
				);
			}
			const now = Date.now();
			const profile: FakeProfile = {
				id: `${idPrefix}${next++}`,
				name: input.name,
				values: copy(input.values),
				is_system: false,
				version: 1,
				created_at: now,
				updated_at: now,
				layer: null
			};
			profiles.set(profile.id, profile);
			return copy(profile);
		},
		async update(
			id: string,
			version: number | string,
			input: { name: string; values: Record<string, unknown> }
		) {
			const before = found(id);
			if (before.layer && !before.layer.editable) throw notEditable(before.layer);
			if (before.version !== version) throw new Error('Profile changed');
			const profile: FakeProfile = {
				...before,
				name: input.name,
				values: copy(input.values),
				version: nextVersion(version),
				updated_at: Date.now(),
				layer: before.layer ? { ...before.layer, overridden: true } : null
			};
			profiles.set(id, profile);
			return copy(profile);
		},
		async remove(id: string) {
			profiles.delete(id);
		},
		async saveCopy(id: string, version: number | null, values: Record<string, unknown>) {
			const before = found(id);
			const layer = before.layer;
			if (!layer || layer.scope !== 'platform') throw new Error('Not a platform profile');
			if (!layer.editable) throw notEditable(layer);
			if (layer.copyVersion !== version) throw new Error('Profile changed');
			const profile: FakeProfile = {
				...before,
				values: copy(values),
				updated_at: Date.now(),
				layer: {
					...layer,
					overridden: true,
					overrideInactive: false,
					overrideInactiveReason: null,
					platformUpdated: false,
					copyVersion: (version ?? 0) + 1
				}
			};
			profiles.set(id, profile);
			return copy(profile);
		},
		async revert(id: string) {
			const before = found(id);
			const layer = before.layer ?? fakeLayer({ scope: 'tenant' });
			const profile: FakeProfile = {
				...before,
				// Removing settings changes the document: a version read before it is stale.
				version: nextVersion(before.version),
				values: copy(
					id === 'default' ? { ...defaults, ...layer.platformValues } : layer.platformValues
				),
				layer: {
					...layer,
					overridden: false,
					overrideInactive: false,
					overrideInactiveReason: null,
					platformUpdated: false,
					copyVersion: null
				}
			};
			profiles.set(id, profile);
			return copy(profile);
		}
	};
}

/** A fake profile as the Admin API answers it (the layer's fields, snake_case, at the top). */
export function fakeProfileRow(profile: FakeProfile): Record<string, unknown> {
	const { layer, ...rest } = profile;
	if (!layer) return rest;
	return {
		...rest,
		scope: layer.scope,
		platform_values: layer.platformValues,
		overridden: layer.overridden,
		override_inactive: layer.overrideInactive,
		override_inactive_reason: layer.overrideInactiveReason,
		locked: layer.locked,
		editable: layer.editable,
		platform_updated: layer.platformUpdated,
		...(layer.scope === 'platform' ? { version: layer.copyVersion } : {})
	};
}
