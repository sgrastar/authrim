/**
 * What the SAML identity page derives from the settings, kept out of the components so it can be
 * tested: the certificate slots of a role, the certificate subject form, the DNS names of a
 * certificate, and the entity ID a style would give.
 */
import type {
	SamlCertificateSubject,
	SamlCertificateSubjectAlternativeNames,
	SamlEntityIdStyle,
	SamlRole,
	SamlSettings,
	SamlSigningKeyPolicy,
	SamlSigningKeyReference,
	SamlSigningSlot
} from '#lib/api/saml-settings.js';

export const SAML_ROLES: readonly SamlRole[] = ['idp', 'sp'];
export const DR_BUNDLE_PASSPHRASE_MIN_LENGTH = 12;

/** Whether a slot's certificate is in the metadata now, as the server decides it. */
export type SlotPublication =
	/** In the metadata. */
	| 'published'
	/** Will be, from `metadataPublishFrom`. */
	| 'scheduled'
	/** Left out by the role's publication mode (`metadataCertificatePublication`). */
	| 'withheld';

/** One certificate slot of a role, as a row of the page. */
export interface SigningSlotRow {
	id: string;
	slot: SamlSigningSlot;
	/** Second and later next candidates get a number. */
	index?: number;
	reference?: SamlSigningKeyReference;
	/** A key is stored for the slot (the active slot without one signs with the default key). */
	stored: boolean;
	publication: SlotPublication;
}

/** The server's default when a policy does not say which certificates the metadata carries. */
const DEFAULT_PUBLICATION = 'active_only';

/** Mirrors the server's `getSAMLMetadataSigningCertificates`. */
export function slotPublication(
	policy: SamlSigningKeyPolicy,
	slot: SamlSigningSlot,
	reference: SamlSigningKeyReference | undefined,
	now = Date.now()
): SlotPublication {
	if (slot === 'active') return 'published';
	const mode = policy.metadataCertificatePublication ?? DEFAULT_PUBLICATION;
	const allowed =
		slot === 'next'
			? mode === 'active_next' || mode === 'active_next_backup'
			: mode === 'active_next_backup';
	if (!allowed) return 'withheld';
	if (reference?.metadataPublishFrom && now < reference.metadataPublishFrom) return 'scheduled';
	return 'published';
}

export function signingPolicy(settings: SamlSettings, role: SamlRole): SamlSigningKeyPolicy {
	return (
		(role === 'idp'
			? settings.localSigning?.idpSigningKeyPolicy
			: settings.localSigning?.spSigningKeyPolicy) ?? {}
	);
}

function referenceKey(reference: SamlSigningKeyReference): string | undefined {
	return reference.kid ?? reference.keyRef ?? reference.certificate ?? reference.id;
}

/** The next certificate and its candidates, without duplicates. */
export function nextReferences(policy: SamlSigningKeyPolicy): SamlSigningKeyReference[] {
	const seen = new Set<string>();
	return [policy.next, ...(policy.nextCandidates ?? [])].filter(
		(reference): reference is SamlSigningKeyReference => {
			if (!reference) return false;
			const key = referenceKey(reference);
			if (key === undefined) return true;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		}
	);
}

function stored(reference: SamlSigningKeyReference | undefined): boolean {
	return !!reference?.kid || !!reference?.keyRef || !!reference?.certificate;
}

/** The rows of a role: the active slot, every next certificate, the backup. */
export function signingSlotRows(policy: SamlSigningKeyPolicy, now = Date.now()): SigningSlotRow[] {
	const next = nextReferences(policy);
	return [
		{
			id: 'active',
			slot: 'active',
			reference: policy.active,
			stored: stored(policy.active),
			publication: 'published'
		},
		...next.map((reference, i) => ({
			id: referenceKey(reference) ?? `next:${i}`,
			slot: 'next' as const,
			index: next.length > 1 ? i + 1 : undefined,
			reference,
			stored: true,
			publication: slotPublication(policy, 'next', reference, now)
		})),
		{
			id: 'backup',
			slot: 'backup',
			reference: policy.backup,
			stored: stored(policy.backup),
			publication: slotPublication(policy, 'backup', policy.backup, now)
		}
	];
}

export const EMPTY_SUBJECT: SamlCertificateSubject = {
	countryName: '',
	stateOrProvinceName: '',
	localityName: '',
	organizationName: '',
	organizationalUnitName: '',
	commonName: ''
};

export function subjectForm(subject?: Partial<SamlCertificateSubject>): SamlCertificateSubject {
	return {
		countryName: subject?.countryName ?? '',
		stateOrProvinceName: subject?.stateOrProvinceName ?? '',
		localityName: subject?.localityName ?? '',
		organizationName: subject?.organizationName ?? '',
		organizationalUnitName: subject?.organizationalUnitName ?? '',
		commonName: subject?.commonName ?? ''
	};
}

const SUBJECT_KEYS: Record<string, keyof SamlCertificateSubject> = {
	C: 'countryName',
	ST: 'stateOrProvinceName',
	L: 'localityName',
	O: 'organizationName',
	OU: 'organizationalUnitName',
	CN: 'commonName'
};

