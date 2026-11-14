import type { MessageKey } from '#lib/i18n/i18n.svelte.js';
import {
	httpsUrlProblem,
	redirectUriProblem,
	type Answers,
	type AppType,
	type ConnectionKind,
	type PartState
} from './connection-model';

/**
 * The settings of a connection beyond what its flow needs to start: token lifetimes, logout,
 * signing and encryption, endpoints, certificates. They follow what the backend can store for
 * each kind (an OAuth client, a SAML service provider, an upstream OpenID or SAML provider), so
 * the screen can be wired later without moving anything. Every one starts with the backend's own
 * default, so none is required until a choice needs something more (a pairwise subject needs its
 * sector address, encryption needs the service's certificate).
 *
 * Dummy: nothing is read or saved; certificates and dates are made up.
 */

/** Signature checking of what the other side sends. */
export type SignaturePolicy = 'required' | 'optional' | 'disabled';

export interface RpSettings {
	description: string;
	logoUri: string;
	clientUri: string;
	policyUri: string;
	tosUri: string;
	contacts: string[];
	minimumIal: string;
	grantTypes: string[];
	/** How a single-page app may refresh: no refresh tokens, or ones bound with DPoP. */
	browserRefresh: 'disabled' | 'dpop_bound';
	idTokenLifetime: number | null;
	idTokenAlg: string;
	userinfoAlg: string;
	refreshRotation: boolean;
	refreshSliding: boolean;
	refreshAbsolute: boolean;
	refreshAbsoluteLifetime: number | null;
	postLogoutUris: string[];
	frontchannelUri: string;
	frontchannelSession: boolean;
	backchannelUri: string;
	backchannelSession: boolean;
	subjectType: 'public' | 'pairwise';
	sectorUri: string;
	webOrigins: string[];
	jwksUri: string;
	dpopBound: boolean;
	mtlsBound: boolean;
	encryptedRequest: boolean;
	skipConsent: boolean;
	tokenExchange: boolean;
	delegationMode: 'none' | 'delegation' | 'impersonation';
	exchangeClients: string[];
	clientCredentials: boolean;
	ccScopes: string[];
	ccAudience: string;
}

export type SamlProfile = 'baseline' | 'strict' | 'academic_publisher' | 'legacy';

export interface SpSettings {
	acsUrls: string[];
	sloUrl: string;
	sloBinding: 'post' | 'redirect';
	bindings: string[];
	profile: SamlProfile;
	signResponses: boolean;
	signAssertions: boolean;
	authnRequestSignature: SignaturePolicy;
	logoutRequestSignature: SignaturePolicy;
	logoutResponseSignature: SignaturePolicy;
	legacyAlgorithms: boolean;
	encryptAssertions: boolean;
	encryptNameId: boolean;
	encryptionCert: string;
	contentAlg: 'aes256-gcm' | 'aes256-cbc';
	keyAlg: 'rsa-oaep-256' | 'rsa-oaep-sha1';
	assertionLifetime: number | null;
	authnContextMode: 'legacy_static' | 'session' | 'assurance';
	minimumIal: string;
	minimumAal: string;
	metadataRefresh: 'automatic' | 'manual';
	metadataInterval: number | null;
	/**
	 * The values set above this connection: by the platform for every tenant, or by the tenant
	 * for all its services. A setting with one uses it until this connection overrides it; a
	 * setting without one has no default to fall back to, so it is simply set here.
	 */
	inherited: Partial<Record<SpInheritKey, InheritedValue>>;
	/** The settings this connection sets for itself although a default exists. */
	overridden: SpInheritKey[];
}

/** Where a default comes from: the platform (every tenant) or the service defaults of a tenant. */
export type InheritSource = 'platform' | 'service';

export interface InheritedValue {
	source: InheritSource;
	value: string | number | boolean | null;
}

