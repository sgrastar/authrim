import { createFakeProfileStore, type FakeProfilesOptions } from './profile-fake-core';
import type { SessionProfile, SessionProfilesClient } from '../session-profiles';

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

export function createFakeSessionProfiles(
	initial: SessionProfile[] = [],
	options: FakeProfilesOptions = {}
): SessionProfilesClient {
	return createFakeProfileStore('sp_', defaults, initial, options) as SessionProfilesClient;
}
