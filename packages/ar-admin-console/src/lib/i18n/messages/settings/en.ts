import type { jaSettings } from './ja';

export const enSettings: Record<keyof typeof jaSettings, string> = {
	'set.page.team': 'Administrators',
	'set.page.team.desc': 'How administrators sign in to this console.',
	'set.section.adminSignIn': 'Admin sign-in',
	'set.section.adminSignIn.desc':
		'How long this tenant’s administrators stay signed in, and the checks asked before an operation.',
	'set.section.adminSignInPlatform': 'Admin sign-in for every tenant',
	'set.section.adminSignInPlatform.desc':
		'Applies to the administrators of every tenant. Only platform administrators can change it.',
	'set.section.adminInvitationsPlatform': 'Admin invitation codes',
	'set.section.adminInvitationsPlatform.desc':
		'Whether an admin invitation’s code is handed to a machine instead of being e-mailed. Applies to every tenant. Only platform administrators can change it.',
	'set.k.admin_invitations.code_handoff_enabled': 'Hand the invitation code to a trusted machine',
	'set.k.admin_invitations.code_handoff_enabled.desc':
		'On lets a machine credential that holds the dedicated permission create an admin invitation and receive its code in the API response instead of by e-mail. The invitee’s e-mail address is then not treated as verified. Invitations made from this console are still e-mailed. Turning it on asks for an extra identity check (step-up); turning it off does not.',
	'settings.notice.codeHandoff.title': 'Codes are handed over without e-mail',
	'settings.notice.codeHandoff.body':
		'A machine with the permission receives the enrollment code directly. Turn this off when no automation needs it.',
	'settings.stepUpCancelled': 'The identity check was cancelled. Some changes are still unsaved.',
	'set.k.session.ttl.admin_passkey': 'Sign-in length for administrators using a passkey',
	'set.k.session.ttl.admin_passkey.desc':
		'How long after signing in with a passkey an administrator is asked to sign in again.',
	'set.k.security.admin_step_up_overrides': 'Raised checks by operation',
	'set.k.security.admin_step_up_overrides.desc':
		'Operation names with the check they ask for (L1: a passkey; L2: a passkey and a second factor), for example {"client.secret.rotate": "L2"}. A level cannot go below the built-in one.',
	'set.k.security.admin_step_up_enforced': 'Ask for extra checks before admin operations',
	'set.k.security.admin_step_up_enforced.desc':
		'Off skips the passkey and second-factor checks before sensitive admin operations. Turn it off only during a migration; turning it off itself needs an L2 check.',
	'set.k.security.admin_keyring_dc_api': 'Present Keyring through the browser',
	'set.k.security.admin_keyring_dc_api.desc':
		'Where the browser supports it, administrators present their Keyring credential through the Digital Credentials API instead of a QR code.',
	'set.k.security.admin_last_resort_reenroll_window_seconds':
		'Re-enrolment window after last-resort recovery',
	'set.k.security.admin_last_resort_reenroll_window_seconds.desc':
		"After the last-resort recovery revoked an administrator's second factors, how long they may register a first one again with a passkey alone.",
	'settings.json.object': 'Enter a JSON object (in braces { }).',
	'set.page.sessionProfiles': 'Session profiles',
	'set.page.sessionProfiles.desc':
		'How long a person stays signed in once they sign in, and single sign-on.',
	'set.page.logout.desc':
		'How apps are told that a person signed out. Each app’s own logout addresses are the app’s.',
	'set.page.logout': 'Logout',
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
	'set.page.tokens': 'Tokens and protocols',
	'set.page.tokens.desc':
		'How long the tokens apps get last, and what every app must meet and the protocol defaults. Each app can override them (a requirement cannot be waived).',
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
	'set.k.oauth.prompt_create_enabled': 'Open the sign-up page for prompt=create',
	'set.k.oauth.prompt_create_enabled.desc':
		'An app that asks for sign-up (prompt=create) lands on the sign-up page instead of the sign-in page. Needs a sign-up method turned on (passkey, email code or authenticator app); otherwise the request signs in as usual. Discovery then lists create among the prompt values.',
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
	'set.page.protection.desc':
		'Keeps sign-in and sign-up emails and authenticator-app codes from being abused.',
	'set.section.emailSending': 'Email sending limit',
	'set.section.emailSending.desc':
		'Limits how many times emails such as sign-in codes can be sent to the same recipient in a row, so they cannot be used to send spam.',
	'set.k.rate_limit.email_max_requests': 'Sends allowed per period',
	'set.k.rate_limit.email_max_requests.desc':
		'How many sign-in, sign-up, re-authentication and directory migration codes can be sent to the same email address (or user). Codes for account discovery have their own limit.',
	'set.k.rate_limit.email_window': 'Period the sends are counted in',
	'set.k.rate_limit.email_window.desc':
		'The period the number above is counted in (5 to 60 minutes). Once it passes, sending is allowed again.',
	'set.section.failedSignIns': 'Failed sign-ins',
	'set.section.failedSignIns.desc':
		'Lock an account for a while after its password is entered wrongly too many times in a row, so it cannot be guessed.',
	'set.k.rate_limit.auth_max_failed_attempts': 'Failed attempts before locking',
	'set.k.rate_limit.auth_max_failed_attempts.desc':
		'Wrong passwords (directory sign-in) within 15 minutes after which the account is locked for the rest of those 15 minutes (3 to 20).',
	'set.section.totpAttempts': 'Authenticator app attempts',
	'set.section.totpAttempts.desc':
		'Limits how often someone can start signing in with an authenticator app, so the codes cannot be guessed by trying many times.',
	'set.k.rate_limit.totp_max_requests': 'Attempts allowed per period',
	'set.k.rate_limit.totp_max_requests.desc':
		'How many authenticator-app sign-ins (and re-authentications) can be started for the same account name from the same network address, and how many codes a sign-up can check from it. Each start allows one code to be entered.',
	'set.k.rate_limit.totp_window': 'Period the attempts are counted in',
	'set.k.rate_limit.totp_window.desc':
		'The period the number above is counted in (1 to 60 minutes). Once it passes, attempts are allowed again.',
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
	'set.page.enterprise': 'SAML',
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
	'set.section.samlInstitution': 'Institution',
	'set.section.samlInstitution.desc':
		'The institution this tenant stands for: the domains its identifiers are issued under, and its name. Only the platform can change them; tenant administrators can read them. Until they are set, nothing in the SAML assertions or metadata changes.',
	'set.k.institution.scopes': 'Scopes',
	'set.k.institution.scopes.desc':
		'Domain names, separated by commas, the first being the default (for example example.ac.jp,med.example.ac.jp). Lowercase, no wildcards, up to 20. Once set, SAML assertions carry eduPersonScopedAffiliation and eduPersonPrincipalName only under these domains: a value under another domain is left out and recorded in the audit log, and a value with no domain gets the default. The metadata lists them (shibmd:Scope), and a service provider can be given the default as schacHomeOrganization. Do not change them while service providers rely on the old ones: they cache the metadata for up to a day. OIDC is not affected.',
	'set.k.institution.display_names': 'Names',
	'set.k.institution.display_names.desc':
		'The institution’s name in each language, as JSON text with ja and en at least (for example {"ja": "例大学", "en": "Example University"}). Once set, the SAML metadata names the institution with it, and a service provider can be given the English name as the organization name (o). OIDC is not affected.',
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

	'set.k.identity_mapping.oidc_default_set_id': 'Default Mapping Set (OIDC)',
	'set.k.identity_mapping.oidc_default_set_id.desc':
		'The ID of the Mapping Set used by apps in this scope that did not choose one of their own. Unset means no default, so no mapping is applied. A tenant can enter none to ignore the platform default as well. Only an active Mapping Set can be named. Apps that name no Mapping Set of their own use it, for the ID token, UserInfo and the consent screen; an app can opt out with its own none. If the named Mapping Set cannot be used (deleted, inactive, not valid), those apps cannot sign in until it is fixed or cleared.',

	'set.k.bulk_apply.max_tenants_per_request': 'Bulk apply: tenants per request',
	'set.k.bulk_apply.max_tenants_per_request.desc':
		'The most tenants one bulk apply request may name; the same tenant named twice counts once. Each tenant costs several subrequests and some run time, so one request can only serve so many; a larger job is sent in several requests. Held between 1 and 100. Platform setting; 25 by default.',

	'set.k.bulk_apply.max_keys_per_request': 'Bulk apply: settings per request',
	'set.k.bulk_apply.max_keys_per_request.desc':
		'The most settings (keys set or cleared, over all categories) one bulk apply request may carry. Held between 1 and 100. Platform setting; 20 by default.',

	'set.k.tenant_capabilities.webhooks': 'Tenants may use webhooks',
	'set.k.tenant_capabilities.webhooks.desc':
		'Off: tenants cannot manage webhooks through the Admin API, and no webhook is delivered for a tenant. Events that occur while it is off are discarded and not delivered later. Due account webhook events waiting in the queue are discarded as they are processed and recorded in the audit log (webhook.outbox.dropped); events still waiting at the moment it is turned back on are delivered. Platform administrators are exempt at the Admin API. A change takes effect within about a minute. On by default.',

	'set.k.tenant_capabilities.dynamic_client_registration':
		'Tenants may use dynamic client registration',
	'set.k.tenant_capabilities.dynamic_client_registration.desc':
		'Off: public registration (POST /register), the client configuration endpoints and initial access tokens are refused, and discovery stops advertising the registration endpoint. Tenants also cannot change their dynamic client registration settings. On by default.',

	'set.k.tenant_capabilities.external_plugins': 'Tenants may use external plugins',
	'set.k.tenant_capabilities.external_plugins.desc':
		'Off: nothing executes from external plugins for tenants, and no one can enable one (platform administrators included). Tenants cannot change their credentials or plugin settings; platform administrators can still manage credentials and settings, but nothing runs for tenants. Built-in plugins (e-mail notifiers, CAPTCHA, TOTP) are not affected. Stopping execution is carried out tenant by tenant by a periodic job, so it can take several minutes or more with many tenants. A tenant backup restore does not restore external plugin installations. On by default.',

	'set.k.tenant_capabilities.bulk_jobs': 'Tenants may run bulk jobs',
	'set.k.tenant_capabilities.bulk_jobs.desc':
		'Off: neither tenants nor platform administrators can create bulk jobs (user import, bulk update, report generation, bulk organization members). Queued jobs do not start: they end as blocked and must be created again once it is back on. Existing jobs and their results stay readable. On by default.',

	'set.k.identity_mapping.reference_scan_tenant_limit': 'Mapping Set usage search: tenants',
	'set.k.identity_mapping.reference_scan_tenant_limit.desc':
		'The most tenants whose apps are read when looking for the places that use a Mapping Set the platform owns. Each tenant is a database read; when there are more tenants than this, the rest are reported as not looked at, and deleting or switching off the set is refused. Held between 1 and 1000. Platform setting; 200 by default.',

	'set.k.identity_mapping.reference_scan_row_limit': 'Mapping Set usage search: rows per place',
	'set.k.identity_mapping.reference_scan_row_limit.desc':
		'The most rows read from one place (the tenant defaults, the apps of one tenant, the SAML providers of one tenant) when looking for the places that use a Mapping Set. A place with more is cut off and the count is given as a lower bound. Held between 10 and 5000. Platform setting; 500 by default.',

	'set.k.identity_mapping.reference_scan_concurrency': 'Mapping Set usage search: concurrency',
	'set.k.identity_mapping.reference_scan_concurrency.desc':
		'How many tenants are read at the same time when looking for the places that use a Mapping Set the platform owns. Held between 1 and 16. Platform setting; 8 by default.',

	'set.k.identity_mapping.reference_display_limit': 'Mapping Set usage: references shown',
	'set.k.identity_mapping.reference_display_limit.desc':
		'How many references the usage answer and the refusal of a deletion list; the count is always the whole. Held between 1 and 100. Platform setting; 20 by default.',

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
	'persona.viewer.desc': 'Sees users, apps and settings, and changes nothing.',
	// The platform's Default methods and the profile switches (platform profile pages).
	'set.k.authentication-methods.passkey.signup_enabled': 'Passkey: Sign-up',
	'set.k.authentication-methods.passkey.login_enabled': 'Passkey: Sign-in',
	'set.k.authentication-methods.passkey.reauth_enabled': 'Passkey: Re-authentication',
	'set.k.authentication-methods.passkey.account_link_enabled': 'Passkey: Account linking',
	'set.k.authentication-methods.email_otp.signup_enabled': 'Email one-time code: Sign-up',
	'set.k.authentication-methods.email_otp.login_enabled': 'Email one-time code: Sign-in',
	'set.k.authentication-methods.email_otp.reauth_enabled': 'Email one-time code: Re-authentication',
	'set.k.authentication-methods.email_otp.account_link_enabled':
		'Email one-time code: Account linking',
	'set.k.authentication-methods.totp.signup_enabled': 'Authenticator app (TOTP): Sign-up',
	'set.k.authentication-methods.totp.login_enabled': 'Authenticator app (TOTP): Sign-in',
	'set.k.authentication-methods.totp.reauth_enabled': 'Authenticator app (TOTP): Re-authentication',
	'set.k.authentication-methods.totp.account_link_enabled':
		'Authenticator app (TOTP): Account linking',
	'set.k.authentication-methods.did.login_enabled': 'DID: Sign-in',
	'set.k.authentication-methods.directory_password.enabled': 'Directory Password: Sign-in',
	'set.k.authentication-methods.guest.login_enabled': 'Allow guest sign-in',
	'set.k.authentication-methods.passkey.guest_upgrade_enabled': 'Upgrade a guest with a passkey',
	'set.k.authentication-methods.email_otp.guest_upgrade_enabled':
		'Upgrade a guest with an email one-time code',
	'set.k.authentication-methods.totp.preset': 'Authenticator app preset',
	'set.k.authentication-methods.totp.preset.compatible': 'Compatible',
	'set.k.authentication-methods.totp.preset.strong': 'Strong',
	'set.k.authentication-methods.totp.default_acr': 'ACR of an authenticator app sign-in',
	'set.k.profiles.method.tenant_change_allowed':
		"Tenants may change the platform's method profiles",
	'set.k.profiles.method.tenant_create_allowed': 'Tenants may create method profiles of their own',
	'set.k.profiles.method.default_locked': "Lock the Default methods (tenants' values do not apply)",
	'set.k.profiles.session.tenant_change_allowed':
		"Tenants may change the platform's session profiles",
	'set.k.profiles.session.tenant_create_allowed':
		'Tenants may create session profiles of their own',
	'set.k.profiles.session.default_locked':
		"Lock the Default session rules (tenants' values do not apply)"
};