/** The SAML service settings that a default above the connection may hold. */
export type SpInheritKey =
	| 'assertionLifetime'
	| 'authnContextMode'
	| 'minimumIal'
	| 'minimumAal'
	| 'contentAlg'
	| 'keyAlg'
	| 'legacyAlgorithms';

/** Sample defaults, as a platform and a tenant may have set them (dummy). */
export function sampleSpDefaults(): Partial<Record<SpInheritKey, InheritedValue>> {
	return {
		assertionLifetime: { source: 'platform', value: 300 },
		contentAlg: { source: 'platform', value: 'aes256-gcm' },
		keyAlg: { source: 'platform', value: 'rsa-oaep-256' },
		legacyAlgorithms: { source: 'platform', value: false },
		authnContextMode: { source: 'service', value: 'session' },
		minimumAal: { source: 'service', value: 'AAL2' }
	};
}

/** Whether the connection uses the default above it for a setting (there is one, not overridden). */
export function usesDefault(settings: SpSettings, key: SpInheritKey): boolean {
	return settings.inherited[key] !== undefined && !settings.overridden.includes(key);
}

/** Switches a setting between its default and this connection's own value. */
export function setOverride(settings: SpSettings, key: SpInheritKey, own: boolean): void {
	const inherited = settings.inherited[key];
	if (!inherited) return;
	if (own) {
		if (!settings.overridden.includes(key)) settings.overridden = [...settings.overridden, key];
		return;
	}
	settings.overridden = settings.overridden.filter((other) => other !== key);
	// Back on the default: the connection holds the default's value again.
	(settings as unknown as Record<string, unknown>)[key] = inherited.value;
}

export type OpTemplate =
	| 'custom'
	| 'google'
	| 'microsoft'
	| 'github'
	| 'apple'
	| 'linkedin'
	| 'facebook'
	| 'twitter';

export interface OpSettings {
	template: OpTemplate;
	protocol: 'oidc' | 'oauth2';
	authorizationEndpoint: string;
	tokenEndpoint: string;
	userinfoEndpoint: string;
	jwksUri: string;
	tokenAuth: 'client_secret_basic' | 'client_secret_post';
	requestObject: boolean;
	requestObjectAlg: string;
	fapi2: boolean;
	scopes: string;
	responseType: 'code' | 'code id_token';
	idTokenAlg: string;
	alwaysUserinfo: boolean;
	jit: boolean;
	trustEmail: boolean;
	profileUpdate: 'tenant' | 'none' | 'all';
	handoffSso: boolean;
	buttonText: string;
	buttonColor: string;
	priority: number | null;
}

/** A certificate of a SAML partner, as the screen shows it (dummy). */
export interface Certificate {
	fingerprint: string;
	subject: string;
	notAfter: string;
	/** Days until it expires; below zero it has expired. */
	daysLeft: number;
	use: 'active' | 'next';
}

export interface IdpSettings {
	ssoUrl: string;
	sloUrl: string;
	bindings: string[];
	providerName: string;
	certificates: Certificate[];
	logoutRequestSignature: SignaturePolicy;
	legacyAlgorithms: boolean;
	nameIdFormat: string;
	authnContextMode: 'observe' | 'require_any';
	authnContexts: string[];
	syntheticEmail: boolean;
	profileUpdate: 'tenant' | 'none' | 'all';
	metadataRefresh: 'automatic' | 'manual';
	metadataInterval: number | null;
}

export interface ConnectionSettings {
	rp: RpSettings;
	sp: SpSettings;
	op: OpSettings;
	idp: IdpSettings;
}

/** What each SAML profile sets, as the backend's profile defaults do. */
export const PROFILE_DEFAULTS: Record<
	SamlProfile,
	Pick<
		SpSettings,
		| 'signResponses'
		| 'signAssertions'
		| 'authnRequestSignature'
		| 'logoutRequestSignature'
		| 'logoutResponseSignature'
	>
