/**
 * The tenant's screens (`/api/admin/screens`): what each Login UI page shows (sign-in, sign-up,
 * profile completion, the account page…), part by part.
 *
 * The built-in (system) screens cannot be changed: a copy is made and edited instead. A change
 * names the version it was made from (If-Match), so two admins cannot overwrite each other. A
 * screen a flow or an account page uses cannot be deleted. The response records are what signed-in
 * people answered to parts kept off the profile; they are personal data, read with the permission
 * to read users.
 */
import type {
	ScreenField,
	ScreenKind,
	ScreenLocalization,
	ScreenSettings,
	ScreenUsage
} from '@authrim/ar-lib-core/types/screens';
import { API_BASE_URL, adminFetch } from './admin-request';
import { errorFromResponse } from './api-error';

export type { ScreenField, ScreenKind, ScreenLocalization, ScreenSettings, ScreenUsage };

const BASE = `${API_BASE_URL}/api/admin/screens`;

export const SCREEN_KINDS: readonly ScreenKind[] = [
	'login',
	'registration',
	'profile_completion',
	'consent',
	'code_input',
	'account',
	'custom'
];

/** How many flows and account pages use a screen. */
export interface ScreenUsageCount {
	flows: number;
	account_pages: number;
}

export interface Screen {
	id: string;
	screen_key: string;
	display_name: string;
	description: string | null;
	screen_kind: ScreenKind;
	fields: ScreenField[];
	localizations: Record<string, ScreenLocalization>;
	settings: ScreenSettings;
	is_active: boolean;
	is_system: boolean;
	version: number;
	created_at: number;
	updated_at: number;
}

/** A screen as one row of the list: in full (the list shows its preview), with its usage. */
export interface ScreenListItem extends Screen {
	usage: ScreenUsageCount;
}

export interface ScreenList {
	screens: ScreenListItem[];
	/** False when a flow or a settings document could not be read: counts are at least these. */
	usagesComplete: boolean;
}

export interface ScreenDetail {
	screen: Screen;
	usages: ScreenUsage[];
	usagesComplete: boolean;
}

export interface ScreenInput {
	display_name: string;
	description: string | null;
	/** Given when a screen is created; the key of a saved screen does not change. */
	screen_key?: string;
	screen_kind: ScreenKind;
	fields: ScreenField[];
	localizations: Record<string, ScreenLocalization>;
	settings: ScreenSettings;
	is_active: boolean;
}

/** One response record: what one person answered on one visit of a screen step. */
export interface ScreenResponseRecord {
	id: string;
	user_id: string;
	screen_key: string;
	flow_id: string | null;
	flow_version_id: string | null;
	interaction_id: string | null;
	step_id: string | null;
	answers: Record<string, string | boolean>;
	created_at: number;
	updated_at: number;
}

export interface ScreenResponsePage {
	responses: ScreenResponseRecord[];
	next_cursor: string | null;
}

export interface ScreensClient {
	list(signal?: AbortSignal): Promise<ScreenList>;
	get(id: string, signal?: AbortSignal): Promise<ScreenDetail>;
	create(input: ScreenInput): Promise<Screen>;
	/** Saves over `version`; a screen changed since answers 409 (`current_version`). */
	update(id: string, version: number, input: ScreenInput): Promise<Screen>;
	/**
	 * Deletes the screen at `version`. One a flow or an account page uses is refused (409
	 * `screen_in_use`, with the usages), as is one whose usage could not be read in full.
	 */
	remove(id: string, version: number): Promise<void>;
	/** A page of the screen's response records, newest first. */
	responses(
		id: string,
		page?: { limit?: number; cursor?: string | null },
		signal?: AbortSignal
	): Promise<ScreenResponsePage>;
}

type Row = Record<string, unknown>;

const record = (value: unknown): Row =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : 0;
const flag = (value: unknown): boolean => value === true || value === 1;

