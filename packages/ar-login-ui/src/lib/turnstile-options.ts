export type TurnstileLanguage = 'en' | 'ja';

export function resolveTurnstileLanguage(
	pageLanguage: string | null | undefined,
	fallbackLanguage: string | null | undefined = 'en'
): TurnstileLanguage {
	const language = (pageLanguage || fallbackLanguage || 'en').toLowerCase();
	return language.startsWith('ja') ? 'ja' : 'en';
}