> = {
	baseline: {
		signResponses: true,
		signAssertions: false,
		authnRequestSignature: 'optional',
		logoutRequestSignature: 'required',
		logoutResponseSignature: 'optional'
	},
	strict: {
		signResponses: true,
		signAssertions: true,
		authnRequestSignature: 'required',
		logoutRequestSignature: 'required',
		logoutResponseSignature: 'required'
	},
	academic_publisher: {
		signResponses: true,
		signAssertions: true,
		authnRequestSignature: 'required',
		logoutRequestSignature: 'required',
		logoutResponseSignature: 'required'
	},
	legacy: {
		signResponses: true,
		signAssertions: false,
		authnRequestSignature: 'optional',
		logoutRequestSignature: 'optional',
		logoutResponseSignature: 'optional'
	}
};

/** The NameID each profile prefers; it is kept on the SP's own form (`SpForm.nameIdFormat`). */
export const PROFILE_NAME_ID: Record<SamlProfile, string> = {
	baseline: 'email',
	strict: 'persistent',
	academic_publisher: 'persistent',
	legacy: 'email'
};

/** Choosing a profile sets what it decides; each value can still be changed afterwards. */
export function applyProfile(settings: SpSettings, profile: SamlProfile): void {
	Object.assign(settings, { profile, ...PROFILE_DEFAULTS[profile] });
}

/** What a template fills in for a provider (dummy endpoints, the provider's usual scopes). */
export const TEMPLATES: Record<
	Exclude<OpTemplate, 'custom'>,
	{
		name: string;
		issuer: string;
		scopes: string;
		protocol: 'oidc' | 'oauth2';
		/** An OAuth 2.0 provider has no discovery: its addresses come with the template. */
		endpoints?: { authorization: string; token: string; userinfo: string };
	}
> = {
	google: {
		name: 'Google',
		issuer: 'https://accounts.google.com',
		scopes: 'openid email profile',
		protocol: 'oidc'
	},
	microsoft: {
		name: 'Microsoft',
		issuer: 'https://login.microsoftonline.com/common/v2.0',
		scopes: 'openid email profile',
		protocol: 'oidc'
	},
	github: {
		name: 'GitHub',
		issuer: '',
		scopes: 'read:user user:email',
		protocol: 'oauth2',
		endpoints: {
			authorization: 'https://github.com/login/oauth/authorize',
			token: 'https://github.com/login/oauth/access_token',
			userinfo: 'https://api.github.com/user'
		}
	},
	apple: {
		name: 'Apple',
		issuer: 'https://appleid.apple.com',
		scopes: 'openid email name',
		protocol: 'oidc'
	},
	linkedin: {
		name: 'LinkedIn',
		issuer: 'https://www.linkedin.com/oauth',
		scopes: 'openid email profile',
		protocol: 'oidc'
	},
	facebook: {
		name: 'Facebook',
		issuer: '',
		scopes: 'email public_profile',
		protocol: 'oauth2',
		endpoints: {
			authorization: 'https://www.facebook.com/dialog/oauth',
			token: 'https://graph.facebook.com/oauth/access_token',
			userinfo: 'https://graph.facebook.com/me'
		}
	},
	twitter: {
		name: 'X',
		issuer: '',
		scopes: 'users.read tweet.read',
		protocol: 'oauth2',
		endpoints: {
			authorization: 'https://x.com/i/oauth2/authorize',
			token: 'https://api.x.com/2/oauth2/token',
			userinfo: 'https://api.x.com/2/users/me'
		}
	}
};

