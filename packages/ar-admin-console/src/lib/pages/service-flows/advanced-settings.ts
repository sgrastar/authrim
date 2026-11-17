import type { MessageKey } from '#lib/i18n/i18n.svelte.js';
export interface AdvancedField {
	key: string;
	label: MessageKey;
	part: string;
	type?: 'boolean' | 'list' | 'number' | 'certificate';
	options?: string[];
	min?: number;
	max?: number;
}
const field = (
	part: string,
	key: string,
	label: MessageKey,
	extra: Omit<AdvancedField, 'key' | 'label' | 'part'> = {}
): AdvancedField => ({ part, key, label, ...extra });
export const RP_FIELDS = [
	field('rp-profile', 'description', 'cs.row.description'),
	field('rp-profile', 'logo_uri', 'cs.row.logoUri'),
	field('rp-profile', 'client_uri', 'cs.row.clientUri'),
	field('rp-profile', 'policy_uri', 'cs.row.policyUri'),
	field('rp-profile', 'tos_uri', 'cs.row.tosUri'),
	field('rp-profile', 'contacts', 'cs.row.contacts', { type: 'list' }),
	field('rp-profile', 'minimum_ial', 'cs.row.minimumIal', { options: ['IAL1', 'IAL2', 'IAL3'] }),
	field('rp-grants', 'grant_types', 'cs.row.grantTypes', {
		type: 'list',
		options: [
			'authorization_code',
			'refresh_token',
			'client_credentials',
			'urn:ietf:params:oauth:grant-type:device_code',
			'urn:openid:params:grant-type:ciba',
			'urn:ietf:params:oauth:grant-type:token-exchange'
		]
	}),
	field('rp-grants', 'browser_refresh_token_policy', 'cs.row.browserRefresh', {
		options: ['disabled', 'dpop_bound']
	}),
	field('rp-tokens', 'id_token_signed_response_alg', 'cs.row.idTokenAlg', {
		options: ['RS256', 'ES256', 'PS256']
	}),
	field('rp-tokens', 'userinfo_signed_response_alg', 'cs.row.userinfoAlg', {
		options: ['none', 'RS256', 'ES256', 'PS256']
	}),
	field('rp-logout', 'post_logout_redirect_uris', 'cs.row.postLogoutUris', { type: 'list' }),
	field('rp-logout', 'frontchannel_logout_uri', 'cs.row.frontchannelUri'),
	field('rp-logout', 'frontchannel_logout_session_required', 'cs.row.sendSession', {
		type: 'boolean'
	}),
	field('rp-logout', 'backchannel_logout_uri', 'cs.row.backchannelUri'),
	field('rp-logout', 'backchannel_logout_session_required', 'cs.row.requireSid', {
		type: 'boolean'
	}),
	field('rp-security', 'token_endpoint_auth_signing_alg', 'cs.live.assertionSigningAlg', {
		options: ['RS256', 'ES256', 'PS256', 'EdDSA']
	}),
	field('rp-security', 'subject_type', 'cs.row.subjectType', { options: ['public', 'pairwise'] }),
	field('rp-security', 'sector_identifier_uri', 'cs.row.sectorUri'),
	field('rp-security', 'tls_client_certificate_bound_access_tokens', 'cs.row.mtls', {
		type: 'boolean'
	}),
	field('rp-security', 'skip_consent', 'cs.row.skipConsent', { type: 'boolean' }),
	field('rp-exchange', 'token_exchange_allowed', 'cs.row.tokenExchange', { type: 'boolean' }),
	field('rp-exchange', 'delegation_mode', 'cs.row.delegationMode', {
		options: ['none', 'delegation', 'impersonation']
	}),
	field('rp-exchange', 'allowed_subject_token_clients', 'cs.row.exchangeClients', { type: 'list' }),
	field('rp-exchange', 'client_credentials_allowed', 'cs.row.clientCredentials', {
		type: 'boolean'
	}),
	field('rp-exchange', 'allowed_scopes', 'cs.row.ccScopes', { type: 'list' }),
	field('rp-exchange', 'default_audience', 'cs.row.ccAudience')
];
export const RP_OAUTH_FIELDS = [
	field('rp-tokens', 'oauth.id_token_expiry', 'cs.row.idTokenLifetime', {
		type: 'number',
		min: 60,
		max: 86400
	}),
	field('rp-tokens', 'oauth.refresh_token_rotation', 'cs.row.refreshRotation', { type: 'boolean' }),
	field('rp-tokens', 'oauth.refresh_token_sliding_window_enabled', 'cs.row.refreshSliding', {
		type: 'boolean'
	}),
	field('rp-tokens', 'oauth.refresh_token_absolute_expiry_enabled', 'cs.row.refreshAbsolute', {
		type: 'boolean'
	}),
	field('rp-tokens', 'oauth.refresh_token_absolute_expiry', 'cs.row.refreshAbsoluteLifetime', {
		type: 'number',
		min: 3600,
		max: 31536000
	})
];
export const RP_SECURITY_FIELDS = [
	field('rp-security', 'security.dpop_bound_access_tokens', 'cs.row.dpop', { type: 'boolean' }),
	field('rp-security', 'security.require_encrypted_request_object', 'cs.row.encryptedRequest', {
		type: 'boolean'
	})
];
const signatures = ['required', 'optional', 'disabled'];
const refresh = (prefix: string) => [
	field(`${prefix}-metadata`, 'metadataRefreshPolicy.mode', 'cs.row.metadataRefresh', {
		options: ['automatic', 'manual']
	}),
	field(`${prefix}-metadata`, 'metadataRefreshPolicy.intervalSeconds', 'cs.row.metadataInterval', {
		type: 'number',
		min: 900,
		max: 604800
	})
];
export const SP_FIELDS = [
	field('sp-endpoints', 'acsUrls', 'cs.row.acsUrls', { type: 'list' }),
	field('sp-endpoints', 'sloUrl', 'cs.row.sloUrl'),
	field('sp-endpoints', 'sloBinding', 'cs.row.sloBinding', { options: ['post', 'redirect'] }),
	field('sp-endpoints', 'allowedBindings', 'cs.row.bindings', {
		type: 'list',
		options: ['post', 'redirect']
	}),
	field('sp-signing', 'samlProfile', 'cs.row.samlProfile', {
		options: ['baseline', 'strict', 'academic_publisher', 'legacy']
	}),
	field('sp-signing', 'signResponses', 'cs.row.signResponses', { type: 'boolean' }),
	field('sp-signing', 'signAssertions', 'cs.row.signAssertions', { type: 'boolean' }),
	field('sp-signing', 'authnRequestSignaturePolicy', 'cs.row.authnRequestSignature', {
		options: signatures
	}),
	field('sp-signing', 'logoutRequestSignaturePolicy', 'cs.row.logoutRequestSignature', {
		options: signatures
	}),
	field('sp-signing', 'logoutResponseSignaturePolicy', 'cs.row.logoutResponseSignature', {
		options: signatures
	}),
	field('sp-signing', 'authnRequestLegacyAlgorithmPolicy', 'cs.row.legacyAlgorithms', {
		options: ['disabled', 'explicit_opt_in']
	}),
	field('sp-signing', 'acceptedAuthnRequestSignatureAlgorithms', 'cs.live.signatureAlgorithms', {
		type: 'list'
	}),
	field('sp-signing', 'acceptedAuthnRequestDigestAlgorithms', 'cs.live.digestAlgorithms', {
		type: 'list'
	}),
	field('sp-encryption', 'encryptAssertions', 'cs.row.encryptAssertions', { type: 'boolean' }),
	field('sp-encryption', 'encryptNameID', 'cs.row.encryptNameId', { type: 'boolean' }),
	field('sp-encryption', 'encryptionCertificate', 'cs.row.encryptionCert', { type: 'certificate' }),
	field('sp-encryption', 'encryptionAlgorithmPolicy', 'cs.live.encryptionPolicy', {
		options: ['modern', 'legacy_opt_in']
	}),
	field('sp-encryption', 'assertionEncryptionAlgorithm', 'cs.row.contentAlg', {
		options: ['aes256-gcm', 'aes256-cbc']
	}),
	field('sp-encryption', 'keyEncryptionAlgorithm', 'cs.row.keyAlg', {
		options: ['rsa-oaep-256', 'rsa-oaep-sha1']
	}),
	field('sp-assertion', 'assertionValiditySeconds', 'cs.row.assertionLifetime', {
		type: 'number',
		min: 60,
		max: 86400
	}),
	field('sp-assertion', 'authnContextClassRefMode', 'cs.row.authnContextMode', {
		options: ['legacy_static', 'session', 'assurance']
	}),
	field('sp-assertion', 'nameIdFormat', 'sf.sp.nameIdLabel', {
		options: [
			'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
			'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
			'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
			'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified'
		]
	}),
	field('sp-assertion', 'minimumIal', 'cs.row.minimumIal', { options: ['IAL1', 'IAL2', 'IAL3'] }),
	field('sp-assertion', 'minimumAal', 'cs.row.minimumAal', { options: ['AAL1', 'AAL2', 'AAL3'] }),
	...refresh('sp')
];
export const OP_FIELDS = [
	field('op-endpoints', 'authorizationEndpoint', 'cs.row.authorizationEndpoint'),
	field('op-endpoints', 'tokenEndpoint', 'cs.row.tokenEndpoint'),
	field('op-endpoints', 'userinfoEndpoint', 'cs.row.userinfoEndpoint'),
	field('op-endpoints', 'jwksUri', 'cs.row.jwksUri'),
	field('op-request', 'tokenEndpointAuthMethod', 'cs.row.tokenAuth', {
		options: ['client_secret_basic', 'client_secret_post']
	}),
	field('op-request', 'alwaysFetchUserinfo', 'cs.row.alwaysUserinfo', { type: 'boolean' }),
	field('op-accounts', 'profileUpdateFields', 'cs.row.profileUpdate', { type: 'list' }),
	field('op-accounts', 'enableSso', 'cs.row.handoffSso', { type: 'boolean' }),
	field('op-button', 'buttonText', 'cs.row.buttonText'),
	field('op-button', 'buttonColor', 'cs.row.buttonColor'),
	field('op-button', 'priority', 'cs.row.priority', { type: 'number', min: -100000, max: 100000 })
];
export const IDP_FIELDS = [
	field('idp-endpoints', 'sloUrl', 'cs.row.sloUrl'),
	field('idp-endpoints', 'allowedBindings', 'cs.row.bindings', {
		type: 'list',
		options: ['post', 'redirect']
	}),
	field('idp-endpoints', 'providerName', 'cs.row.providerName'),
	field('idp-assertion', 'logoutRequestSignaturePolicy', 'cs.row.logoutRequestSignature', {
		options: signatures
	}),
	field('idp-assertion', 'logoutRequestLegacyAlgorithmPolicy', 'cs.row.legacyAlgorithms', {
		options: ['disabled', 'explicit_opt_in']
	}),
	field(
		'idp-assertion',
		'acceptedLogoutRequestSignatureAlgorithms',
		'cs.live.signatureAlgorithms',
		{ type: 'list' }
	),
	field('idp-assertion', 'acceptedLogoutRequestDigestAlgorithms', 'cs.live.digestAlgorithms', {
		type: 'list'
	}),
	field('idp-assertion', 'nameIdFormat', 'sf.sp.nameIdLabel', {
		options: [
			'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
			'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
			'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
			'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified'
		]
	}),
	field('idp-assertion', 'authnContextPolicy.mode', 'cs.row.authnContextMode', {
		options: ['observe', 'require_any']
	}),
	field('idp-assertion', 'authnContextPolicy.allowedClassRefs', 'cs.row.authnContexts', {
		type: 'list'
	}),
	field('idp-accounts', 'jitEmailLinkingPolicy', 'cs.live.jitPolicy', {
		options: ['disabled', 'jit_create_only', 'email_linking']
	}),
	field('idp-accounts', 'allowSyntheticEmailFallback', 'cs.row.syntheticEmail', {
		type: 'boolean'
	}),
	field('idp-accounts', 'profileUpdateFields', 'cs.row.profileUpdate', { type: 'list' }),
	...refresh('idp')
];
export function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};
}
export function readAdvanced(source: unknown, fields: AdvancedField[]): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const field of fields) {
		let value: unknown = source;
		for (const path of field.key.split('.')) value = record(value)[path];
		if (field.type === 'list' && typeof value === 'string') {
			try {
				value = JSON.parse(value);
			} catch {
				/* Retain an unrecognized stored value; never write it implicitly. */
			}
		}
		result[field.key] = value ?? null;
	}
	return result;
}
/** Only changed, allowlisted fields are sent. Merge nested contracts from the loaded version. */
export function advancedPatch(
	source: unknown,
	values: Record<string, unknown>,
	fields: AdvancedField[]
): Record<string, unknown> {
	const before = readAdvanced(source, fields);
	const patch: Record<string, unknown> = {};
	for (const { key } of fields) {
		if (JSON.stringify(before[key]) === JSON.stringify(values[key])) continue;
		const [parent, child] = key.split('.');
		if (!child) patch[key] = values[key];
		else
			patch[parent] = {
				...record(record(source)[parent]),
				...record(patch[parent]),
				[child]: values[key]
			};
	}
	return patch;
}
export function changedFlat(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
	fields: AdvancedField[]
): Record<string, unknown> {
	return Object.fromEntries(
		fields
			.filter(({ key }) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
			.map(({ key }) => [key, after[key]])
	);
}
