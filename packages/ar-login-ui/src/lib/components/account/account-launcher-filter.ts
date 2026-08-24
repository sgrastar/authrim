import type { AccountLauncher } from '$lib/api/account';

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