export function emptySettings(): ConnectionSettings {
	return {
		rp: {
			description: '',
			logoUri: '',
			clientUri: '',
			policyUri: '',
			tosUri: '',
			contacts: [],
			minimumIal: '',
			grantTypes: ['authorization_code', 'refresh_token'],
			browserRefresh: 'disabled',
			idTokenLifetime: 3600,
			idTokenAlg: 'RS256',
			userinfoAlg: 'none',
			refreshRotation: true,
			refreshSliding: true,
			refreshAbsolute: true,
			refreshAbsoluteLifetime: 31536000,
			postLogoutUris: [],
			frontchannelUri: '',
			frontchannelSession: false,
			backchannelUri: '',
			backchannelSession: false,
			subjectType: 'public',
			sectorUri: '',
			webOrigins: [],
			jwksUri: '',
			dpopBound: false,
			mtlsBound: false,
			encryptedRequest: false,
			skipConsent: false,
			tokenExchange: false,
			delegationMode: 'delegation',
			exchangeClients: [],
			clientCredentials: false,
			ccScopes: [],
			ccAudience: ''
		},
		sp: {
			acsUrls: [],
			sloUrl: '',
			sloBinding: 'post',
			bindings: ['post', 'redirect'],
			profile: 'baseline',
			...PROFILE_DEFAULTS.baseline,
			legacyAlgorithms: false,
			encryptAssertions: false,
			encryptNameId: false,
			encryptionCert: '',
			contentAlg: 'aes256-gcm',
			keyAlg: 'rsa-oaep-256',
			assertionLifetime: 300,
			authnContextMode: 'session',
			minimumIal: '',
			minimumAal: 'AAL2',
			metadataRefresh: 'automatic',
			metadataInterval: 21600,
			inherited: sampleSpDefaults(),
			overridden: []
		},
		op: {
			template: 'custom',
			protocol: 'oidc',
			authorizationEndpoint: '',
			tokenEndpoint: '',
			userinfoEndpoint: '',
			jwksUri: '',
			tokenAuth: 'client_secret_post',
			requestObject: false,
			requestObjectAlg: 'RS256',
			fapi2: false,
			scopes: 'openid email profile',
			responseType: 'code',
			idTokenAlg: 'RS256',
			alwaysUserinfo: false,
			jit: true,
			trustEmail: false,
			profileUpdate: 'tenant',
			handoffSso: true,
			buttonText: '',
			buttonColor: '#1f2937',
			priority: 0
		},
		idp: {
			ssoUrl: '',
			sloUrl: '',
			bindings: ['post', 'redirect'],
			providerName: '',
			certificates: [],
			logoutRequestSignature: 'required',
			legacyAlgorithms: false,
			nameIdFormat: 'persistent',
			authnContextMode: 'observe',
			authnContexts: [],
			syntheticEmail: false,
			profileUpdate: 'tenant',
			metadataRefresh: 'automatic',
			metadataInterval: 21600
		}
	};
}

/** A sample certificate pair, active and next (dummy), as reading a provider's metadata gives. */
export function sampleCertificates(): Certificate[] {
	return [
		{
			fingerprint: 'SHA-256 7C:1A:9E:44:B2:0D:F3:58 …',
			subject: 'CN=idp.corp.example',
			notAfter: '2026-12-12',
			daysLeft: 29,
			use: 'active'
		},
		{
			fingerprint: 'SHA-256 A4:61:0F:9B:3E:C2:57:D0 …',
			subject: 'CN=idp.corp.example',
			notAfter: '2028-01-31',
			daysLeft: 444,
			use: 'next'
		}
	];
}

/**
 * What reading a SAML provider's metadata leaves in its settings: its certificates (dummy). Given
 * by hand, there are none until one is added.
 */
export function settingsFromImport(settings: ConnectionSettings, importMode: string): void {
	if (importMode !== 'manual' && settings.idp.certificates.length === 0)
		settings.idp.certificates = sampleCertificates();
}

/**
 * The settings of each kind, in the order they are listed under "Connection settings". They are
 * not steps of the flow (the flow is what Authrim does with the people who pass through); they
 * are how the connection itself behaves.
 */
export const SETTINGS_PARTS: Record<ConnectionKind, readonly string[]> = {
	rp: ['rp-profile', 'rp-grants', 'rp-tokens', 'rp-logout', 'rp-security', 'rp-exchange'],
	sp: ['sp-endpoints', 'sp-signing', 'sp-encryption', 'sp-assertion', 'sp-metadata'],
	op: ['op-endpoints', 'op-request', 'op-accounts', 'op-button'],
	idp: ['idp-endpoints', 'idp-certs', 'idp-assertion', 'idp-accounts', 'idp-metadata']
};

