import type { CategoryKind } from './statement-model';

/**
 * The words a new terms of service or privacy policy starts with, in each language the console
 * writes statements in, from the earlier admin UI's templates. Its `%link1%` becomes the
 * statement's name. The description is HTML the admin writes as they like (a link to the
 * document included); nothing is added to it.
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
 * "Other", or a language without them).
 */
export function statementPreset(kind: CategoryKind, language: string): StatementPreset {
	if (kind === 'other') return NONE;
	const title = NAMES[kind][language];
	const agreement = AGREEMENTS[kind][language];
	if (!title || !agreement) return NONE;
	return { title, description: agreement.replace('%link1%', escapeHtml(title)) };
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
