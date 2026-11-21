import type { AccountLauncher } from '#lib/api/account.js';

function normalizeSearch(value: string, locale: string): string {
	return value.toLocaleLowerCase(locale);
}

export function launcherMatchesSearch(
	launcher: AccountLauncher,
	query: string,
	locale: string
): boolean {
	const search = normalizeSearch(query.trim(), locale);
	if (!search) return true;
	return [launcher.name, launcher.description ?? '', launcher.category ?? ''].some((value) =>
		normalizeSearch(value, locale).includes(search)
	);
}

/** A launcher background uploaded to this environment (a path the page's own origin serves). */
const UPLOADED_PICTURE =
	/^\/api\/assets\/[A-Za-z0-9_-]{1,128}\/login-ui\/launcher-background\/[A-Za-z0-9-]{1,64}\.(?:gif|jpe?g|png|webp)$/u;

/**
 * The tile picture to load: an uploaded launcher background, or an HTTPS URL; anything else
 * (another scheme, another path) is not drawn.
 */
export function launcherPicture(value: string | null | undefined): string | null {
	if (typeof value !== 'string' || !value || value.length > 2048) return null;
	if (UPLOADED_PICTURE.test(value)) return value;
	try {
		return new URL(value).protocol === 'https:' ? value : null;
	} catch {
		return null;
	}
}