export const SETTINGS_LABELS: Record<string, MessageKey> = {
	'rp-profile': 'cs.part.rp-profile',
	'rp-grants': 'cs.part.rp-grants',
	'rp-tokens': 'cs.part.rp-tokens',
	'rp-logout': 'cs.part.logout',
	'rp-security': 'cs.part.rp-security',
	'rp-exchange': 'cs.part.rp-exchange',
	'sp-endpoints': 'cs.part.endpoints',
	'sp-signing': 'cs.part.sp-signing',
	'sp-encryption': 'cs.part.sp-encryption',
	'sp-assertion': 'cs.part.assertion',
	'sp-metadata': 'cs.part.metadata',
	'op-endpoints': 'cs.part.op-endpoints',
	'op-request': 'cs.part.op-request',
	'op-accounts': 'cs.part.accounts',
	'op-button': 'cs.part.op-button',
	'idp-endpoints': 'cs.part.endpoints',
	'idp-certs': 'cs.part.idp-certs',
	'idp-assertion': 'cs.part.assertion',
	'idp-accounts': 'cs.part.accounts',
	'idp-metadata': 'cs.part.metadata'
};

/** One line under each setting's name, saying what is in it. */
export const SETTINGS_DESCRIPTIONS: Record<string, MessageKey> = {
	'rp-profile': 'cs.desc.rp-profile',
	'rp-grants': 'cs.desc.rp-grants',
	'rp-tokens': 'cs.desc.rp-tokens',
	'rp-logout': 'cs.desc.rp-logout',
	'rp-security': 'cs.desc.rp-security',
	'rp-exchange': 'cs.desc.rp-exchange',
	'sp-endpoints': 'cs.desc.sp-endpoints',
	'sp-signing': 'cs.desc.sp-signing',
	'sp-encryption': 'cs.desc.sp-encryption',
	'sp-assertion': 'cs.desc.sp-assertion',
	'sp-metadata': 'cs.desc.metadata',
	'op-endpoints': 'cs.desc.op-endpoints',
	'op-request': 'cs.desc.op-request',
	'op-accounts': 'cs.desc.accounts',
	'op-button': 'cs.desc.op-button',
	'idp-endpoints': 'cs.desc.idp-endpoints',
	'idp-certs': 'cs.desc.idp-certs',
	'idp-assertion': 'cs.desc.idp-assertion',
	'idp-accounts': 'cs.desc.accounts',
	'idp-metadata': 'cs.desc.metadata'
};

const HTTPS = /^https:\/\/[^/\s]+/;

/** Every address given is https; left empty, an optional address is fine. */
function addressesOk(...values: string[]): boolean {
	return values.every((value) => value === '' || HTTPS.test(value));
}

/** Every entry of a list is a valid address (checked the way its field checks it). */
function listOk(values: string[], problem: (value: string) => string | undefined): boolean {
	return values.every((value) => value.trim() !== '' && !problem(value));
}

/** Grant types an app of this type may use: one that cannot keep a secret has no client credentials. */
export function grantAllowed(grant: string, appType: AppType): boolean {
	return grant !== 'client_credentials' || appType === 'web';
}

/**
 * How far a setting has got. They all start with a working default; only a choice that needs
 * more makes one required. Settings that are not here are always done.
 */
