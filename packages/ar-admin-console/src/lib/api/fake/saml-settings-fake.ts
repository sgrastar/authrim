/**
 * In-memory SAML identity settings for Storybook, the whole-console mock and tests. Answers as
 * the Admin API does: a passphrase shorter than 12 characters is refused, a bundle is only
 * imported into the tenant it was made for and with its passphrase, and each signing-key action
 * moves the slots the way the server does (publish → next, promote → active with the previous as
 * backup, retire → no backup, delete → no next, recreate → a new active key).
 */
import { ApiError } from '../api-error';
import type {
	SamlCertificatePreview,
	SamlCertificateSubject,
	SamlLocalSigningDrBundle,
	SamlLocalSigningRequest,
	SamlRole,
	SamlSettings,
	SamlSettingsClient,
	SamlSigningKeyPolicy,
	SamlSigningKeyReference
} from '../saml-settings';

export interface FakeSamlSettingsOptions {
	settings?: SamlSettings;
	/** Milliseconds each call takes. */
	delay?: number;
	/** The export and import refuse (no permission). */
	drForbidden?: boolean;
	now?: () => number;
}

const DAY = 86_400_000;
const PASSPHRASE_MIN = 12;

/** A certificate's details are kept beside its fake PEM, keyed by the PEM. */
const previews = new Map<string, SamlCertificatePreview>();

