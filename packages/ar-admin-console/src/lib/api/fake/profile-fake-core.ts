/**
 * The in-memory profiles behind the method and session profile fakes: a tenant's own profiles,
 * Default, and the platform's profiles with the tenant's copies of them, as the Admin API answers
 * them (profile-layer.ts).
 */
import { ApiError } from '../api-error';
import type { PlatformProfile } from '../platform-profiles';
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
	/**
	 * The platform's profiles of this kind, read on every call: the tenant sees them as they are
	 * now (a lock, a change, a delete on the platform shows at once). Its copies of them are kept
	 * in `copies`. Without it, the platform profiles are the ones given in `initial`.
	 */
	platform?: { list(): Promise<PlatformProfile[]> };
	/** The tenant's copies of platform profiles (with `platform`; shared to count them there). */
	copies?: Map<string, FakeProfileCopy>;
}

/** A tenant's copy of a platform profile. */
export interface FakeProfileCopy {
	values: Record<string, unknown>;
	/** The copy's own version (what its next save names). */
	copyVersion: number;
	/** The platform profile's version the copy was made from. */
	from: number;
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
	const copies = options.copies ?? new Map<string, FakeProfileCopy>();
	const platformVersions = new Map<string, number>();
	/** The platform's profiles as the tenant lists them now, with its copies over them. */
	async function sync() {
		if (!options.platform) return;
		const platform = (await options.platform.list()).filter((item) => item.state === 'active');
		for (const [id, profile] of profiles)
			if (profile.layer?.scope === 'platform') profiles.delete(id);
		platformVersions.clear();
		for (const item of platform) {
			platformVersions.set(item.id, item.version);
			const kept = copies.get(item.id);
			// A locked profile sets the tenant's copy aside (kept, not applied).
			const setAside = kept !== undefined && item.locked;
			profiles.set(item.id, {
				id: item.id,
				name: item.name,
				is_system: false,
				values: copy(kept && !setAside ? kept.values : item.values),
				version: item.version,
				created_at: item.created_at,
				updated_at: item.updated_at,
				layer: fakeLayer({
					platformValues: copy(item.values),
					overridden: kept !== undefined && !setAside,
					overrideInactive: setAside,
					overrideInactiveReason: setAside ? 'locked' : null,
					locked: item.locked,
					editable: !item.locked,
					platformUpdated: kept !== undefined && kept.from !== item.version,
					copyVersion: kept?.copyVersion ?? null
				})
			});
		}
	}
	return {
		async list() {
			await sync();
			return [...profiles.values()].map(copy);
		},
		async get(id: string) {
			await sync();
			return copy(found(id));
		},
		async create(input: { name: string; values: Record<string, unknown> }) {
			await sync();
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
			await sync();
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
			await sync();
			if (found(id).layer?.scope === 'platform') throw new Error('A platform profile');
			profiles.delete(id);
		},
		async saveCopy(id: string, version: number | null, values: Record<string, unknown>) {
			await sync();
			const before = found(id);
			const layer = before.layer;
			if (!layer || layer.scope !== 'platform') throw new Error('Not a platform profile');
			if (!layer.editable) throw notEditable(layer);
			if (layer.copyVersion !== version) throw new Error('Profile changed');
			if (options.platform) {
				copies.set(id, {
					values: copy(values),
					copyVersion: (version ?? 0) + 1,
					// Saving a copy again keeps the version it was made from (as the Admin API does).
					from: copies.get(id)?.from ?? platformVersions.get(id) ?? 0
				});
				await sync();
				return copy(found(id));
			}
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
			await sync();
			const before = found(id);
			if (options.platform && before.layer?.scope === 'platform') {
				copies.delete(id);
				await sync();
				return copy(found(id));
			}
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
