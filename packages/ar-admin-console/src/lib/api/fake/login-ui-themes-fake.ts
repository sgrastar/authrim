/**
 * In-memory Login UI themes for Storybook, the whole-console mock and tests. Answers as the Admin
 * API does: names are unique per tenant (409 `theme_name_taken`), at most `limit` themes (409
 * `theme_limit_reached`), a save over a stale version is refused (409 with `current_version`),
 * and the applied theme cannot be deleted (409 `theme_active`).
 */
import { ApiError } from '../api-error';
import type {
	ActiveTheme,
	LoginUiTheme,
	LoginUiThemesClient,
	ThemeInput,
	ThemeSummary
} from '../login-ui-themes';

export interface FakeLoginUiThemesOptions {
	/** The themes that exist; none by default (a tenant starts with none). */
	themes?: LoginUiTheme[];
	/** The applied theme, if any. */
	active?: ActiveTheme | null;
	/** Milliseconds each call takes. */
	delay?: number;
	/** At most this many themes (the API's limit is 50). */
	limit?: number;
}

const NAME_MAX = 80;

export function createFakeLoginUiThemes(
	options: FakeLoginUiThemesOptions = {}
): LoginUiThemesClient {
	let themes: LoginUiTheme[] = (options.themes ?? []).map((theme) => ({ ...theme }));
	let active: ActiveTheme | null = options.active ?? null;
	let sequence = themes.length;
	const limit = options.limit ?? 50;

	const wait = () =>
		options.delay ? new Promise((resolve) => setTimeout(resolve, options.delay)) : null;
	const find = (id: string) => {
		const theme = themes.find((item) => item.id === id);
		if (!theme) throw new ApiError(404, 'not_found', 'Theme not found');
		return theme;
	};
	const checkName = (name: string, except?: string) => {
		const trimmed = name.trim();
		if (trimmed.length === 0 || trimmed.length > NAME_MAX) {
			throw new ApiError(400, 'invalid_request', 'Invalid name', { field: 'name' });
		}
		const taken = themes.some(
			(item) => item.id !== except && item.name.toLowerCase() === trimmed.toLowerCase()
		);
		if (taken) throw new ApiError(409, 'theme_name_taken', 'A theme has this name');
		return trimmed;
	};
	const summary = (theme: LoginUiTheme): ThemeSummary => ({
		id: theme.id,
		name: theme.name,
		template:
			typeof theme.values['login-ui.template'] === 'string'
				? (theme.values['login-ui.template'] as string)
				: null,
		palette:
			typeof theme.values['login-ui.palette'] === 'string'
				? (theme.values['login-ui.palette'] as string)
				: null,
		version: theme.version,
		updated_at: theme.updated_at
	});

	return {
		async list() {
			await wait();
			const sorted = [...themes].sort((a, b) => b.updated_at - a.updated_at);
			return { themes: sorted.map(summary), active: active ? { ...active } : null };
		},
		async get(id) {
			await wait();
			const theme = find(id);
			return { theme: { ...theme, values: { ...theme.values } }, active: active?.theme_id === id };
		},
		async create(input: ThemeInput) {
			await wait();
			if (themes.length >= limit) {
				throw new ApiError(409, 'theme_limit_reached', 'Too many themes');
			}
			const name = checkName(input.name);
			const now = Date.now();
			sequence += 1;
			const theme: LoginUiTheme = {
				id: `thm_${sequence}`,
				name,
				values: { ...input.values },
				version: 1,
				created_by: 'admin',
				created_at: now,
				updated_at: now
			};
			themes = [...themes, theme];
			return { ...theme };
		},
		async update(id, version, input) {
			await wait();
			const theme = find(id);
			if (theme.version !== version) {
				throw new ApiError(409, 'ADMIN_CONFLICT', 'The theme has changed', {
					current_version: theme.version
				});
			}
			const name = checkName(input.name, id);
			const next: LoginUiTheme = {
				...theme,
				name,
				values: { ...input.values },
				version: theme.version + 1,
				updated_at: Math.max(Date.now(), theme.updated_at + 1)
			};
			themes = themes.map((item) => (item.id === id ? next : item));
			return { ...next };
		},
		async remove(id) {
			await wait();
			find(id);
			if (active?.theme_id === id) {
				throw new ApiError(409, 'theme_active', 'The applied theme cannot be deleted');
			}
			themes = themes.filter((item) => item.id !== id);
		},
		async apply(id, version) {
			await wait();
			const theme = find(id);
			if (version !== undefined && theme.version !== version) {
				throw new ApiError(409, 'ADMIN_CONFLICT', 'The theme has changed', {
					current_version: theme.version
				});
			}
			active = { theme_id: id, version: theme.version };
			return { ...active };
		}
	};
}
