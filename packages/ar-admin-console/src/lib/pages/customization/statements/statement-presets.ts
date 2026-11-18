import { isHttpUrl, type CategoryKind } from './statement-model';

/**
 * The words a new terms of service or privacy policy starts with, in each language the console
 * writes statements in, from the earlier admin UI's templates. Its `%link1%` (a link to the
 * document) becomes the statement's name, linked to the document once its link is given: the
 * description is HTML where people are asked to agree.
 */
type PresetKind = Exclude<CategoryKind, 'other'>;

const NAMES: Record<PresetKind, Record<string, string>> = {
	terms: {
		ja: '利用規約',
		en: 'Terms of Service',
		de: 'Nutzungsbedingungen',
		ar: 'شروط الخدمة'
	},
	privacy: {
		ja: 'プライバシーポリシー',
		en: 'Privacy Policy',
		de: 'Datenschutzerklärung',
		ar: 'سياسة الخصوصية'
	}
};

const AGREEMENTS: Record<PresetKind, Record<string, string>> = {
	terms: {
		ja: '%link1%を読み、その内容に同意します。',
		en: 'I have read and agree to the %link1%.',
		de: 'Ich habe die %link1% gelesen und stimme ihnen zu.',
		ar: 'لقد قرأت %link1% وأوافق عليها.'
	},
	privacy: {
		ja: '%link1%を読み、その内容に同意します。',
		en: 'I have read and agree to the %link1%.',
		de: 'Ich habe die %link1% gelesen und stimme ihr zu.',
		ar: 'لقد قرأت %link1% وأوافق عليها.'
	}
};

export interface StatementPreset {
	title: string;
	description: string;
}

const NONE: StatementPreset = { title: '', description: '' };

function escapeHtml(value: string): string {
	return value
		.replace(/&/gu, '&amp;')
		.replace(/</gu, '&lt;')
		.replace(/>/gu, '&gt;')
		.replace(/"/gu, '&quot;')
		.replace(/'/gu, '&#39;');
}

/**
 * The name and description a new statement of this kind starts with in a language (none for
 * "Other", or a language without them). The name in the description links to `url` when it is a
 * web address.
 */
export function statementPreset(kind: CategoryKind, language: string, url = ''): StatementPreset {
	if (kind === 'other') return NONE;
	const title = NAMES[kind][language];
	const agreement = AGREEMENTS[kind][language];
	if (!title || !agreement) return NONE;
	const name = escapeHtml(title);
	const href = url.trim();
	// The href is written as typed (an `&` stays `&`): the sign-in screen escapes it once as it
	// shows it. A link it could not keep whole (a quote, `<`, `>` or a space in it) is left out.
	const link = isHttpUrl(href) && !/["'<>\s]/u.test(href) ? `<a href="${href}">${name}</a>` : name;
	return { title, description: agreement.replace('%link1%', link) };
}

/**
 * A key for a statement made where its key is not asked: its kind and a random part, so two made
 * at once do not take the same one. It is never shown to people asked to agree.
 */
export function generatedStatementSlug(
	kind: CategoryKind,
	random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)
): string {
	const prefix = kind === 'other' ? 'statement' : kind;
	const suffix = Array.from(random(new Uint8Array(5)), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
	return `${prefix}-${suffix}`;
}