export function settingsState(part: string, s: ConnectionSettings, appType: AppType): PartState {
	switch (part) {
		case 'rp-grants':
			return s.rp.grantTypes.length > 0 && s.rp.grantTypes.every((g) => grantAllowed(g, appType))
				? 'done'
				: 'required';
		case 'rp-profile':
			return addressesOk(s.rp.logoUri, s.rp.clientUri, s.rp.policyUri, s.rp.tosUri)
				? 'done'
				: 'required';
		case 'rp-logout':
			return addressesOk(s.rp.frontchannelUri, s.rp.backchannelUri) &&
				listOk(s.rp.postLogoutUris, redirectUriProblem)
				? 'done'
				: 'required';
		case 'rp-exchange':
			return s.rp.clientCredentials && !grantAllowed('client_credentials', appType)
				? 'required'
				: 'done';
		case 'rp-security':
			return (s.rp.subjectType === 'pairwise' && !HTTPS.test(s.rp.sectorUri)) ||
				!addressesOk(s.rp.jwksUri) ||
				!listOk(s.rp.webOrigins, httpsUrlProblem)
				? 'required'
				: 'done';
		case 'sp-encryption':
			return (s.sp.encryptAssertions || s.sp.encryptNameId) && s.sp.encryptionCert.trim() === ''
				? 'required'
				: 'done';
		case 'idp-certs':
			return s.idp.certificates.some((c) => c.use === 'active' && c.daysLeft >= 0)
				? 'done'
				: 'required';
		case 'op-endpoints': {
			const { authorizationEndpoint, tokenEndpoint, userinfoEndpoint, jwksUri } = s.op;
			if (!addressesOk(authorizationEndpoint, tokenEndpoint, userinfoEndpoint, jwksUri))
				return 'required';
			return s.op.protocol === 'oauth2' && (!authorizationEndpoint || !tokenEndpoint)
				? 'required'
				: 'done';
		}
		case 'sp-endpoints':
			return s.sp.bindings.length > 0 &&
				addressesOk(s.sp.sloUrl) &&
				listOk(s.sp.acsUrls, httpsUrlProblem)
				? 'done'
				: 'required';
		case 'idp-endpoints':
			return s.idp.bindings.length > 0 && addressesOk(s.idp.ssoUrl, s.idp.sloUrl)
				? 'done'
				: 'required';
		case 'idp-assertion':
			return s.idp.authnContextMode === 'require_any' &&
				!s.idp.authnContexts.some((ref) => ref.trim() !== '')
				? 'required'
				: 'done';
		default:
			return 'done';
	}
}

/**
 * What a passed test was run against, per kind: changing any of it needs a new test. Display
 * only settings (the button, the profile links) keep the result.
 */
export function testBasis(a: Answers): string {
	const { sp, op, idp } = a.settings;
	return JSON.stringify({
		sp: [
			sp.acsUrls,
			sp.sloUrl,
			sp.sloBinding,
			sp.bindings,
			sp.signResponses,
			sp.signAssertions,
			sp.authnRequestSignature,
			sp.encryptAssertions,
			sp.encryptNameId,
			sp.encryptionCert,
			sp.contentAlg,
			sp.keyAlg,
			sp.legacyAlgorithms,
			sp.assertionLifetime,
			sp.authnContextMode,
			sp.minimumIal,
			sp.minimumAal,
			// The NameID a service gets (a profile proposes one) changes what it receives too.
			a.sp.nameIdFormat,
			// The sign-in response, shown beside the test.
			a.sp.attributePreset,
			a.sp.minAuth,
			a.sp.consent,
			// Who the service is: where its metadata came from and what it said.
			a.sp.importMode,
			a.sp.metadataUrl,
			a.sp.fileName,
			a.sp.entityId,
			a.sp.acsUrl
		],
		op: [
			op.protocol,
			op.authorizationEndpoint,
			op.tokenEndpoint,
			op.userinfoEndpoint,
			op.jwksUri,
			op.tokenAuth,
			op.requestObject,
			op.requestObjectAlg,
			op.fapi2,
			op.scopes,
			op.responseType,
			op.idTokenAlg,
			op.alwaysUserinfo,
			// Which provider, and how Authrim proves itself to it (beside the test now).
			a.op.issuer,
			a.op.clientId,
			a.op.clientSecret
		],
		idp: [
			idp.ssoUrl,
			idp.bindings,
			idp.certificates,
			idp.legacyAlgorithms,
			idp.nameIdFormat,
			idp.authnContextMode,
			idp.authnContexts,
			a.idp.importMode,
			a.idp.metadataUrl,
			a.idp.fileName,
			a.idp.entityId,
			a.idp.acsUrl
		]
	});
}

