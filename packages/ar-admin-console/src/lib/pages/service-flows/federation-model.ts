import type {
	FederationCertificate,
	FederationEntity,
	FederationEntityState,
	FederationIdpSelectionMode,
	FederationRole,
	FederationSource,
	FederationUpdate,
	FederationWrite
} from '#lib/api/federation-sources.js';
import { t } from '#lib/i18n/i18n.svelte.js';
import { certificateFingerprints } from '#lib/pages/authentication/saml-local/local-signing-model.js';
import type { Direction } from './connection-model';

/**
 * What the console asks of a SAML federation (an aggregate metadata document trusted as a whole,
 * such as a national research federation's), and what it makes of the answers. It is a pure
 * module: the wizard, the connection's page and the stories share it.
 *
 * A federation takes part as one or both of two roles, named by what the *other* entities are:
 * the SP role lets the federation's service providers sign in through Authrim (Authrim is their
 * identity provider: the `out` direction), the IdP role lets Authrim's people sign in through the
 * federation's identity providers (`in`).
 */
export interface FederationForm {
	name: string;
	description: string;
	/** The one address the aggregate is fetched from. */
	metadataUrl: string;
	/** The certificates the aggregate's signature is checked against. */
	certificates: FederationCertificate[];
	spRole: boolean;
	idpRole: boolean;
	/** The mapping set of each role; empty until one is chosen. */
	spMappingSetId: string;
	idpMappingSetId: string;
	/** What an SP of the federation is sent unless a mapping set says otherwise. */
	attributePreset: string;
	idpSelectionMode: FederationIdpSelectionMode;
	discoveryServiceUrl: string;
	/** Entities set aside (the connection's page edits them; the wizard starts with none). */
	excludedEntityIds: string[];
	/** Only entities registered by one of these authorities take part; empty: any (one per line). */
	registrationAuthorities: string;
}

/** The attribute-release presets the server accepts for a federation's service providers. */
export const FEDERATION_ATTRIBUTE_PRESETS = [
	'basic.v1',
	'enterprise_saas.v1',
	'academic_publisher.v1',
	'research_federation.v1'
] as const;
export const DEFAULT_POLLING_SECONDS = 6 * 60 * 60;

/** A new federation: the direction chosen first decides which role starts on. */
export function emptyFederationForm(direction: Direction | '' = ''): FederationForm {
	return {
		name: '',
		description: '',
		metadataUrl: '',
		certificates: [],
		spRole: direction === 'out',
		idpRole: direction === 'in',
		spMappingSetId: '',
		idpMappingSetId: '',
		attributePreset: 'basic.v1',
		idpSelectionMode: 'authrim_search',
		discoveryServiceUrl: '',
		excludedEntityIds: [],
		registrationAuthorities: ''
	};
}

/** The form of a source that was read, to edit. */
export function federationFormOf(source: FederationSource): FederationForm {
	return {
		name: source.name,
		description: source.description,
		metadataUrl: source.metadataUrl,
		certificates: source.certificates.map((certificate) => ({ ...certificate })),
		spRole: source.roles.includes('saml_sp'),
		idpRole: source.roles.includes('saml_idp'),
		spMappingSetId: source.spMappingSetId,
		idpMappingSetId: source.idpMappingSetId,
		attributePreset: source.attributePresetId || 'basic.v1',
		idpSelectionMode: source.idpSelection.mode,
		discoveryServiceUrl: source.idpSelection.discoveryServiceUrl,
		excludedEntityIds: [...source.excludedEntityIds],
		registrationAuthorities: source.registrationAuthorities.join('\n')
	};
}

export interface FederationProblem {
	field:
		| 'name'
		| 'metadataUrl'
		| 'certificates'
		| 'roles'
		| 'spMappingSet'
		| 'idpMappingSet'
		| 'discoveryServiceUrl';
	message: string;
}

