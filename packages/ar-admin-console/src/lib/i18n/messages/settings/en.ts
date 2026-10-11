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
	'set.page.appDefaults': 'App defaults',
	'set.page.appDefaults.desc':
		'Rules for authorization requests and tokens that apply to every app of the tenant. An app’s own settings can add a security requirement but not waive one.',
	'set.section.authRequests': 'Authorization requests',
	'set.section.authRequests.desc': 'What an app’s sign-in request must carry.',
	'set.section.authRequests.advanced': 'Signed and encrypted request objects',
	'set.section.redirectUris': 'Redirect URIs',
	'set.section.redirectUris.desc': 'Where sign-in may return to an app.',
	'set.section.senderConstrained': 'Sender-constrained tokens',
	'set.section.senderConstrained.desc': 'Tokens bound to the key of the app that received them.',
	'set.section.senderConstrained.advanced': 'DPoP under FAPI, and nonces',
	'set.section.fapi': 'FAPI',
	'set.section.fapi.desc': 'The financial-grade security profile (FAPI 2.0).',
	'set.section.fapi.advanced': 'Detailed FAPI requirements',
	'set.section.tokenExchange': 'Token exchange',
	'set.section.tokenExchange.desc': 'Exchanging a token an app holds for another.',
	'set.section.tokenExchange.advanced': 'Delegation and impersonation',
	'set.k.security.pkce_required': 'Require PKCE',
	'set.k.security.pkce_required.desc':
		'Every authorization code request must carry PKCE (S256). An app can require it as well, but cannot waive the tenant’s requirement.',
	'set.k.security.par_required': 'Require PAR',
	'set.k.security.par_required.desc':
		'Authorization requests must first be pushed server to server (Pushed Authorization Request).',
	'set.k.oauth.state_required': 'Require the state parameter',
	'set.k.oauth.state_required.desc':
		'Refuse authorization requests without a state (CSRF protection).',
	'set.k.security.require_signed_request_object': 'Require signed request objects',
	'set.k.security.require_signed_request_object.desc':
		'Authorization requests must come in a request object the app signed.',
	'set.k.security.require_encrypted_request_object': 'Require encrypted request objects',
	'set.k.security.require_encrypted_request_object.desc':
		'Authorization requests must come in a request object encrypted to the tenant’s encryption key (use enc in its JWKS). Apps must support it.',
	'set.k.security.allow_unsigned_request_object': 'Allow unsigned request objects (development)',
	'set.k.security.allow_unsigned_request_object.desc':
		'Never allowed in production, whatever this says.',
	'set.k.security.https_redirect_only': 'Allow HTTPS redirect URIs only',
	'set.k.security.https_redirect_only.desc':
		'A native app’s loopback (localhost and the like) may use http. Off: a web app may use http on a loopback host as well (development).',
	'set.k.security.dpop_bound_access_tokens': 'Bind access tokens to DPoP',
	'set.k.security.dpop_bound_access_tokens.desc':
		'A DPoP proof is required to obtain tokens, so a leaked token cannot be used by anyone else. Apps must support it.',
	'set.k.security.dpop_required': 'DPoP under FAPI',
	'set.k.security.dpop_required.desc': 'Whether DPoP is required while FAPI applies.',
	'set.k.security.dpop_required.with_fapi': 'Required with FAPI',
	'set.k.security.dpop_required.always': 'Always required',
	'set.k.security.dpop_required.never': 'Never required',
	'set.k.security.dpop_nonce_enabled': 'Use DPoP server nonces',
	'set.k.security.dpop_nonce_enabled.desc':
		'DPoP proofs must include a nonce the server issued, which stops their reuse.',
	'set.k.security.fapi_strict_dpop': 'Validate DPoP strictly',
	'set.k.security.fapi_strict_dpop.desc':
		'Refuse an authorization request whose DPoP proof is not valid.',
	'set.k.security.fapi_allow_public_clients': 'Allow public clients',
	'set.k.security.fapi_allow_public_clients.desc':
		'Allow apps without a secret (browser and mobile apps) while FAPI applies.',
	'set.k.security.fapi_require_private_key_jwt': 'Require private_key_jwt',
	'set.k.security.fapi_require_private_key_jwt.desc':
		'Apps authenticate with private_key_jwt only.',
	'set.k.security.require_jarm': 'Require signed authorization responses (JARM)',
	'set.k.tokens.exchange_enabled': 'Enable token exchange',
	'set.k.tokens.exchange_enabled.desc':
		'Apps can exchange a token they hold for another (RFC 8693).',
	'set.k.tokens.exchange_delegation_enabled': 'Allow delegation',
	'set.k.tokens.exchange_delegation_enabled.desc':
		'An app can obtain a token for another service on a person’s behalf. While this is off, apps in delegation mode (the default) are refused token exchange. Each app’s own delegation mode can narrow it further.',
	'set.k.tokens.exchange_impersonation_enabled': 'Allow impersonation',
	'set.k.tokens.exchange_impersonation_enabled.desc':
		'An app can obtain a token that acts as the person themselves. While this is off, apps in impersonation mode are refused token exchange. It has a large security impact: turn it on only where needed.',
	'set.page.protection': 'Attack protection',
	'set.page.protection.desc': 'Keeps sign-in and sign-up emails from being abused.',
	'set.section.emailSending': 'Email sending limit',
	'set.section.emailSending.desc':
		'Limits how many times emails such as sign-in codes can be sent to the same recipient in a row, so they cannot be used to send spam.',
	'set.k.rate_limit.email_max_requests': 'Sends allowed per period',
	'set.k.rate_limit.email_max_requests.desc':
		'How many sign-in, sign-up, re-authentication and directory migration codes can be sent to the same email address (or user). Codes for account discovery have their own limit.',
	'set.k.rate_limit.email_window': 'Period the sends are counted in',
	'set.k.rate_limit.email_window.desc':
		'The period the number above is counted in (5 to 60 minutes). Once it passes, sending is allowed again.',
	'set.section.introspection': 'Token introspection',
	'set.section.introspection.desc':
		'The answer a Resource Server gets when it asks whether a token is valid.',
	'set.k.tokens.introspection_extended_claims': 'Return each Resource Server’s extra claims',
	'set.k.tokens.introspection_extended_claims.desc':
		'Off: the answer holds only the basic claims (active, scope, client_id, sub, exp and the like), and a Resource Server’s profile and identity mapping are not used. On: the claims its profile allows are added.',
	'set.section.scim': 'SCIM provisioning',
	'set.section.scim.desc': 'The tokens external systems use to sync users over SCIM.',
	'set.section.scim.advanced': 'The longest lifetime allowed',
	'set.k.federation.scim_token_default_expiry': 'Default SCIM token lifetime',
	'set.k.federation.scim_token_default_expiry.desc':
		'How long a SCIM token lasts when it is created without a lifetime. Never longer than the maximum. Tokens already issued are not changed.',
	'set.k.federation.scim_token_max_expiry': 'Longest SCIM token lifetime',
	'set.k.federation.scim_token_max_expiry.desc':
		'A SCIM token cannot be created with a longer lifetime (one year at most). Tokens already issued are not changed.',
	'set.k.assurance.scim_max_ial': 'Highest identity assurance level (IAL) SCIM may assert',
	'set.k.assurance.scim_max_ial.desc':
		'How high an identity assurance level an external system can state for a user over SCIM: 1 is IAL1 (no proofing), 2 is IAL2, 3 is IAL3. A request asserting a higher level is refused and changes nothing. It starts at 1, so SCIM cannot assert IAL2 or IAL3 until you raise it. Levels already recorded are not removed when you lower it. It does not limit what administrators record, the level given to accounts created by the organisation, or CSV imports.',
	'set.page.enterprise': 'Enterprise SSO (SAML)',
	'set.page.enterprise.desc':
		'Decides whether this tenant answers SAML at all, how long SAML assertions and requests stay valid, and what new SAML providers start with. Registering providers (IdPs and SPs) is still done on the SAML page of the previous admin screens.',
	'set.section.samlService': 'SAML service',
	'set.section.samlService.desc':
		'When off, this tenant refuses every SAML request and does not publish its SAML metadata. Registered providers are kept.',
	'set.k.federation.saml_enabled': 'Use SAML',
	'set.k.federation.saml_enabled.desc':
		'While off, the SAML IdP and SP endpoints and the metadata answer 403 (the health check and the admin API keep working). Turn it back on and the registered providers work as before. A change can take about a minute to apply.',
	'set.section.samlLifetimes': 'Lifetimes',
	'set.section.samlLifetimes.desc': 'How long SAML assertions and requests stay valid.',
	'set.section.samlLifetimes.advanced': 'Request lifetime',
	'set.k.federation.saml_assertion_ttl': 'Assertion lifetime',
	'set.k.federation.saml_assertion_ttl.desc':
		'How long a SAML assertion issued by Authrim is valid (60 to 600 seconds). A service provider with a lifetime of its own keeps it. A change applies to assertions issued after it.',
	'set.k.federation.saml_request_ttl': 'Request lifetime',
	'set.k.federation.saml_request_ttl.desc':
		'How long a SAML sign-in or logout request stays valid (60 to 600 seconds): the oldest request Authrim accepts, and how long the requests it sends are kept to be matched with their responses. A change applies to the lifetime of requests made after it. The age of a request is also checked against the current value when a sign-in in progress resumes, so shortening it can reject sign-ins that have already started.',
	'set.section.samlProviderDefaults': 'Defaults for new providers',
	'set.section.samlProviderDefaults.desc':
		'What a SAML provider gets when it is added or its metadata is imported and nothing else says. Existing providers are not changed.',
	'set.section.samlProviderDefaults.advanced': 'Bindings',
	'set.k.federation.saml_nameid_format': 'NameID format',
	'set.k.federation.saml_nameid_format.desc':
		'The NameID format a provider gets when its metadata names none. A provider profile that sets its own format (such as strict) keeps it. Persistent gives each service its own identifier, which protects people’s privacy.',
	'set.k.federation.saml_nameid_format.emailAddress': 'Email address',
	'set.k.federation.saml_nameid_format.persistent': 'Persistent identifier',
	'set.k.federation.saml_nameid_format.transient': 'Transient identifier',
	'set.k.federation.saml_nameid_format.unspecified': 'Unspecified',
	'set.k.federation.saml_sso_binding': 'Sign-in binding',
	'set.k.federation.saml_sso_binding.desc':
		'The binding a new external identity provider is signed in through when its metadata offers both, or names none. HTTP-Redirect sends a signed request; HTTP-POST sends it unsigned.',
	'set.k.federation.saml_sso_binding.HTTP-POST': 'HTTP-POST',
	'set.k.federation.saml_sso_binding.HTTP-Redirect': 'HTTP-Redirect',
	'set.k.federation.saml_slo_binding': 'Logout binding',
	'set.k.federation.saml_slo_binding.desc':
		'The default binding of logout requests, used when the metadata offers both or names none. A provider profile that sets its own (the legacy profile) keeps it.',
	'set.k.federation.saml_slo_binding.HTTP-POST': 'HTTP-POST',
	'set.k.federation.saml_slo_binding.HTTP-Redirect': 'HTTP-Redirect',
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
	'settings.notice.exchangeCeilings.title': 'Some apps will be refused token exchange',
	'settings.notice.exchangeCeilings.body':
		'Token exchange is on, but delegation is not allowed, so apps in delegation mode (the default for new apps) are refused. Turn on “Allow delegation” to let them use it.',
	'settings.notice.samlDisabled.title': 'Apps and external IdPs that use SAML will stop working',
	'settings.notice.samlDisabled.body':
		'With SAML off, apps that sign in over SAML (service providers) and sign-in through external SAML identity providers fail. Registered providers are kept, so turning it back on restores them.',
	'settings.notice.samlPostBinding.title': 'HTTP-POST sends the sign-in request unsigned',
	'settings.notice.samlPostBinding.body':
		'A sign-in request sent to a new identity provider over HTTP-POST carries no signature. HTTP-Redirect, which can be signed, is the default. Choose POST only if the identity provider accepts nothing else.',
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