function kindOf(value: unknown): ScreenKind {
	return SCREEN_KINDS.includes(value as ScreenKind) ? (value as ScreenKind) : 'custom';
}

export function screenFromRow(value: unknown): Screen {
	const row = record(value);
	return {
		id: text(row.id),
		screen_key: text(row.screen_key),
		display_name: text(row.display_name),
		description: textOrNull(row.description),
		screen_kind: kindOf(row.screen_kind),
		fields: Array.isArray(row.fields) ? (row.fields as ScreenField[]) : [],
		localizations: record(row.localizations) as Record<string, ScreenLocalization>,
		settings: record(row.settings) as ScreenSettings,
		is_active: flag(row.is_active),
		is_system: flag(row.is_system),
		version: count(row.version) || 1,
		created_at: count(row.created_at),
		updated_at: count(row.updated_at)
	};
}

function usageCountFromRow(value: unknown): ScreenUsageCount {
	const row = record(value);
	return { flows: count(row.flows), account_pages: count(row.account_pages) };
}

export function screenResponseFromRow(value: unknown): ScreenResponseRecord {
	const row = record(value);
	const answers: Record<string, string | boolean> = {};
	for (const [key, answer] of Object.entries(record(row.answers))) {
		if (typeof answer === 'string' || typeof answer === 'boolean') answers[key] = answer;
	}
	return {
		id: text(row.id),
		user_id: text(row.user_id),
		screen_key: text(row.screen_key),
		flow_id: textOrNull(row.flow_id),
		flow_version_id: textOrNull(row.flow_version_id),
		interaction_id: textOrNull(row.interaction_id),
		step_id: textOrNull(row.step_id),
		answers,
		created_at: count(row.created_at),
		updated_at: count(row.updated_at)
	};
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

const screenUrl = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
const ifMatch = (version: number) => ({ 'If-Match': `"${version}"` });

export const httpScreens: ScreensClient = {
	async list(signal) {
		const body = await readJson(await adminFetch(BASE, { signal }));
		const screens = Array.isArray(body.screens)
			? body.screens.map((row) => ({
					...screenFromRow(row),
					usage: usageCountFromRow(record(row).usage)
				}))
			: [];
		return { screens, usagesComplete: body.usages_complete !== false };
	},
	async get(id, signal) {
		const body = await readJson(await adminFetch(screenUrl(id), { signal }));
		return {
			screen: screenFromRow(body.screen),
			usages: Array.isArray(body.usages) ? (body.usages as ScreenUsage[]) : [],
			usagesComplete: body.usages_complete !== false
		};
	},
	async create(input) {
		const body = await readJson(await adminFetch(BASE, json('POST', input)));
		return screenFromRow(body.screen);
	},
	async update(id, version, input) {
		const { screen_key: _key, ...change } = input;
		const body = await readJson(
			await adminFetch(screenUrl(id), json('PUT', change, ifMatch(version)))
		);
		return screenFromRow(body.screen);
	},
	async remove(id, version) {
		await readJson(
			await adminFetch(screenUrl(id), { method: 'DELETE', headers: ifMatch(version) })
		);
	},
	async responses(id, page = {}, signal) {
		const query = new URLSearchParams();
		if (page.limit !== undefined) query.set('limit', String(page.limit));
		if (page.cursor) query.set('cursor', page.cursor);
		const suffix = query.size > 0 ? `?${query.toString()}` : '';
		const body = await readJson(
			await adminFetch(`${screenUrl(id)}/responses${suffix}`, { signal })
		);
		return {
			responses: Array.isArray(body.responses) ? body.responses.map(screenResponseFromRow) : [],
			next_cursor: textOrNull(body.next_cursor)
		};
	}
};

/** Where a screen is used, from an error the API answered (`screen_in_use`), or none. */
export function usagesOfError(body: Record<string, unknown>): ScreenUsage[] {
	return Array.isArray(body.usages) ? (body.usages as ScreenUsage[]) : [];
}
