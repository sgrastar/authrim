import type {
	SessionProfile,
	SessionProfileInput,
	SessionProfilesClient
} from '../session-profiles';

/** The tenant's session settings as the fake's Default profile has them. */
const defaults = {
	'session.default_ttl': 86_400_000,
	'session.max_ttl': 2_592_000_000,
	'session.ttl.passkey': 604_800_000,
	'session.ttl.email_code': 86_400_000,
	'session.ttl.directory_password': 86_400_000,
	'session.ttl.direct_auth': 86_400_000,
	'session.ttl.did': 86_400_000,
	'session.ttl.guest': 86_400_000,
	'session.ttl.passkey_registration': 2_592_000_000,
	'session.refresh_default': true,
	'oauth.sso_enabled': true
};

export function createFakeSessionProfiles(initial: SessionProfile[] = []): SessionProfilesClient {
	const profiles = new Map<string, SessionProfile>();
	profiles.set('default', {
		id: 'default',
		name: 'Default',
		is_system: true,
		values: { ...defaults },
		version: 'rev-1',
		created_at: null,
		updated_at: null
	});
	for (const profile of initial) profiles.set(profile.id, structuredClone(profile));
	let next = 1;
	return {
		async list() {
			return [...profiles.values()].map((item) => structuredClone(item));
		},
		async get(id) {
			const profile = profiles.get(id);
			if (!profile) throw new Error('Profile not found');
			return structuredClone(profile);
		},
		async create(input: SessionProfileInput) {
			const now = Date.now();
			const profile: SessionProfile = {
				id: `sp_${next++}`,
				name: input.name,
				values: structuredClone(input.values),
				is_system: false,
				version: 1,
				created_at: now,
				updated_at: now
			};
			profiles.set(profile.id, profile);
			return structuredClone(profile);
		},
		async update(id, version, input) {
			const before = profiles.get(id);
			if (!before || before.version !== version) throw new Error('Profile changed');
			const profile = {
				...before,
				name: input.name,
				values: structuredClone(input.values),
				version: typeof version === 'number' ? version + 1 : 'rev-2',
				updated_at: Date.now()
			};
			profiles.set(id, profile);
			return structuredClone(profile);
		},
		async remove(id) {
			profiles.delete(id);
		}
	};
}
