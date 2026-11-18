/**
 * The tenant's own SAML identity (`/api/admin/saml-settings`): the entity IDs it publishes, where
 * its interactive sign-in goes, how its IdP and SP metadata are published, and the signing keys
 * behind both roles (an active certificate, the next one for a rollover, a backup).
 *
 * Signing-key operations and the DR bundle import ask for a step-up (the Admin API refuses with
 * `step_up_required` and the operation is repeated with a receipt); `withStepUp` handles that.
 *
 * Pages take a `SamlSettingsClient` rather than calling fetch, so Storybook and tests hand them an
 * in-memory one (`fake/saml-settings-fake.ts`).
 */
import { adminFetch, API_BASE_URL } from './admin-request';
import { StepUpCancelledError, stepUpHeaders, withStepUp } from './admin-step-up';
import { errorFromResponse } from './api-error';
import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';

export type SamlRole = 'idp' | 'sp';
export type SamlSigningSlot = 'active' | 'next' | 'backup';
/** `metadata_url`: the metadata address is the entity ID; `role_url`: the role's own address. */
export type SamlEntityIdStyle = 'metadata_url' | 'role_url';
/** Where an IdP-initiated or SP-initiated interactive sign-in sends the person. */
export type SamlInteractiveLoginUrlPolicy = 'tenant_host' | 'ui_base_url';

export interface SamlSigningKeyReference {
	slot: SamlSigningSlot;
	id?: string;
	keyRef?: string;
	kid?: string;
	/** PEM. */
	certificate?: string;
	state?: string;
	metadataPublishFrom?: number;
	plannedActivationAt?: number;
	validFrom?: number;
	validTo?: number;
	publicKeyAlgorithm?: 'RSA';
	publicKeySizeBits?: number;
	subjectAlternativeNames?: { dnsNames: string[] };
}

export interface SamlSigningKeyPolicy {
	scope?: 'tenant_role' | 'provider';
	metadataCertificatePublication?: 'active_only' | 'active_next' | 'active_next_backup';
	active?: SamlSigningKeyReference;
	next?: SamlSigningKeyReference;
	nextCandidates?: SamlSigningKeyReference[];
	backup?: SamlSigningKeyReference;
}

export interface SamlCertificateSubject {
	countryName: string;
	stateOrProvinceName: string;
	localityName: string;
	organizationName: string;
	organizationalUnitName: string;
	commonName: string;
}

export interface SamlCertificateSubjectAlternativeNames {
	/** Add the DNS names of the tenant's SAML addresses to the certificate. */
	includeGeneratedDnsNames: boolean;
	dnsNames: string[];
}

export interface SamlSettings {
	tenantId: string;
	entityIdStyle: SamlEntityIdStyle;
	interactiveLoginUrlPolicy: SamlInteractiveLoginUrlPolicy;
	localSigning?: {
		certificateSubject: SamlCertificateSubject;
		certificateSubjectAlternativeNames: SamlCertificateSubjectAlternativeNames;
		idpSigningKeyPolicy: SamlSigningKeyPolicy;
		spSigningKeyPolicy: SamlSigningKeyPolicy;
	};
	metadata: {
		signingMode: 'disabled' | 'enabled';
		signingEnabled: boolean;
		validUntilEnabled: boolean;
		idpValidUntil: string;
		spValidUntil: string;
		validityDays: number;
		cacheDuration: string;
	};
	generated: {
		issuerUrl: string;
		idpEntityId: string;
		spEntityId: string;
		idpMetadataUrl: string;
		spMetadataUrl: string;
	};
}

export interface SamlSettingsUpdate {
	entityIdStyle?: SamlEntityIdStyle;
	interactiveLoginUrlPolicy?: SamlInteractiveLoginUrlPolicy;
}

/**
 * - `publish_next`: make a new certificate and publish it as the next one (a rollover starts).
 * - `promote_next`: sign with the next one from now; the previous one stays as the backup.
 * - `retire_backup`: drop the backup from the metadata.
 * - `delete_next`: drop a next certificate that was published but not promoted.
 * - `recreate_active`: replace the active key at once (an emergency; partners must re-import).
 */
export type SamlLocalSigningAction =
	| 'publish_next'
	| 'promote_next'
	| 'retire_backup'
	| 'delete_next'
	| 'recreate_active';

