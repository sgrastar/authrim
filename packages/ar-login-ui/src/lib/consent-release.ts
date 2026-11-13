/**
 * What the consent screen shows about the information an app is given (OIDC claims, or a SAML
 * SP's attributes and NameID): the labels
 * of the standard claims, how a value is written as text, and which optional items start checked.
 * Shared by the SPA consent view and the lite consent page; plain text only, never HTML.
 */
import type { TranslationFunctions } from '$i18n/i18n-types';

type Label = (LL: TranslationFunctions) => string;

/** Standard OIDC claims with a label of their own; any other claim is shown by its name. */
const CLAIM_LABELS: Readonly<Record<string, Label>> = {
	sub: (LL) => LL.consent_claim_sub(),
	name: (LL) => LL.consent_claim_name(),
	given_name: (LL) => LL.consent_claim_given_name(),
	family_name: (LL) => LL.consent_claim_family_name(),
	middle_name: (LL) => LL.consent_claim_middle_name(),
	nickname: (LL) => LL.consent_claim_nickname(),
	preferred_username: (LL) => LL.consent_claim_preferred_username(),
	profile: (LL) => LL.consent_claim_profile(),
	picture: (LL) => LL.consent_claim_picture(),
	website: (LL) => LL.consent_claim_website(),
	email: (LL) => LL.consent_claim_email(),
	email_verified: (LL) => LL.consent_claim_email_verified(),
	gender: (LL) => LL.consent_claim_gender(),
	birthdate: (LL) => LL.consent_claim_birthdate(),
	zoneinfo: (LL) => LL.consent_claim_zoneinfo(),
	locale: (LL) => LL.consent_claim_locale(),
	phone_number: (LL) => LL.consent_claim_phone_number(),
	phone_number_verified: (LL) => LL.consent_claim_phone_number_verified(),
	address: (LL) => LL.consent_claim_address(),
	updated_at: (LL) => LL.consent_claim_updated_at()
};

/** The label of a claim in the page's language; the raw claim name when it has none. */
export function releaseClaimLabel(LL: TranslationFunctions, name: string): string {
	return Object.hasOwn(CLAIM_LABELS, name) ? CLAIM_LABELS[name](LL) : name;
}

const SAML_EMAIL_NAMEID = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

/**
 * The label of a release item: an OIDC claim's (by its name), or a SAML SP's item, which carries
 * its own label; the NameID is called the identifier the service gets (the email address when
 * that is what it is).
 */
export function releaseItemLabel(
	LL: TranslationFunctions,
	item: { name: string; label?: string; kind?: string }
): string {
	if (item.kind === 'nameid') {
		return item.label === SAML_EMAIL_NAMEID
			? LL.consent_release_saml_nameid_email()
			: LL.consent_release_saml_nameid();
	}
	if (item.kind === 'attribute' && typeof item.label === 'string' && item.label) return item.label;
	return releaseClaimLabel(LL, item.name);
}

/**
 * What a recorded release item is called on the account page: a SAML SP's items are recorded by
 * key (`["attribute", name, format]` or `["nameid", format]`), an OIDC service's by claim name.
 */
export function recordedReleaseItemLabel(LL: TranslationFunctions, name: string): string {
	if (name.startsWith('[')) {
		try {
			const key: unknown = JSON.parse(name);
			if (Array.isArray(key) && key[0] === 'nameid' && typeof key[1] === 'string') {
				return releaseItemLabel(LL, { name, kind: 'nameid', label: key[1] });
			}
			if (Array.isArray(key) && key[0] === 'attribute' && typeof key[1] === 'string') {
				return key[1];
			}
		} catch {
			// Not a key: shown as it is.
		}
	}
	return releaseClaimLabel(LL, name);
}

const MAX_VALUE_TEXT = 300;
const MAX_DEPTH = 3;

function valueParts(value: unknown, depth: number): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value);
	}
	if (depth >= MAX_DEPTH) return '…';
	if (Array.isArray(value)) {
		return value
			.map((entry) => valueParts(entry, depth + 1))
			.filter((text) => text.length > 0)
			.join(', ');
	}
	if (typeof value === 'object') {
		return Object.entries(value as Record<string, unknown>)
			.map(([key, entry]) => {
				const text = valueParts(entry, depth + 1);
				return text ? `${key}: ${text}` : '';
			})
			.filter((text) => text.length > 0)
			.join('; ');
	}
	return '';
}

/**
 * A released value written compactly as text (arrays comma-separated, objects as `key: value`
 * pairs, long text cut). Null when there is nothing to show.
 */
export function formatReleaseValue(value: unknown): string | null {
	let text: string;
	try {
		text = valueParts(value, 0).trim();
	} catch {
		return null;
	}
	if (!text) return null;
	return text.length > MAX_VALUE_TEXT ? `${text.slice(0, MAX_VALUE_TEXT)}…` : text;
}

/** An optional item starts checked only when the user approved it last time (privacy by default). */
export function releaseDefaultChecked(item: { previously_approved?: boolean }): boolean {
	return item.previously_approved === true;
}

/**
 * The optional item names to send as `release_selected`: those still checked (a choice the user
 * made, else the item's default). Required items are not sent; approval releases them.
 */
export function releaseSelectedNames(
	release: { items: Array<{ name: string; required: boolean; previously_approved?: boolean }> },
	choices: Readonly<Record<string, boolean>>
): string[] {
	return release.items
		.filter((item) => !item.required && (choices[item.name] ?? releaseDefaultChecked(item)))
		.map((item) => item.name);
}

const MAX_ACCOUNT_RELEASE_NAMES = 100;

function releaseNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((name): name is string => typeof name === 'string' && name.length > 0)
		.slice(0, MAX_ACCOUNT_RELEASE_NAMES);
}

/**
 * What the account page shows about the information a service is given, as label/value rows:
 * the items the user approved and declined, or how it was decided for them (a trusted service,
 * or one that does not ask). Accepts the API's value as is (the lite page passes raw JSON).
 */
export function accountReleaseRows(
	LL: TranslationFunctions,
	release: unknown
): Array<{ label: string; value: string }> {
	const label = LL.account_consentInformationRelease();
	const record =
		release && typeof release === 'object' ? (release as Record<string, unknown>) : null;
	// A decision the service's policy made, which no longer decides: what was already issued
	// still holds it, and the next sign-in asks.
	const superseded = (text: string) =>
		record?.superseded === true ? `${text} ${LL.account_consentInformationSuperseded()}` : text;
	switch (record?.basis) {
		case 'trust':
			return [{ label, value: superseded(LL.account_consentInformationTrusted()) }];
		case 'not_asked':
			return [{ label, value: superseded(LL.account_consentInformationRequiredOnly()) }];
		case 'user': {
			if (record.refused === true) {
				return [{ label, value: LL.account_consentInformationRefused() }];
			}
			const list = (names: string[]) =>
				names.map((name) => recordedReleaseItemLabel(LL, name)).join(', ');
			const approved = releaseNames(record.approved);
			const declined = releaseNames(record.declined);
			const rows = [{ label, value: list(approved) || LL.account_consentInformationNone() }];
			if (declined.length > 0) {
				rows.push({ label: LL.account_consentInformationDeclined(), value: list(declined) });
			}
			return rows;
		}
		default:
			return [{ label, value: LL.account_consentInformationNotRecorded() }];
	}
}