/**
 * The values each connection setting shows, by kind: what a closed section compares with what is
 * saved, so its heading says when something inside has changed.
 */
export const SETTINGS_FIELDS: Record<string, readonly string[]> = {
	'rp-profile': [
		'clientUri',
		'contacts',
		'description',
		'logoUri',
		'minimumIal',
		'policyUri',
		'tosUri'
	],
	'rp-grants': ['browserRefresh', 'grantTypes'],
	'rp-tokens': [
		'idTokenAlg',
		'idTokenLifetime',
		'refreshAbsolute',
		'refreshAbsoluteLifetime',
		'refreshRotation',
		'refreshSliding',
		'userinfoAlg'
	],
	'rp-logout': [
		'backchannelSession',
		'backchannelUri',
		'frontchannelSession',
		'frontchannelUri',
		'postLogoutUris'
	],
	'rp-security': [
		'dpopBound',
		'encryptedRequest',
		'jwksUri',
		'mtlsBound',
		'sectorUri',
		'skipConsent',
		'subjectType',
		'webOrigins'
	],
	'rp-exchange': [
		'ccAudience',
		'ccScopes',
		'clientCredentials',
		'delegationMode',
		'exchangeClients',
		'tokenExchange'
	],
	'sp-endpoints': ['acsUrls', 'bindings', 'sloBinding', 'sloUrl'],
	'sp-signing': [
		'authnRequestSignature',
		'legacyAlgorithms',
		'logoutRequestSignature',
		'logoutResponseSignature',
		'profile',
		'signAssertions',
		'signResponses'
	],
	'sp-encryption': ['contentAlg', 'encryptAssertions', 'encryptNameId', 'encryptionCert', 'keyAlg'],
	'sp-assertion': ['assertionLifetime', 'authnContextMode', 'minimumAal', 'minimumIal'],
	'sp-metadata': ['metadataInterval', 'metadataRefresh'],
	'op-endpoints': [
		'authorizationEndpoint',
		'jwksUri',
		'protocol',
		'template',
		'tokenEndpoint',
		'userinfoEndpoint'
	],
	'op-request': [
		'alwaysUserinfo',
		'fapi2',
		'idTokenAlg',
		'requestObject',
		'requestObjectAlg',
		'responseType',
		'scopes',
		'tokenAuth'
	],
	'op-accounts': ['handoffSso', 'jit', 'profileUpdate'],
	'op-button': ['buttonColor', 'buttonText', 'priority'],
	'idp-endpoints': ['bindings', 'providerName', 'sloUrl', 'ssoUrl'],
	'idp-certs': ['certificates', 'legacyAlgorithms', 'logoutRequestSignature'],
	'idp-assertion': ['authnContextMode', 'authnContexts', 'nameIdFormat'],
	'idp-accounts': ['profileUpdate', 'syntheticEmail'],
	'idp-metadata': ['metadataInterval', 'metadataRefresh']
};

/** Whether a connection setting differs from what is saved (for the change mark on its heading). */
export function settingsChanged(
	part: string,
	now: ConnectionSettings,
	saved: ConnectionSettings
): boolean {
	const kind = part.split('-')[0] as 'rp' | 'sp' | 'op' | 'idp';
	const pick = (s: ConnectionSettings) => {
		const slice = s[kind] as unknown as Record<string, unknown>;
		const fields = SETTINGS_FIELDS[part] ?? [];
		// Overriding a default changes the connection even when the value shown stays the same:
		// it no longer follows that default.
		const overridden = ((slice.overridden as string[] | undefined) ?? [])
			.filter((field) => fields.includes(field))
			.sort();
		return JSON.stringify([fields.map((field) => slice[field]), overridden]);
	};
	return pick(now) !== pick(saved);
}