export interface SamlLocalSigningRequest {
	role: SamlRole;
	action: SamlLocalSigningAction;
	certificateSubject?: Partial<SamlCertificateSubject>;
	certificateSubjectAlternativeNames?: Partial<SamlCertificateSubjectAlternativeNames>;
	keepPreviousAsBackup?: boolean;
	targetKid?: string;
	targetKeyRef?: string;
	/** ISO 8601. */
	validFrom?: string;
	validTo?: string;
	publicKeyAlgorithm?: 'RSA';
	publicKeySizeBits?: 2048 | 3072 | 4096;
}

/** What a certificate says, read by the server from its PEM. */
export interface SamlCertificatePreview {
	certificate: string;
	subject: string;
	issuer: string;
	serialNumber: string;
	validFrom: string;
	validTo: string;
	signatureAlgorithm: string;
	publicKeyAlgorithm: string;
	publicKeySizeBits?: number;
	fingerprintSha1: string;
	fingerprintSha256: string;
	warnings: string[];
}

/** The signing keys of both roles, encrypted with a passphrase. Private keys: keep it offline. */
export interface SamlLocalSigningDrBundle {
	kind: 'authrim.saml_local_signing_secret_dr_bundle.encrypted.v1';
	version: 1;
	tenantId: string;
	generatedAt: string;
	encrypted: true;
	sensitive: true;
	warning: string;
	kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
	cipher: { name: 'AES-GCM'; iv: string };
	payload: string;
	payloadEncoding: 'base64';
}

export interface SamlSettingsClient {
	get(): Promise<SamlSettings>;
	/** Changes how the entity IDs are published; the server asks for a step-up first. */
	update(change: SamlSettingsUpdate): Promise<SamlSettings>;
	/** Runs a signing-key operation; the server asks for a step-up first. */
	localSigning(request: SamlLocalSigningRequest): Promise<SamlSettings>;
	/**
	 * What a certificate says, read by the server. The Admin API allows it to admins who may
	 * create SAML providers; readers get the fingerprints computed in the browser instead.
	 */
	previewCertificate(certificate: string): Promise<SamlCertificatePreview>;
	exportDrBundle(passphrase: string): Promise<SamlLocalSigningDrBundle>;
	/** Restores the keys of the bundle into this tenant; the server asks for a step-up first. */
	importDrBundle(bundle: unknown, passphrase: string): Promise<SamlSettings>;
}

const BASE = `${API_BASE_URL}/api/admin/saml-settings`;

async function send<T>(
	url: string,
	init: { method?: string; json?: unknown; receipt?: string; tenantId?: string } = {}
): Promise<T> {
	const response = await adminFetch(url, {
		method: init.method ?? 'GET',
		tenantId: init.tenantId,
		includeJsonContentType: init.json !== undefined,
		headers: stepUpHeaders(init.receipt),
		body: init.json === undefined ? undefined : JSON.stringify(init.json)
	});
	if (!response.ok) throw await errorFromResponse(response);
	return (await response.json()) as T;
}

/**
 * A step-up protected write. The tenant is the one selected when the operation starts: should a
 * platform admin switch tenants while the step-up is pending, the retry is cancelled rather than
 * sent to the newly selected tenant.
 */
function protectedWrite<T>(url: string, method: 'PUT' | 'POST', json: unknown): Promise<T> {
	const tenantId = tenantScope.tenantId ?? undefined;
	return withStepUp((receipt) => {
		if ((tenantScope.tenantId ?? undefined) !== tenantId) throw new StepUpCancelledError();
		return send<T>(url, { method, json, receipt, tenantId });
	});
}

export const httpSamlSettings: SamlSettingsClient = {
	get: () => send(BASE),
	// Changing the published entity IDs is step-up protected like the signing operations.
	update: (change) => protectedWrite(BASE, 'PUT', change),
	localSigning: (request) => protectedWrite(`${BASE}/local-signing`, 'POST', request),
	previewCertificate: (certificate) =>
		send(`${API_BASE_URL}/api/admin/saml-metadata/certificate-preview`, {
			method: 'POST',
			json: { certificate }
		}),
	// Not step-up protected on the server today; the same tenant-bound path keeps it so should
	// the server start asking, and never exports from a tenant switched to meanwhile.
	exportDrBundle: (passphrase) =>
		protectedWrite(`${BASE}/local-signing/dr-bundle`, 'POST', { passphrase }),
	importDrBundle: (bundle, passphrase) =>
		protectedWrite(`${BASE}/local-signing/dr-bundle/import`, 'POST', { bundle, passphrase })
};
