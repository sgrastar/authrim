/**
 * The tenant's saved Login UI themes (`/api/admin/login-ui/themes`): a list the admin builds up,
 * each one the full look of the sign-in screens, and one of them applied (made live).
 *
 * A theme's `values` are Login UI settings keyed as the settings are (`login-ui.template`, …); the
 * editor turns them into its draft and back (`theme-values.ts`). Applying writes them to the
 * tenant's Login UI settings, clearing the ones the theme does not set, so that the screens show
 * the theme and nothing else.
 */
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';

const BASE = `${API_BASE_URL}/api/admin/login-ui/themes`;

export type ThemeValues = Record<string, unknown>;

/** A theme as one row of the list. */
export interface ThemeSummary {
	id: string;
	name: string;
	template: string | null;
	palette: string | null;
	version: number;
	updated_at: number;
}

/** A theme in full. */
export interface LoginUiTheme {
	id: string;
	name: string;
	values: ThemeValues;
	version: number;
	created_by: string | null;
	created_at: number;
	updated_at: number;
}

/** Which theme is live, and at which of its versions (a later save is not live until applied). */
export interface ActiveTheme {
	theme_id: string;
	version: number;
}

export interface ThemeList {
	themes: ThemeSummary[];
	active: ActiveTheme | null;
}

export interface ThemeInput {
	name: string;
	values: ThemeValues;
}

export interface LoginUiThemesClient {
	list(signal?: AbortSignal): Promise<ThemeList>;
	get(id: string, signal?: AbortSignal): Promise<{ theme: LoginUiTheme; active: boolean }>;
	create(input: ThemeInput): Promise<LoginUiTheme>;
	/** Saves over `version`; a theme changed since answers 409 (`ApiError`, `current_version`). */
	update(id: string, version: number, input: ThemeInput): Promise<LoginUiTheme>;
	/** The applied theme cannot be deleted (409 `theme_active`). */
	remove(id: string): Promise<void>;
	/** Makes the theme live; with `version`, only if it is still that version. */
	apply(id: string, version?: number): Promise<ActiveTheme>;
}

type Row = Record<string, unknown>;

const record = (value: unknown): Row =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : 0;

export function themeSummaryFromRow(value: unknown): ThemeSummary {
	const row = record(value);
	return {
		id: text(row.id),
		name: text(row.name),
		template: textOrNull(row.template),
		palette: textOrNull(row.palette),
		version: count(row.version),
		updated_at: count(row.updated_at)
	};
}

export function themeFromRow(value: unknown): LoginUiTheme {
	const row = record(value);
	return {
		id: text(row.id),
		name: text(row.name),
		values: record(row.values),
		version: count(row.version),
		created_by: textOrNull(row.created_by),
		created_at: count(row.created_at),
		updated_at: count(row.updated_at)
	};
}

export function activeFromRow(value: unknown): ActiveTheme | null {
	const row = record(value);
	const id = text(row.theme_id);
	return id ? { theme_id: id, version: count(row.version) } : null;
}

async function readJson(response: Response): Promise<Row> {
	if (!response.ok) throw await errorFromResponse(response);
	if (response.status === 204) return {};
	return record(await response.json().catch(() => ({})));
}

const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
	method,
	headers,
	includeJsonContentType: true,
	body: JSON.stringify(body)
});

const themeUrl = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export const httpLoginUiThemes: LoginUiThemesClient = {
	async list(signal) {
		const body = await readJson(await adminFetch(BASE, { signal }));
		const themes = Array.isArray(body.themes) ? body.themes.map(themeSummaryFromRow) : [];
		return { themes, active: activeFromRow(body.active) };
	},
	async get(id, signal) {
		const body = await readJson(await adminFetch(themeUrl(id), { signal }));
		return { theme: themeFromRow(body.theme), active: body.active === true };
	},
	async create(input) {
		const body = await readJson(await adminFetch(BASE, json('POST', input)));
		return themeFromRow(body.theme);
	},
	async update(id, version, input) {
		const body = await readJson(
			await adminFetch(themeUrl(id), json('PUT', input, { 'If-Match': `"${version}"` }))
		);
		return themeFromRow(body.theme);
	},
	async remove(id) {
		await readJson(await adminFetch(themeUrl(id), { method: 'DELETE' }));
	},
	async apply(id, version) {
		const body = await readJson(
			await adminFetch(
				`${themeUrl(id)}/apply`,
				json('POST', version === undefined ? {} : { version })
			)
		);
		const active = activeFromRow(body.active);
		return active ?? { theme_id: id, version: version ?? 0 };
	}
};

/** Uploads an image for the Login UI (`logo`, `background`, `panel-background`, `favicon`). */
export async function uploadLoginUiAsset(kind: string, file: File): Promise<string> {
	const form = new FormData();
	form.set('kind', kind);
	form.set('file', file);
	const body = await readJson(
		await adminFetch(`${API_BASE_URL}/api/admin/assets/login-ui`, { method: 'POST', body: form })
	);
	const url = text(body.url);
	if (!url) throw new Error('The upload answered no URL');
	return url;
}
