/**
 * The lite account page's application launcher (lite plan PR7b; the SPA's AccountLauncherWidget):
 * the applications the account can open, filtered by a search, a category and favourites (the
 * SPA's filters, here a form the page is drawn again with: `launcher_q`, `launcher_category`,
 * `launcher_favorites`), and a favourite set or cleared (a post).
 *
 * Each opens by ar-management's own launch link (`/api/account/launchers/<id>/launch`, which signs
 * the person in to it). Icons are drawn as the name's first letter: the lite page loads no image
 * from elsewhere, nor the SPA's icon font.
 */
import { fail, type RequestEvent } from '@sveltejs/kit';
import { openAccountPost } from './account-post';
import { liteAccountItemId } from './account-widgets';
import { record } from './totp-passkey';

function text(value: unknown, max = 8192): string | null {
	return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

export interface LiteAccountLauncherView {
	/** Every application (the count the SPA shows). */
	total: number;
	categories: string[];
	launchers: Array<{
		id: string;
		name: string;
		description: string | null;
		category: string | null;
		href: string;
		newTab: boolean;
		favorite: boolean;
		allowFavorite: boolean;
		initial: string;
	}>;
	filters: { q: string; category: string; favorites: boolean };
}

/** ar-management's launch link of the application, only as such (a path of this origin). */
function launchHref(value: unknown, id: string): string | null {
	return value === `/api/account/launchers/${encodeURIComponent(id)}/launch` ? value : null;
}

/** The SPA's search: the name, description or category containing the words, case ignored. */
function matches(
	launcher: { name: string; description: string | null; category: string | null },
	query: string,
	locale: string
): boolean {
	const lower = (value: string) => {
		try {
			return value.toLocaleLowerCase(locale);
		} catch {
			return value.toLowerCase();
		}
	};
	const search = lower(query.trim());
	if (!search) return true;
	return [launcher.name, launcher.description ?? '', launcher.category ?? ''].some((value) =>
		lower(value).includes(search)
	);
}

/** The applications, filtered as the page's query asks. */
export function liteAccountLaunchers(
	json: Record<string, unknown>,
	url: URL,
	locale: string
): LiteAccountLauncherView {
	const rows = Array.isArray(json.launchers) ? json.launchers : [];
	const all = rows.flatMap((raw) => {
		const row = record(raw);
		const id = liteAccountItemId(row.id);
		const name = text(row.name, 1024);
		const href = id ? launchHref(row.launch_href, id) : null;
		if (!id || !name || !href) return [];
		return [
			{
				id,
				name,
				description: text(row.description),
				category: text(row.category, 256),
				href,
				newTab: row.open_in_new_tab === true,
				favorite: row.favorite === true,
				allowFavorite: row.allow_favorite === true,
				initial: [...name.trim()][0]?.toLocaleUpperCase() ?? '?'
			}
		];
	});
	const compare = (left: string, right: string) => {
		try {
			return left.localeCompare(right, locale);
		} catch {
			return left.localeCompare(right);
		}
	};
	const categories = [
		...new Set(all.map((launcher) => launcher.category).filter((value) => value !== null))
	].sort(compare) as string[];
	const q = (url.searchParams.get('launcher_q') ?? '').slice(0, 200);
	const asked = url.searchParams.get('launcher_category') ?? '';
	const category = categories.includes(asked) ? asked : '';
	const favorites = url.searchParams.get('launcher_favorites') === '1';
	return {
		total: all.length,
		categories,
		launchers: all.filter(
			(launcher) =>
				(!favorites || launcher.favorite) &&
				(!category || launcher.category === category) &&
				matches(launcher, q, locale)
		),
		filters: { q, category, favorites }
	};
}

/** `launcher_favorite`: an application's favourite set or cleared. */
export async function liteAccountLauncherFavoriteAction(event: RequestEvent) {
	const opened = await openAccountPost(event);
	if ('failure' in opened) return opened.failure;
	const { post } = opened;
	const id = liteAccountItemId(post.fields.get('launcher'));
	const favorite = post.fields.get('favorite');
	if (!id || (favorite !== '1' && favorite !== '0')) {
		return fail(400, { error: 'action_failed' as const, widget: 'launcher' });
	}
	const answer = await post.backend
		.request(`/api/account/launchers/${encodeURIComponent(id)}/favorite`, {
			method: 'PUT',
			json: { favorite: favorite === '1' }
		})
		.catch(() => null);
	if (answer?.status !== 200) {
		return fail(answer && answer.status < 500 ? 400 : 503, {
			error: 'favorite_failed' as const,
			widget: 'launcher'
		});
	}
	return { notice: 'favorite_saved' as const, widget: 'launcher' };
}

export const liteAccountLauncherActions = {
	launcher_favorite: liteAccountLauncherFavoriteAction
};
