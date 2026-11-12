import { ApiError } from '../api-error';
import type {
	PlatformProfile,
	PlatformProfileInput,
	PlatformProfilesClient
} from '../platform-profiles';

export interface FakePlatformProfilesOptions {
	/** Profiles a tenant's Flow still names: deleting them is refused (409 profile_in_use). */
	inUse?: string[];
	/** How many profiles the platform may hold (409 limit_reached past it). */
	limit?: number;
}

/** The platform's profiles of one kind, in memory (`pmp_` / `psp_` ids). */
export function createFakePlatformProfiles(
	idPrefix: 'pmp_' | 'psp_',
	initial: PlatformProfile[] = [],
	options: FakePlatformProfilesOptions = {}
): PlatformProfilesClient {
	const profiles = new Map<string, PlatformProfile>();
	for (const profile of initial) profiles.set(profile.id, structuredClone(profile));
	let next = 1;
	const copy = <T>(value: T): T => structuredClone(value);
	const found = (id: string) => {
		const profile = profiles.get(id);
		if (!profile) throw new ApiError(404, 'not_found', 'Platform profile not found');
		return profile;
	};
	const current = (id: string, version: number) => {
		const profile = found(id);
		if (profile.version !== version) {
			throw new ApiError(409, 'conflict', 'The profile changed; reload and try again', {
				error: 'conflict',
				current_version: profile.version
			});
		}
		return profile;
	};
	const nameTaken = (name: string, except?: string) =>
		[...profiles.values()].some(
			(profile) => profile.id !== except && profile.name.toLowerCase() === name.toLowerCase()
		);
	return {
		async list() {
			return [...profiles.values()].map(copy);
		},
		async get(id) {
			return copy(found(id));
		},
		async create(input: PlatformProfileInput) {
			if (options.limit !== undefined && profiles.size >= options.limit) {
				throw new ApiError(409, 'limit_reached', 'The platform has its most profiles', {
					error: 'limit_reached'
				});
			}
			if (nameTaken(input.name)) {
				throw new ApiError(409, 'conflict', 'A platform profile has this name', {
					error: 'conflict'
				});
			}
			const now = Date.now();
			const profile: PlatformProfile = {
				id: `${idPrefix}${next++}`,
				name: input.name,
				values: copy(input.values),
				version: 1,
				locked: false,
				state: 'active',
				overridingTenants: 0,
				created_at: now,
				updated_at: now
			};
			profiles.set(profile.id, profile);
			return copy(profile);
		},
		async update(id, version, input) {
			const before = current(id, version);
			if (nameTaken(input.name, id)) {
				throw new ApiError(409, 'conflict', 'A platform profile has this name', {
					error: 'conflict'
				});
			}
			const profile = {
				...before,
				name: input.name,
				values: copy(input.values),
				version: version + 1,
				updated_at: Date.now()
			};
			profiles.set(id, profile);
			return copy(profile);
		},
		async setLocked(id, version, locked) {
			const profile = { ...current(id, version), locked, version: version + 1 };
			profiles.set(id, profile);
			return copy(profile);
		},
		async remove(id) {
			found(id);
			if (options.inUse?.includes(id)) {
				throw new ApiError(409, 'profile_in_use', 'A service flow uses this profile', {
					error: 'profile_in_use'
				});
			}
			profiles.delete(id);
		}
	};
}
