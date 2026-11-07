/**
 * In-memory screens for Storybook, the whole-console mock and tests. Answers as the Admin API
 * does: a key is unique per tenant (409 `screen_key_taken`), a system screen cannot be changed or
 * deleted (400), a change over a stale version is refused (409 `ADMIN_CONFLICT` with
 * `current_version`), and a screen in use is not deleted (409 `screen_in_use` with the usages).
 */
import { ApiError, ConflictError } from '../api-error';
import type {
	Screen,
	ScreenInput,
	ScreenListItem,
	ScreenResponseRecord,
	ScreensClient,
	ScreenUsage
} from '../screens';

export interface FakeScreensOptions {
	screens?: Screen[];
	/** Where each screen is used, by screen id. */
	usages?: Record<string, ScreenUsage[]>;
	/** Response records, by screen id (any order; answered newest first). */
	responses?: Record<string, ScreenResponseRecord[]>;
	/** Milliseconds each call takes. */
	delay?: number;
	/** The time the fake stamps on what it saves (tests pin it). */
	now?: () => number;
}

const KEY = /^[a-z0-9_-]{1,96}$/u;

export function createFakeScreens(options: FakeScreensOptions = {}): ScreensClient {
	let screens: Screen[] = (options.screens ?? []).map((screen) => structuredClone(screen));
	const usages = options.usages ?? {};
	const responses = options.responses ?? {};
	const now = options.now ?? Date.now;
	let sequence = screens.length;

	const wait = () =>
		options.delay ? new Promise((resolve) => setTimeout(resolve, options.delay)) : null;
	const find = (id: string) => {
		const screen = screens.find((item) => item.id === id);
		if (!screen) throw new ApiError(404, 'not_found', 'Screen not found');
		return screen;
	};
	const usageOf = (screen: Screen) => usages[screen.id] ?? [];
	const listItem = (screen: Screen): ScreenListItem => {
		const used = usageOf(screen);
		return {
			...structuredClone(screen),
			usage: {
				flows: used.filter((usage) => usage.kind === 'flow').length,
				account_pages: used.filter((usage) => usage.kind === 'account_page').length
			}
		};
	};
	const conflict = (current: number) =>
		new ConflictError('The screen was changed since it was loaded', {
			error: 'ADMIN_CONFLICT',
			current_version: current
		});
	const checkInput = (input: ScreenInput) => {
		if (!input.display_name.trim()) {
			throw new ApiError(400, 'invalid_request', 'display_name is required');
		}
		if (input.fields.length === 0) {
			throw new ApiError(400, 'invalid_request', 'fields must contain at least one field');
		}
		// As the API: an account page holds content and at most one account widget.
		if (input.screen_kind === 'account') {
			const widgets = input.fields.filter((field) =>
				String(field.block_type ?? '').startsWith('account_')
			);
			if (widgets.length > 1) {
				throw new ApiError(
					400,
					'invalid_request',
					'Account screens may contain at most one primary Account Widget'
				);
			}
		}
	};

	return {
		async list() {
			await wait();
			return { screens: screens.map(listItem), usagesComplete: true };
		},
		async get(id) {
			await wait();
			const screen = find(id);
			return {
				screen: structuredClone(screen),
				usages: structuredClone(usageOf(screen)),
				usagesComplete: true
			};
		},
		async create(input) {
			await wait();
			checkInput(input);
			const key = (input.screen_key ?? '').trim();
			if (!KEY.test(key)) throw new ApiError(400, 'invalid_request', 'screen_key is invalid');
			if (screens.some((item) => item.screen_key === key)) {
				throw new ConflictError('A screen with this key already exists', {
					error: 'screen_key_taken'
				});
			}
			const at = now();
			const screen: Screen = {
				id: `screen_${++sequence}`,
				screen_key: key,
				display_name: input.display_name.trim(),
				description: input.description,
				screen_kind: input.screen_kind,
				fields: structuredClone(input.fields),
				localizations: structuredClone(input.localizations),
				settings: structuredClone(input.settings),
				is_active: input.is_active,
				is_system: false,
				version: 1,
				created_at: at,
				updated_at: at
			};
			screens = [...screens, screen];
			return structuredClone(screen);
		},
		async update(id, version, input) {
			await wait();
			const current = find(id);
			if (current.is_system) {
				throw new ApiError(400, 'invalid_request', 'System screens are immutable');
			}
			if (current.version !== version) throw conflict(current.version);
			checkInput(input);
			const saved: Screen = {
				...current,
				display_name: input.display_name.trim(),
				description: input.description,
				screen_kind: input.screen_kind,
				fields: structuredClone(input.fields),
				localizations: structuredClone(input.localizations),
				settings: structuredClone(input.settings),
				is_active: input.is_active,
				version: current.version + 1,
				updated_at: now()
			};
			screens = screens.map((item) => (item.id === id ? saved : item));
			return structuredClone(saved);
		},
		async remove(id, version) {
			await wait();
			const current = find(id);
			if (current.is_system) {
				throw new ApiError(400, 'invalid_request', 'System screens cannot be deleted');
			}
			if (current.version !== version) throw conflict(current.version);
			const used = usageOf(current);
			if (used.length > 0) {
				throw new ConflictError('The screen is used by flows or account pages', {
					error: 'screen_in_use',
					usages: structuredClone(used)
				});
			}
			screens = screens.filter((item) => item.id !== id);
		},
		async responses(id, page = {}) {
			await wait();
			find(id);
			const limit = page.limit ?? 50;
			const sorted = [...(responses[id] ?? [])].sort((a, b) =>
				a.created_at !== b.created_at ? b.created_at - a.created_at : b.id < a.id ? -1 : 1
			);
			const start = page.cursor ? sorted.findIndex((row) => row.id === page.cursor) + 1 : 0;
			const slice = sorted.slice(start, start + limit);
			return {
				responses: structuredClone(slice),
				next_cursor:
					start + limit < sorted.length && slice.length > 0 ? slice[slice.length - 1].id : null
			};
		}
	};
}