function fingerprint(seed: string, bytes: number): string {
	let h = 2166136261;
	const out: string[] = [];
	for (let i = 0; i < bytes; i++) {
		for (const ch of `${seed}:${i}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
		out.push((h & 0xff).toString(16).padStart(2, '0').toUpperCase());
	}
	return out.join(':');
}

export function fakeCertificate(input: {
	kid: string;
	subject: string;
	validFrom: number;
	validTo: number;
	bits?: number;
	dnsNames?: string[];
}): SamlSigningKeyReference {
	const pem = `-----BEGIN CERTIFICATE-----\n${btoa(`0fake-certificate:${input.kid}`)}\n-----END CERTIFICATE-----`;
	previews.set(pem, {
		certificate: pem,
		subject: input.subject,
		issuer: input.subject,
		serialNumber: fingerprint(`${input.kid}:serial`, 8).replaceAll(':', ''),
		validFrom: new Date(input.validFrom).toISOString(),
		validTo: new Date(input.validTo).toISOString(),
		signatureAlgorithm: 'SHA256withRSA',
		publicKeyAlgorithm: 'RSA',
		publicKeySizeBits: input.bits ?? 2048,
		fingerprintSha1: fingerprint(`${input.kid}:sha1`, 20),
		fingerprintSha256: fingerprint(`${input.kid}:sha256`, 32),
		warnings: []
	});
	return {
		slot: 'active',
		kid: input.kid,
		keyRef: `kms:${input.kid}`,
		certificate: pem,
		validFrom: input.validFrom,
		validTo: input.validTo,
		publicKeyAlgorithm: 'RSA',
		publicKeySizeBits: input.bits ?? 2048,
		subjectAlternativeNames: { dnsNames: input.dnsNames ?? [] }
	};
}

const NOW = Date.UTC(2026, 10, 19);
const SUBJECT = 'C=JP, ST=Tokyo, L=Chiyoda, O=Acme University, OU=IT, CN=Acme SAML Signing';

/** The mock tenant: an IdP in the middle of a rollover, an SP with one certificate. */
export function mockSamlSettings(): SamlSettings {
	const base = 'https://acme.authrim.example';
	return {
		tenantId: 'acme',
		entityIdStyle: 'metadata_url',
		interactiveLoginUrlPolicy: 'tenant_host',
		localSigning: {
			certificateSubject: {
				countryName: 'JP',
				stateOrProvinceName: 'Tokyo',
				localityName: 'Chiyoda',
				organizationName: 'Acme University',
				organizationalUnitName: 'IT',
				commonName: 'Acme SAML Signing'
			},
			certificateSubjectAlternativeNames: { includeGeneratedDnsNames: true, dnsNames: [] },
			idpSigningKeyPolicy: {
				scope: 'tenant_role',
				metadataCertificatePublication: 'active_next',
				active: {
					...fakeCertificate({
						kid: 'key-202511010000-idp',
						subject: SUBJECT,
						validFrom: NOW - 380 * DAY,
						validTo: NOW + 20 * DAY,
						dnsNames: ['acme.authrim.example']
					}),
					slot: 'active'
				},
				next: {
					...fakeCertificate({
						kid: 'key-202611010000-idp',
						subject: SUBJECT,
						validFrom: NOW - 18 * DAY,
						validTo: NOW + 712 * DAY,
						bits: 3072,
						dnsNames: ['acme.authrim.example']
					}),
					slot: 'next',
					metadataPublishFrom: NOW - 18 * DAY
				}
			},
			spSigningKeyPolicy: {
				scope: 'tenant_role',
				metadataCertificatePublication: 'active_only',
				active: {
					...fakeCertificate({
						kid: 'key-202602010000-sp',
						subject: SUBJECT,
						validFrom: NOW - 290 * DAY,
						validTo: NOW + 440 * DAY
					}),
					slot: 'active'
				}
			}
		},
		metadata: {
			signingMode: 'enabled',
			signingEnabled: true,
			validUntilEnabled: true,
			idpValidUntil: new Date(NOW + 7 * DAY).toISOString(),
			spValidUntil: new Date(NOW + 7 * DAY).toISOString(),
			validityDays: 7,
			cacheDuration: 'PT1H'
		},
		generated: {
			issuerUrl: base,
			idpEntityId: `${base}/saml/idp/metadata`,
			spEntityId: `${base}/saml/sp/metadata`,
			idpMetadataUrl: `${base}/saml/idp/metadata`,
			spMetadataUrl: `${base}/saml/sp/metadata`
		}
	};
}

/** Base64 of a string's UTF-8 bytes (btoa alone refuses characters outside Latin-1). */
function base64Utf8(text: string): string {
	return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function utf8Base64(encoded: string): string {
	return new TextDecoder().decode(Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0)));
}

function subjectText(subject: Partial<SamlCertificateSubject> | undefined): string {
	const parts: string[] = [];
	const add = (key: string, value: string | undefined) => {
		if (value?.trim()) parts.push(`${key}=${value.trim()}`);
	};
	add('C', subject?.countryName);
	add('ST', subject?.stateOrProvinceName);
	add('L', subject?.localityName);
	add('O', subject?.organizationName);
	add('OU', subject?.organizationalUnitName);
	add('CN', subject?.commonName);
	return parts.join(', ') || 'CN=Authrim SAML Signing';
}

export function createFakeSamlSettings(options: FakeSamlSettingsOptions = {}): SamlSettingsClient {
	const settings = structuredClone(options.settings ?? mockSamlSettings());
	const now = options.now ?? (() => Date.now());
	let sequence = 0;
	const wait = () =>
		options.delay ? new Promise((resolve) => setTimeout(resolve, options.delay)) : null;
	const current = () => structuredClone(settings);

	const policyOf = (role: SamlRole): SamlSigningKeyPolicy => {
		const signing = settings.localSigning!;
		return role === 'idp' ? signing.idpSigningKeyPolicy : signing.spSigningKeyPolicy;
	};

	const applyEntityIdStyle = () => {
		const strip = (url: string) => url.replace(/\/metadata\/?$/, '');
		const { generated } = settings;
		generated.idpEntityId =
			settings.entityIdStyle === 'metadata_url'
				? generated.idpMetadataUrl
				: strip(generated.idpMetadataUrl);
		generated.spEntityId =
			settings.entityIdStyle === 'metadata_url'
				? generated.spMetadataUrl
				: strip(generated.spMetadataUrl);
	};

	function makeKey(role: SamlRole, request: SamlLocalSigningRequest): SamlSigningKeyReference {
		const signing = settings.localSigning!;
		const subject = request.certificateSubject
			? { ...signing.certificateSubject, ...request.certificateSubject }
			: signing.certificateSubject;
		if (request.certificateSubject) signing.certificateSubject = subject;
		if (request.certificateSubjectAlternativeNames) {
			signing.certificateSubjectAlternativeNames = {
				...signing.certificateSubjectAlternativeNames,
				...request.certificateSubjectAlternativeNames
			};
		}
		const validFrom = request.validFrom ? Date.parse(request.validFrom) : now();
		const validTo = request.validTo ? Date.parse(request.validTo) : validFrom + 365 * DAY;
		if (!(validTo > validFrom)) {
			throw new ApiError(400, 'validation_failed', 'validTo must be after validFrom', {
				field: 'validTo'
			});
		}
		sequence += 1;
		return fakeCertificate({
			kid: `key-${new Date(now()).toISOString().replace(/\D/g, '').slice(0, 12)}${sequence}-${role}`,
			subject: subjectText(subject),
			validFrom,
			validTo,
			bits: request.publicKeySizeBits ?? 2048,
			dnsNames: [
				...(signing.certificateSubjectAlternativeNames.includeGeneratedDnsNames
					? [new URL(settings.generated.issuerUrl).hostname]
					: []),
				...signing.certificateSubjectAlternativeNames.dnsNames
			]
		});
	}

	return {
		async get() {
			await wait();
			return current();
		},
		async update(change) {
			await wait();
			if (change.entityIdStyle) settings.entityIdStyle = change.entityIdStyle;
			if (change.interactiveLoginUrlPolicy)
				settings.interactiveLoginUrlPolicy = change.interactiveLoginUrlPolicy;
			applyEntityIdStyle();
			return current();
		},
		async localSigning(request) {
			await wait();
			const policy = policyOf(request.role);
			switch (request.action) {
				case 'publish_next': {
					const key = { ...makeKey(request.role, request), slot: 'next' as const };
					if (policy.next) policy.nextCandidates = [...(policy.nextCandidates ?? []), key];
					else policy.next = { ...key, metadataPublishFrom: now() };
					// As the server: publishing a next certificate opens the metadata to it.
					policy.metadataCertificatePublication = policy.backup
						? 'active_next_backup'
						: 'active_next';
					break;
				}
				case 'promote_next': {
					const candidates = [policy.next, ...(policy.nextCandidates ?? [])].filter(Boolean);
					const chosen =
						candidates.find((c) => c!.kid === request.targetKid) ?? candidates[0] ?? undefined;
					if (!chosen) throw new ApiError(409, 'saml_no_next_certificate', 'No next certificate');
					if (request.keepPreviousAsBackup !== false && policy.active)
						policy.backup = { ...policy.active, slot: 'backup' };
					policy.active = { ...chosen, slot: 'active', metadataPublishFrom: undefined };
					const rest = candidates.filter((c) => c !== chosen) as SamlSigningKeyReference[];
					policy.next = rest[0];
					policy.nextCandidates = rest.slice(1);
					policy.metadataCertificatePublication = policy.backup
						? 'active_next_backup'
						: rest.length
							? 'active_next'
							: 'active_only';
					break;
				}
				case 'retire_backup':
					delete policy.backup;
					policy.metadataCertificatePublication = policy.next ? 'active_next' : 'active_only';
					break;
				case 'delete_next': {
					const candidates = [policy.next, ...(policy.nextCandidates ?? [])].filter(
						(c): c is SamlSigningKeyReference => !!c && c.kid !== request.targetKid
					);
					policy.next = candidates[0];
					policy.nextCandidates = candidates.slice(1);
					policy.metadataCertificatePublication = candidates.length
						? policy.backup
							? 'active_next_backup'
							: 'active_next'
						: policy.backup
							? 'active_next_backup'
							: 'active_only';
					break;
				}
				case 'recreate_active':
					policy.active = { ...makeKey(request.role, request), slot: 'active' };
					break;
			}
			return current();
		},
		async previewCertificate(certificate) {
			await wait();
			const preview = previews.get(certificate.trim());
			if (!preview) throw new ApiError(400, 'invalid_certificate', 'Not a certificate');
			return structuredClone(preview);
		},
		async exportDrBundle(passphrase) {
			await wait();
			if (options.drForbidden) throw new ApiError(403, 'forbidden', 'Forbidden');
			if (passphrase.length < PASSPHRASE_MIN)
				throw new ApiError(400, 'validation_failed', 'Passphrase is too short', {
					field: 'passphrase'
				});
			const bundle: SamlLocalSigningDrBundle = {
				kind: 'authrim.saml_local_signing_secret_dr_bundle.encrypted.v1',
				version: 1,
				tenantId: settings.tenantId,
				generatedAt: new Date(now()).toISOString(),
				encrypted: true,
				sensitive: true,
				warning: 'This bundle contains SAML private signing keys. Store it offline.',
				kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600_000, salt: 'c2FsdA==' },
				cipher: { name: 'AES-GCM', iv: 'aXZpdml2aXZpdg==' },
				// Not encrypted: the fake carries the keys as they are, tagged with the passphrase.
				// As the real bundle: the keys, and the publication settings of the time.
				payload: base64Utf8(
					JSON.stringify({
						passphrase,
						localSigning: settings.localSigning,
						entityIdStyle: settings.entityIdStyle,
						interactiveLoginUrlPolicy: settings.interactiveLoginUrlPolicy
					})
				),
				payloadEncoding: 'base64'
			};
			return bundle;
		},
		async importDrBundle(bundle, passphrase) {
			await wait();
			if (options.drForbidden) throw new ApiError(403, 'forbidden', 'Forbidden');
			const candidate = bundle as Partial<SamlLocalSigningDrBundle> | null;
			if (
				!candidate ||
				candidate.kind !== 'authrim.saml_local_signing_secret_dr_bundle.encrypted.v1' ||
				typeof candidate.payload !== 'string'
			) {
				throw new ApiError(400, 'invalid_dr_bundle', 'Not a SAML signing DR bundle');
			}
			if (candidate.tenantId !== settings.tenantId) {
				throw new ApiError(400, 'dr_bundle_tenant_mismatch', 'The bundle is for another tenant');
			}
			let payload: {
				passphrase?: string;
				localSigning?: SamlSettings['localSigning'];
				entityIdStyle?: SamlSettings['entityIdStyle'];
				interactiveLoginUrlPolicy?: SamlSettings['interactiveLoginUrlPolicy'];
			};
			try {
				payload = JSON.parse(utf8Base64(candidate.payload));
			} catch {
				throw new ApiError(400, 'dr_bundle_decrypt_failed', 'The bundle could not be decrypted');
			}
			if (payload.passphrase !== passphrase) {
				throw new ApiError(400, 'dr_bundle_decrypt_failed', 'Wrong passphrase');
			}
			if (payload.localSigning) settings.localSigning = structuredClone(payload.localSigning);
			if (payload.entityIdStyle) settings.entityIdStyle = payload.entityIdStyle;
			if (payload.interactiveLoginUrlPolicy)
				settings.interactiveLoginUrlPolicy = payload.interactiveLoginUrlPolicy;
			applyEntityIdStyle();
			return current();
		}
	};
}