/**
 * The form values of a distinguished name as a certificate shows it ("CN=x, O=y"). A comma
 * splits attributes only where an attribute name follows it, so "O=Example, Inc." stays whole.
 */
export function parseSubject(subject: string | undefined): SamlCertificateSubject | null {
	if (!subject?.trim()) return null;
	const values: Partial<SamlCertificateSubject> = {};
	for (const part of subject.split(/,\s*(?=[A-Za-z][A-Za-z0-9.]*=)/)) {
		const index = part.indexOf('=');
		if (index < 0) continue;
		const key = SUBJECT_KEYS[part.slice(0, index).trim()];
		if (key) values[key] = part.slice(index + 1).trim();
	}
	return Object.keys(values).length > 0 ? subjectForm(values) : null;
}

/** Lower-cased host names, without scheme, path or duplicates; blanks dropped. */
export function normalizeDnsNames(values: readonly string[]): string[] {
	const names = new Set<string>();
	for (const raw of values) {
		let value = raw.trim().toLowerCase();
		if (!value) continue;
		if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
			try {
				value = new URL(value).hostname;
			} catch {
				continue;
			}
		}
		value = value.split('/')[0].split(':')[0];
		if (value) names.add(value);
	}
	return [...names];
}

export function parseDnsNamesInput(value: string): string[] {
	return normalizeDnsNames(value.split(/[\s,]+/));
}

/** The host names of a role's addresses, as the server adds them when asked to. */
export function generatedDnsNames(settings: SamlSettings, role: SamlRole): string[] {
	const urls =
		role === 'idp'
			? [settings.generated.idpMetadataUrl, settings.generated.idpEntityId]
			: [settings.generated.spMetadataUrl, settings.generated.spEntityId];
	return normalizeDnsNames(urls.filter((url) => /^https?:\/\//.test(url)));
}

export function subjectAlternativeNamesForm(
	names?: Partial<SamlCertificateSubjectAlternativeNames>
): SamlCertificateSubjectAlternativeNames {
	return {
		includeGeneratedDnsNames: names?.includeGeneratedDnsNames ?? true,
		dnsNames: normalizeDnsNames(names?.dnsNames ?? [])
	};
}

/** The entity ID a style would publish for a role, from the addresses the settings give. */
export function entityIdForStyle(
	settings: SamlSettings,
	role: SamlRole,
	style: SamlEntityIdStyle
): string {
	if (style === settings.entityIdStyle) {
		return role === 'idp' ? settings.generated.idpEntityId : settings.generated.spEntityId;
	}
	const metadataUrl =
		role === 'idp' ? settings.generated.idpMetadataUrl : settings.generated.spMetadataUrl;
	if (style === 'metadata_url') return metadataUrl;
	return metadataUrl.replace(/\/metadata\/?$/, '');
}

/** `datetime-local` value of an instant, in the browser's zone (empty when not a date). */
export function toDateTimeLocal(value: Date | number | string | undefined): string {
	if (value === undefined || value === '') return '';
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** ISO 8601 of a `datetime-local` value; undefined when empty or not a date. */
export function fromDateTimeLocal(value: string): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** A year from now, the default end of a new certificate. */
export function defaultValidTo(now = new Date()): Date {
	const date = new Date(now);
	date.setFullYear(date.getFullYear() + 1);
	return date;
}

/** Why a passphrase pair cannot be used, or null. */
export function passphraseProblem(
	passphrase: string,
	confirmation: string
): 'short' | 'mismatch' | null {
	if (passphrase.length < DR_BUNDLE_PASSPHRASE_MIN_LENGTH) return 'short';
	if (passphrase !== confirmation) return 'mismatch';
	return null;
}

/** Hand a text to the browser as a file download. */
export function downloadText(filename: string, contents: string, type: string): void {
	const url = URL.createObjectURL(new Blob([contents], { type }));
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

/** The DER bytes of a PEM certificate, or null when it is not one. */
export function derOfPem(pem: string): Uint8Array<ArrayBuffer> | null {
	const body = pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '');
	if (!body) return null;
	try {
		const binary = atob(body);
		const der = new Uint8Array(new ArrayBuffer(binary.length));
		for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
		// A certificate is an ASN.1 SEQUENCE; anything else that happens to be base64 is not one.
		return der[0] === 0x30 ? der : null;
	} catch {
		return null;
	}
}

export interface CertificateFingerprints {
	sha1: string;
	sha256: string;
}

function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)]
		.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase())
		.join(':');
}

/** SHA-1 and SHA-256 fingerprints of a PEM certificate, as partners compare them; null if not a certificate. */
export async function certificateFingerprints(
	pem: string
): Promise<CertificateFingerprints | null> {
	const der = derOfPem(pem);
	if (!der || typeof crypto === 'undefined' || !crypto.subtle) return null;
	const [sha1, sha256] = await Promise.all([
		crypto.subtle.digest('SHA-1', der),
		crypto.subtle.digest('SHA-256', der)
	]);
	return { sha1: hex(sha1), sha256: hex(sha256) };
}