/** An https address with a host and no embedded credentials, as the URL parser reads it. */
export function isHttps(value: string): boolean {
	// The scheme written out with its slashes: the server's pattern check wants exactly that.
	if (!/^https:\/\//i.test(value.trim())) return false;
	try {
		const url = new URL(value.trim());
		return url.protocol === 'https:' && url.hostname !== '' && !url.username && !url.password;
	} catch {
		return false;
	}
}
/**
 * An address the metadata can be fetched from: https, one exact URL (no pattern, no spaces), and
 * no `#` part: a link copied from a page with a highlighted passage ends in one, and it names a
 * place in that page, not a document.
 */
const exactMetadataUrl = (value: string) => isHttps(value) && !/[*\s#]/.test(value.trim());

/** Why an address cannot be the metadata's, in words; undefined when it can (or is empty). */
export function metadataUrlProblem(value: string): string | undefined {
	const url = value.trim();
	if (!url) return undefined;
	if (url.includes('#')) return t('sf.fed.error.metadataUrlFragment');
	return exactMetadataUrl(url) ? undefined : t('sf.fed.error.metadataUrl');
}

/**
 * What is still missing for the federation to be trusted automatically: a name, exactly one
 * metadata address (not a pattern), a certificate to check its signature against, at least one
 * role and, for each role, the mapping set that turns what is sent or taken into the profile.
 */
export function federationProblems(form: FederationForm): FederationProblem[] {
	const problems: FederationProblem[] = [];
	if (!form.name.trim()) problems.push({ field: 'name', message: t('sf.fed.error.name') });
	if (!exactMetadataUrl(form.metadataUrl))
		problems.push({
			field: 'metadataUrl',
			message: metadataUrlProblem(form.metadataUrl) ?? t('sf.fed.error.metadataUrl')
		});
	if (form.certificates.length === 0)
		problems.push({ field: 'certificates', message: t('sf.fed.error.certificates') });
	if (!form.spRole && !form.idpRole)
		problems.push({ field: 'roles', message: t('sf.fed.error.roles') });
	if (form.spRole && !form.spMappingSetId)
		problems.push({ field: 'spMappingSet', message: t('sf.fed.error.spMapping') });
	if (form.idpRole && !form.idpMappingSetId)
		problems.push({ field: 'idpMappingSet', message: t('sf.fed.error.idpMapping') });
	if (form.idpRole && form.idpSelectionMode === 'external_ds' && !isHttps(form.discoveryServiceUrl))
		problems.push({ field: 'discoveryServiceUrl', message: t('sf.fed.error.dsUrl') });
	return problems;
}

/**
 * What a federation needs to exist at all: a name, the exact metadata address, a certificate to
 * check its signature against, and a role. The mapping sets come later, on its own page; until
 * every role has one the federation only collects the inventory and signs nobody in.
 */
export function federationSetupProblems(form: FederationForm): FederationProblem[] {
	return federationProblems(form).filter((problem) =>
		['name', 'metadataUrl', 'certificates', 'roles', 'discoveryServiceUrl'].includes(problem.field)
	);
}

/** Every role has its mapping set (and an external discovery service its address). */
export function federationInUse(form: FederationForm): boolean {
	return federationProblems(form).length === 0;
}

/** The registration authorities typed, one per line, without blanks or repeats. */
export function registrationAuthorityList(
	form: Pick<FederationForm, 'registrationAuthorities'>
): string[] {
	return [
		...new Set(
			form.registrationAuthorities
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean)
		)
	];
}

export function federationRoles(form: FederationForm): FederationRole[] {
	return [
		...(form.idpRole ? (['saml_idp'] as const) : []),
		...(form.spRole ? (['saml_sp'] as const) : [])
	];
}

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/** Still waiting for its mapping sets: made by the wizard (or already waiting) and not complete. */
function federationSetupPending(form: FederationForm, base: Record<string, unknown>): boolean {
	return !federationInUse(form) && (base.setupPending === true || Object.keys(base).length === 0);
}

/**
 * Without a mapping set per role nobody can sign in, so a federation waiting for them only
 * collects the inventory and is switched on when the last set is chosen. One an administrator
 * set to inventory-only on purpose (not waiting) stays so.
 */
function resolutionMode(
	form: FederationForm,
	base: Record<string, unknown>,
	resolution: Record<string, unknown>
): 'automatic' | 'inventory_only' {
	if (!federationInUse(form)) return 'inventory_only';
	if (base.setupPending === true) return 'automatic';
	return resolution.mode === 'inventory_only' ? 'inventory_only' : 'automatic';
}

/**
 * The stored payload for a form, laid over the one the source already has: what the console does
 * not set (polling, signature policy, registration authorities, entity-category rules) is kept.
 * The exceptions and the institution picker are siblings of the runtime policy, not inside it:
 * a change of either must not count as a change of what is trusted.
 */
export function federationPayload(
	form: FederationForm,
	base: Record<string, unknown> = {}
): Record<string, unknown> {
	const url = form.metadataUrl.trim();
	const resolution =
		base.runtimeResolution && typeof base.runtimeResolution === 'object'
			? (base.runtimeResolution as Record<string, unknown>)
			: {};
	const {
		idpFieldMappingSetId: _idp,
		spFieldMappingSetId: _sp,
		defaultAttributePresetId: _preset,
		registrationAuthorities: _authorities,
		...keptResolution
	} = resolution;
	const preset = FEDERATION_ATTRIBUTE_PRESETS.find(
		(candidate) => candidate === form.attributePreset
	);
	const { setupPending: _pending, ...kept } = base;
	return {
		...kept,
		// Set by the wizard, kept until every role has its mapping set: it tells a federation that
		// is waiting for them from one an administrator set to inventory-only on purpose.
		...(federationSetupPending(form, base) ? { setupPending: true } : {}),
		metadataUrl: url,
		metadataUrlPatterns: [url],
		policy: base.policy ?? 'strict',
		description: form.description.trim(),
		certificates: form.certificates.map((certificate) => ({ ...certificate })),
		polling: base.polling ?? { mode: 'automatic', intervalSeconds: DEFAULT_POLLING_SECONDS },
		runtimeResolution: {
			...keptResolution,
			mode: resolutionMode(form, base, resolution),
			roles: federationRoles(form),
			// An empty id is refused by the server: a role with no set yet simply has none.
			...(form.idpRole && form.idpMappingSetId
				? { idpFieldMappingSetId: form.idpMappingSetId }
				: {}),
			...(form.spRole && form.spMappingSetId ? { spFieldMappingSetId: form.spMappingSetId } : {}),
			...(form.spRole && preset ? { defaultAttributePresetId: preset } : {}),
			...(registrationAuthorityList(form).length > 0
				? { registrationAuthorities: registrationAuthorityList(form) }
				: {})
		},
		// Siblings the console does not set survive a save, as in the runtime policy above.
		exceptions: {
			...record(base.exceptions),
			excludedEntityIds: [...new Set(form.excludedEntityIds)]
		},
		idpSelection:
			form.idpRole && form.idpSelectionMode === 'external_ds'
				? {
						...record(base.idpSelection),
						mode: 'external_ds',
						discoveryServiceUrl: form.discoveryServiceUrl.trim()
					}
				: (({ discoveryServiceUrl: _url, ...kept }) => ({ ...kept, mode: 'authrim_search' }))(
						record(base.idpSelection)
					)
	};
}

/** The request that makes a federation, or an error when the form is not complete. */
export function federationCreateInput(form: FederationForm): FederationWrite {
	if (federationSetupProblems(form).length > 0) throw new Error(t('sf.create.invalid'));
	return {
		// The address is what makes two federations the same one.
		sourceKey: form.metadataUrl.trim(),
		name: form.name.trim(),
		lifecycleState: 'active',
		payload: federationPayload(form)
	};
}

/** The request that saves the form over a source that was read. */
export function federationUpdateInput(
	form: FederationForm,
	source: FederationSource
): FederationUpdate {
	if (federationSetupProblems(form).length > 0) throw new Error(t('sf.create.invalid'));
	return {
		sourceKey: source.sourceKey,
		name: form.name.trim(),
		lifecycleState: source.lifecycleState,
		payload: federationPayload(form, source.payload),
		expectedUpdatedAt: source.updatedAt
	};
}

export type FederationStatusKey = 'draft' | 'active' | 'expired' | 'refreshFailed' | 'retired';

/**
 * Where a federation stands: not in use yet, in use, in use on metadata that has run out, in use
 * but the last fetch failed, or taken out of use. `now` is milliseconds.
 */
export function federationStatus(source: FederationSource, now = Date.now()): FederationStatusKey {
	if (source.lifecycleState === 'retired') return 'retired';
	if (source.lifecycleState === 'draft') return 'draft';
	const status = source.status;
	if (status) {
		const validUntil = status.acceptedValidUntil ? Date.parse(status.acceptedValidUntil) : NaN;
		if (status.sourceState === 'expired' || (Number.isFinite(validUntil) && validUntil <= now))
			return 'expired';
		if (
			status.sourceState === 'error' ||
			status.sourceState === 'missing' ||
			status.consecutiveFailures > 0 ||
			status.lastVerification?.status === 'failed'
		)
			return 'refreshFailed';
	}
	return 'active';
}

/** How an entity stands in the federation: an explicit connection wins, then the exclusion list. */
export function entityState(entity: FederationEntity): FederationEntityState {
	if (entity.explicitProviderId) return 'explicit';
	return entity.excluded ? 'excluded' : 'participating';
}

/** A mapping set a role can be given, as the page offers it. */
export interface FederationMappingOption {
	value: string;
	label: string;
}

const PEM = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/;

/**
 * A certificate from pasted or uploaded text: its first PEM block, with the SHA-256 fingerprint
 * worked out here, in the browser, so it can be compared with the one the federation publishes
 * before anything is saved. Null when the text holds no certificate.
 */
export async function certificateFromPem(text: string): Promise<FederationCertificate | null> {
	const pem = PEM.exec(text)?.[0];
	if (!pem) return null;
	const normalized = pem.replace(/\r/g, '').trim();
	const fingerprints = await certificateFingerprints(normalized);
	if (!fingerprints) return null;
	return {
		id: crypto.randomUUID(),
		certificate: normalized,
		fingerprintSha256: fingerprints.sha256.replaceAll(':', '').toLowerCase(),
		createdAt: Math.floor(Date.now() / 1000)
	};
}

/**
 * The PEM of a certificate file's bytes: a PEM file as it is, a DER (binary) one wrapped as PEM.
 * Federations publish their signer as either. Empty when the bytes are neither.
 */
export function pemFromFileBytes(bytes: Uint8Array): string {
	const firstContent = bytes.find((b) => b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x20);
	if (firstContent !== 0x30) return new TextDecoder().decode(bytes);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const lines = btoa(binary).match(/.{1,64}/g) ?? [];
	return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

/** `AA:BB:…`: how a federation publishes its signing certificate's fingerprint. */
export function fingerprintDisplay(hex: string): string {
	return (hex.toUpperCase().match(/.{1,2}/g) ?? []).join(':');
}

/**
 * A fingerprint (`AA:BB:…`) in runs of bytes, each ending in its colon but the last, so a
 * narrow line breaks between runs and never inside a byte pair.
 */
export function fingerprintGroups(display: string, bytesPerGroup = 8): string[] {
	const bytes = display.split(':').filter(Boolean);
	const groups: string[] = [];
	for (let i = 0; i < bytes.length; i += bytesPerGroup) {
		const run = bytes.slice(i, i + bytesPerGroup).join(':');
		groups.push(i + bytesPerGroup < bytes.length ? `${run}:` : run);
	}
	return groups;
}
