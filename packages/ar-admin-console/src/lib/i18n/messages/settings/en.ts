import type { jaSettings } from './ja';

export const enSettings: Record<keyof typeof jaSettings, string> = {
	'set.page.stayingSignedIn': 'Staying signed in',
	'set.page.stayingSignedIn.desc':
		'How long people stay signed in once they have signed in, and how long their apps keep that sign-in.',
	'set.page.signingKeys': 'Signing keys',
	'set.page.signingKeys.desc': 'How this tenant signs its tokens.',
	'set.section.idTokenSigning': 'ID token signing',
	'set.section.idTokenSigning.desc':
		'The algorithm ID tokens are signed with, and whether apps may choose their own.',

	'set.section.signIn': 'Sign-in length',
	'set.section.signIn.desc': 'How long a person stays signed in to Authrim.',
	'set.section.signIn.advanced': 'Length per sign-in method, and the allowed range',
	'set.section.appTokens': 'Tokens for apps',
	'set.section.appTokens.desc': 'How long the tokens that let apps keep using a sign-in are valid.',
	'set.section.appTokens.advanced': 'ID tokens, and how refresh tokens are renewed',
	'set.section.logout': 'Logout notices',
	'set.section.logout.desc':
		'What happens when Authrim tells apps that a person has signed out (back-channel logout).',
	'set.section.logout.advanced': 'When a notice does not arrive, and retries',

	'set.k.session.default_ttl': 'Keep people signed in for',
	'set.k.session.default_ttl.desc':
		'Time until the person has to sign in again, for sign-ins without a time of their own, such as with an external IdP or SAML. Set passkeys, email codes and the other methods under Advanced.',
	'set.k.session.refresh_default': 'Extend the sign-in while it is in use',
	'set.k.session.refresh_default.desc':
		'When an app asks to extend the sign-in (/api/sessions/refresh), the time starts again from then. Off: no extension. An extension never goes past the longest time to stay signed in.',
	'set.k.oauth.sso_enabled': 'Share the sign-in between apps (single sign-on)',
	'set.k.oauth.sso_enabled.desc':
		'Signed in once, a person opens the tenant’s other apps without signing in again. Off: every app asks them to sign in.',
	'set.k.session.ttl.passkey': 'After signing in with a passkey',
	'set.k.session.ttl.email_code': 'After signing in with an email code',
	'set.k.session.ttl.directory_password': 'After signing in with a directory password',
	'set.k.session.ttl.direct_auth': 'After signing in with Direct Auth',
	'set.k.session.ttl.did': 'After signing in with a DID',
	'set.k.session.ttl.guest': 'After signing in as a guest',
	'set.k.session.ttl.passkey_registration': 'Right after registering a passkey',
	'set.k.session.max_ttl': 'Longest sign-in allowed',
	'set.k.session.max_ttl.desc':
		'The longest a sign-in lasts, extensions included. A longer time for a sign-in method is cut to this.',

	'set.k.oauth.access_token_expiry': 'Access token lifetime',
	'set.k.oauth.access_token_expiry.desc':
		'The token an app uses to call APIs. The shorter it is, the less a leaked one can do.',
	'set.k.oauth.refresh_token_expiry': 'Refresh token lifetime',
	'set.k.oauth.refresh_token_expiry.desc':
		'How long an app can get new access tokens without asking the person to sign in again.',
	'set.k.oauth.id_token_expiry': 'ID token lifetime',
	'set.k.oauth.id_token_expiry.desc': 'The token that tells an app who signed in.',
	'set.k.oauth.refresh_token_rotation': 'Replace the refresh token each time it is used',
	'set.k.oauth.id_token_signing_alg': 'ID token signing algorithm',
	'set.k.oauth.id_token_signing_alg.desc':
		'Signs the ID tokens of apps that do not choose their own algorithm.',
	'set.k.oauth.id_token_signing_alg_client_override': 'Apps may choose their own algorithm',
	'set.k.oauth.id_token_signing_alg_client_override.desc':
		'Off: every ID token is signed with the tenant’s algorithm, and an app registered with another one is refused.',
	'set.k.security.fapi_enabled': 'Apply FAPI 2.0',
	'set.k.security.fapi_enabled.desc':
		'Apply the FAPI 2.0 Security Profile to every app of the tenant.',
	'set.k.oauth.id_token_signing_alg.RS256': 'RS256',
	'set.k.oauth.id_token_signing_alg.ES256': 'ES256',
	'set.k.oauth.id_token_signing_alg.PS256': 'PS256',
	'set.k.oauth.refresh_token_rotation.desc':
		'A used token stops working, so a leaked one cannot be used again. Keeping this on is recommended.',
	'set.k.oauth.refresh_token_sliding_window_enabled': 'Extend the lifetime each time it is used',
	'set.k.oauth.refresh_token_sliding_window_enabled.desc':
		'Each use of the refresh token starts its lifetime again.',
	'set.k.oauth.refresh_token_absolute_expiry_enabled': 'Set a limit that extending cannot pass',
	'set.k.oauth.refresh_token_absolute_expiry_enabled.desc':
		'Limits the time since the first token was issued. After it, the person signs in again.',
	'set.k.oauth.refresh_token_absolute_expiry': 'Limit (from the first token)',
	'set.k.oauth.offline_access_required': 'Issue only to apps that ask for offline_access',
	'set.k.oauth.offline_access_required.desc':
		'Off: refresh tokens are issued whatever scopes the app asks for.',
	'set.k.oauth.refresh_id_token_reissue': 'Issue a new ID token on refresh too',

	'set.k.session.backchannel_on_failure': 'When a notice does not arrive',
	'set.k.session.backchannel_on_failure.desc':
		'What to do when retries do not get the notice through.',
	'set.k.session.backchannel_on_failure.ignore': 'Nothing',
	'set.k.session.backchannel_on_failure.log': 'Write it to the log',
	'set.k.session.backchannel_on_failure.error': 'Treat it as an error',
	'set.k.session.backchannel_retry_max_attempts': 'Retries',
	'set.k.session.backchannel_logout_token_exp': 'Logout token lifetime',
	'set.k.session.backchannel_request_timeout_ms': 'Wait for the app’s answer for',
	'set.k.session.backchannel_retry_initial_delay_ms': 'Time before the first retry',
	'set.k.session.backchannel_retry_max_delay_ms': 'Longest time between retries',
	'set.k.session.backchannel_retry_backoff_multiplier':
		'Factor that lengthens the time between retries',

	'settings.advanced': 'Advanced',
	'settings.setHere': 'Overridden settings: {n}',
	'settings.readOnly.title': 'View only',
	'settings.readOnly.body':
		'You cannot change these settings. To have them changed, ask an admin who can.',
	'settings.rejected': 'This value could not be saved ({reason})',
	'settings.partial': 'Some settings could not be saved. Check the marked ones.',
	'settings.setHereOption': 'Override',
	'settings.defaultFrom.platform': 'Platform default: {value}',
	'settings.defaultFrom.tenant': 'Tenant default: {value}',
	'settings.locked.platform': 'Fixed by the platform settings',
	'settings.inDevelopment': 'In development: changing this has no effect yet',
	'settings.locked.tenant': 'Fixed by the tenant settings',
	'settings.badge.locked': 'Locked',
	'settings.badge.here': 'Overridden',
	'settings.badge.inDevelopment': 'In development',
	'settings.notice.idTokenAlgorithm.title': 'This departs from OpenID Connect Discovery',
	'settings.notice.idTokenAlgorithm.body':
		'Every ID token is signed with an algorithm other than RS256 and apps may not choose RS256, so the discovery document no longer offers RS256, which OpenID Connect Discovery requires. Discovery itself keeps working.',
	'settings.notice.fapi.title': 'FAPI 2.0 requirements apply',
	'settings.notice.fapi.body':
		'Requests FAPI 2.0 does not allow, such as authorization requests without PAR, are refused, so apps that do not support FAPI may stop working. Discovery keeps working as the specification describes.',
	'settings.value.on': 'On',
	'settings.value.off': 'Off',
	'settings.value.empty': '(none)',
	'settings.conflict.title': 'Another admin saved first',
	'settings.conflict.body': 'Since you opened this page, another admin changed these settings:',
	'settings.conflict.reload': 'Load the latest values',
	'settings.conflict.reload.desc': 'Your changes are discarded.',
	'settings.conflict.overwrite': 'Save my changes over them',
	'settings.conflict.overwrite.desc':
		'Only the settings you changed are saved, on top of the latest values.',

	'inherit.usingDeployment': 'Using the deployment’s setting',
	'inherit.sourceBuiltIn': 'Authrim',

	'access.none.title': 'You cannot see this page',
	'access.none.body': 'Open another page, or ask an admin who has access.',
	'load.error.title': 'This could not be loaded',
	'load.error.body': 'Try again in a moment.',
	'load.retry': 'Try again',

	'persona.label': 'Kind of admin',
	'persona.platform': 'Platform admin',
	'persona.platform.desc': 'Runs the whole installation: every tenant, and the platform.',
	'persona.tenant': 'Tenant admin',
	'persona.tenant.desc': 'Runs one tenant: its users, apps and settings.',
	'persona.support': 'Support (limited)',
	'persona.support.desc': 'Only helps users (unlocking, signing out). Does not see settings.',
	'persona.viewer': 'Viewer (limited)',
	'persona.viewer.desc': 'Sees users, apps and settings, and changes nothing.'
};
