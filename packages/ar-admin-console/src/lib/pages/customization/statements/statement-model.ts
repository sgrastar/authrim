import type {
	ConsentContentType,
	ConsentLocalization,
	ConsentLocalizationInput,
	ConsentStatement,
	ConsentStatementInput,
	ConsentStatementListItem,
	ConsentVersion
} from '#lib/api/consent-statements.js';
import { LOCALE_LABELS, isSupportedLocale } from '#lib/i18n/locales.js';

/** What the console calls the kinds of statement; every other stored category is "Other". */
export type CategoryKind = 'terms' | 'privacy' | 'other';

export const CATEGORY_KINDS: readonly CategoryKind[] = ['terms', 'privacy', 'other'];

const CATEGORY_OF_KIND: Record<Exclude<CategoryKind, 'other'>, string> = {
	terms: 'terms_of_service',
	privacy: 'privacy_policy'
};

export function categoryKind(category: string): CategoryKind {
	if (category === CATEGORY_OF_KIND.terms) return 'terms';
	if (category === CATEGORY_OF_KIND.privacy) return 'privacy';
	return 'other';
}

/**
 * The stored category for a chosen kind. "Other" keeps what the statement already had (a SAML
 * release category, for one) and is `custom` for a new statement.
 */
export function categoryOfKind(kind: CategoryKind, original = 'custom'): string {
	if (kind === 'other') return categoryKind(original) === 'other' ? original : 'custom';
	return CATEGORY_OF_KIND[kind];
}

export const LEGAL_BASES = [
	'consent',
	'contract',
	'legal_obligation',
	'vital_interests',
	'public_task',
	'legitimate_interests'
] as const;

export const LIMITS = {
	title: 200,
	description: 2000,
	content: 100_000,
	url: 2048,
	impact: 1000,
	slug: 96
} as const;

/** A statement key: lower-case letters, digits, `-` and `_`. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]*$/u;

/** The title to show for a statement: in the admin's language, else any other, else its key. */
export function statementName(
	titles: Readonly<Record<string, string>>,
	locale: string,
	slug: string
): string {
	if (titles[locale]) return titles[locale];
	for (const language of ['ja', 'en', 'de', 'ar']) if (titles[language]) return titles[language];
	const first = Object.keys(titles).sort()[0];
	return first ? titles[first] : slug;
}

export type StatementStatus = 'active' | 'inactive' | 'draftOnly';

/** On, off (turned off or retired), or with no published version yet. */
export function statementStatus(
	statement: ConsentStatement,
	current: ConsentVersion | null
): StatementStatus {
	if (statement.retired_at !== null) return 'inactive';
	if (!current) return 'draftOnly';
	return statement.is_active ? 'active' : 'inactive';
}

export const listItemStatus = (item: ConsentStatementListItem) =>
	statementStatus(item.statement, item.current);

/** Today as a version number (YYYYMMDD), in the browser's day. */
export function todayVersion(now: Date = new Date()): string {
	const month = String(now.getMonth() + 1).padStart(2, '0');
	const day = String(now.getDate()).padStart(2, '0');
	return `${now.getFullYear()}${month}${day}`;
}

/** A version number is eight digits that make a real date. */
export function isValidVersion(value: string): boolean {
	const match = /^(\d{4})(\d{2})(\d{2})$/u.exec(value);
	if (!match) return false;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		year >= 2000 &&
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	);
}

/** `20261001` as `2026-10-01`. */
export function versionLabel(version: string): string {
	return /^\d{8}$/u.test(version)
		? `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6)}`
		: version;
}

/** The draft a statement has, if any (there is normally one at a time). */
export const draftOf = (versions: readonly ConsentVersion[]): ConsentVersion | null =>
	versions.find((version) => version.status === 'draft') ?? null;

export const currentOf = (versions: readonly ConsentVersion[]): ConsentVersion | null =>
	versions.find((version) => version.is_current) ?? null;

/** The text of one language while it is edited. */
export interface LanguageValue {
	title: string;
	description: string;
	/** The text of the document (version content type `inline`). */
	content: string;
	/** The address of the document (version content type `url`). */
	url: string;
	/**
	 * Per-language texts this page does not edit (set in the old console or by the API). Kept as
	 * they are and sent back with every save, as the API clears what a PUT leaves out.
	 */
	processingPurpose?: string | null;
	withdrawalImpact?: string | null;
}

export const emptyLanguage = (): LanguageValue => ({
	title: '',
	description: '',
	content: '',
	url: ''
});

export function languageValue(item: ConsentLocalization): LanguageValue {
	return {
		title: item.title,
		description: item.description,
		content: item.inline_content ?? '',
		url: item.document_url ?? '',
		processingPurpose: item.processing_purpose,
		withdrawalImpact: item.withdrawal_impact
	};
}

/** What the page edits: the statement's settings and the draft version's texts. */
export interface StatementEditorValue {
	category: CategoryKind;
	legalBasis: string;
	withdrawalAllowed: boolean;
	withdrawalImpact: string;
	retentionDays: number | null;
	reconsentDays: number | null;
	/** Of the draft version. */
	contentType: ConsentContentType;
	/** The draft version's texts by language. */
	languages: Record<string, LanguageValue>;
}

export function editorValue(
	statement: ConsentStatement,
	draft: ConsentVersion | null,
	localizations: readonly ConsentLocalization[]
): StatementEditorValue {
	return {
		category: categoryKind(statement.category),
		legalBasis: statement.legal_basis,
		withdrawalAllowed: statement.withdrawal_allowed,
		withdrawalImpact: statement.withdrawal_impact ?? '',
		retentionDays: statement.record_retention_days,
		reconsentDays: statement.reconsent_interval_days,
		contentType: draft?.content_type ?? 'inline',
		languages: Object.fromEntries(localizations.map((item) => [item.language, languageValue(item)]))
	};
}

/** What changed on the statement itself, as the API takes it; empty when nothing did. */
export function statementChange(
	from: StatementEditorValue,
	saved: StatementEditorValue,
	statement: ConsentStatement
): ConsentStatementInput {
	const change: ConsentStatementInput = {};
	if (from.category !== saved.category) {
		change.category = categoryOfKind(from.category, statement.category);
	}
	if (from.legalBasis !== saved.legalBasis) change.legal_basis = from.legalBasis;
	if (from.withdrawalAllowed !== saved.withdrawalAllowed) {
		change.withdrawal_allowed = from.withdrawalAllowed;
	}
	if (from.withdrawalImpact.trim() !== saved.withdrawalImpact.trim()) {
		change.withdrawal_impact = from.withdrawalImpact.trim() || null;
	}
	if (from.retentionDays !== saved.retentionDays) change.record_retention_days = from.retentionDays;
	if (from.reconsentDays !== saved.reconsentDays) {
		change.reconsent_interval_days = from.reconsentDays;
	}
	return change;
}

/** The body of a language's PUT: only what its content type uses is sent. */
export function localizationInput(
	value: LanguageValue,
	contentType: ConsentContentType
): ConsentLocalizationInput {
	return {
		title: value.title.trim(),
		description: value.description.trim(),
		processing_purpose: value.processingPurpose ?? null,
		withdrawal_impact: value.withdrawalImpact ?? null,
		document_url: contentType === 'url' ? value.url.trim() || null : null,
		inline_content: contentType === 'inline' ? value.content || null : null
	};
}

export const sameLanguage = (a: LanguageValue | undefined, b: LanguageValue | undefined) =>
	!!a &&
	!!b &&
	a.title === b.title &&
	a.description === b.description &&
	a.content === b.content &&
	a.url === b.url;

export function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value.trim());
		return url.protocol === 'https:' || url.protocol === 'http:';
	} catch {
		return false;
	}
}

export type LanguageProblem = 'title' | 'description' | 'url' | 'content';

/**
 * What stops a language being saved (a title and a summary are required; an address has to be a
 * link) or, with `forPublish`, being published (the text or link must be there).
 */
export function languageProblems(
	value: LanguageValue,
	contentType: ConsentContentType,
	forPublish = false
): LanguageProblem[] {
	const found: LanguageProblem[] = [];
	if (!value.title.trim()) found.push('title');
	if (!value.description.trim()) found.push('description');
	if (contentType === 'url') {
		const url = value.url.trim();
		if (url ? !isHttpUrl(url) : forPublish) found.push('url');
	} else if (forPublish && !value.content.trim()) found.push('content');
	return found;
}

/** The order languages are listed in: the console's own first, then others by code. */
export function sortedLanguages(codes: Iterable<string>): string[] {
	const own = Object.keys(LOCALE_LABELS);
	return [...new Set(codes)].sort((a, b) => {
		const rank = (code: string) => (own.includes(code) ? own.indexOf(code) : own.length);
		return rank(a) - rank(b) || a.localeCompare(b);
	});
}

export const languageName = (code: string): string =>
	isSupportedLocale(code) ? LOCALE_LABELS[code].native : code;

/**
 * A stored text as plain text for the preview. Statements made in the old console hold simple
 * HTML (`<p>…</p>`); it is shown as the text it holds, never rendered.
 */
export function plainText(content: string): string {
	let text = content
		.replace(/<br\s*\/?>/giu, '\n')
		.replace(/<\/(p|div|li|h[1-6])>/giu, '\n')
		.replace(/&nbsp;/gu, ' ')
		.replace(/&lt;/gu, '<')
		.replace(/&gt;/gu, '>')
		.replace(/&quot;/gu, '"');
	// Entities are decoded before tags are removed, and removal repeats until nothing changes, so
	// no tag (an encoded one or one formed by a removal) is left in what is returned.
	let previous: string;
	do {
		previous = text;
		text = text.replace(/<[^>]*>/gu, '');
	} while (text !== previous);
	return text.replace(/&amp;/gu, '&').trim();
}
